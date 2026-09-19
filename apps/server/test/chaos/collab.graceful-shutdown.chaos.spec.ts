import type { ReadyzBody } from '@iridium/contracts';
import { decodeStateVector, dominates, stateVector } from '@iridium/crdt';
import {
  startServer,
  startTestEnv,
  type NoteClient,
  type TestEnv,
  type TestServer,
} from '@iridium/testkit';
import { createConnection } from 'mysql2/promise';
import { describe, expect, it } from 'vitest';

import { asStateVector } from '../../src/collab/persistence/testing/bytes.ts';
import { NIGHTLY_CHAOS, persistedCount } from '../support/collab-chaos.ts';
import { readCommittedNote } from '../support/collab-harness.ts';

// The production image runs a real Linux process, so SIGTERM invokes the shipped signal handler on
// Windows hosts too. A real row lock provides a pending-write boundary without enabling test faults.
describe('collab.graceful-shutdown.chaos [hp:HP-2]', () => {
  it('announces shutdown, fails readiness, drains dirty notes, and exits zero before a fresh recovery', async () => {
    let env: TestEnv | undefined;
    let server: TestServer | undefined;
    const clients: NoteClient[] = [];
    let lock: Awaited<ReturnType<typeof createConnection>> | undefined;
    try {
      env = await startTestEnv({ productionCredentials: true });
      server = await startServer({
        mode: 'container',
        db: { ...env.mysql, schema: env.mysql.templateSchema },
        extraEnv: { ...env.serverEnv, LOG_LEVEL: 'info' },
      });
      await server.waitReady();
      const cast = await server.seed.kernel();
      const second = await server.seed.note({
        vault: cast.vault,
        name: 'Second dirty note',
        markdown: 'second\n',
      });
      clients.push(
        ...(await Promise.all(
          [
            [cast.editorA, cast.note],
            [cast.editorB, cast.note],
            [cast.editorC, second],
          ].map(async ([user, note]) => {
            if (
              user === undefined ||
              note === undefined ||
              !('email' in user) ||
              !('markdown' in note)
            )
              throw new Error('The shutdown cast needs a user and a note.');
            return server!.client(user, note.id, { flushDelayMs: false });
          }),
        )),
      );
      await Promise.all(clients.map((client) => client.waitFor('saved')));
      clients.forEach((client, index) => client.marker(`checkpoint-prime-${String(index)}`));
      await Promise.all(clients.map((client) => client.waitFor('saved')));
      const projected = [clients[0], clients[2]].map((client) => {
        if (client === undefined) throw new Error('Each note needs its checkpoint producer.');
        const promise = client.waitForStateless('projected');
        client.sendStateless({ v: 1, t: 'flush' });
        return promise;
      });
      await Promise.all(projected);
      lock = await createConnection(env.mysql.rootUri);
      await lock.beginTransaction();
      await lock.query(
        `SELECT head_seq FROM ${server.schema}.note_docs WHERE note_id IN (UNHEX(?),UNHEX(?)) FOR UPDATE`,
        [cast.note.id.replaceAll('-', ''), second.id.replaceAll('-', '')],
      );
      const closing = clients.map((client) => client.waitForStateless('closing'));
      const markers = clients.map((client, index) => client.marker(`shutdown-${String(index)}`));
      await expect
        .poll(async () => (await server!.metrics())['iridium_persist_queue_depth'])
        .toBeGreaterThan(0);
      const began = Date.now();
      const stopped = server.kill('SIGTERM');
      const notices = await Promise.all(closing);
      expect(
        notices.every((message) => message.reason === 'shutdown' && message.graceMs === 2_000),
      ).toBe(true);
      expect((await server.rest().request('GET', '/readyz')).status).toBe(503);
      await lock.commit();
      await lock.end();
      lock = undefined;
      await stopped;
      expect(Date.now() - began).toBeLessThan(20_000);
      expect(server.lastExit).toEqual({ code: 0, signal: null });
      const firstDurable = await readCommittedNote(env.admin, server.schema, cast.note.id);
      const secondDurable = await readCommittedNote(env.admin, server.schema, second.id);
      expect(firstDurable.text).toContain(markers[0]);
      expect(firstDurable.text).toContain(markers[1]);
      expect(secondDurable.text).toContain(markers[2]);
      const checkpoints = await Promise.all(
        [
          [cast.note, firstDurable],
          [second, secondDurable],
        ].map(async ([note, durable]) => {
          if (
            note === undefined ||
            durable === undefined ||
            !('id' in note) ||
            !('head' in durable)
          )
            throw new Error('Each note needs its durable head.');
          return env!.admin.rows(
            `SELECT kind FROM ${server!.schema}.note_revisions WHERE note_id=UNHEX('${note.id.replaceAll('-', '')}') AND seq=${String(durable.head)};`,
          );
        }),
      );
      expect(checkpoints).toEqual([[['unload']], [['unload']]]);
      await Promise.all(clients.map((client) => client.close()));
      await server.restart();
      const fresh = await Promise.all(
        [cast.note, second].map((note) => server!.client(cast.editorA, note.id)),
      );
      clients.push(...fresh);
      await Promise.all(fresh.map((client) => client.waitFor('saved')));
      expect(fresh.map((client) => client.text.toJSON())).toEqual([
        firstDurable.text,
        secondDurable.text,
      ]);
      for (const marker of markers)
        expect(
          fresh
            .map((client) => client.text.toJSON())
            .join('')
            .split(marker),
        ).toHaveLength(2);
    } finally {
      await lock?.rollback();
      await lock?.end();
      await Promise.all(clients.map((client) => client.close()));
      await server?.stop();
      await env?.stop();
    }
  }, 180_000);

  it.skipIf(!NIGHTLY_CHAOS).each([
    {
      name: 'exits one at the real drain deadline with undrained note ids while live-owner persistence stays blocked',
      blockage: 'row-lock',
      minimumElapsedMs: 19_000,
    },
    {
      name: 'exits one without a clean drain after database loss retires its captured writers',
      blockage: 'database-unavailable',
      minimumElapsedMs: 0,
    },
  ] as const)(
    '$name',
    async ({ blockage, minimumElapsedMs }) => {
      const env = await startTestEnv({ productionCredentials: true, toxiproxy: true });
      const proxy = env.mysqlViaToxiproxy;
      if (proxy === undefined)
        throw new Error('The negative drain cases require their real MySQL proxy.');
      let server: TestServer | undefined;
      let lock: Awaited<ReturnType<typeof createConnection>> | undefined;
      const clients: NoteClient[] = [];
      try {
        server = await startServer({
          mode: 'container',
          db: {
            ...env.mysql,
            host: proxy.host,
            port: proxy.port,
            schema: env.mysql.templateSchema,
          },
          extraEnv: { ...env.serverEnv, LOG_LEVEL: 'info' },
        });
        await server.waitReady();
        const cast = await server.seed.kernel();
        const editor = await server.client(cast.editorA, cast.note.id, { flushDelayMs: false });
        clients.push(editor);
        await editor.waitFor('saved');
        const before = await readCommittedNote(env.admin, server.schema, cast.note.id);
        const acknowledgements = persistedCount(editor);
        if (blockage === 'row-lock') {
          // Keep the owner lease live while its real persistence statement cannot complete. This
          // independently proves the hard deadline, rather than waiting after a known ownership loss.
          lock = await createConnection(env.mysql.rootUri);
          await lock.beginTransaction();
          await lock.query(
            `SELECT head_seq FROM ${server.schema}.note_docs WHERE note_id=UNHEX(?) FOR UPDATE`,
            [cast.note.id.replaceAll('-', '')],
          );
        } else {
          await proxy.setEnabled(false);
        }
        const failed =
          blockage === 'database-unavailable'
            ? editor.waitForStateless('persist-failed')
            : Promise.resolve();
        const marker = editor.marker('never-acknowledged-during-shutdown');
        const pendingVector = stateVector(editor.ydoc);
        const observedAcknowledgements = () =>
          editor.stateless
            .filter((message) => message.t === 'persisted')
            .slice(acknowledgements)
            .map((message) => {
              const vector = decodeStateVector(asStateVector(Buffer.from(message.sv, 'base64')));
              return {
                seq: message.seq,
                alreadyCommitted: dominates(before.sv, vector),
                coversPending: dominates(vector, pendingVector),
              };
            });
        const assertUnacknowledged = () => {
          const observed = observedAcknowledgements();
          // A repeated pre-fault baseline is valid. A new seq or vector covering the pending edit is not.
          expect(
            observed.every(
              (ack) => ack.seq === before.head && ack.alreadyCommitted && !ack.coversPending,
            ),
          ).toBe(true);
          expect(editor.saveState).not.toBe('saved');
        };
        await expect
          .poll(async () => (await server!.metrics())['iridium_persist_queue_depth'])
          .toBeGreaterThan(0);
        await failed;
        assertUnacknowledged();
        const notice = editor.waitForStateless('closing');
        const began = Date.now();
        const stopped = server.kill('SIGTERM').then(
          () => null,
          (error: unknown) => error,
        );
        expect(await notice).toMatchObject({ reason: 'shutdown', graceMs: 2_000 });
        const readiness = await server.rest().request<ReadyzBody>('GET', '/readyz');
        expect(readiness.status).toBe(503);
        expect(
          readiness.body.checks.find((check) => check.name === 'collab_owner_lease')?.status,
        ).toBe(blockage === 'row-lock' ? 'ok' : 'fail');
        const stoppedOutcome = await stopped;
        const elapsedMs = Date.now() - began;
        const events = [...server.stdout, ...server.stderr]
          .flatMap((chunk) => chunk.split('\n'))
          .flatMap((line) => {
            try {
              const value: unknown = JSON.parse(line);
              return typeof value === 'object' && value !== null && 'event' in value ? [value] : [];
            } catch {
              return [];
            }
          });
        console.info(
          'CH8 negative drain observation',
          JSON.stringify({
            blockage,
            exit: server.lastExit,
            elapsedMs,
            rejected: stoppedOutcome instanceof Error,
            receivedAcknowledgements: observedAcknowledgements(),
            events: events.filter(
              (event) =>
                typeof event.event === 'string' &&
                /shutdown\.|owner_lease|persist\.drain_timeout/.test(event.event),
            ),
          }),
        );
        expect(stoppedOutcome).toBeInstanceOf(Error);
        expect(server.lastExit).toEqual({ code: 1, signal: null });
        expect(elapsedMs).toBeGreaterThanOrEqual(minimumElapsedMs);
        expect(elapsedMs).toBeLessThan(25_000);
        expect(events.some((event) => event.event === 'shutdown.drained')).toBe(false);
        expect(events.some((event) => event.event === 'collab.owner_lease.lost')).toBe(
          blockage === 'database-unavailable',
        );
        expect(
          events.some(
            (event) =>
              event.event === 'persist.drain_timeout' &&
              'level' in event &&
              event.level === 'error' &&
              JSON.stringify(event).includes(cast.note.id) &&
              JSON.stringify(event).includes('undrained'),
          ),
        ).toBe(true);
        assertUnacknowledged();
        expect(editor.text.toJSON()).toContain(marker);
        await editor.close();
        await lock?.rollback();
        await lock?.end();
        lock = undefined;
        await proxy.setEnabled(true);
        const after = await readCommittedNote(env.admin, server.schema, cast.note.id);
        expect(after.head).toBe(before.head);
        expect(after.text).toBe(before.text);
        await server.restart();
        const fresh = await server.client(cast.editorB, cast.note.id);
        clients.push(fresh);
        await fresh.waitFor('saved');
        expect(fresh.text.toJSON()).toBe(before.text);
        expect(fresh.text.toJSON()).not.toContain(marker);
      } finally {
        await lock?.rollback();
        await lock?.end();
        await proxy.setEnabled(true);
        await Promise.all(clients.map((client) => client.close()));
        await server?.stop();
        await env.stop();
      }
    },
    180_000,
  );
});
