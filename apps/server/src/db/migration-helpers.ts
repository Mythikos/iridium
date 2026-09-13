/**
 * Idempotent guards for the migration set (03-data-model.md section 14.2).
 *
 * MySQL performs an implicit commit for DDL, so a migration cannot be rolled back by a transaction
 * wrapper: a re-run of an interrupted migration must be a no-op rather than an error. `CREATE TABLE
 * IF NOT EXISTS` and `CREATE TRIGGER IF NOT EXISTS` (MySQL 8.0.29+, inside the 8.4.11 floor) cover
 * most of the set; everything else -- a unique key over a generated column, a FULLTEXT index, a
 * multi-valued index, an added column -- has no `IF NOT EXISTS` form and is guarded by the
 * `information_schema` probes below.
 */
import { sql, type Kysely } from 'kysely';

/** The schema the connection is using. Every probe is scoped to it. */
export async function currentSchema<DB>(db: Kysely<DB>): Promise<string> {
  const result = await sql<{
    schema_name: string | null;
  }>`SELECT DATABASE() AS schema_name`.execute(db);
  const schema = result.rows[0]?.schema_name;
  if (schema === undefined || schema === null) {
    throw new Error('the migrating connection has no default schema');
  }
  return schema;
}

/** True when `table` already carries an index named `index` in the current schema. */
export async function indexExists<DB>(
  db: Kysely<DB>,
  table: string,
  index: string,
): Promise<boolean> {
  const result = await sql<{ n: number }>`
    SELECT COUNT(*) AS n
      FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ${table}
       AND INDEX_NAME = ${index}
  `.execute(db);
  return (result.rows[0]?.n ?? 0) > 0;
}

/** True when `table` already carries `column` in the current schema. */
export async function columnExists<DB>(
  db: Kysely<DB>,
  table: string,
  column: string,
): Promise<boolean> {
  const result = await sql<{ n: number }>`
    SELECT COUNT(*) AS n
      FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ${table}
       AND COLUMN_NAME = ${column}
  `.execute(db);
  return (result.rows[0]?.n ?? 0) > 0;
}

// There is deliberately no `tableExists` or `triggerExists` probe: `CREATE TABLE IF NOT EXISTS` and
// `CREATE TRIGGER IF NOT EXISTS` cover both, and 03-data-model.md section 14.2 reaches for an
// `information_schema` probe only where no `IF NOT EXISTS` form exists. A probe that duplicates a
// clause the engine already offers is a second way to be wrong about the same condition.
