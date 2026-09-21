/** Process-owned scheduler; all entry points execute these same durable handlers. */
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { MAINTENANCE_JOB_TYPES, type MaintenanceJobType } from '@iridium/contracts';
import { PIPELINE_VERSION } from '@iridium/markdown';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';

import type { AttachmentScanHit } from '../attachments/reference-scan.worker.ts';
import { generateAttachmentReport } from '../attachments/report.ts';
import { createAuditKeys, readPromotedAuditKeyVersion } from '../audit/keys.ts';
import { createMaintDb } from '../db/migrator.ts';
import type { TimerHandle } from '../ops/clock.ts';
import { READINESS_RECHECK_MS } from '../ops/plugin.ts';
import { appDb } from '../rest/handler-context.ts';
import { archiveAudit } from './archive.ts';
import { maintainAccessPartitions } from './partitions.ts';
import { cleanTransfers, pruneUpdates, sweepCredentials, thinRevisions } from './retention.ts';
import { createMaintenanceSampler } from './sampler.ts';
import { JOB_SCHEDULE } from './schedule.ts';
import { JobScheduler, type JobHandler } from './scheduler.ts';
import { purgeTrash } from './trash.ts';

export interface MaintenanceResult {
  readonly status: 'complete' | 'already-running';
  readonly removed: number;
}
export interface MaintenanceJobs {
  readonly scheduler: JobScheduler;
  /** Existing callers retain this surface, now backed by a durable row. */
  run(type: 'update_log_prune'): Promise<MaintenanceResult>;
  tick(): Promise<void>;
  stop(): Promise<void>;
}
declare module 'fastify' {
  interface FastifyInstance {
    jobs: MaintenanceJobs;
  }
}

/** Dependencies are read at execution, after every boot step has registered. */
export function applyJobsPlugin(app: FastifyInstance): void {
  let maint: ReturnType<typeof createMaintDb> | null = null;
  const maintenance = (): ReturnType<typeof createMaintDb> | null => {
    if (app.iridiumConfig.db.migrateUrl === null) return null;
    maint ??= createMaintDb(app.iridiumConfig.db.migrateUrl, app.iridiumConfig.db.connectTimeoutMs);
    return maint;
  };
  const handlers: Record<MaintenanceJobType, JobHandler> = {
    update_log_prune: (context) =>
      pruneUpdates(
        appDb(app),
        app.clock.date(),
        app.iridiumConfig.collab.updateLogRetentionDays,
        context,
      ),
    revision_thinning: (context) => thinRevisions(appDb(app), app.clock.date(), context),
    session_ticket_sweep: (context) =>
      sweepCredentials(appDb(app), app.clock.date(), context, () => {
        app.auth.tickets.sweepExpired();
      }),
    transfer_cleanup: (context) =>
      cleanTransfers(
        appDb(app),
        app.clock.date(),
        {
          staging: app.iridiumConfig.transfer.stagingDir,
          exports: app.iridiumConfig.transfer.exportsDir,
          attachmentTemporary: join(
            app.iridiumConfig.storage.driver === 'fs'
              ? app.iridiumConfig.storage.dir
              : app.iridiumConfig.transfer.stagingDir,
            '.tmp',
          ),
        },
        context,
      ),
    trash_purge: (context) => purgeTrash(app, context),
    access_log_partitions: (context) =>
      maintainAccessPartitions(
        maintenance()?.db ?? null,
        app.clock.date(),
        Math.max(
          app.iridiumConfig.retention.accessLogPartitionLeadMonths,
          typeof context.payload['leadMonths'] === 'number' ? context.payload['leadMonths'] : 0,
        ),
        Math.max(
          app.iridiumConfig.retention.accessLogDays,
          typeof context.payload['retentionDays'] === 'number'
            ? context.payload['retentionDays']
            : 0,
        ),
        context,
      ),
    audit_archive: async (context) => {
      const connection = maintenance();
      return archiveAudit(
        {
          db: connection?.db ?? null,
          pool: connection?.pool ?? null,
          keys: createAuditKeys({
            keyring: app.iridiumConfig.keys.auditHmac,
            signingVersion: await readPromotedAuditKeyVersion(appDb(app)),
          }),
          audit: app.audit,
          directory: app.iridiumConfig.retention.auditArchiveExportDir,
          now: app.clock.date(),
          retentionDays: app.iridiumConfig.retention.auditDays,
        },
        context,
      );
    },
    attachment_unreferenced_report: async (context) => {
      await context.assertActive();
      const report = await generateAttachmentReport(
        {
          database: () => appDb(app),
          clock: app.clock,
          storage: app.attachmentStorage,
          scan: async (task) => {
            await context.assertActive();
            return app.projectionPool.run<readonly AttachmentScanHit[]>(task, {
              filename: new URL(
                import.meta.url.endsWith('.ts')
                  ? '../attachments/reference-scan.worker.ts'
                  : './attachment-reference.worker.mjs',
                import.meta.url,
              ).href,
            });
          },
        },
        typeof context.payload['vaultId'] === 'string' ? context.payload['vaultId'] : undefined,
      );
      await context.checkpoint({
        phase: 'complete',
        done: report.totals.rows,
        total: report.totals.rows,
      });
      return { ...report };
    },
    reindex: async (context) => {
      const result = await app.searchIndex.rebuild(context.payload, context);
      return { ...result };
    },
  };
  const schemaReady = (): boolean => {
    const status = app.database.migrations();
    return (
      status !== null &&
      status.pending.length === 0 &&
      (status.status === 'current' ||
        (status.status === 'newer_schema' && app.iridiumConfig.lifecycle.allowNewerSchema))
    );
  };
  const canRun = (): boolean =>
    schemaReady() &&
    app.database.dbApp !== null &&
    app.collab.ownerLease.held &&
    !app.readiness.draining &&
    app.readiness.lastEvaluation?.checks.find((check) => check.name === 'persist_backlog')
      ?.status !== 'fail';
  const scheduler = new JobScheduler({
    database: () => appDb(app),
    clock: app.clock,
    processId: createHash('sha256').update(app.instanceId).digest('hex'),
    handlers,
    captureFence: () => app.collab.ownerLease.captureFence(),
    ownerGeneration: () => app.collab.ownerLease.captureGeneration(),
    canRun,
    audit: app.audit,
    metrics: {
      finished(type, status, durationMs) {
        app.metrics.jobsTotal.inc({ type, status });
        app.metrics.jobDurationSeconds.observe({ type }, durationMs / 1000);
        if (status === 'succeeded')
          app.metrics.jobLastSuccessTimestamp.set({ type }, app.clock.now() / 1000);
      },
    },
    onError: (error) => {
      app.log.error({ err: error }, 'jobs.execution_failed');
    },
    onTransition: (event) => {
      app.log.info({ ...event, event: `job.${event.status}` }, `job.${event.status}`);
    },
  });
  let timer: TimerHandle | null = null;
  let bootstrapTimer: TimerHandle | null = null;
  let bootstrapWork: Promise<void> | null = null;
  let unsubscribeReadiness: (() => void) | null = null;
  let started = false;
  let stopping = false;
  let tickWork: Promise<void> | null = null;
  let legacy: Promise<MaintenanceResult> | null = null;
  const sampler = createMaintenanceSampler(app, canRun);
  // Schema metadata advances only when the global rebuild completes. Keep discovering a boot
  // upgrade until its durable intent exists, including ownership acquired after readiness.
  const enqueuePipelineUpgrade = async (): Promise<void> => {
    if (!canRun()) return;
    const version = await appDb(app)
      .selectFrom('schema_meta')
      .select('value')
      .where('key', '=', 'pipeline_version')
      .executeTakeFirstOrThrow();
    if (Number(version.value) >= PIPELINE_VERSION) return;
    await scheduler.enqueueIfIdle(
      'reindex',
      { pipelineVersion: true },
      app.collab.ownerLease.captureFence(),
    );
  };
  const tick = (): Promise<void> => {
    tickWork ??= (async () => {
      if (!canRun()) return;
      await enqueuePipelineUpgrade();
      const now = app.clock.date();
      for (const schedule of JOB_SCHEDULE) {
        // eslint-disable-next-line no-await-in-loop -- each maintenance unit is discovered and committed before admitting the next unit
        const latest = await appDb(app)
          .selectFrom('jobs')
          .select(['created_at', 'status'])
          .where('type', '=', schedule.type)
          .where('vault_id', 'is', null)
          .orderBy('created_at', 'desc')
          .limit(1)
          .executeTakeFirst();
        if (latest?.status === 'queued' || latest?.status === 'running') continue;
        if (latest === undefined || latest.created_at.getTime() < schedule.dueAt(now).getTime())
          // eslint-disable-next-line no-await-in-loop -- each maintenance unit is discovered and committed before admitting the next unit
          await scheduler.enqueueIfIdle(
            schedule.type,
            schedule.payload ?? {},
            app.collab.ownerLease.captureFence(),
          );
      }
      await scheduler.runQueuedOnce();
    })().finally(() => {
      tickWork = null;
    });
    return tickWork;
  };
  const stop = async (): Promise<void> => {
    stopping = true;
    unsubscribeReadiness?.();
    unsubscribeReadiness = null;
    bootstrapTimer?.cancel();
    bootstrapTimer = null;
    timer?.cancel();
    timer = null;
    await Promise.all([scheduler.stop(), bootstrapWork]);
    await tickWork;
    await legacy;
    await sampler.stop();
  };
  app.decorate('jobs', {
    scheduler,
    tick,
    stop,
    run(type: 'update_log_prune'): Promise<MaintenanceResult> {
      if (legacy !== null) return Promise.resolve({ status: 'already-running', removed: 0 });
      legacy = (async () => {
        const job = await scheduler.enqueue(
          type,
          {},
          { ownerFence: app.collab.ownerLease.captureFence() },
        );
        const completed = await scheduler.runUntilSettled(job.id);
        if (completed.status !== 'succeeded') throw new MaintenanceJobFailed(completed.error);
        return {
          status: 'complete',
          removed:
            typeof completed.result?.['removed'] === 'number' ? completed.result['removed'] : 0,
        } as const;
      })().finally(() => {
        legacy = null;
      });
      return legacy;
    },
  } satisfies MaintenanceJobs);
  const startWhenReady = (): Promise<void> => {
    if (started || stopping || !canRun()) return Promise.resolve();
    bootstrapWork ??= (async () => {
      const successes = await appDb(app)
        .selectFrom('jobs')
        .select(['type'])
        .select((eb) => eb.fn.max<Date>('finished_at').as('lastSuccess'))
        .where('status', '=', 'succeeded')
        .where(
          sql<string>`COALESCE(JSON_UNQUOTE(JSON_EXTRACT(${sql.ref('result')}, '$.status')), '')`,
          '!=',
          'skipped_no_ddl_credential',
        )
        .groupBy('type')
        .execute();
      if (stopping || !canRun()) return;
      for (const type of MAINTENANCE_JOB_TYPES) {
        const last = successes.find((row) => row.type === type)?.lastSuccess;
        app.metrics.jobLastSuccessTimestamp.set({ type }, last == null ? 0 : last.getTime() / 1000);
      }
      if (app.iridiumConfig.ops.jobsEnabled) await enqueuePipelineUpgrade();
      if (stopping || !canRun()) return;
      scheduler.start();
      sampler.start();
      if (app.iridiumConfig.ops.jobsEnabled)
        timer = app.clock.every(60_000, () => {
          void tick().catch((error) => app.log.error({ err: error }, 'jobs.schedule_failed'));
        });
      started = true;
      bootstrapTimer?.cancel();
      bootstrapTimer = null;
    })()
      .catch((error) => app.log.error({ err: error }, 'jobs.bootstrap_failed'))
      .finally(() => {
        bootstrapWork = null;
      });
    return bootstrapWork;
  };
  app.addHook('onReady', async () => {
    // Metrics exist even on a pending schema, but no maintenance SQL runs before its readiness
    // check passes. A live operator migrate-up starts this same owned lifecycle without a restart.
    for (const type of MAINTENANCE_JOB_TYPES) {
      app.metrics.jobLastSuccessTimestamp.set({ type }, 0);
      const schedule = JOB_SCHEDULE.find((row) => row.type === type);
      app.metrics.jobIntervalSeconds.set(
        { type },
        schedule === undefined ? 0 : schedule.intervalMs / 1000,
      );
    }
    if (app.database.mode !== 'none' && app.role === 'server') {
      unsubscribeReadiness = app.readiness.onTransition((state) => {
        if (state === 'ready') void startWhenReady();
      });
      bootstrapTimer = app.clock.every(READINESS_RECHECK_MS, () => {
        void startWhenReady();
      });
      // All readiness owners are registered before onReady. Await the first full observation so
      // a healthy boot retains its pipeline-upgrade enqueue before serving its first request.
      await app.readiness.evaluate();
      await startWhenReady();
    }
    app.onDrain({ phase: 'jobs', name: 'jobs.stop', run: stop });
  });
  app.addHook('onClose', async () => {
    await stop();
    await maint?.db.destroy();
  });
}
class MaintenanceJobFailed extends Error {
  constructor(reason: string | null) {
    super(reason ?? 'Maintenance failed.');
    this.name = 'MaintenanceJobFailed';
  }
}
