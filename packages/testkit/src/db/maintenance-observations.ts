/** Read-only maintenance observations on the caller's actual executor and physical session. */
import { sql, type QueryExecutorProvider, type QueryResult, type RawBuilder } from 'kysely';

import { assertSchemaName, type MysqlAdmin } from '../env/mysql.ts';

/** Observe real InnoDB gate contention without changing either participant's session or timing. */
export async function inspectVaultLockWaits(
  admin: MysqlAdmin,
  schema: string,
): Promise<readonly { requested: string; blocking: string }[]> {
  assertSchemaName(schema);
  const rows = await admin.rows(`SELECT requested.LOCK_MODE, blocking.LOCK_MODE
    FROM performance_schema.data_lock_waits waits
    JOIN performance_schema.data_locks requested ON requested.ENGINE=waits.ENGINE AND requested.ENGINE_LOCK_ID=waits.REQUESTING_ENGINE_LOCK_ID
    JOIN performance_schema.data_locks blocking ON blocking.ENGINE=waits.ENGINE AND blocking.ENGINE_LOCK_ID=waits.BLOCKING_ENGINE_LOCK_ID
    WHERE requested.OBJECT_SCHEMA='${schema}' AND requested.OBJECT_NAME='vaults' AND requested.INDEX_NAME='PRIMARY'`);
  return rows.map((row) => ({ requested: row[0] ?? '', blocking: row[1] ?? '' }));
}

/** EXPLAIN without ANALYZE plans the caller's actual statement without executing its operation. */
export function inspectQueryPlan(
  executor: QueryExecutorProvider,
  query: RawBuilder<unknown>,
): Promise<QueryResult<{ EXPLAIN: unknown }>> {
  return sql<{ EXPLAIN: unknown }>`EXPLAIN FORMAT=JSON ${query}`.execute(executor);
}

/** Connection-local archive mode must be observed without opening an unrelated admin session. */
export function inspectArchiveSession(
  executor: QueryExecutorProvider,
): Promise<QueryResult<{ id: number; flag: number | null }>> {
  return sql<{
    id: number;
    flag: number | null;
  }>`SELECT CONNECTION_ID() AS id, @iridium_audit_archive AS flag`.execute(executor);
}

/** Observe real partition names/bounds independently of the retention job's own classification. */
export function inspectAccessLogPartitions(
  executor: QueryExecutorProvider,
): Promise<QueryResult<{ name: string; boundary: string }>> {
  return sql<{
    name: string;
    boundary: string;
  }>`SELECT PARTITION_NAME AS name, PARTITION_DESCRIPTION AS boundary
    FROM information_schema.PARTITIONS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='access_log'
    ORDER BY PARTITION_ORDINAL_POSITION`.execute(executor);
}
