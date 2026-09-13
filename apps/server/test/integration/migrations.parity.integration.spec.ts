/**
 * `migrations.parity.integration` (12-milestones.md section 4.6, 10-testing-and-quality.md "Ops,
 * restore, release and the seam contract suites").
 *
 * The two required engines must produce the **same** schema, not merely a legal one. A construct
 * that is legal on both lines but yields a different index, collation or generated-column shape on
 * each is exactly the class of defect prose cannot catch, and it is why this file compares the
 * produced schema rather than the statements that produced it.
 *
 * **How the two-image comparison is completed.** A single test process sees one engine, so this file
 * does not compare 8.4.11 with 9.7.2 directly: it reduces the migrated schema to a fingerprint and
 * compares that against the committed `@iridium/sql-policy/schema-fingerprint.json` -- the SQL policy
 * is a workspace package (`tooling/sql` on disk), so the fingerprint arrives through a declared
 * dependency rather than through a path that climbs out of `apps/server`. `ci.yml`'s
 * `integration` job is a two-entry matrix -- `mysql:8.4.11` and `mysql:9.7.2-oraclelinux9`, both
 * merge-blocking -- and each entry runs this file against the same committed fingerprint. Equality
 * with one fingerprint on both entries is equality with each other, and it is a stronger statement
 * than a pairwise comparison would be: a change that moved both engines together would still have to
 * be reviewed as a diff to a committed file. A divergence turns exactly one matrix entry red and the
 * failure names the differing rows.
 *
 * Regenerate the fingerprint deliberately, never as a side effect: `IRIDIUM_WRITE_SCHEMA_FINGERPRINT=1`
 * rewrites the file from the engine the run selected, and the diff is then reviewed like any other.
 *
 * The fingerprint deliberately excludes `information_schema.STATISTICS.CARDINALITY`, which is a
 * sampled estimate and not a schema property. It also excludes the two `my.cnf` sizing lines --
 * `innodb_buffer_pool_size` and `innodb_redo_log_capacity` -- because they are tuning rather than
 * schema prerequisites, the server rounds them, and a test container is entitled to shrink them: a
 * 2 GiB redo log is 2 GiB of a runner's memory when `/var/lib/mysql` is a tmpfs. Everything the
 * schema actually depends on (03-data-model.md section 1.1) is in the list below.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import expectedFingerprint from '@iridium/sql-policy/schema-fingerprint.json' with { type: 'json' };
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDb, parseDatabaseUrl } from '../../src/db/index.ts';
import { createMaintDb, migrateToLatest } from '../../src/db/migrator.ts';
import type { Database } from '../../src/db/schema.ts';
import { IRIDIUM_SCHEMA, startIridiumMysql, type IridiumMysql } from '../db-mysql-container.ts';

/**
 * The regeneration path, resolved through the same package export the comparison reads, so
 * `IRIDIUM_WRITE_SCHEMA_FINGERPRINT=1` can never write to a different file than the one asserted
 * against. The workspace link makes this the real `tooling/sql/schema-fingerprint.json`.
 */
const FINGERPRINT_PATH = fileURLToPath(
  import.meta.resolve('@iridium/sql-policy/schema-fingerprint.json'),
);

/**
 * The `my.cnf` settings the schema itself depends on (03-data-model.md section 1.1). They belong in
 * the fingerprint because two engines that resolve the same file to different values would produce
 * the same DDL and a different FULLTEXT index.
 */
const SCHEMA_PREREQUISITE_VARIABLES = [
  'character_set_server',
  'collation_server',
  'authentication_policy',
  'innodb_ft_min_token_size',
  'innodb_ft_enable_stopword',
  'innodb_flush_log_at_trx_commit',
  'sync_binlog',
  'log_bin',
  'log_bin_trust_function_creators',
  'binlog_expire_logs_seconds',
  'binlog_format',
  'binlog_row_image',
  'gtid_mode',
  'max_allowed_packet',
  'sql_require_primary_key',
  'cte_max_recursion_depth',
  'max_connections',
  'local_infile',
];

interface SchemaFingerprint {
  tables: string[];
  columns: string[];
  statistics: string[];
  foreignKeys: string[];
  triggers: string[];
  partitions: string[];
  variables: string[];
  utf8mb4_0900_as_ci: number;
}

/** One `information_schema` cell: the views return only strings, numbers and NULLs. */
type Cell = string | number | null;
type InfoRow = Record<string, Cell>;

const n = (value: Cell | undefined): string =>
  value === null || value === undefined ? '~' : String(value);

async function fingerprint(db: Kysely<Database>, schema: string): Promise<SchemaFingerprint> {
  const tables = await sql<InfoRow>`
    SELECT TABLE_NAME, ENGINE, TABLE_COLLATION, ROW_FORMAT, CREATE_OPTIONS
      FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = ${schema} AND TABLE_TYPE = 'BASE TABLE'
  `.execute(db);

  const columns = await sql<InfoRow>`
    SELECT TABLE_NAME, ORDINAL_POSITION, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE,
           COLUMN_DEFAULT, EXTRA, COLLATION_NAME, GENERATION_EXPRESSION, COLUMN_KEY
      FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ${schema}
  `.execute(db);

  const statistics = await sql<InfoRow>`
    SELECT TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX, COLUMN_NAME, COLLATION, SUB_PART, PACKED,
           NULLABLE, INDEX_TYPE, NON_UNIQUE, EXPRESSION, IS_VISIBLE
      FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = ${schema}
  `.execute(db);

  const foreignKeys = await sql<InfoRow>`
    SELECT rc.CONSTRAINT_NAME, rc.TABLE_NAME, rc.REFERENCED_TABLE_NAME, rc.UPDATE_RULE,
           rc.DELETE_RULE, kcu.COLUMN_NAME, kcu.REFERENCED_COLUMN_NAME, kcu.ORDINAL_POSITION
      FROM information_schema.REFERENTIAL_CONSTRAINTS rc
      JOIN information_schema.KEY_COLUMN_USAGE kcu
        ON kcu.CONSTRAINT_SCHEMA = rc.CONSTRAINT_SCHEMA
       AND kcu.CONSTRAINT_NAME = rc.CONSTRAINT_NAME
       AND kcu.TABLE_NAME = rc.TABLE_NAME
     WHERE rc.CONSTRAINT_SCHEMA = ${schema}
  `.execute(db);

  const triggers = await sql<InfoRow>`
    SELECT TRIGGER_NAME, EVENT_MANIPULATION, EVENT_OBJECT_TABLE, ACTION_TIMING,
           ACTION_ORIENTATION, ACTION_STATEMENT
      FROM information_schema.TRIGGERS
     WHERE TRIGGER_SCHEMA = ${schema}
  `.execute(db);

  const partitions = await sql<InfoRow>`
    SELECT TABLE_NAME, PARTITION_NAME, PARTITION_ORDINAL_POSITION, PARTITION_METHOD,
           PARTITION_EXPRESSION, PARTITION_DESCRIPTION
      FROM information_schema.PARTITIONS
     WHERE TABLE_SCHEMA = ${schema} AND PARTITION_NAME IS NOT NULL
  `.execute(db);

  const variables = await sql<{ name: string; value: string }>`
    SELECT VARIABLE_NAME AS name, VARIABLE_VALUE AS value
      FROM performance_schema.global_variables
     WHERE VARIABLE_NAME IN (${sql.join(SCHEMA_PREREQUISITE_VARIABLES)})
  `.execute(db);

  const collation = await sql<{ c: number }>`
    SELECT COUNT(*) AS c FROM information_schema.COLLATIONS
     WHERE COLLATION_NAME = 'utf8mb4_0900_as_ci'
  `.execute(db);

  const row = (values: ReadonlyArray<Cell | undefined>): string => values.map(n).join('|');

  return {
    tables: tables.rows
      .map((r) =>
        row([
          r['TABLE_NAME'],
          r['ENGINE'],
          r['TABLE_COLLATION'],
          r['ROW_FORMAT'],
          r['CREATE_OPTIONS'],
        ]),
      )
      .toSorted(),
    columns: columns.rows
      .map((r) =>
        row([
          r['TABLE_NAME'],
          r['ORDINAL_POSITION'],
          r['COLUMN_NAME'],
          r['COLUMN_TYPE'],
          r['IS_NULLABLE'],
          r['COLUMN_DEFAULT'],
          r['EXTRA'],
          r['COLLATION_NAME'],
          r['GENERATION_EXPRESSION'],
          r['COLUMN_KEY'],
        ]),
      )
      .toSorted(),
    statistics: statistics.rows
      .map((r) =>
        row([
          r['TABLE_NAME'],
          r['INDEX_NAME'],
          r['SEQ_IN_INDEX'],
          r['COLUMN_NAME'],
          r['COLLATION'],
          r['SUB_PART'],
          r['PACKED'],
          r['NULLABLE'],
          r['INDEX_TYPE'],
          r['NON_UNIQUE'],
          r['EXPRESSION'],
          r['IS_VISIBLE'],
        ]),
      )
      .toSorted(),
    foreignKeys: foreignKeys.rows
      .map((r) =>
        row([
          r['CONSTRAINT_NAME'],
          r['TABLE_NAME'],
          r['COLUMN_NAME'],
          r['ORDINAL_POSITION'],
          r['REFERENCED_TABLE_NAME'],
          r['REFERENCED_COLUMN_NAME'],
          r['UPDATE_RULE'],
          r['DELETE_RULE'],
        ]),
      )
      .toSorted(),
    triggers: triggers.rows
      .map((r) =>
        row([
          r['TRIGGER_NAME'],
          r['ACTION_TIMING'],
          r['EVENT_MANIPULATION'],
          r['EVENT_OBJECT_TABLE'],
          r['ACTION_ORIENTATION'],
          n(r['ACTION_STATEMENT']).replaceAll(/\s+/g, ' ').trim(),
        ]),
      )
      .toSorted(),
    partitions: partitions.rows
      .map((r) =>
        row([
          r['TABLE_NAME'],
          r['PARTITION_NAME'],
          r['PARTITION_ORDINAL_POSITION'],
          r['PARTITION_METHOD'],
          r['PARTITION_EXPRESSION'],
          r['PARTITION_DESCRIPTION'],
        ]),
      )
      .toSorted(),
    variables: variables.rows.map((r) => `${r.name}=${r.value}`).toSorted(),
    utf8mb4_0900_as_ci: collation.rows[0]?.c ?? 0,
  };
}

describe('migrations.parity.integration [area:ops]', () => {
  let mysql: IridiumMysql;
  let maint: ReturnType<typeof createMaintDb>;
  let app: ReturnType<typeof createDb>;
  let actual: SchemaFingerprint;

  beforeAll(async () => {
    mysql = await startIridiumMysql();
    maint = createMaintDb(mysql.migratorUrl());
    await migrateToLatest({ db: maint.db, target: maint.target });
    app = createDb(parseDatabaseUrl(mysql.rootUrl()), 2);
    actual = await fingerprint(app.db, IRIDIUM_SCHEMA);
    if (process.env['IRIDIUM_WRITE_SCHEMA_FINGERPRINT'] === '1') {
      writeFileSync(FINGERPRINT_PATH, `${JSON.stringify(actual, null, 2)}\n`, 'utf8');
    }
  }, 600_000);

  afterAll(async () => {
    await app?.db.destroy();
    await maint?.db.destroy();
    await mysql?.stop();
  }, 120_000);

  it('produces the committed column set: type, nullability, collation, EXTRA and generation expression', () => {
    expect(actual.columns).toEqual(expectedFingerprint.columns);
  });

  it('produces the committed index set: INDEX_TYPE, SUB_PART, EXPRESSION and NULLABLE', () => {
    expect(actual.statistics).toEqual(expectedFingerprint.statistics);
  });

  it('produces the committed table set: InnoDB and one TABLE_COLLATION per table', () => {
    expect(actual.tables).toEqual(expectedFingerprint.tables);
  });

  it('produces the committed foreign keys, every one of them RESTRICT', () => {
    expect(actual.foreignKeys).toEqual(expectedFingerprint.foreignKeys);
    for (const key of actual.foreignKeys) {
      expect(key.endsWith('|NO ACTION|NO ACTION') || key.endsWith('|RESTRICT|RESTRICT')).toBe(true);
    }
  });

  it('produces the committed audit triggers on both the live table and the archive', () => {
    expect(actual.triggers).toEqual(expectedFingerprint.triggers);
    expect(actual.triggers).toHaveLength(4);
  });

  it('produces the committed access_log partitions, including the p_overflow catch-all', () => {
    expect(actual.partitions).toEqual(expectedFingerprint.partitions);
    expect(actual.partitions.some((p) => p.includes('|p_overflow|'))).toBe(true);
  });

  it('resolves the shipped my.cnf to the committed values on this engine', () => {
    expect(actual.variables).toEqual(expectedFingerprint.variables);
  });

  it("reports exactly one row for SHOW COLLATION LIKE 'utf8mb4_0900_as_ci'", () => {
    expect(actual.utf8mb4_0900_as_ci).toBe(1);
    expect(actual.utf8mb4_0900_as_ci).toBe(expectedFingerprint.utf8mb4_0900_as_ci);
  });
});
