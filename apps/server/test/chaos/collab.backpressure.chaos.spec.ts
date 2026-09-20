import { LIMITS } from '@iridium/contracts';
import { FAULT } from '@iridium/testkit';
import { describe, expect, it } from 'vitest';

import { ROUTINE_ITERATIONS, waitFault } from '../support/collab-chaos.ts';
import { expectConverged, startCollab } from '../support/collab-harness.ts';

describe.each(Array.from({ length: ROUTINE_ITERATIONS }, (_, index) => index))(
  'collab.backpressure.chaos [hp:HP-5] iteration %i',
  () => {
    it('bounds a real five-thousand-update queue, refuses all senders, preserves pending edits, and keeps another writer healthy', async () => {
      const harness = await startCollab({ mode: 'child' });
      const unsubscribe: (() => void)[] = [];
      try {
        await harness.server.waitReady();
        const cast = await harness.server.seed.kernel();
        const independent = await harness.server.seed.note({
          vault: cast.vault,
          name: 'Fair writer',
          markdown: 'unrelated\n',
        });
        // 30 attachments stay below all real user/IP caps and send <200 frames each per 10 s.
        const clients = await Promise.all(
          [cast.editorA, cast.editorB, cast.editorC].flatMap((user) =>
            Array.from({ length: 10 }, () =>
              harness.open(user, cast.note.id, { flushDelayMs: false }),
            ),
          ),
        );
        const fair = await harness.open(cast.admin, independent.id, {
          role: 'manager',
          flushDelayMs: false,
        });
        await expectConverged(harness, cast.note.id, clients);
        await fair.waitFor('saved');
        const held = await harness.server.faults.arm(FAULT.storeHoldBeforeCommit);
        const logStart = harness.logs.length;
        const first = clients[0];
        if (first === undefined) throw new Error('The writer needs an attached producer.');
        first.marker('queue-hold');
        await waitFault(harness, FAULT.storeHoldBeforeCommit, logStart);
        const refusalStates = new Map<number, string>();
        clients.forEach((client, index) => {
          const provider = client.provider;
          if (provider === null) throw new Error('Every producer must be attached.');
          // The product folds stateless input before this observer. A snapshot subscription alone
          // can miss this event when the dominance deadline already made the state save-failed.
          const recordRefusal = (): void => {
            if (client.session.input.persistFailed !== null && !refusalStates.has(index)) {
              refusalStates.set(index, client.saveState);
            }
          };
          provider.on('stateless', recordRefusal);
          unsubscribe.push(() => provider.off('stateless', recordRefusal));
        });
        const markers: string[] = [];
        clients.forEach((client, index) => {
          for (let update = 0; update < 175; update++)
            markers.push(client.marker(`queue-${String(index)}`));
        });
        const backpressureEvents = (): unknown[] =>
          harness.logs.flatMap((line) => {
            try {
              const value: unknown = JSON.parse(line);
              return typeof value === 'object' &&
                value !== null &&
                'event' in value &&
                value.event === 'persist.backpressure'
                ? [value]
                : [];
            } catch {
              return [];
            }
          });
        let phase = 'fill the held queue';
        try {
          // Producing and broadcasting 5,250 real updates is setup for the refusal oracle.
          // Start its 15 s delivery deadline only after the server has crossed the queue bound.
          // Child stdout and WebSocket delivery are independent; either may arrive first.
          await expect.poll(() => backpressureEvents().length > 0, { timeout: 60_000 }).toBe(true);
          phase = 'deliver every refusal';
          await expect
            .poll(
              () =>
                clients.every((client) =>
                  client.stateless.some((message) => message.t === 'persist-failed'),
                ),
              { timeout: 15_000 },
            )
            .toBe(true);
        } catch (error) {
          console.error('Backpressure observation failed', {
            phase,
            clients: clients.map((client) => ({
              state: client.saveState,
              unsynced: client.provider?.unsyncedChanges,
              failures: client.stateless.filter((message) => message.t === 'persist-failed'),
              closes: client.closes,
            })),
            metrics: await harness.server
              .metrics()
              .catch((cause: unknown) => ({ error: String(cause) })),
            events: harness.logs
              .filter((line) => /persist\.|fault\.|rate.limit/.test(line))
              .slice(-20),
          });
          throw error;
        }
        const messages = clients.map((client, index) => {
          const message = client.stateless.find((item) => item.t === 'persist-failed');
          if (message === undefined) throw new Error('The observed refusal must be retained.');
          return { message, stateAtRefusal: refusalStates.get(index) };
        });
        expect(
          messages.every(
            ({ message }) => message.reason === 'backpressure' && message.retryInMs > 0,
          ),
        ).toBe(true);
        expect(
          messages.every(
            ({ stateAtRefusal }) => stateAtRefusal !== undefined && stateAtRefusal !== 'saved',
          ),
        ).toBe(true);
        const events = backpressureEvents();
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ queued: LIMITS.WRITER_QUEUE_MAX_UPDATES + 1 });
        const metrics = await harness.server.metrics();
        expect(metrics['iridium_persist_queue_depth']).toBeLessThanOrEqual(
          LIMITS.WRITER_QUEUE_MAX_UPDATES + 1,
        );
        expect(metrics['iridium_persist_queue_depth']).toBeGreaterThan(0);
        // A refused edit stays local until the role-restoration sync replays it.
        const rejected = first.marker('pressure-rejected');
        expect(first.provider?.unsyncedChanges).toBeGreaterThan(0);
        // The one-shot hold keeps this queue full while another writer gets its own pool slot.
        const started = Date.now();
        const fairMarker = fair.marker('fair-through-pressure');
        await fair.waitFor('saved', { timeoutMs: 2_000 });
        expect(Date.now() - started).toBeLessThan(2_000);
        expect((await harness.committed(independent.id)).text).toContain(fairMarker);
        await held.disarm();
        await Promise.all(clients.map((client) => client.waitFor('saved', { timeoutMs: 30_000 })));
        const recovered = await expectConverged(harness, cast.note.id, clients);
        for (const marker of [...markers, rejected])
          expect(recovered.text.split(marker)).toHaveLength(2);
        expect(clients.every((client) => client.session.input.persistFailed === null)).toBe(true);
        expect((await harness.server.metrics())['iridium_persist_queue_depth']).toBe(0);
        expect(harness.logs.some((line) => line.includes('persist.cas_mismatch'))).toBe(false);
      } finally {
        for (const off of unsubscribe) off();
        await harness.server.faults.disarmAll();
        await harness.close();
      }
    }, 180_000);
  },
);
