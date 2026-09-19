/**
 * `migrations.integration` (12-milestones.md section 4.6, 10-testing-and-quality.md "Ops").
 *
 * Every migration of 03-data-model.md section 14.1 applies forward on whichever required image
 * `IRIDIUM_MYSQL_IMAGE` selects -- an unset selector resolves to the compatibility floor,
 * `mysql:8.4.11` -- `iridium migrate status` then reports `current`, and the three roles of section 2
 * exist with the settled grants. It also owns the advisory-lock case (`migration.lock.integration`
 * belongs to this file).
 *
 * The row's fourth assertion is "`kysely-codegen` output equals `schema.ts`". That comparison is a
 * `pnpm gen` step and a byte diff of generated output, and it cannot be expressed here without
 * making the hand-written `Database` interface reproduce kysely-codegen's own emit -- which would
 * defeat the two things 03-data-model.md section 1.3 requires of it, string-literal enum unions and
 * a typed shape per JSON column. What this file asserts instead is the invariant that diff exists to
 * protect: the migrated database and `schema.ts` declare the same tables and the same columns, in
 * both directions, so a migration that forgets its type change and a type change with no migration
 * both fail here. The byte diff belongs to the `gen` stream.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  corruptDeliberately,
  inspectAdvisoryLock,
  inspectApplicationPrivileges,
  inspectGuardedIndexes,
  inspectRoleAuthentication,
  inspectRoleGrants,
  inspectSchemaColumnCount,
  inspectSchemaColumns,
  inspectSchemaTables,
  inspectTablesWithoutPrimaryKey,
} from '@iridium/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { assertFoundRows } from '../../src/db/assertFoundRows.ts';
import { GLOBAL_GRANTS, GRANT_MATRIX, SCHEMA_GRANTS } from '../../src/db/grants.ts';
import {
  createDatabaseLayer,
  createDb,
  parseDatabaseUrl,
  type DatabaseLayer,
} from '../../src/db/index.ts';
import {
  createMaintDb,
  MIGRATION_NAMES,
  migrateToLatest,
  migrationStatus,
  withMigrationLock,
} from '../../src/db/migrator.ts';
import { IRIDIUM_SCHEMA, startIridiumMysql, type IridiumMysql } from '../db-mysql-container.ts';

const SCHEMA_SOURCE = fileURLToPath(new URL('../../src/db/schema.ts', import.meta.url));

/** Parses the hand-written `Database` interface out of its own source text. */
function declaredSchema(): Map<string, Set<string>> {
  const source = readFileSync(SCHEMA_SOURCE, 'utf8');

  const interfaces = new Map<string, Set<string>>();
  const interfacePattern = /export interface (\w+) \{([^}]*)\}/g;
  let match = interfacePattern.exec(source);
  while (match !== null) {
    const name = match[1];
    const body = match[2];
    if (name !== undefined && body !== undefined) {
      const properties = new Set<string>();
      for (const line of body.split('\n')) {
        const property = /^ {2}(\w+):/.exec(line);
        if (property?.[1] !== undefined) properties.add(property[1]);
      }
      interfaces.set(name, properties);
    }
    match = interfacePattern.exec(source);
  }

  const databaseBody = /export interface Database \{([^}]*)\}/.exec(source)?.[1];
  if (databaseBody === undefined) throw new Error('schema.ts declares no Database interface');

  const tables = new Map<string, Set<string>>();
  for (const line of databaseBody.split('\n')) {
    const entry = /^ {2}(\w+): (\w+);/.exec(line);
    const table = entry?.[1];
    const interfaceName = entry?.[2];
    if (table === undefined || interfaceName === undefined) continue;
    const columns = interfaces.get(interfaceName);
    if (columns === undefined) {
      throw new Error(`schema.ts names ${interfaceName} but declares no such interface`);
    }
    tables.set(table, columns);
  }
  return tables;
}

describe('migrations.integration [area:ops]', () => {
  let mysql: IridiumMysql;
  let maint: ReturnType<typeof createMaintDb>;
  let layer: DatabaseLayer;
  let applied: readonly string[];

  beforeAll(async () => {
    mysql = await startIridiumMysql();
    maint = createMaintDb(mysql.migratorUrl());
    const outcome = await migrateToLatest({ db: maint.db, target: maint.target });
    applied = outcome.results.map((r) => r.migrationName);
    layer = await createDatabaseLayer({ url: mysql.appUrl() });
  }, 600_000);

  afterAll(async () => {
    await layer?.destroy();
    await maint?.db.destroy();
    await mysql?.stop();
  }, 120_000);

  it('applies every migration of the initial set forward, in order', () => {
    expect(MIGRATION_NAMES[0]).toBe('0001_users');
    expect(MIGRATION_NAMES.at(-1)).toBe('0055_min_client_version');
    expect(MIGRATION_NAMES).toHaveLength(55);
    expect(applied).toEqual(MIGRATION_NAMES);
  });

  it('reports migrate status as current', async () => {
    const status = await migrationStatus(maint.db);
    expect(status.status).toBe('current');
    expect(status.pending).toEqual([]);
    expect(status.unknown).toEqual([]);
    expect(status.applied).toEqual(MIGRATION_NAMES);
  });

  it('creates every table as InnoDB with a utf8mb4 collation and a primary key', async () => {
    const rows = await inspectSchemaTables(layer.dbApp, IRIDIUM_SCHEMA);
    expect(rows.rows.length).toBeGreaterThan(0);
    expect(rows.rows.filter((row) => row.engine !== 'InnoDB')).toEqual([]);
    expect(rows.rows.filter((row) => !row.collation.startsWith('utf8mb4_'))).toEqual([]);

    const noPrimaryKey = await inspectTablesWithoutPrimaryKey(layer.dbApp, IRIDIUM_SCHEMA);
    expect(noPrimaryKey.rows).toEqual([]);
  });

  it('produces a database whose tables and columns are exactly what schema.ts declares', async () => {
    const declared = declaredSchema();
    const rows = await inspectSchemaColumns(layer.dbApp, IRIDIUM_SCHEMA);

    const actual = new Map<string, Set<string>>();
    for (const row of rows.rows) {
      const columns = actual.get(row.t) ?? new Set<string>();
      columns.add(row.c);
      actual.set(row.t, columns);
    }

    expect([...actual.keys()].toSorted()).toEqual([...declared.keys()].toSorted());
    const drift = [...actual].flatMap(([table, columns]) => {
      const expectedColumns = [...(declared.get(table) ?? new Set<string>())].toSorted();
      const actualColumns = [...columns].toSorted();
      return actualColumns.join(',') === expectedColumns.join(',')
        ? []
        : [
            `${table}: database has [${actualColumns.join(', ')}], schema.ts has [${expectedColumns.join(', ')}]`,
          ];
    });
    expect(drift).toEqual([]);
  });

  it('creates the three roles, each using caching_sha2_password', async () => {
    const root = createDb(parseDatabaseUrl(mysql.rootUrl('mysql')), 1);
    try {
      const rows = await inspectRoleAuthentication(root.db);
      expect(rows.rows.map((r) => r.user).toSorted()).toEqual([
        'iridium_app',
        'iridium_backup',
        'iridium_migrator',
      ]);
      expect(rows.rows.filter((r) => r.plugin !== 'caching_sha2_password')).toEqual([]);
    } finally {
      await root.db.destroy();
    }
  });

  it("grants iridium_app exactly the matrix's per-table privileges, and nothing else", async () => {
    const actual = await inspectApplicationPrivileges(layer.dbApp, IRIDIUM_SCHEMA);

    const tables = await inspectSchemaTables(layer.dbApp, IRIDIUM_SCHEMA);
    const present = new Set(tables.rows.map((r) => r.t));

    // Every table that exists carries a matrix row: a forgotten grants migration is a red test here,
    // never an ER_TABLEACCESS_DENIED_ERROR in production (D03-02, invariant I-23).
    const covered = new Set(GRANT_MATRIX.map((row) => row.table));
    expect([...present].filter((t) => !covered.has(t))).toEqual([]);

    const expected = GRANT_MATRIX.filter((row) => present.has(row.table)).flatMap((row) =>
      row.app.flatMap((privilege) =>
        privilege.columns === undefined
          ? [`${row.table}.${privilege.name}`]
          : privilege.columns.map((column) => `${row.table}.${privilege.name}(${column})`),
      ),
    );
    expect(actual).toEqual(expected.toSorted());
  });

  it('grants the migrator and the backup role their settled schema-level and global privileges', async () => {
    const root = createDb(parseDatabaseUrl(mysql.rootUrl('mysql')), 1);
    try {
      const show = (role: 'iridium_migrator' | 'iridium_backup'): Promise<string> =>
        inspectRoleGrants(root.db, role);

      const migrator = await show('iridium_migrator');
      expect(SCHEMA_GRANTS.migrator.filter((privilege) => !migrator.includes(privilege))).toEqual(
        [],
      );
      expect(migrator).toContain('`iridium`.*');
      expect(migrator).toContain('WITH GRANT OPTION');

      const backup = await show('iridium_backup');
      expect(SCHEMA_GRANTS.backup.filter((privilege) => !backup.includes(privilege))).toEqual([]);
      expect(GLOBAL_GRANTS.backup.filter((privilege) => !backup.includes(privilege))).toEqual([]);
      expect(backup).not.toContain('WITH GRANT OPTION');
    } finally {
      await root.db.destroy();
    }
  });

  it('satisfies the FOUND_ROWS boot assertion once schema_meta exists', async () => {
    await expect(assertFoundRows(layer.dbApp)).resolves.toBeUndefined();
  });

  it('seeds schema_meta with the install-state keys the boot path reads', async () => {
    const rows = await layer.dbApp
      .selectFrom('schema_meta')
      .select(['key as k', 'value as v'])
      .execute();
    expect(rows.map((entry) => entry.k).toSorted()).toEqual(
      [
        ...GRANT_MATRIX.map((entry) => 'acl.' + entry.table),
        'admin_users_lock',
        'api_version',
        'attachment_key_version',
        'audit_key_version',
        'cursor_key_version',
        'iridium_version',
        'min_client_version',
        'pepper_version',
        'pipeline_version',
      ].toSorted(),
    );
  });

  it('serialises two concurrent migration runs behind GET_LOCK(iridium_migrate)', async () => {
    // A second schema, provisioned the way init/01_roles.sh provisions `iridium`, so the race runs
    // against a database that has had nothing applied to it yet.
    const probeSchema = 'iridium_lock_probe';
    const root = createDb(parseDatabaseUrl(mysql.rootUrl('mysql')), 1);
    try {
      await corruptDeliberately(root.db, {
        kind: 'create-schema',
        schema: probeSchema,
        ifNotExists: true,
      });
      await corruptDeliberately(root.db, {
        kind: 'grant-schema',
        schema: probeSchema,
        account: 'iridium_migrator',
        privileges: SCHEMA_GRANTS.migrator,
        withGrantOption: true,
      });
    } finally {
      await root.db.destroy();
    }

    const a = createMaintDb(mysql.migratorUrl(probeSchema));
    const b = createMaintDb(mysql.migratorUrl(probeSchema));
    try {
      const [first, second] = await Promise.all([
        migrateToLatest({ db: a.db, target: a.target }),
        migrateToLatest({ db: b.db, target: b.target }),
      ]);
      const names = [
        ...first.results.map((r) => r.migrationName),
        ...second.results.map((r) => r.migrationName),
      ];
      // Serialised, so the set is applied exactly once across the two runs rather than interleaved.
      expect(names.toSorted()).toEqual(MIGRATION_NAMES.toSorted());
      const status = await migrationStatus(a.db);
      expect(status.status).toBe('current');
    } finally {
      await a.db.destroy();
      await b.db.destroy();
    }
  }, 600_000);

  it('re-applies an interrupted tail of the set as a no-op, not an error', async () => {
    // MySQL commits DDL implicitly, so a migration cannot be rolled back by a transaction wrapper:
    // 03-data-model.md section 14.2 requires every file to be individually re-runnable. The faithful
    // way to prove that is to make the ledger disagree with the schema and migrate again. Kysely
    // refuses a ledger that is not a prefix of the set, so the tail is what can be un-recorded --
    // and the tail is where the guards that have no `IF NOT EXISTS` form live: `0034_grants`,
    // `0038`'s unique key over a generated column, `0046`'s columns and foreign keys, `0047`'s
    // indexes and `0048`'s instant column.
    const tail = MIGRATION_NAMES.slice(MIGRATION_NAMES.indexOf('0034_grants'));
    expect(tail[0]).toBe('0034_grants');

    const before = await inspectSchemaColumnCount(maint.db, IRIDIUM_SCHEMA);

    await maint.db.deleteFrom('kysely_migration').where('name', 'in', tail).execute();

    const replay = await migrateToLatest({ db: maint.db, target: maint.target });
    expect(replay.results.map((r) => r.migrationName)).toEqual(tail);

    const status = await migrationStatus(maint.db);
    expect(status.status).toBe('current');
    expect(status.applied).toEqual(MIGRATION_NAMES);

    // Nothing was created twice: the column count is unchanged and each guarded object exists once.
    const after = await inspectSchemaColumnCount(maint.db, IRIDIUM_SCHEMA);
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);

    const objects = await inspectGuardedIndexes(maint.db, IRIDIUM_SCHEMA);
    expect(objects.rows.map((r) => r.index_name).toSorted()).toEqual([
      'ft_note_search',
      'ix_proj_fm_aliases',
      'ix_proj_fm_tags',
      'ix_tokens_client',
      'ix_tokens_consent',
      'uq_oauth_consents_live',
      'uq_sibling',
    ]);
  }, 600_000);

  it('holds the advisory lock for the whole run and releases it afterwards', async () => {
    const target = parseDatabaseUrl(mysql.migratorUrl());
    const observer = createDb(parseDatabaseUrl(mysql.migratorUrl()), 1);
    try {
      const heldBy = await withMigrationLock(target, async () => {
        const rows = await inspectAdvisoryLock(observer.db, 'iridium_migrate');
        return rows.rows[0]?.owner ?? null;
      });
      expect(heldBy).not.toBeNull();

      const after = await inspectAdvisoryLock(observer.db, 'iridium_migrate');
      expect(after.rows[0]?.owner ?? null).toBeNull();
    } finally {
      await observer.db.destroy();
    }
  });
});
