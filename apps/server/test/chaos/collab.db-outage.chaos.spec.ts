import {
  connectToxiproxy,
  MYSQL_PROXY_NAME,
  TOXIC,
  workerSchemaName,
  withDeadline,
  warnsBeforeUnload,
  type ToxicHandle,
} from '@iridium/testkit';
import { describe, expect, inject, it } from 'vitest';

import { NIGHTLY_CHAOS, persistedCount } from '../support/collab-chaos.ts';
import { expectConverged, startCollab } from '../support/collab-harness.ts';

const failures = NIGHTLY_CHAOS
  ? (['disabled', 'reset_peer', 'timeout', 'blackhole'] as const)
  : (['disabled'] as const);

describe('collab.db-outage.chaos [hp:HP-1] [hp:HP-5]', () => {
  it.each(failures)(
    'retains every unsaved edit and bounds pools through a thirty-second %s database outage',
    async (kind) => {
      const provided = inject('iridiumToxiproxy');
      const proxy = connectToxiproxy(provided.controlUrl).proxy(
        MYSQL_PROXY_NAME,
        provided.mysqlProxy.host,
        provided.mysqlProxy.port,
      );
      const harness = await startCollab({
        mode: 'child',
        db: {
          ...provided.mysqlProxy,
          schema: workerSchemaName(process.env['VITEST_WORKER_ID'] ?? '1'),
        },
      });
      let toxic: ToxicHandle | undefined;
      let phase = 'boot';
      try {
        await harness.server.waitReady();
        phase = 'seed';
        const cast = await harness.server.seed.kernel();
        phase = 'initial connected baseline';
        const clients = await Promise.all(
          [cast.editorA, cast.editorB, cast.editorC].map((user) =>
            harness.open(user, cast.note.id, { flushDelayMs: false }),
          ),
        );
        const before = await expectConverged(harness, cast.note.id, clients);
        const ackCounts = clients.map(persistedCount);
        const identities = clients.map((client) => ({ document: client.ydoc, undo: client.undo }));
        const markers: string[] = [];
        phase = 'arm database fault';
        if (kind === 'disabled') await proxy.setEnabled(false);
        else
          toxic = await withDeadline(
            proxy.addToxic(
              kind === 'reset_peer'
                ? TOXIC.resetPeer()
                : TOXIC.timeout(kind === 'timeout' ? 5_000 : 0),
            ),
            { timeoutMs: 5_000, description: 'install the database fault' },
          );
        phase = 'edit throughout the outage';
        const began = Date.now();
        // Explicit workload pacing: edits continue throughout the actual 30 s outage.
        for (let tick = 0; tick < 60; tick++) {
          clients.forEach((client, index) =>
            markers.push(client.marker(`outage-${String(index)}-${String(tick)}`)),
          );
          // eslint-disable-next-line no-await-in-loop -- sustain two real edits per second per editor while the database is unreachable
          await expect
            .poll(() => Date.now() - began, { timeout: 2_000, interval: 25 })
            .toBeGreaterThanOrEqual((tick + 1) * 500);
          expect(clients.map(persistedCount)).toEqual(ackCounts);
          expect(clients.every((client) => client.saveState !== 'saved')).toBe(true);
        }
        phase = 'local save-failed notification';
        await expect
          .poll(
            () =>
              clients.every(
                (client) =>
                  client.saveState === 'save-failed' ||
                  client.closes[0]?.collabReason === 'no-owner-lease',
              ),
            { timeout: 15_000 },
          )
          .toBe(true);
        phase = 'healthz response';
        expect(
          (
            await harness.server
              .rest()
              .request('GET', '/healthz', { signal: AbortSignal.timeout(5_000) })
          ).status,
        ).toBe(200);
        phase = 'readyz response';
        expect(
          (
            await harness.server
              .rest()
              .request('GET', '/readyz', { signal: AbortSignal.timeout(60_000) })
          ).status,
        ).toBe(503);
        phase = 'metrics response';
        const metrics = await withDeadline(harness.server.metrics(), {
          timeoutMs: 30_000,
          description: 'outage metrics response',
        });
        const ownershipLost = harness.logs.some((line) =>
          line.includes('"event":"collab.owner_lease.lost"'),
        );
        // The ownership-loss exception closes the established socket explicitly and discards only
        // the former server lifetime. Pending updates and undo stay in each original client.
        expect(clients.map((client) => client.closes[0]?.code ?? null)).toEqual(
          clients.map(() => (ownershipLost ? 4503 : null)),
        );
        expect(clients.map((client) => client.closes[0]?.collabReason ?? null)).toEqual(
          clients.map(() => (ownershipLost ? 'no-owner-lease' : null)),
        );
        await expect
          .poll(
            async () => {
              const settled = await harness.server.metrics();
              const queue = settled['iridium_persist_queue_depth'] ?? -1;
              const documents = settled['iridium_docs_loaded'] ?? -1;
              return ownershipLost ? queue === 0 && documents === 0 : queue > 0 && documents >= 1;
            },
            { timeout: 15_000 },
          )
          .toBe(true);
        clients.forEach((client, index) => {
          expect(client.ydoc).toBe(identities[index]?.document);
          expect(client.undo).toBe(identities[index]?.undo);
          expect(warnsBeforeUnload(client.session.input)).toBe(true);
        });
        for (const pool of ['app', 'persist']) {
          expect(metrics[`iridium_db_pool_in_use{pool="${pool}"}`]).toBeLessThanOrEqual(
            metrics[`iridium_db_pool_size{pool="${pool}"}`] ?? 0,
          );
        }
        phase = 'unproxied committed-prefix observation';
        expect(harness.server.lastExit).toBeNull();
        expect((await harness.committed(cast.note.id)).head).toBe(before.head);
        expect(
          [...harness.server.stderr, ...harness.logs].some((line) =>
            /unhandledRejection|unhandled rejection|Unhandled 'error' event/i.test(line),
          ),
        ).toBe(false);
        phase = 'restore database';
        await toxic?.remove();
        toxic = undefined;
        await proxy.setEnabled(true);
        phase = 'connected recovery';
        try {
          // CH-6: an intact owner drains within 30 s. Losing ownership invokes the documented
          // 60 s document / 30 s socket retry ladders, plus readiness and handshake/COMMIT work.
          // The 75 s bound includes one 5 s readiness tick and 10 s for admission and durable save.
          const recoveryTimeoutMs = ownershipLost ? 75_000 : 30_000;
          await Promise.all(
            clients.map((client) => client.waitFor('saved', { timeoutMs: recoveryTimeoutMs })),
          );
        } catch (cause) {
          throw new Error(
            `Recovery after ${kind}: ${JSON.stringify({
              clients: clients.map((client) => ({
                userId: client.userId,
                state: client.saveState,
                input: client.session.input,
                states: client.states,
                closes: client.closes,
                authenticated: client.provider?.isAuthenticated,
                synced: client.provider?.synced,
                unsynced: client.provider?.unsyncedChanges,
                stateless: client.stateless.slice(-8),
              })),
              durable: await harness.committed(cast.note.id),
              logs: harness.logs.slice(-20),
            })}`,
            { cause },
          );
        }
        const recovered = await expectConverged(harness, cast.note.id, clients);
        clients.forEach((client, index) => {
          expect(client.ydoc).toBe(identities[index]?.document);
          expect(client.undo).toBe(identities[index]?.undo);
        });
        for (const marker of markers) expect(recovered.text.split(marker)).toHaveLength(2);
        expect(recovered.head - before.head).toBeGreaterThan(0);
        expect(recovered.head - before.head).toBeLessThanOrEqual(markers.length);
        await harness.server.waitReady({ timeoutMs: 30_000 });
        expect(harness.server.lastExit).toBeNull();
        await Promise.all(clients.map((client) => client.close()));
        phase = 'fresh process recovery';
        await harness.server.kill('SIGKILL');
        await harness.server.restart();
        const fresh = await harness.open(cast.editorA, cast.note.id);
        expect((await expectConverged(harness, cast.note.id, [fresh])).text).toBe(recovered.text);
      } catch (cause) {
        throw new Error(
          `Database outage ${kind} failed during ${phase}: ${JSON.stringify({
            lastExit: harness.server.lastExit,
            stderr: harness.server.stderr,
            logs: harness.logs.slice(-80),
          })}`,
          { cause },
        );
      } finally {
        await toxic?.remove();
        // A failed control request may install its toxic before its HTTP response times out.
        await proxy.removeAllToxics();
        await proxy.setEnabled(true);
        await harness.close();
      }
    },
    180_000,
  );
});
