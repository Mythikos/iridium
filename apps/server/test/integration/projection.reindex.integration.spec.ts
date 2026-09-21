/** Real worker, writer FIFO and durable scheduler proofs for the reindex selection and resume contract. */
import { idFromBytes, NoteId } from '@iridium/contracts';
import { PIPELINE_VERSION } from '@iridium/markdown';
import { describe, expect, it } from 'vitest';

import { idBytes } from '../../src/auth/ids.ts';
import type { JobScheduler } from '../../src/jobs/scheduler.ts';
import { lockNoteParents } from '../../src/notes/lock-parents.ts';
import { lockProjectionVault } from '../../src/projection/lock-vault.ts';
import { ReindexService } from '../../src/projection/reindex.ts';
import { upsertProjection } from '../../src/projection/write.ts';
import { appDb } from '../../src/rest/handler-context.ts';
import { startCollab, type CollabHarness } from '../support/collab-harness.ts';
import { ManualClock } from '../support/manual-clock.ts';
import { reindexClaimant } from '../support/reindex-claimant.ts';

/** The migration boundary writes a real historical-version projection through the monotonic writer. */
async function historicalProjection(harness: CollabHarness, noteId: string): Promise<void> {
  const app = harness.application(),
    db = appDb(app),
    id = idBytes(noteId);
  const source = await db
    .selectFrom('note_projections as p')
    .innerJoin('nodes as n', 'n.id', 'p.note_id')
    .selectAll('p')
    .select('n.vault_id')
    .where('p.note_id', '=', id)
    .executeTakeFirstOrThrow();
  const prepared = await app.notes.prepare(source.markdown);
  await db.transaction().execute(async (trx) => {
    await app.collab.ownerLease.captureFence().assertCurrent(trx);
    await lockProjectionVault(trx, source.vault_id);
    await lockNoteParents(trx, id);
    await trx
      .selectFrom('note_docs')
      .select('head_seq')
      .where('note_id', '=', id)
      .forUpdate()
      .executeTakeFirstOrThrow();
    await upsertProjection(
      trx,
      {
        noteId: id,
        revision: source.revision,
        markdown: source.markdown,
        contentHash: source.content_hash,
        prepared,
        pipelineVersion: PIPELINE_VERSION - 1,
        strict: false,
        now: app.clock.date(),
      },
      app.searchIndex,
    );
  });
}

describe('projection.reindex.integration [area:projection]', () => {
  it('queues a real pipeline upgrade at boot and advances the global marker only after the complete selection', async () => {
    const clock = new ManualClock(Date.now());
    const original = await startCollab({ clock, extraEnv: { JOBS_ENABLED: 'false' } });
    let ids: string[] = [];
    try {
      const vault = await original.server.seed.vault({ name: 'Pre-upgrade projections' });
      for (const name of ['Earlier', 'Later']) {
        // eslint-disable-next-line no-await-in-loop -- historical projections are committed in deterministic id order
        const note = await original.server.seed.note({
          vault,
          name,
          markdown: `# ${name}\nprevious pipeline source`,
        });
        // eslint-disable-next-line no-await-in-loop -- each historical projection uses its own real transaction
        await historicalProjection(original, note.id);
        ids.push(note.id);
      }
      ids = ids.toSorted();
      await appDb(original.application())
        .updateTable('schema_meta')
        .set({ value: String(PIPELINE_VERSION - 1) })
        .where('key', '=', 'pipeline_version')
        .execute();
    } finally {
      await original.close();
    }
    const upgraded = await startCollab({ clock, extraEnv: { JOBS_ENABLED: 'true' } });
    try {
      const app = upgraded.application(),
        db = appDb(app);
      const job = await db
        .selectFrom('jobs')
        .select(['id', 'payload', 'status'])
        .where('type', '=', 'reindex')
        .executeTakeFirstOrThrow();
      expect(job).toMatchObject({ payload: { pipelineVersion: true }, status: 'queued' });
      const marker = async () =>
        (
          await db
            .selectFrom('schema_meta')
            .select('value')
            .where('key', '=', 'pipeline_version')
            .executeTakeFirstOrThrow()
        ).value;
      expect(await marker()).toBe(String(PIPELINE_VERSION - 1));
      const first = ids[0];
      if (first === undefined)
        throw new Error('The upgrade fixture did not create its first note.');
      const ownerFence = app.collab.ownerLease.captureFence();
      const context = {
        ownerFence,
        progress: null,
        checkpoint: async () => {},
        assertActive: async () => ownerFence.assertActive(),
      };
      expect(
        await app.searchIndex.rebuild({ pipelineVersion: true, fromNoteId: first }, context),
      ).toMatchObject({ rebuilt: 1 });
      expect(await marker()).toBe(String(PIPELINE_VERSION - 1));
      expect((await app.jobs.scheduler.runUntilSettled(idFromBytes(job.id))).status).toBe(
        'succeeded',
      );
      expect(await marker()).toBe(String(PIPELINE_VERSION));
      expect(
        await db
          .selectFrom('note_projections')
          .select('pipeline_version')
          .where('note_id', 'in', ids.map(idBytes))
          .execute(),
      ).toEqual(ids.map(() => ({ pipeline_version: PIPELINE_VERSION })));
    } finally {
      await upgraded.close();
    }
  });

  it('throttles actual worker admission and resumes a stopped claimant from its persisted cursor', async () => {
    const clock = new ManualClock(Date.now());
    const harness = await startCollab({
      clock,
      extraEnv: { JOBS_ENABLED: 'false', REINDEX_RATE_PER_SECOND: '1' },
    });
    const app = harness.application();
    await app.jobs.scheduler.stop();
    const first = reindexClaimant(app, 'reindex-first-claimant'),
      second = reindexClaimant(app, 'reindex-second-claimant');
    let firstWork: Promise<void> | undefined,
      secondWork: ReturnType<JobScheduler['runUntilSettled']> | undefined;
    try {
      const vault = await harness.server.seed.vault({ name: 'Rate and resume' });
      const ids: string[] = [];
      for (const name of ['One', 'Two', 'Three']) {
        ids.push(
          // eslint-disable-next-line no-await-in-loop -- the fixture intentionally fixes the persisted keyset order
          (await harness.server.seed.note({ vault, name, markdown: `# ${name}\nresumableneedle` }))
            .id,
        );
      }
      ids.sort();
      const timerBaseline = clock.pendingTimers;
      const queued = await first.enqueue(
        'reindex',
        { vaultId: vault.id },
        { ownerFence: app.collab.ownerLease.captureFence() },
      );
      firstWork = first.runQueuedOnce();
      await expect.poll(async () => (await first.get(queued.id)).progress?.done).toBe(1);
      await expect.poll(() => clock.pendingTimers).toBeGreaterThan(timerBaseline + 1);
      await clock.advance(999);
      expect((await first.get(queued.id)).progress?.done).toBe(1);
      const stop = first.stop();
      await clock.advance(1);
      await stop;
      await firstWork;
      const interrupted = await first.get(queued.id);
      expect(interrupted).toMatchObject({
        status: 'queued',
        progress: { done: 1, total: 3, cursor: ids[0] },
      });
      const rowBefore = await appDb(app)
        .selectFrom('note_search')
        .selectAll()
        .where('note_id', '=', idBytes(ids[0] ?? ''))
        .executeTakeFirstOrThrow();
      const resumedTimers = clock.pendingTimers;
      secondWork = second.runUntilSettled(queued.id);
      await expect.poll(async () => (await second.get(queued.id)).progress?.done).toBe(2);
      await expect.poll(() => clock.pendingTimers).toBeGreaterThan(resumedTimers + 1);
      await clock.advance(999);
      expect((await second.get(queued.id)).progress?.done).toBe(2);
      await clock.advance(1);
      expect(await secondWork).toMatchObject({
        status: 'succeeded',
        progress: { done: 3, total: 3, cursor: ids[2] },
        result: { rebuilt: 2, processed: 3 },
      });
      expect(
        await appDb(app)
          .selectFrom('note_search')
          .selectAll()
          .where('note_id', '=', rowBefore.note_id)
          .executeTakeFirstOrThrow(),
      ).toEqual(rowBefore);
    } finally {
      const stopping = Promise.all([first.stop(), second.stop()]);
      await clock.advance(1000);
      await stopping;
      await firstWork;
      await secondWork?.catch(() => undefined);
      await harness.close();
    }
  });

  it('drains an accepted but uncommitted writer update before capturing the selected note', async () => {
    const harness = await startCollab({
      collab: { debounceMs: 60_000, maxDebounceMs: 60_000 },
      extraEnv: { JOBS_ENABLED: 'false' },
    });
    const locked = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>(),
      drainEntered = Promise.withResolvers<void>();
    let held: Promise<void> | undefined, work: Promise<Record<string, unknown>> | undefined;
    try {
      const cast = await harness.server.seed.kernel(),
        app = harness.application(),
        db = appDb(app),
        noteId = NoteId.parse(cast.note.id);
      const client = await harness.open(cast.editorA, noteId);
      await client.waitFor('saved');
      const before = await harness.committed(noteId);
      const binaryBefore = await db
        .selectFrom('note_docs')
        .select(['snapshot', 'snapshot_through_seq'])
        .where('note_id', '=', idBytes(noteId))
        .executeTakeFirstOrThrow();
      held = db.transaction().execute(async (trx) => {
        await trx
          .selectFrom('note_docs')
          .select('head_seq')
          .where('note_id', '=', idBytes(noteId))
          .forUpdate()
          .executeTakeFirstOrThrow();
        locked.resolve();
        await release.promise;
      });
      await locked.promise;
      const acknowledged = client.waitForAck();
      client.typeAt(client.text.length, '\nacceptedfifoneedle');
      const writer = app.collab.persistence.writerOf(noteId);
      if (writer === undefined) throw new Error('The opened note must own its real writer.');
      await expect.poll(() => writer.inFlight).toBe(true);
      const rebuild = new ReindexService({
        database: () => db,
        searchIndex: app.searchIndex,
        prepare: (markdown) => app.notes.prepare(markdown),
        clock: app.clock,
        ratePerSecond: app.iridiumConfig.projection.reindexRatePerSecond,
        projected: () => {},
        drainAccepted: async (id) => {
          expect(id).toBe(noteId);
          drainEntered.resolve();
          await writer.drainAccepted();
        },
      });
      const ownerFence = app.collab.ownerLease.captureFence();
      work = rebuild.run(
        { noteIds: [noteId] },
        {
          ownerFence,
          progress: null,
          checkpoint: async () => {},
          assertActive: async () => ownerFence.assertActive(),
        },
      );
      await drainEntered.promise;
      expect(writer.lastCommittedSeq).toBe(before.head);
      release.resolve();
      await held;
      await acknowledged;
      expect(await work).toMatchObject({ rebuilt: 1 });
      const after = await harness.committed(noteId);
      expect(after.projected).toBe(after.head);
      expect(after.head).toBeGreaterThan(before.head);
      expect(after.text).toContain('acceptedfifoneedle');
      expect(
        await db
          .selectFrom('note_docs')
          .select(['snapshot', 'snapshot_through_seq'])
          .where('note_id', '=', idBytes(noteId))
          .executeTakeFirstOrThrow(),
      ).toEqual(binaryBefore);
      expect(
        await app.searchIndex.rebuild(
          { stale: true },
          {
            ownerFence,
            progress: null,
            checkpoint: async () => {},
            assertActive: async () => ownerFence.assertActive(),
          },
        ),
      ).toMatchObject({ rebuilt: 0 });
    } finally {
      release.resolve();
      await held;
      await work;
      await harness.close();
    }
  });
});
