/** Access-log partition maintenance uses only the explicitly configured migrator role. */
import { sql, type Kysely } from 'kysely';

import { partitionBoundaryTime, readAccessLogPartitions } from '../db/access-log-partitions.ts';
import type { Database } from '../db/schema.ts';
import type { JobContext } from './scheduler.ts';

const DAY_MS = 86_400_000;
/** The partition name and its exclusive upper bound come from UTC calendar arithmetic. */
export function monthPartition(
  year: number,
  month: number,
): { readonly name: string; readonly boundary: string } {
  const start = new Date(Date.UTC(year, month, 1));
  const end = new Date(Date.UTC(year, month + 1, 1));
  return {
    name: `p${String(start.getUTCFullYear())}_${String(start.getUTCMonth() + 1).padStart(2, '0')}`,
    boundary: `${end.toISOString().slice(0, 10)} 00:00:00.000000`,
  };
}
/** DDL is idempotent under the process-owned job claim and re-reads the live partition inventory. */
export async function maintainAccessPartitions(
  db: Kysely<Database> | null,
  now: Date,
  leadMonths: number,
  retentionDays: number,
  context: JobContext,
): Promise<Record<string, unknown>> {
  if (db === null) return { status: 'skipped_no_ddl_credential', created: 0, dropped: 0 };
  const inventory = await readAccessLogPartitions(db);
  let latest = inventory
    .filter((part) => part.name !== 'p_overflow')
    .reduce((max, part) => Math.max(max, partitionBoundaryTime(part.boundary)), 0);
  let created = 0;
  let dropped = 0;
  for (let offset = 0; offset <= leadMonths; offset += 1) {
    // eslint-disable-next-line no-await-in-loop -- each DDL step depends on the preceding live partition boundary
    await context.assertActive();
    const part = monthPartition(now.getUTCFullYear(), now.getUTCMonth() + offset);
    const boundary = partitionBoundaryTime(part.boundary);
    if (boundary <= latest) continue;
    // eslint-disable-next-line no-await-in-loop -- each DDL step depends on the preceding live partition boundary
    await sql`ALTER TABLE access_log REORGANIZE PARTITION p_overflow INTO (PARTITION ${sql.id(part.name)} VALUES LESS THAN (${sql.lit(part.boundary)}), PARTITION p_overflow VALUES LESS THAN (MAXVALUE))`.execute(
      db,
    );
    latest = boundary;
    created += 1;
    // eslint-disable-next-line no-await-in-loop -- each DDL step depends on the preceding live partition boundary
    await context.checkpoint({ phase: 'partitions_create', done: created, total: leadMonths + 1 });
  }
  const cutoff = now.getTime() - retentionDays * DAY_MS;
  for (const part of inventory) {
    // eslint-disable-next-line no-await-in-loop -- each DDL step depends on the preceding live partition boundary
    await context.assertActive();
    if (part.name === null || !/^p\d{4}_\d{2}$/.test(part.name)) continue;
    const boundary = partitionBoundaryTime(part.boundary);
    if (!Number.isFinite(boundary) || boundary > cutoff) continue;
    // eslint-disable-next-line no-await-in-loop -- each DDL step depends on the preceding live partition boundary
    await sql`ALTER TABLE access_log DROP PARTITION ${sql.id(part.name)}`.execute(db);
    dropped += 1;
    // eslint-disable-next-line no-await-in-loop -- each DDL step depends on the preceding live partition boundary
    await context.checkpoint({
      phase: 'partitions_drop',
      done: dropped,
      total: inventory.length,
    });
  }
  return { created, dropped };
}
