/** A surviving writer reconciles a durable MySQL transaction whose successful result was discarded. */
import { NoteId } from '@iridium/contracts';
import { dominates, stateVector } from '@iridium/crdt';
import { describe, expect, it } from 'vitest';

import { idBytes } from '../../src/auth/ids.ts';
import { startCollab } from '../support/collab-harness.ts';
import { ManualClock } from '../support/manual-clock.ts';

describe('collab.commit-reconcile.integration [hp:HP-2]', () => {
  it('keeps the process and owner alive, reconciles the committed prefix, and acknowledges later edits separately', async () => {
    const clock = new ManualClock(Date.now());
    const harness = await startCollab({
      clock,
      collab: { debounceMs: 60_000, maxDebounceMs: 60_000 },
    });
    try {
      const cast = await harness.server.seed.kernel();
      const noteId = NoteId.parse(cast.note.id);
      const client = await harness.open(cast.editorA, noteId);
      await client.waitFor('saved');
      const app = harness.application();
      const writer = app.collab.persistence.writerOf(noteId);
      const db = app.database.dbApp;
      if (writer === undefined || db === null)
        throw new Error('A live writer and real database are required.');
      const fence = app.collab.ownerLease.captureFence();
      const before = writer.lastCommittedSeq;
      const seen = client.stateless.length;
      // The real transaction commits first. This fault drops its successful result at the writer
      // boundary, not a MySQL wire packet, and leaves the process and owner generation alive.
      app.faults.arm({ point: 'store.throw-after-commit-before-ack' });
      const failed = client.waitForStateless('persist-failed');
      const first = client.marker('commit-result-lost');
      const firstVector = stateVector(client.ydoc);
      expect(await failed).toMatchObject({ reason: 'db_unavailable', seq: before + 1 });
      expect(writer.state).toBe('retrying');
      expect(writer.lastCommittedSeq).toBe(before);
      expect(client.stateless.slice(seen).filter((message) => message.t === 'persisted')).toEqual(
        [],
      );
      const committed = await harness.committed(noteId);
      expect(committed.head).toBe(before + 1);
      expect(committed.text).toContain(first);
      const durableRow = await db
        .selectFrom('note_updates')
        .selectAll()
        .where('note_id', '=', idBytes(noteId))
        .where('seq', '=', before + 1)
        .executeTakeFirstOrThrow();
      const second = client.marker('after-lost-result');
      await expect.poll(() => writer.queueLength).toBe(2);
      await clock.advance(200);
      await client.waitFor('saved');
      const acknowledgements = client.stateless
        .slice(seen)
        .filter((message) => message.t === 'persisted');
      expect(acknowledgements.map((message) => message.seq)).toEqual([before + 1, before + 2]);
      expect(acknowledgements[0]?.sv).toBe(Buffer.from(firstVector).toString('base64'));
      expect(dominates(firstVector, stateVector(client.ydoc))).toBe(false);
      const after = await harness.committed(noteId);
      expect(after.head).toBe(before + 2);
      expect(after.text).toContain(first);
      expect(after.text).toContain(second);
      expect(after.text.split(first)).toHaveLength(2);
      expect(after.text.split(second)).toHaveLength(2);
      expect(
        await db
          .selectFrom('note_updates')
          .selectAll()
          .where('note_id', '=', idBytes(noteId))
          .where('seq', '=', before + 1)
          .executeTakeFirstOrThrow(),
      ).toEqual(durableRow);
      expect(app.collab.persistence.writerOf(noteId)).toBe(writer);
      expect(writer.state).toBe('idle');
      expect(() => fence.assertActive()).not.toThrow();
      expect(client.closes).toEqual([]);
      expect(harness.logs.some((line) => line.includes('persist.cas_mismatch'))).toBe(false);
    } finally {
      await harness.close();
    }
  }, 60_000);
});
