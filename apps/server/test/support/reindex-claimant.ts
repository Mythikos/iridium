/** Independent real maintenance claimants for restart and throttling proofs. */
import type { FastifyInstance } from 'fastify';

import { JobScheduler } from '../../src/jobs/scheduler.ts';
import { appDb } from '../../src/rest/handler-context.ts';

/** Uses the production rebuild handler, owner fence, progress persistence, metrics and SQL claim CAS. */
export function reindexClaimant(app: FastifyInstance, processId: string): JobScheduler {
  return new JobScheduler({
    database: () => appDb(app),
    clock: app.clock,
    processId,
    handlers: { reindex: (context) => app.searchIndex.rebuild(context.payload, context) },
    captureFence: () => app.collab.ownerLease.captureFence(),
    canRun: () => app.collab.ownerLease.held,
    audit: app.audit,
    metrics: {
      finished(type, status, durationMs) {
        app.metrics.jobsTotal.inc({ type, status });
        app.metrics.jobDurationSeconds.observe({ type }, durationMs / 1000);
      },
    },
    onError: (error) => app.log.error({ err: error }, 'reindex.claim-proof'),
  });
}
