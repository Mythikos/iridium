/** Every claim binding must preserve durable intent, exclusivity and cancellation. */
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';

import { pruneUpdates } from '../../src/jobs/retention.ts';
import { JobScheduler } from '../../src/jobs/scheduler.ts';
import { appDb } from '../../src/rest/handler-context.ts';
import { startCollab } from '../support/collab-harness.ts';
import { ManualClock } from '../support/manual-clock.ts';

interface ClaimImplementation {
  readonly name: string;
  create(
    app: FastifyInstance,
    processId: string,
  ): Pick<
    JobScheduler,
    'enqueue' | 'get' | 'cancel' | 'runQueuedOnce' | 'runUntilSettled' | 'stop'
  >;
}
const IMPLEMENTATIONS: readonly ClaimImplementation[] = [
  {
    name: 'MySQL durable JobScheduler',
    create: (app, processId) =>
      new JobScheduler({
        database: () => appDb(app),
        clock: app.clock,
        processId,
        handlers: {
          update_log_prune: (context) => pruneUpdates(appDb(app), app.clock.date(), 7, context),
          reindex: (context) => app.searchIndex.rebuild(context.payload, context),
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
        onError: (error) => app.log.error({ err: error }, 'job.contract'),
      }),
  },
];

describe.each(IMPLEMENTATIONS)('job-claim.contract [area:seams] $name', (implementation) => {
  it('deduplicates equivalent JSON selections and admits one of two real claimants', async () => {
    const harness = await startCollab({
      clock: new ManualClock(Date.now()),
      extraEnv: { JOBS_ENABLED: 'false' },
    });
    const app = harness.application(),
      first = implementation.create(app, 'claim-contract-a'),
      second = implementation.create(app, 'claim-contract-b');
    try {
      const options = { ownerFence: app.collab.ownerLease.captureFence() };
      const [left, right] = await Promise.all([
        first.enqueue('reindex', { stale: true, mode: 'stale' }, options),
        second.enqueue('reindex', { mode: 'stale', stale: true }, options),
      ]);
      expect(left.id).toBe(right.id);
      await expect(first.enqueue('reindex', { mode: 'all' }, options)).rejects.toMatchObject({
        code: 'invalid_state',
      });
      await Promise.all([first.runQueuedOnce(), second.runQueuedOnce()]);
      expect(await first.get(left.id)).toMatchObject({ status: 'succeeded', attempts: 1 });
      expect(await second.get(left.id)).toEqual(await first.get(left.id));
    } finally {
      await first.stop();
      await second.stop();
      await harness.close();
    }
  });
  it('cancels a queued intent once and leaves a stopped producer’s next intent executable by its successor', async () => {
    const harness = await startCollab({
      clock: new ManualClock(Date.now()),
      extraEnv: { JOBS_ENABLED: 'false' },
    });
    const app = harness.application(),
      first = implementation.create(app, 'claim-contract-a'),
      second = implementation.create(app, 'claim-contract-b');
    try {
      const ownerFence = app.collab.ownerLease.captureFence();
      const cancelled = await first.enqueue('update_log_prune', {}, { ownerFence });
      const contenders = await Promise.allSettled([
        first.cancel(cancelled.id, ownerFence),
        second.cancel(cancelled.id, ownerFence),
      ]);
      expect(contenders.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(await second.get(cancelled.id)).toMatchObject({ status: 'cancelled', attempts: 0 });
      const next = await first.enqueue('update_log_prune', {}, { ownerFence });
      await first.stop();
      await expect(first.enqueue('update_log_prune', {}, { ownerFence })).rejects.toMatchObject({
        code: 'unavailable',
      });
      expect(await second.runUntilSettled(next.id)).toMatchObject({
        status: 'succeeded',
        attempts: 1,
        result: { removed: 0 },
      });
      expect(await second.get(cancelled.id)).toMatchObject({ status: 'cancelled', attempts: 0 });
    } finally {
      await first.stop();
      await second.stop();
      await harness.close();
    }
  });
});
