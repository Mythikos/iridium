/** A slow real COMMIT followed by a queued update must never resurrect a trashed note (I-10). */
import { createHash } from 'node:crypto';

import { NoteId, type TrashNodeResult } from '@iridium/contracts';
import { createNoteDoc, loadState, LOAD_ORIGIN, projectMarkdown } from '@iridium/crdt';
import { describe, expect, it } from 'vitest';

import { idBytes } from '../../src/auth/ids.ts';
import { CLOSING_GRACE_MS } from '../../src/collab/gateway.ts';
import { startCollab } from '../support/collab-harness.ts';
import { ManualClock } from '../support/manual-clock.ts';

const SLOW_COMMIT_MS = 5_000;

describe('collab.trash-during-write.integration [hp:HP-2]', () => {
  it('commits the locked prefix, drops the later batch, and unloads with the exact trash checkpoint', async () => {
    const clock = new ManualClock(Date.now());
    const harness = await startCollab({
      clock,
      extraEnv: { JOBS_ENABLED: 'false' },
      collab: { debounceMs: 60_000, maxDebounceMs: 60_000 },
    });
    let trashRequest: Promise<unknown> | undefined;
    try {
      const cast = await harness.server.seed.kernel();
      const noteId = NoteId.parse(cast.note.id);
      const [first, second] = await Promise.all([
        harness.open(cast.editorA, noteId),
        harness.open(cast.editorB, noteId),
      ]);
      await Promise.all([first.waitFor('saved'), second.waitFor('saved')]);
      const app = harness.application();
      const db = app.database.dbApp;
      const writer = app.collab.persistence.writerOf(noteId);
      if (db === null || writer === undefined)
        throw new Error('The connected note must own its real database and writer.');
      const initial = await harness.committed(noteId);
      app.faults.arm({ point: 'store.slow', arg: SLOW_COMMIT_MS });
      const committedMarker = first.marker('committing-before-trash');
      await expect
        .poll(() =>
          harness.logs.some((line) => line.includes('fault.fired') && line.includes('store.slow')),
        )
        .toBe(true);
      await expect.poll(() => second.text.toJSON().includes(committedMarker)).toBe(true);
      const acceptedPrefix = second.text.toJSON();
      const rejectedMarker = second.marker('queued-after-slow-commit');
      await expect
        .poll(() => first.text.toJSON().includes(rejectedMarker) && writer.queueLength >= 2)
        .toBe(true);
      expect((await harness.committed(noteId)).head).toBe(initial.head);

      const trash = cast.admin.client.post<TrashNodeResult>(`/nodes/${noteId}/trash`, {
        ifMatch: 1,
        json: {},
      });
      trashRequest = trash;
      await expect.poll(() => app.collab.gateway.isClosing(noteId)).toBe(true);
      // Observe the actual InnoDB wait, so trash is ordered ahead of the queued batch without sleeps.
      await expect
        .poll(async () => {
          const rows = await harness.sql.rows(
            `SELECT COUNT(*) FROM performance_schema.data_lock_waits AS waiting JOIN performance_schema.data_locks AS requested ON requested.ENGINE_LOCK_ID = waiting.REQUESTING_ENGINE_LOCK_ID WHERE requested.OBJECT_SCHEMA = '${harness.server.schema}' AND requested.OBJECT_NAME = 'nodes'`,
          );
          return Number(rows[0]?.[0] ?? 0);
        })
        .toBeGreaterThan(0);
      await clock.advance(SLOW_COMMIT_MS);
      await expect.poll(() => writer.state).toBe('trashed');
      expect(writer.queueLength).toBe(0);
      expect(writer.lastCommittedSeq).toBe(initial.head + 1);
      app.faults.arm({ point: 'store.slow', count: 0 });

      const checkpoint = await db
        .selectFrom('note_revisions')
        .select(['seq', 'markdown', 'content_hash', 'snapshot'])
        .where('note_id', '=', idBytes(noteId))
        .where('kind', '=', 'trash')
        .executeTakeFirstOrThrow();
      expect(checkpoint.seq).toBe(writer.lastCommittedSeq);
      expect(checkpoint.markdown).toBe(acceptedPrefix);
      expect(checkpoint.content_hash).toEqual(createHash('sha256').update(acceptedPrefix).digest());
      expect(checkpoint.markdown).not.toContain(rejectedMarker);
      if (checkpoint.snapshot === null)
        throw new Error('The trash checkpoint must retain its binary state.');
      const checkpointDoc = createNoteDoc({ gc: true });
      try {
        loadState(checkpointDoc, checkpoint.snapshot, 2, LOAD_ORIGIN);
        expect(projectMarkdown(checkpointDoc)).toBe(acceptedPrefix);
      } finally {
        checkpointDoc.destroy();
      }
      await clock.advance(CLOSING_GRACE_MS);
      expect((await trash).status).toBe(200);
      await expect
        .poll(() => app.collab.persistence.writerOf(noteId), { timeout: 15_000 })
        .toBeUndefined();
      expect(writer.state).toBe('disposed');
      const durable = await harness.committed(noteId);
      expect(durable.head).toBe(checkpoint.seq);
      expect(durable.text).toBe(checkpoint.markdown);
      expect(durable.text).not.toContain(rejectedMarker);
      const atHead = await db
        .selectFrom('note_revisions')
        .select(['markdown', 'content_hash'])
        .where('note_id', '=', idBytes(noteId))
        .where('seq', '=', durable.head)
        .execute();
      expect(atHead.length).toBeGreaterThan(0);
      for (const revision of atHead) {
        expect(revision.markdown).toBe(checkpoint.markdown);
        expect(revision.content_hash).toEqual(checkpoint.content_hash);
      }
      expect(
        await db
          .selectFrom('note_updates')
          .select('seq')
          .where('note_id', '=', idBytes(noteId))
          .where('seq', '>', checkpoint.seq)
          .execute(),
      ).toEqual([]);
      expect(app.collab.gateway.isClosing(noteId)).toBe(false);
    } finally {
      harness.application().faults.arm({ point: 'store.slow', count: 0 });
      await clock.advance(SLOW_COMMIT_MS);
      await harness.close();
      await Promise.allSettled(trashRequest === undefined ? [] : [trashRequest]);
    }
  });
});
