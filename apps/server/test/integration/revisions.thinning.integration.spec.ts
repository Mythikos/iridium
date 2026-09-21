/** Revision retention through real CRDT commits, the production checkpoint store and maintenance. */
import {
  LIMITS,
  Node,
  NoteId,
  NoteRevision,
  REVISION_KINDS,
  REVISION_RETENTION,
  UserId,
  type RevisionKind,
} from '@iridium/contracts';
import { storedSv } from '@iridium/crdt';
import { describe, expect, it } from 'vitest';

import { idBytes } from '../../src/auth/ids.ts';
import { insertRevisionRow } from '../../src/collab/persistence/kysely-store.ts';
import { captureStoredState } from '../../src/notes/committed-state.ts';
import { appDb } from '../../src/rest/handler-context.ts';
import { startCollab } from '../support/collab-harness.ts';
import { ManualClock } from '../support/manual-clock.ts';

const DAY = 86_400_000;
const HOUR = 3_600_000;
describe('revisions.thinning.integration [area:revisions]', () => {
  it('yields at the production row cap and resumes a distinct hash run without losing its representative', async () => {
    const clock = new ManualClock(Math.floor(Date.now() / DAY) * DAY + 12 * HOUR);
    const cleanupTime = clock.now();
    const harness = await startCollab({
      clock,
      collab: { debounceMs: 60_000, maxDebounceMs: 60_000 },
      extraEnv: { JOBS_ENABLED: 'false' },
    });
    try {
      const cast = await harness.server.seed.kernel();
      const editor = await harness.server.loginAs(cast.editorA);
      const created = await editor.post(`/vaults/${cast.vault.id}/nodes`, {
        json: {
          kind: 'note',
          parentId: cast.vault.rootNodeId,
          name: 'Bounded thinning',
          markdown: 'stable',
        },
      });
      expect(created.status).toBe(201);
      const note = Node.parse(created.body);
      const noteId = NoteId.parse(note.id);
      const app = harness.application();
      const db = appDb(app);
      const client = await harness.open(cast.editorA, note.id);
      await client.waitSynced();
      const checkpoints: number[] = [];
      let distinct = 0;
      // The distinct run straddles the first descending 100-row page even when the kernel
      // fixture's note sorts before this note. Every row has a real acknowledged sequence.
      for (let index = 1; index <= LIMITS.REVISION_THINNING_ROWS_PER_RUN + 30; index += 1) {
        clock.jump(cleanupTime + index * 1000);
        const text = index >= 27 && index <= 35 ? 'distinct across the continuation' : 'stable';
        const acknowledged = client.waitForAck();
        client.ydoc.transact(() => {
          client.deleteAt(0, client.text.length);
          client.typeAt(0, text);
        });
        // eslint-disable-next-line no-await-in-loop -- produce acknowledged sequences before capturing their real revision snapshots
        await acknowledged;
        // eslint-disable-next-line no-await-in-loop -- the production revision store consumes each fresh authoritative head
        const revision = await db.transaction().execute(async (trx) => {
          await app.collab.ownerLease.captureFence().assertCurrent(trx);
          const captured = await captureStoredState(trx, noteId, true);
          return insertRevisionRow(trx, idBytes(noteId), {
            seq: captured.throughSeq,
            kind: 'checkpoint',
            label: null,
            markdown: captured.markdown,
            contentHash: Buffer.from(captured.contentHash),
            sizeChars: captured.sizeChars,
            snapshot: captured.stateV2,
            snapshotSv: storedSv(captured.sv),
            actor: { actorType: 'user', userId: UserId.parse(cast.editorA.id), sessionId: null },
            createdAt: clock.date(),
          });
        });
        checkpoints.push(revision.id);
        if (index === 35) distinct = revision.id;
      }
      await client.close();
      clock.jump(cleanupTime + 31 * DAY);
      const queued = await app.jobs.scheduler.enqueue(
        'revision_thinning',
        {},
        { ownerFence: app.collab.ownerLease.captureFence() },
      );
      await app.jobs.scheduler.runQueuedOnce();
      const yielded = await app.jobs.scheduler.get(queued.id);
      expect(yielded.status).toBe('queued');
      expect(yielded.attempts).toBe(0);
      expect(yielded.progress?.done).toBe(LIMITS.REVISION_THINNING_ROWS_PER_RUN);
      expect(yielded.progress?.cursor).toContain('pending');
      expect(yielded.progress?.cursor?.length).toBeLessThan(1000);
      const completed = await app.jobs.scheduler.runUntilSettled(queued.id);
      expect(completed.status).toBe('succeeded');
      expect(completed.attempts).toBe(1);
      const retained = await db
        .selectFrom('note_revisions')
        .select('id')
        .where('note_id', '=', idBytes(note.id))
        .where('kind', '=', 'checkpoint')
        .orderBy('id')
        .execute();
      expect(retained.map((row) => row.id)).toEqual([distinct, checkpoints.at(-1)]);
      expect(completed.result?.['removed']).toBe(checkpoints.length - 2);
      const repeated = await app.jobs.scheduler.enqueue(
        'revision_thinning',
        {},
        { ownerFence: app.collab.ownerLease.captureFence() },
      );
      expect((await app.jobs.scheduler.runUntilSettled(repeated.id)).result?.['removed']).toBe(0);
    } finally {
      clock.jump(cleanupTime);
      await harness.close();
    }
  });
  it('keeps UTC bucket representatives, recent rows, every protected kind, restore targets, transient states and the current head', async () => {
    const clock = new ManualClock(Date.now());
    const cleanupTime = clock.now();
    const harness = await startCollab({
      clock,
      collab: { debounceMs: 60_000, maxDebounceMs: 60_000 },
      extraEnv: {
        JOBS_ENABLED: 'false',
        SESSION_WEB_IDLE_HOURS: '2400',
        SESSION_WEB_ABSOLUTE_DAYS: '365',
        STEP_UP_WINDOW_MIN: '100000',
      },
    });
    try {
      const cast = await harness.server.seed.kernel();
      const editor = await harness.server.loginAs(cast.editorA);
      const admin = await harness.server.loginAs(cast.admin);
      const create = async (name: string) => {
        const response = await editor.post(`/vaults/${cast.vault.id}/nodes`, {
          json: { kind: 'note', parentId: cast.vault.rootNodeId, name, markdown: 'stable' },
        });
        expect(response.status).toBe(201);
        return Node.parse(response.body);
      };
      const note = await create('Thinning bands');
      const trash = await create('Protected trash checkpoint');
      expect(
        (
          await editor.post(`/nodes/${trash.id}/trash`, {
            json: {},
            headers: { 'if-match': `"${String(trash.version)}"` },
          })
        ).status,
      ).toBe(200);
      const named = await editor.post(`/notes/${note.id}/revisions`, {
        json: { label: 'Protected named state' },
      });
      expect(named.status).toBe(201);
      NoteRevision.parse(named.body);
      const client = await harness.open(cast.editorA, note.id);
      await client.waitSynced();
      const app = harness.application();
      const db = appDb(app);
      const noteId = NoteId.parse(note.id);
      const captureRevision = (kind: RevisionKind) =>
        db.transaction().execute(async (trx) => {
          await app.collab.ownerLease.captureFence().assertCurrent(trx);
          const captured = await captureStoredState(trx, noteId, true);
          // This is the real producer store seam: fresh committed state, current injected time and
          // a real sequence. Import's public producer arrives in M6; no fixture SQL ages history.
          return insertRevisionRow(trx, idBytes(noteId), {
            seq: captured.throughSeq,
            kind,
            label: null,
            markdown: captured.markdown,
            contentHash: Buffer.from(captured.contentHash),
            sizeChars: captured.sizeChars,
            snapshot: captured.stateV2,
            snapshotSv: storedSv(captured.sv),
            actor: { actorType: 'user', userId: UserId.parse(cast.editorA.id), sessionId: null },
            createdAt: clock.date(),
          });
        });
      await captureRevision('import');
      const record = async (
        at: number,
        text = 'stable',
        kind: 'checkpoint' | 'unload' = 'checkpoint',
      ): Promise<number> => {
        clock.jump(at);
        const acknowledged = client.waitForAck();
        client.ydoc.transact(() => {
          client.deleteAt(0, client.text.length);
          client.typeAt(0, text);
        });
        await acknowledged;
        return (await captureRevision(kind)).id;
      };
      const base = Math.floor(cleanupTime / DAY) * DAY + DAY;
      const now = base + 40 * DAY + 12 * HOUR;
      const drop: number[] = [],
        keep: number[] = [];
      drop.push(await record(base + HOUR));
      keep.push(await record(base + HOUR + 5 * 60_000, 'short-lived distinct state'));
      drop.push(await record(base + HOUR + 10 * 60_000));
      keep.push(await record(base + HOUR + 20 * 60_000));
      drop.push(await record(base + DAY + HOUR));
      const restoredTarget = await record(base + DAY + HOUR + 10 * 60_000);
      keep.push(restoredTarget);
      const excursion = await record(base + DAY + HOUR + 20 * 60_000, 'state replaced by restore');
      // Restore preserves this exact state in a protected pre_restore row, so its redundant
      // checkpoint can be thinned. The earlier short-lived state has no such protected copy.
      drop.push(excursion);
      const restored = await admin.post(
        `/notes/${note.id}/revisions/${String(restoredTarget)}/restore`,
        { json: { confirm: true } },
      );
      expect({ status: restored.status, body: restored.body }).toMatchObject({
        status: 200,
        body: { changed: true },
      });
      await client.waitFor('saved');
      keep.push(await record(base + DAY + HOUR + 40 * 60_000));
      for (const hour of [now - 2 * DAY - HOUR, now - 2 * DAY]) {
        // eslint-disable-next-line no-await-in-loop -- each persisted sequence belongs to its explicit historical clock instant
        drop.push(await record(hour));
        // eslint-disable-next-line no-await-in-loop -- each persisted sequence belongs to its explicit historical clock instant
        drop.push(await record(hour + 10 * 60_000));
        // eslint-disable-next-line no-await-in-loop -- each persisted sequence belongs to its explicit historical clock instant
        keep.push(await record(hour + 20 * 60_000));
      }
      for (const offset of [30, 20, 10])
        // eslint-disable-next-line no-await-in-loop -- recent rows must all survive, including repeated content hashes
        keep.push(await record(now - offset * 60_000));
      // A clock regression puts the current head behind its bucket's representative. It is still
      // the note's sole recoverable head and must survive, independently of wall-clock ordering.
      keep.push(await record(base + HOUR + 2 * 60_000, 'stable', 'unload'));
      await client.close();
      const before = await db
        .selectFrom('note_revisions')
        .selectAll()
        .where('note_id', 'in', [idBytes(note.id), idBytes(trash.id)])
        .orderBy('id')
        .execute();
      expect(new Set(before.map((row) => row.kind))).toEqual(new Set(REVISION_KINDS));
      const excursionRow = before.find((row) => row.id === excursion);
      expect(
        before.some(
          (row) =>
            row.kind === 'pre_restore' &&
            row.seq === excursionRow?.seq &&
            row.content_hash.equals(excursionRow.content_hash),
        ),
      ).toBe(true);
      const protectedRows = before.filter((row) =>
        REVISION_RETENTION.neverThinned.includes(row.kind),
      );
      clock.jump(now);
      const queued = await app.jobs.scheduler.enqueue(
        'revision_thinning',
        {},
        { ownerFence: app.collab.ownerLease.captureFence() },
      );
      const result = await app.jobs.scheduler.runUntilSettled(queued.id);
      expect(result.status).toBe('succeeded');
      expect(result.result?.['removed']).toBeGreaterThan(0);
      const after = await db
        .selectFrom('note_revisions')
        .selectAll()
        .where('note_id', 'in', [idBytes(note.id), idBytes(trash.id)])
        .orderBy('id')
        .execute();
      const ids = new Set(after.map((row) => row.id));
      for (const id of keep)
        expect(ids.has(id), `Expected revision ${String(id)} to survive`).toBe(true);
      for (const id of drop)
        expect(ids.has(id), `Expected revision ${String(id)} to be thinned`).toBe(false);
      expect(after.filter((row) => REVISION_RETENTION.neverThinned.includes(row.kind))).toEqual(
        protectedRows,
      );
      const head = await db
        .selectFrom('note_docs')
        .select('head_seq')
        .where('note_id', '=', idBytes(note.id))
        .executeTakeFirstOrThrow();
      expect(
        after.some((row) => row.note_id.equals(idBytes(note.id)) && row.seq === head.head_seq),
      ).toBe(true);
      const repeated = await app.jobs.scheduler.enqueue(
        'revision_thinning',
        {},
        { ownerFence: app.collab.ownerLease.captureFence() },
      );
      expect((await app.jobs.scheduler.runUntilSettled(repeated.id)).result?.['removed']).toBe(0);
    } finally {
      clock.jump(cleanupTime);
      await harness.close();
    }
  });
});
