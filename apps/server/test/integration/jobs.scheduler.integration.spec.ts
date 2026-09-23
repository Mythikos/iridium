/** Real database claims and administrator routes; executors are production retention functions. */
import { Job, JobPage, LIMITS, newId } from '@iridium/contracts';
import type { Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';

import { idBytes } from '../../src/auth/ids.ts';
import type { Database } from '../../src/db/schema.ts';
import { pruneUpdates } from '../../src/jobs/retention.ts';
import { JobScheduler, type JobContext, type JobHandler } from '../../src/jobs/scheduler.ts';
import { appDb } from '../../src/rest/handler-context.ts';
import { startCollab } from '../support/collab-harness.ts';
import { ManualClock } from '../support/manual-clock.ts';
import { insertJob } from '../support/seed.ts';

/**
 * The claim §6.2 names — `jobs.locked_by` and `jobs.locked_at` — plus the two columns that say
 * whether it was taken twice. `Job` deliberately hides the owner ("Public metadata never includes
 * the internal claim owner", `packages/contracts/src/rest/jobs.ts`), so the row is the only place
 * the claim of 12-milestones.md §6.4 can be observed.
 */
interface ClaimRow {
  readonly status: string;
  readonly locked_by: string | null;
  readonly locked_at: Date | null;
  readonly attempts: number;
}

function readClaim(db: Kysely<Database>, jobId: string): Promise<ClaimRow> {
  return db
    .selectFrom('jobs')
    .select(['status', 'locked_by', 'locked_at', 'attempts'])
    .where('id', '=', idBytes(jobId))
    .executeTakeFirstOrThrow();
}

describe('jobs.scheduler.integration [area:jobs]', () => {
  it('audits administrator execution, exposes progress, rejects invalid payloads and cancels only queued jobs', async () => {
    const harness = await startCollab({ extraEnv: { JOBS_ENABLED: 'false' } });
    try {
      const cast = await harness.server.seed.kernel();
      const admin = await harness.server.loginAs(cast.admin);
      const viewer = await harness.server.loginAs(cast.viewer);
      const app = harness.application();
      expect((await viewer.get('/admin/jobs')).status).toBe(403);
      const invalidList = await admin.get('/admin/jobs', { query: { limit: 0 } });
      expect(invalidList.status).toBe(422);
      expect(invalidList.body).toMatchObject({ code: 'validation_failed' });
      const absentId = newId();
      const missingJob = await admin.get(`/admin/jobs/${absentId}`);
      expect(missingJob.status).toBe(404);
      expect(missingJob.body).toMatchObject({ code: 'not_found' });
      const missingCancel = await admin.post(`/admin/jobs/${absentId}/cancel`);
      expect(missingCancel.status).toBe(404);
      expect(missingCancel.body).toMatchObject({ code: 'not_found' });
      const missingVault = await admin.post('/admin/jobs/reindex/run', {
        json: { payload: { vaultId: newId() } },
      });
      expect(missingVault.status).toBe(404);
      expect(missingVault.body).toMatchObject({ code: 'not_found' });
      expect(
        (
          await admin.post('/admin/jobs/update_log_prune/run', {
            json: { payload: { vaultId: cast.vault.id } },
          })
        ).status,
      ).toBe(422);
      const started = await admin.post('/admin/jobs/update_log_prune/run', {
        json: { payload: {} },
      });
      expect(started.status).toBe(202);
      const job = Job.parse(started.body);
      await expect
        .poll(async () => Job.parse((await admin.get(`/admin/jobs/${job.id}`)).body).status)
        .toBe('succeeded');
      const complete = Job.parse((await admin.get(`/admin/jobs/${job.id}`)).body);
      expect(complete.attempts).toBe(1);
      expect(complete.progress).toEqual({ phase: 'updates', done: 0, total: 0 });
      expect(complete.result).toEqual({ removed: 0 });
      expect(complete.requestedBy?.id).toBe(cast.admin.id);
      expect((await admin.post(`/admin/jobs/${job.id}/cancel`)).status).toBe(409);
      // The row has to still be queued when the cancel lands. JOBS_ENABLED only gates the
      // scheduled enqueue paths, and the run route above woke the scheduler, whose drain keeps
      // claiming queued rows of any handled type — so a `revision_thinning` row races it and the
      // route answers its documented 409 for a job that is no longer queued. The scheduler cannot
      // simply be stopped first either: `enqueue` refuses once it is stopping. An `export` row is
      // queued, parses as a `Job`, and has no handler at M2, so nothing can claim it. What the
      // cancel route checks is the status, not the type.
      const queuedId = await insertJob(
        appDb(app),
        { vaultId: null, requestedBy: null },
        app.clock.now(),
      );
      const cancelled = await admin.post(`/admin/jobs/${queuedId}/cancel`);
      expect(cancelled.status).toBe(200);
      expect(Job.parse(cancelled.body).status).toBe('cancelled');
      const page = JobPage.parse((await admin.get('/admin/jobs', { query: { limit: 1 } })).body);
      expect(page.items).toHaveLength(1);
      expect(page.nextCursor).toBeTypeOf('string');
      expect(
        JobPage.parse(
          (await admin.get('/admin/jobs', { query: { limit: 1, cursor: page.nextCursor } })).body,
        ).items[0]?.id,
      ).not.toBe(page.items[0]?.id);
      const audit = await appDb(app)
        .selectFrom('audit_events')
        .select('metadata')
        .where('action', '=', 'admin.job.triggered')
        .execute();
      expect(audit.some((row) => row.metadata?.['type'] === 'update_log_prune')).toBe(true);
    } finally {
      await harness.close();
    }
  });
  it('two independent schedulers claim one real job exactly once and active enqueue is idempotent', async () => {
    const clock = new ManualClock();
    const harness = await startCollab({ clock, extraEnv: { JOBS_ENABLED: 'false' } });
    const app = harness.application();
    const db = appDb(app);
    // Each handler reads its own row while it is executing, so the claim is captured while it is
    // held rather than after the scheduler has already released it (§6.4, `jobs.scheduler`).
    const observed: { readonly processId: string; readonly claim: ClaimRow }[] = [];
    const create = (processId: string) =>
      new JobScheduler({
        database: () => db,
        clock,
        processId,
        handlers: {
          update_log_prune: async (context: JobContext) => {
            observed.push({ processId, claim: await readClaim(db, context.jobId) });
            return pruneUpdates(db, clock.date(), 7, context);
          },
        },
        captureFence: () => app.collab.ownerLease.captureFence(),
        canRun: () => app.collab.ownerLease.held,
        audit: app.audit,
        metrics: {
          finished(type, status, durationMs) {
            app.metrics.jobsTotal.inc({ type, status });
            app.metrics.jobDurationSeconds.observe({ type }, durationMs / 1000);
          },
        },
        onError: (error) => {
          app.log.error({ err: error }, 'job.claim_test');
        },
      });
    const first = create('maintenance-contender-a');
    const second = create('maintenance-contender-b');
    try {
      const options = { ownerFence: app.collab.ownerLease.captureFence() };
      const [a, b] = await Promise.all([
        first.enqueue('update_log_prune', {}, options),
        second.enqueue('update_log_prune', {}, options),
      ]);
      expect(a.id).toBe(b.id);
      const claimedAt = clock.date();
      await Promise.all([first.runQueuedOnce(), second.runQueuedOnce()]);
      // Exactly one handler ran, and the row it ran under names that handler's process.
      expect(observed).toHaveLength(1);
      const winner = observed[0];
      if (winner === undefined) throw new Error('One contender must have claimed the row.');
      expect(['maintenance-contender-a', 'maintenance-contender-b']).toContain(winner.processId);
      expect(winner.claim).toEqual({
        status: 'running',
        locked_by: winner.processId,
        locked_at: claimedAt,
        attempts: 1,
      });
      const done = await first.get(a.id);
      expect(done.status).toBe('succeeded');
      expect(done.attempts).toBe(1);
      expect(done.result).toEqual({ removed: 0 });
      // A settled job owns nothing: the claim is released with the terminal transition.
      expect(await readClaim(db, a.id)).toEqual({
        status: 'succeeded',
        locked_by: null,
        locked_at: null,
        attempts: 1,
      });
      const repeat = await first.enqueue('update_log_prune', {}, options);
      expect(repeat.id).not.toBe(a.id);
      expect((await first.runUntilSettled(repeat.id)).result).toEqual(done.result);
    } finally {
      await first.stop();
      await second.stop();
      await harness.close();
    }
  });
  it('holds a live claim against a second scheduler and yields it only once it has expired', async () => {
    const clock = new ManualClock();
    const harness = await startCollab({ clock, extraEnv: { JOBS_ENABLED: 'false' } });
    const app = harness.application();
    const db = appDb(app);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let holderRuns = 0;
    let reclaimerRuns = 0;
    const create = (processId: string, handler: JobHandler) =>
      new JobScheduler({
        database: () => db,
        clock,
        processId,
        handlers: { update_log_prune: handler },
        captureFence: () => app.collab.ownerLease.captureFence(),
        canRun: () => app.collab.ownerLease.held,
        audit: app.audit,
        metrics: {
          finished(type, status, durationMs) {
            app.metrics.jobsTotal.inc({ type, status });
            app.metrics.jobDurationSeconds.observe({ type }, durationMs / 1000);
          },
        },
        onError: (error) => {
          app.log.error({ err: error }, 'job.reclaim_test');
        },
      });
    const holder = create('maintenance-holder', async (context: JobContext) => {
      holderRuns += 1;
      entered.resolve();
      await release.promise;
      return pruneUpdates(db, clock.date(), 7, context);
    });
    const reclaimer = create('maintenance-reclaimer', (context: JobContext) => {
      reclaimerRuns += 1;
      return pruneUpdates(db, clock.date(), 7, context);
    });
    try {
      const job = await holder.enqueue(
        'update_log_prune',
        {},
        { ownerFence: app.collab.ownerLease.captureFence() },
      );
      const held = holder.runQueuedOnce();
      await entered.promise;
      const claimedAt = clock.date();
      expect(await readClaim(db, job.id)).toEqual({
        status: 'running',
        locked_by: 'maintenance-holder',
        locked_at: claimedAt,
        attempts: 1,
      });
      // A live claim is never taken: the second instance finds no candidate and runs nothing.
      await reclaimer.runQueuedOnce();
      expect(reclaimerRuns).toBe(0);
      expect(await readClaim(db, job.id)).toEqual({
        status: 'running',
        locked_by: 'maintenance-holder',
        locked_at: claimedAt,
        attempts: 1,
      });
      // Past `JOB_LOCK_TIMEOUT_MS` the row counts as abandoned, which is the only way a second
      // process may take it (`apps/server/src/jobs/scheduler.ts`, the `#claim` predicate).
      clock.jump(clock.now() + LIMITS.JOB_LOCK_TIMEOUT_MS + 1_000);
      await reclaimer.runQueuedOnce();
      expect(reclaimerRuns).toBe(1);
      const settled = {
        status: 'succeeded',
        locked_by: null,
        locked_at: null,
        attempts: 2,
      };
      expect(await readClaim(db, job.id)).toEqual(settled);
      release.resolve();
      await held;
      // The dispossessed holder ran once and wrote nothing back over the row it no longer owns.
      expect(holderRuns).toBe(1);
      expect(await readClaim(db, job.id)).toEqual(settled);
    } finally {
      release.resolve();
      await holder.stop();
      await reclaimer.stop();
      await harness.close();
    }
  });
});
