/** Real database claims and administrator routes; executors are production retention functions. */
import { Job, JobPage, newId } from '@iridium/contracts';
import { describe, expect, it } from 'vitest';

import { pruneUpdates } from '../../src/jobs/retention.ts';
import { JobScheduler } from '../../src/jobs/scheduler.ts';
import { appDb } from '../../src/rest/handler-context.ts';
import { startCollab } from '../support/collab-harness.ts';

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
      const queued = await app.jobs.scheduler.enqueue(
        'revision_thinning',
        {},
        { ownerFence: app.collab.ownerLease.captureFence() },
      );
      const cancelled = await admin.post(`/admin/jobs/${queued.id}/cancel`);
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
    const harness = await startCollab({ extraEnv: { JOBS_ENABLED: 'false' } });
    const app = harness.application();
    const db = appDb(app);
    const create = (processId: string) =>
      new JobScheduler({
        database: () => db,
        clock: app.clock,
        processId,
        handlers: { update_log_prune: (context) => pruneUpdates(db, app.clock.date(), 7, context) },
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
      await Promise.all([first.runQueuedOnce(), second.runQueuedOnce()]);
      const done = await first.get(a.id);
      expect(done.status).toBe('succeeded');
      expect(done.attempts).toBe(1);
      expect(done.result).toEqual({ removed: 0 });
      const repeat = await first.enqueue('update_log_prune', {}, options);
      expect(repeat.id).not.toBe(a.id);
      expect((await first.runUntilSettled(repeat.id)).result).toEqual(done.result);
    } finally {
      await first.stop();
      await second.stop();
      await harness.close();
    }
  });
});
