/** Low-frequency aggregate observations, independent of the maintenance scheduler switch. */
import type { FastifyInstance } from 'fastify';

import type { TimerHandle } from '../ops/clock.ts';
const PROJECTION_SAMPLE_MS = 60_000;
const ATTACHMENT_SAMPLE_MS = 300_000;
/** One owner cancels its timer and joins every outstanding database read during drain. */
export function createMaintenanceSampler(
  app: FastifyInstance,
  canSample: () => boolean,
): {
  start(): void;
  stop(): Promise<void>;
  sample(): Promise<void>;
} {
  let timer: TimerHandle | null = null;
  let work: Promise<void> | null = null;
  let attachmentAt = -Infinity;
  const sample = (): Promise<void> => {
    work ??= (async () => {
      const db = app.database.dbApp;
      if (db === null || !canSample()) return;
      const pending = await db
        .selectFrom('note_docs')
        .select((eb) => eb.fn.min<Date>('updated_at').as('oldest'))
        .whereRef('projected_seq', '<', 'head_seq')
        .executeTakeFirst();
      const degraded = await db
        .selectFrom('note_projections')
        .select((eb) => eb.fn.min<Date>('projected_at').as('oldest'))
        .where('status', 'in', ['pending', 'error', 'timeout'])
        .executeTakeFirst();
      const oldest = [pending?.oldest, degraded?.oldest]
        .filter((date): date is Date => date != null)
        .reduce<Date | null>(
          (before, date) => (before === null || date < before ? date : before),
          null,
        );
      app.metrics.projectionLagSeconds.set(
        oldest === null ? 0 : Math.max(0, (app.clock.now() - oldest.getTime()) / 1000),
      );
      if (app.clock.monotonic() - attachmentAt >= ATTACHMENT_SAMPLE_MS) {
        const total = await db
          .selectFrom('attachments')
          .select((eb) => eb.fn.sum<number | string>('size_bytes').as('bytes'))
          .executeTakeFirst();
        app.metrics.attachmentBytesTotal.set(Number(total?.bytes ?? 0));
        attachmentAt = app.clock.monotonic();
      }
    })().finally(() => {
      work = null;
    });
    return work;
  };
  return {
    sample,
    start() {
      if (timer !== null) return;
      timer = app.clock.every(PROJECTION_SAMPLE_MS, () => {
        void sample().catch((error) => app.log.warn({ err: error }, 'jobs.metrics_failed'));
      });
    },
    async stop() {
      timer?.cancel();
      timer = null;
      await work;
    },
  };
}
