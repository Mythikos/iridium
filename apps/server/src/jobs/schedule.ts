/** The UTC schedule in 11-operations-and-deployment.md, anchored to durable job history. */
import type { MaintenanceJobType } from '@iridium/contracts';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
export interface JobSchedule {
  readonly type: MaintenanceJobType;
  readonly intervalMs: number;
  readonly payload?: Readonly<Record<string, unknown>>;
  dueAt(now: Date): Date;
}
function interval(type: MaintenanceJobType, intervalMs: number): JobSchedule {
  return {
    type,
    intervalMs,
    dueAt: (now) => new Date(Math.floor(now.getTime() / intervalMs) * intervalMs),
  };
}
function daily(type: MaintenanceJobType, hour: number, minute: number): JobSchedule {
  return {
    type,
    intervalMs: DAY_MS,
    dueAt: (now) => {
      const time = Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
        hour,
        minute,
      );
      return new Date(time > now.getTime() ? time - DAY_MS : time);
    },
  };
}
/** last_used_flush begins with M3's token producer; reindex also repairs stale projections hourly. */
export const JOB_SCHEDULE: readonly JobSchedule[] = [
  interval('session_ticket_sweep', 5 * MINUTE_MS),
  interval('transfer_cleanup', 15 * MINUTE_MS),
  interval('update_log_prune', HOUR_MS),
  interval('trash_purge', HOUR_MS),
  { ...interval('reindex', HOUR_MS), payload: { stale: true } },
  daily('revision_thinning', 3, 10),
  daily('access_log_partitions', 0, 30),
  {
    type: 'attachment_unreferenced_report',
    intervalMs: 30 * DAY_MS,
    dueAt: (now) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
  },
  {
    type: 'audit_archive',
    intervalMs: 7 * DAY_MS,
    dueAt: (now) => {
      const sunday = Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() - now.getUTCDay(),
        4,
      );
      return new Date(sunday > now.getTime() ? sunday - 7 * DAY_MS : sunday);
    },
  },
];
