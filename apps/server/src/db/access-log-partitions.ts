/** Read-only partition inventory shared by maintenance and its operational readiness check. */
import { sql, type Kysely } from 'kysely';

import type { CheckOutcome } from '../ops/readiness.ts';
import type { Database } from './schema.ts';

interface AccessLogPartition {
  readonly name: string | null;
  readonly boundary: string | null;
  readonly method: string | null;
  readonly expression: string | null;
}

interface PartitionReadinessOptions {
  readonly now: Date;
  readonly leadMonths: number;
  readonly ddlCredentialConfigured: boolean;
  readonly jobsEnabled: boolean;
}

const DAY_MS = 86_400_000;
// The configured monthly target and the readiness warning threshold are distinct (11, Health).
const LEAD_WARN_DAYS = 30;

/** MySQL reports quoted DATETIME partition bounds; parse them explicitly as UTC. */
export function partitionBoundaryTime(boundary: string | null): number {
  if (boundary === null) return Number.NaN;
  return Date.parse(boundary.replaceAll("'", '').replace(' ', 'T') + 'Z');
}

/** Serving and maintenance roles observe the same live inventory without opening another pool. */
export async function readAccessLogPartitions(
  db: Kysely<Database>,
): Promise<readonly AccessLogPartition[]> {
  const inventory = await sql<AccessLogPartition>`
    SELECT PARTITION_NAME AS name, PARTITION_DESCRIPTION AS boundary,
      PARTITION_METHOD AS method, PARTITION_EXPRESSION AS expression
    FROM information_schema.PARTITIONS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'access_log'
    ORDER BY PARTITION_ORDINAL_POSITION
  `.execute(db);
  return inventory.rows;
}

/**
 * I-20 is an operator warning, never a serving gate. Exact overflow existence avoids relying on
 * InnoDB's approximate TABLE_ROWS; LIMIT 1 bounds the check even after prolonged missed maintenance.
 * Credential presence describes configuration only: the last durable job result reports execution.
 */
export async function accessLogPartitionsOutcome(
  db: Kysely<Database>,
  options: PartitionReadinessOptions,
): Promise<CheckOutcome> {
  const configuration =
    `configured lead=${String(options.leadMonths)} future months; ` +
    `DDL credential ${options.ddlCredentialConfigured ? 'configured' : 'absent'}; ` +
    `scheduled maintenance ${options.jobsEnabled ? 'enabled' : 'disabled (JOBS_ENABLED=false)'}`;
  try {
    const inventory = await readAccessLogPartitions(db);
    if (
      inventory.length === 0 ||
      inventory.some(
        (part) =>
          part.method !== 'RANGE COLUMNS' || part.expression?.replaceAll('`', '') !== 'occurred_at',
      )
    )
      return {
        status: 'warn',
        detail: `access_log RANGE COLUMNS (occurred_at) inventory is unavailable; ${configuration}`,
      };

    const overflow = inventory.at(-1);
    if (overflow?.name !== 'p_overflow' || overflow.boundary !== 'MAXVALUE')
      return {
        status: 'warn',
        detail: `p_overflow MAXVALUE catch-all is missing; restore it before new access-log writes; ${configuration}`,
      };

    const boundaries = inventory
      .filter((part) => part.name !== 'p_overflow')
      .map((part) => partitionBoundaryTime(part.boundary));
    if (boundaries.some((boundary) => !Number.isFinite(boundary)))
      return {
        status: 'warn',
        detail: `access_log has an unreadable finite partition boundary; ${configuration}`,
      };

    const latest = boundaries.length === 0 ? null : Math.max(...boundaries);
    const target = Date.UTC(
      options.now.getUTCFullYear(),
      options.now.getUTCMonth() + options.leadMonths + 1,
      1,
    );
    const leadMs = latest === null ? 0 : latest - options.now.getTime();
    const overflowRows = await sql<{ present: number }>`
      SELECT 1 AS present FROM access_log PARTITION (p_overflow) LIMIT 1
    `.execute(db);
    const lastRun = await db
      .selectFrom('jobs')
      .select(['status', 'result', 'finished_at'])
      // This maintenance type is schema-wide; the leading vault key uses ix_jobs_vault_type.
      .where('vault_id', 'is', null)
      .where('type', '=', 'access_log_partitions')
      .where('started_at', 'is not', null)
      .where('finished_at', 'is not', null)
      .orderBy('finished_at', 'desc')
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst();
    const skipped = lastRun?.result?.['status'] === 'skipped_no_ddl_credential';
    const hasOverflowRows = overflowRows.rows.length > 0;
    const warning =
      latest === null || leadMs < LEAD_WARN_DAYS * DAY_MS || hasOverflowRows || skipped;
    const detail = [
      latest === null
        ? 'no finite partition boundary'
        : `newest boundary=${new Date(latest).toISOString()} (${String(Math.floor(leadMs / DAY_MS))} whole days ahead)`,
      `p_overflow ${hasOverflowRows ? 'contains rows' : 'empty'}`,
      `${configuration}; target boundary=${new Date(target).toISOString()} (${latest !== null && latest >= target ? 'met' : 'not yet met'})`,
      lastRun === undefined
        ? 'no completed maintenance run'
        : `last run=${skipped ? 'skipped_no_ddl_credential' : lastRun.status} at ${lastRun.finished_at?.toISOString() ?? 'unknown'}`,
    ];
    if (warning)
      detail.push(
        'run iridium jobs run access_log_partitions with DATABASE_MIGRATE_URL, or apply docs/ops/access-log-partitions.sql as the DBA',
      );
    return { status: warning ? 'warn' : 'ok', detail: detail.join('; ') };
  } catch (error) {
    // Database outages are db_app's failure; partition inspection never closes the serving gate.
    return {
      status: 'warn',
      detail: `access_log partition inspection unavailable: ${error instanceof Error ? error.message : String(error)}; ${configuration}`,
    };
  }
}
