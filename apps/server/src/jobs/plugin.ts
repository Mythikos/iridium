/** M1 maintenance operations; M2 adds the persisted due-job scheduler at this same boot step. */
import type { FastifyInstance } from 'fastify';

import { PersistenceUnavailable } from '../collab/persistence/kysely-store.ts';
import { pruneUpdateLog } from '../collab/persistence/prune.ts';

export interface MaintenanceResult {
  readonly status: 'complete' | 'already-running';
  readonly removed: number;
}

export interface MaintenanceJobs {
  /** Invoke the real operation directly; in-process suites never need a background timer. */
  run(type: 'update_log_prune'): Promise<MaintenanceResult>;
}

declare module 'fastify' {
  interface FastifyInstance {
    jobs: MaintenanceJobs;
  }
}

/** Consume the resolved retention setting once, using the application clock and real app-role pool. */
export function applyJobsPlugin(app: FastifyInstance): void {
  let running: Promise<MaintenanceResult> | null = null;
  app.decorate('jobs', {
    run(_type: 'update_log_prune'): Promise<MaintenanceResult> {
      if (running !== null) return Promise.resolve({ status: 'already-running', removed: 0 });
      const db = app.database.dbApp;
      if (db === null) return Promise.reject(new PersistenceUnavailable());
      running = pruneUpdateLog({
        db,
        now: app.clock.date(),
        retentionDays: app.iridiumConfig.collab.updateLogRetentionDays,
      })
        .then((removed): MaintenanceResult => ({ status: 'complete', removed }))
        .finally(() => {
          running = null;
        });
      return running;
    },
  } satisfies MaintenanceJobs);
  app.addHook('onClose', async () => {
    await running;
  });
}
