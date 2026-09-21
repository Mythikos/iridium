/** Durable maintenance jobs and administrator API (03 §11, 09 §2.15.4). */
import { z } from 'zod';

import { JobId, NoteId, VaultId } from '../ids.ts';
import { LIMITS } from '../limits.ts';
import { Timestamp } from '../time.ts';
import { UserRef } from './common.ts';

/** The complete persisted vocabulary, including types whose producers arrive after M2. */
export const JOB_TYPES = [
  'import',
  'export',
  'reindex',
  'trash_purge',
  'update_log_prune',
  'revision_thinning',
  'access_log_partitions',
  'audit_archive',
  'transfer_cleanup',
  'session_ticket_sweep',
  'last_used_flush',
  'attachment_unreferenced_report',
] as const;
export type JobType = (typeof JOB_TYPES)[number];
export const JobType: z.ZodType<JobType> = z.enum(JOB_TYPES).meta({ id: 'JobType' });
/** M2 has no token last-used producer, import executor or export executor. */
export const MAINTENANCE_JOB_TYPES = [
  'reindex',
  'trash_purge',
  'update_log_prune',
  'revision_thinning',
  'access_log_partitions',
  'audit_archive',
  'transfer_cleanup',
  'session_ticket_sweep',
  'attachment_unreferenced_report',
] as const;
export type MaintenanceJobType = (typeof MAINTENANCE_JOB_TYPES)[number];
export const MaintenanceJobType: z.ZodType<MaintenanceJobType> = z
  .enum(MAINTENANCE_JOB_TYPES)
  .meta({ id: 'MaintenanceJobType' });
/** A claim owns running; terminal states are retained for inspection. */
export const JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export const JobStatus: z.ZodType<JobStatus> = z.enum(JOB_STATUSES).meta({ id: 'JobStatus' });
/** A bounded unit checkpoint; cursor is an implementation-owned resume position. */
export interface JobProgress {
  readonly phase: string;
  readonly done: number;
  readonly total: number;
  readonly cursor?: string | undefined;
}
export const JobProgress: z.ZodType<JobProgress> = z
  .strictObject({
    phase: z.string(),
    done: z.int().nonnegative(),
    total: z.int().nonnegative(),
    cursor: z.string().optional(),
  })
  .meta({ id: 'JobProgress' });
/** Public metadata never includes the internal claim owner or arbitrary input payload. */
export interface Job {
  readonly id: string;
  readonly type: JobType;
  readonly status: JobStatus;
  readonly vaultId: string | null;
  readonly requestedBy: UserRef | null;
  readonly progress: JobProgress | null;
  readonly result: Record<string, unknown> | null;
  readonly error: string | null;
  readonly attempts: number;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
}
export const Job: z.ZodType<Job> = z
  .strictObject({
    id: JobId,
    type: JobType,
    status: JobStatus,
    vaultId: VaultId.nullable(),
    requestedBy: UserRef.nullable(),
    progress: JobProgress.nullable(),
    result: z.record(z.string(), z.unknown()).nullable(),
    error: z.string().nullable(),
    attempts: z.int().nonnegative(),
    createdAt: Timestamp,
    startedAt: Timestamp.nullable(),
    finishedAt: Timestamp.nullable(),
  })
  .meta({ id: 'Job' });
export interface JobPage {
  readonly items: readonly Job[];
  readonly nextCursor?: string | undefined;
}
export const JobPage: z.ZodType<JobPage> = z
  .strictObject({ items: z.array(Job), nextCursor: z.string().optional() })
  .meta({ id: 'JobPage' });
export interface ListJobsQuery {
  readonly type?: JobType | undefined;
  readonly status?: JobStatus | undefined;
  readonly vaultId?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit: number;
}
export const ListJobsQuery: z.ZodType<ListJobsQuery> = z
  .strictObject({
    type: JobType.optional(),
    status: JobStatus.optional(),
    vaultId: VaultId.optional(),
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(LIMITS.JOB_LIST_MAX).default(LIMITS.JOB_LIST_DEFAULT),
  })
  .meta({ id: 'ListJobsQuery' });
export const JobParams: z.ZodType<{ readonly jobId: string }> = z
  .strictObject({ jobId: JobId })
  .meta({ id: 'JobParams' });
export const RunJobParams: z.ZodType<{ readonly type: MaintenanceJobType }> = z
  .strictObject({ type: MaintenanceJobType })
  .meta({ id: 'RunJobParams' });
export const RunJobBody: z.ZodType<{ readonly payload: Record<string, unknown> }> = z
  .strictObject({ payload: z.record(z.string(), z.unknown()).default({}) })
  .meta({ id: 'RunJobBody' });
const empty = z.strictObject({});
const payloads = {
  reindex: z.strictObject({
    vaultId: VaultId.optional(),
    stale: z.boolean().optional(),
    pipelineVersion: z.boolean().optional(),
    noteIds: z.array(NoteId).max(LIMITS.JOB_REINDEX_NOTE_MAX).optional(),
    mode: z.enum(['all', 'stale', 'pipeline-version']).optional(),
    fromNoteId: NoteId.optional(),
  }),
  trash_purge: z.strictObject({
    vaultId: VaultId.optional(),
    olderThanDays: z.int().positive().optional(),
    dryRun: z.boolean().default(false),
  }),
  update_log_prune: empty,
  revision_thinning: empty,
  transfer_cleanup: empty,
  session_ticket_sweep: empty,
  access_log_partitions: z.strictObject({
    leadMonths: z.int().positive().optional(),
    retentionDays: z.int().positive().optional(),
  }),
  audit_archive: z.strictObject({
    beforeDate: Timestamp.optional(),
    olderThanDays: z.int().positive().optional(),
    dryRun: z.boolean().default(false),
  }),
  attachment_unreferenced_report: z.strictObject({ vaultId: VaultId.optional() }),
} satisfies Record<MaintenanceJobType, z.ZodType<Record<string, unknown>>>;
/** Every executor receives validated, persisted inputs, including administrator-triggered jobs. */
export function parseMaintenancePayload(
  type: MaintenanceJobType,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return payloads[type].parse(payload);
}
