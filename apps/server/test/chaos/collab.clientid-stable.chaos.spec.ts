import { LIMITS } from '@iridium/contracts';
import { decodeStateVector, stateVector } from '@iridium/crdt';
import { describe, expect, it } from 'vitest';

import { expectConverged, startCollab } from '../support/collab-harness.ts';

describe('collab.clientid-stable.chaos [hp:HP-1] [area:collab] [hp:HP-2]', () => {
  it('retains client clocks, durable whole-vector saved, and per-user undo through continuous compaction and reconnect', async () => {
    const harness = await startCollab({ mode: 'child' });
    try {
      await harness.server.waitReady();
      const cast = await harness.server.seed.kernel();
      const clients = await Promise.all(
        [cast.editorA, cast.editorB].map((user) =>
          harness.open(user, cast.note.id, { flushDelayMs: false }),
        ),
      );
      await expectConverged(harness, cast.note.id, clients);
      const originalIds = clients.map((client) => client.clientId);
      clients.forEach((client, index) => client.marker(`initial-${String(index)}`));
      await expectConverged(harness, cast.note.id, clients);
      const started = Date.now();
      let iteration = 0;
      while (Date.now() - started <= LIMITS.COMPACTION_MAX_DEBOUNCE_MS + 1_000) {
        const editor = clients[iteration % clients.length];
        if (editor === undefined)
          throw new Error('The continuous-edit experiment requires two users.');
        editor.marker(`spike-${String(iteration)}`);
        // eslint-disable-next-line no-await-in-loop -- each acknowledgement independently proves whole-vector saved
        await expectConverged(harness, cast.note.id, clients);
        expect(clients.map((client) => client.clientId)).toEqual(originalIds);
        for (const client of clients) {
          expect(decodeStateVector(stateVector(client.ydoc)).has(client.clientId)).toBe(true);
          expect(client.provider?.awareness?.getStates().get(client.clientId)).toMatchObject({
            user: { id: client.userId },
          });
        }
        iteration += 1;
        // This is an explicit paced workload, not a timing guess: sustain edits past maxDebounce
        // without consuming the protocol's independent 200/10s budget.
        // eslint-disable-next-line no-await-in-loop -- the next real-time workload slot follows this one
        await expect
          .poll(() => Date.now() - started, { timeout: 2_000, interval: 50 })
          .toBeGreaterThanOrEqual(iteration * 250);
      }
      expect((await harness.committed(cast.note.id)).snapshotThrough).toBeGreaterThan(1);
      const [first, second] = clients;
      if (first === undefined || second === undefined) throw new Error('Both editors must remain.');
      first.undo.stopCapturing();
      second.undo.stopCapturing();
      const firstMarker = first.marker('undo-first');
      await expectConverged(harness, cast.note.id, clients);
      const secondMarker = second.marker('undo-second');
      await expectConverged(harness, cast.note.id, clients);
      first.undo.undo();
      const undone = await expectConverged(harness, cast.note.id, clients);
      expect(undone.text).not.toContain(firstMarker);
      expect(undone.text).toContain(secondMarker);
      await harness.server.restart();
      await expectConverged(harness, cast.note.id, clients);
      expect(clients.map((client) => client.clientId)).toEqual(originalIds);
      const final = await harness.committed(cast.note.id);
      for (const user of [cast.editorA, cast.editorB]) {
        expect(
          final.updates.some((row) => row.actorId.toLowerCase() === user.id.replaceAll('-', '')),
        ).toBe(true);
      }
    } finally {
      await harness.close();
    }
  }, 90_000);
});
