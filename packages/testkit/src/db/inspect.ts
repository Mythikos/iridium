/**
 * Read-only SQL observations used by database acceptance tests. These helpers return actual rows
 * without assertions, normalization or product schema imports. They use only a caller's executor;
 * they never create a pool, transaction, fixture or alternate server path.
 */
import { sql, type QueryExecutorProvider, type QueryResult } from 'kysely';

/** The values exposed by MySQL information_schema/performance_schema views used in fingerprints. */
export type DatabaseProbeCell = string | number | null;

/** One metadata row, with original column names retained for the independent fingerprint oracle. */
export type DatabaseProbeRow = Record<string, DatabaseProbeCell>;

/** Raw result groups whose sorting/normalization remains owned by the parity test. */
export interface SchemaProbeRows {
  readonly tables: QueryResult<DatabaseProbeRow>;
  readonly columns: QueryResult<DatabaseProbeRow>;
  readonly statistics: QueryResult<DatabaseProbeRow>;
  readonly foreignKeys: QueryResult<DatabaseProbeRow>;
  readonly triggers: QueryResult<DatabaseProbeRow>;
  readonly partitions: QueryResult<DatabaseProbeRow>;
  readonly variables: QueryResult<{ name: string; value: string }>;
  readonly collation: QueryResult<{ c: number }>;
}

/** Observe the exact connection and both lock waits without changing session state. */
export function inspectSessionLockTimeouts(
  executor: QueryExecutorProvider,
): Promise<QueryResult<{ id: number; row_wait: number; metadata_wait: number }>> {
  return sql<{ id: number; row_wait: number; metadata_wait: number }>`
    SELECT CONNECTION_ID() AS id, @@SESSION.innodb_lock_wait_timeout AS row_wait, @@SESSION.lock_wait_timeout AS metadata_wait
  `.execute(executor);
}

/** Observe whether a failed statement preserved the same physical connection. */
export function inspectConnectionIdentity(
  executor: QueryExecutorProvider,
): Promise<QueryResult<{ id: number }>> {
  return sql<{ id: number }>`SELECT CONNECTION_ID() AS id`.execute(executor);
}

/** Observe a named lock and its independent observing connection in the same round trip. */
export function inspectAdvisoryLock(
  executor: QueryExecutorProvider,
  name: string,
): Promise<QueryResult<{ owner: number | null; observer: number }>> {
  return sql<{
    owner: number | null;
    observer: number;
  }>`SELECT IS_USED_LOCK(${name}) AS owner, CONNECTION_ID() AS observer`.execute(executor);
}

/** Count connections visible to the caller's role for failed-boot cleanup checks. */
export async function inspectVisibleConnectionCount(
  executor: QueryExecutorProvider,
): Promise<number> {
  const result = await sql<{
    open: number | string;
  }>`SELECT COUNT(*) AS open FROM information_schema.processlist`.execute(executor);
  return Number(result.rows[0]?.open ?? 0);
}

/** Observe all create-user write targets in one statement, preserving the rollback oracle. */
export function inspectCreationCounts(executor: QueryExecutorProvider): Promise<
  QueryResult<{
    users: number;
    credentials: number;
    links: number;
    members: number;
    events: number;
  }>
> {
  return sql<{
    users: number;
    credentials: number;
    links: number;
    members: number;
    events: number;
  }>`
    SELECT (SELECT COUNT(*) FROM users) AS users,
      (SELECT COUNT(*) FROM user_credentials) AS credentials,
      (SELECT COUNT(*) FROM password_setup_tokens) AS links,
      (SELECT COUNT(*) FROM vault_members) AS members,
      (SELECT COUNT(*) FROM audit_events) AS events
  `.execute(executor);
}

/** Verify rolled-back privilege probes leave rows, owner generation and audit allocation unchanged. */
export function inspectGrantCriticalState(executor: QueryExecutorProvider): Promise<
  QueryResult<{
    audit_rows: number;
    command_rows: number;
    generation: string;
    next_audit_id: number | null;
  }>
> {
  return sql<{
    audit_rows: number;
    command_rows: number;
    generation: string;
    next_audit_id: number | null;
  }>`
    SELECT
      (SELECT COUNT(*) FROM audit_events) AS audit_rows,
      (SELECT COUNT(*) FROM session_revocation_commands) AS command_rows,
      (SELECT HEX(generation) FROM collab_owner_fence WHERE id = 1) AS generation,
      (SELECT AUTO_INCREMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audit_events') AS next_audit_id
  `.execute(executor);
}

/** Preserve both names and original timestamps when verifying a forward migration. */
export function inspectMigrationHistory(
  executor: QueryExecutorProvider,
  through: string,
): Promise<QueryResult<{ name: string; timestamp: string }>> {
  return sql<{
    name: string;
    timestamp: string;
  }>`SELECT name, timestamp FROM kysely_migration WHERE name <= ${through} ORDER BY name`.execute(
    executor,
  );
}

/** Query the physical metadata needed to validate table-engine/collation and matrix completeness. */
export function inspectSchemaTables(
  executor: QueryExecutorProvider,
  schema: string,
): Promise<QueryResult<{ t: string; engine: string; collation: string }>> {
  return sql<{ t: string; engine: string; collation: string }>`
    SELECT TABLE_NAME AS t, ENGINE AS engine, TABLE_COLLATION AS collation
      FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = ${schema} AND TABLE_TYPE = 'BASE TABLE'
  `.execute(executor);
}

/** List base tables lacking an actual PRIMARY index, independent of their source declarations. */
export function inspectTablesWithoutPrimaryKey(
  executor: QueryExecutorProvider,
  schema: string,
): Promise<QueryResult<{ t: string }>> {
  return sql<{ t: string }>`
    SELECT t.TABLE_NAME AS t
      FROM information_schema.TABLES t
      LEFT JOIN information_schema.STATISTICS s
        ON s.TABLE_SCHEMA = t.TABLE_SCHEMA AND s.TABLE_NAME = t.TABLE_NAME AND s.INDEX_NAME = 'PRIMARY'
     WHERE t.TABLE_SCHEMA = ${schema} AND t.TABLE_TYPE = 'BASE TABLE' AND s.INDEX_NAME IS NULL
  `.execute(executor);
}

/** Read live table/column pairs for the bidirectional hand-written schema comparison. */
export function inspectSchemaColumns(
  executor: QueryExecutorProvider,
  schema: string,
): Promise<QueryResult<{ t: string; c: string }>> {
  return sql<{
    t: string;
    c: string;
  }>`SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ${schema}`.execute(
    executor,
  );
}

/** Inspect the three actual shipped accounts, not the fixture's intended role configuration. */
export function inspectRoleAuthentication(
  executor: QueryExecutorProvider,
): Promise<QueryResult<{ user: string; plugin: string }>> {
  return sql<{
    user: string;
    plugin: string;
  }>`SELECT user, plugin FROM mysql.user WHERE user IN ('iridium_app','iridium_migrator','iridium_backup')`.execute(
    executor,
  );
}

/** Observe schema/global grants while restricting the account to one shipped role. */
export async function inspectRoleGrants(
  executor: QueryExecutorProvider,
  role: 'iridium_migrator' | 'iridium_backup',
): Promise<string> {
  const result = await sql<Record<string, string>>`SHOW GRANTS FOR ${role}@'%'`.execute(executor);
  return result.rows.map((entry) => Object.values(entry).join(' ')).join('\n');
}

/** Read effective application table/column privileges from both metadata views. */
export async function inspectApplicationPrivileges(
  executor: QueryExecutorProvider,
  schema: string,
): Promise<string[]> {
  const tableRows = await sql<{ t: string; p: string }>`
    SELECT TABLE_NAME AS t, PRIVILEGE_TYPE AS p
      FROM information_schema.TABLE_PRIVILEGES
     WHERE TABLE_SCHEMA = ${schema} AND GRANTEE = "'iridium_app'@'%'"
  `.execute(executor);
  const columnRows = await sql<{ t: string; c: string; p: string }>`
    SELECT TABLE_NAME AS t, COLUMN_NAME AS c, PRIVILEGE_TYPE AS p
      FROM information_schema.COLUMN_PRIVILEGES
     WHERE TABLE_SCHEMA = ${schema} AND GRANTEE = "'iridium_app'@'%'"
  `.execute(executor);
  return [
    ...tableRows.rows.map((entry) => `${entry.t}.${entry.p}`),
    ...columnRows.rows.map((entry) => `${entry.t}.${entry.p}(${entry.c})`),
  ].toSorted();
}

/** Count actual columns before/after replaying an interrupted migration tail. */
export function inspectSchemaColumnCount(
  executor: QueryExecutorProvider,
  schema: string,
): Promise<QueryResult<{ n: number }>> {
  return sql<{
    n: number;
  }>`SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ${schema}`.execute(
    executor,
  );
}

/** Read the actual guarded indexes after an idempotent migration replay. */
export function inspectGuardedIndexes(
  executor: QueryExecutorProvider,
  schema: string,
): Promise<QueryResult<{ index_name: string; n: number }>> {
  return sql<{ index_name: string; n: number }>`
    SELECT INDEX_NAME AS index_name, COUNT(DISTINCT SEQ_IN_INDEX) AS n
      FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = ${schema}
       AND INDEX_NAME IN ('uq_oauth_consents_live', 'ix_tokens_consent', 'ix_tokens_client',
                          'uq_sibling', 'ft_note_search', 'ix_proj_fm_tags', 'ix_proj_fm_aliases')
     GROUP BY INDEX_NAME
  `.execute(executor);
}

/** Exercise a real SELECT through the deadline adapter; only its unit I/O transport is scripted. */
export function inspectTransportValue(
  executor: QueryExecutorProvider,
): Promise<QueryResult<{ value: number }>> {
  return sql<{ value: number }>`SELECT 1 AS value`.execute(executor);
}

/** Read the unnormalized schema facts required by the two-engine fingerprint proof. */
export async function inspectSchemaFingerprint(
  executor: QueryExecutorProvider,
  schema: string,
  variableNames: readonly string[],
): Promise<SchemaProbeRows> {
  const tables = await sql<DatabaseProbeRow>`
    SELECT TABLE_NAME, ENGINE, TABLE_COLLATION, ROW_FORMAT, CREATE_OPTIONS
      FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = ${schema} AND TABLE_TYPE = 'BASE TABLE'
  `.execute(executor);
  const columns = await sql<DatabaseProbeRow>`
    SELECT TABLE_NAME, ORDINAL_POSITION, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE,
           COLUMN_DEFAULT, EXTRA, COLLATION_NAME, GENERATION_EXPRESSION, COLUMN_KEY
      FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ${schema}
  `.execute(executor);
  const statistics = await sql<DatabaseProbeRow>`
    SELECT TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX, COLUMN_NAME, COLLATION, SUB_PART, PACKED,
           NULLABLE, INDEX_TYPE, NON_UNIQUE, EXPRESSION, IS_VISIBLE
      FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = ${schema}
  `.execute(executor);
  const foreignKeys = await sql<DatabaseProbeRow>`
    SELECT rc.CONSTRAINT_NAME, rc.TABLE_NAME, rc.REFERENCED_TABLE_NAME, rc.UPDATE_RULE,
           rc.DELETE_RULE, kcu.COLUMN_NAME, kcu.REFERENCED_COLUMN_NAME, kcu.ORDINAL_POSITION
      FROM information_schema.REFERENTIAL_CONSTRAINTS rc
      JOIN information_schema.KEY_COLUMN_USAGE kcu
        ON kcu.CONSTRAINT_SCHEMA = rc.CONSTRAINT_SCHEMA
       AND kcu.CONSTRAINT_NAME = rc.CONSTRAINT_NAME
       AND kcu.TABLE_NAME = rc.TABLE_NAME
     WHERE rc.CONSTRAINT_SCHEMA = ${schema}
  `.execute(executor);
  const triggers = await sql<DatabaseProbeRow>`
    SELECT TRIGGER_NAME, EVENT_MANIPULATION, EVENT_OBJECT_TABLE, ACTION_TIMING,
           ACTION_ORIENTATION, ACTION_STATEMENT
      FROM information_schema.TRIGGERS
     WHERE TRIGGER_SCHEMA = ${schema}
  `.execute(executor);
  const partitions = await sql<DatabaseProbeRow>`
    SELECT TABLE_NAME, PARTITION_NAME, PARTITION_ORDINAL_POSITION, PARTITION_METHOD,
           PARTITION_EXPRESSION, PARTITION_DESCRIPTION
      FROM information_schema.PARTITIONS
     WHERE TABLE_SCHEMA = ${schema} AND PARTITION_NAME IS NOT NULL
  `.execute(executor);
  const variables = await sql<{ name: string; value: string }>`
    SELECT VARIABLE_NAME AS name, VARIABLE_VALUE AS value
      FROM performance_schema.global_variables
     WHERE VARIABLE_NAME IN (${sql.join(variableNames)})
  `.execute(executor);
  const collation = await sql<{ c: number }>`
    SELECT COUNT(*) AS c FROM information_schema.COLLATIONS
     WHERE COLLATION_NAME = 'utf8mb4_0900_as_ci'
  `.execute(executor);
  return { tables, columns, statistics, foreignKeys, triggers, partitions, variables, collation };
}
