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
        const slow = await harness.server.faults.arm(FAULT.storeSlow, { arg: 5_000 });
        const logStart = harness.logs.length;
        const first = clients[0];
        if (first === undefined) throw new Error('The writer needs an attached producer.');
        first.marker('queue-hold');
        await waitFault(harness, FAULT.storeSlow, logStart);
        const failures = clients.map((client) =>
          client.waitForStateless('persist-failed', { timeoutMs: 15_000 }).then((message) => ({
            message,
            stateAtRefusal: client.saveState,
          })),
        );
        const markers: string[] = [];
        clients.forEach((client, index) => {
          for (let update = 0; update < 175; update++)
            markers.push(client.marker(`queue-${String(index)}`));
        });
        const messages = await Promise.all(failures);
        expect(
          messages.every(
            ({ message }) => message.reason === 'backpressure' && message.retryInMs > 0,
          ),
        ).toBe(true);
        expect(messages.every(({ stateAtRefusal }) => stateAtRefusal !== 'saved')).toBe(true);
        const events = harness.logs.flatMap((line) => {
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
        // Already-entered delays still hold this queue while another writer gets its own pool slot.
        await slow.disarm();
        const started = Date.now();
        const fairMarker = fair.marker('fair-through-pressure');
        await fair.waitFor('saved', { timeoutMs: 2_000 });
        expect(Date.now() - started).toBeLessThan(2_000);
        expect((await harness.committed(independent.id)).text).toContain(fairMarker);
        await Promise.all(clients.map((client) => client.waitFor('saved', { timeoutMs: 30_000 })));
        const recovered = await expectConverged(harness, cast.note.id, clients);
        for (const marker of [...markers, rejected])
          expect(recovered.text.split(marker)).toHaveLength(2);
        expect(clients.every((client) => client.session.input.persistFailed === null)).toBe(true);
        expect((await harness.server.metrics())['iridium_persist_queue_depth']).toBe(0);
        expect(harness.logs.some((line) => line.includes('persist.cas_mismatch'))).toBe(false);
      } finally {
        await harness.close();
      }
    }, 180_000);
  },
);
