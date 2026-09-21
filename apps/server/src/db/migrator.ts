/**
 * The migrator wrapper the CLI and the boot path share (03-data-model.md section 14.3,
 * 11-operations-and-deployment.md "Migrations at startup").
 *
 * Two things make this a wrapper rather than a direct `Migrator` call:
 *
 *  - **Mutual exclusion.** Kysely's own `kysely_migration_lock` row lock cannot survive MySQL's
 *    implicit commit for DDL, so it is not the real mutual exclusion. `SELECT GET_LOCK(
 *    'iridium_migrate', 60)` is: two operators, or two container entrypoints racing during a rolling
 *    restart, serialise rather than interleave. The lock is a *session* lock, so it is held on a
 *    connection of its own -- never one checked out of `dbMaint`, whose pool is a single connection
 *    the migration statements themselves need -- and released in a `finally`.
 *  - **Forward-only in production.** `migrateTo` refuses with exit `3` when the named target is
 *    behind the recorded head and `NODE_ENV=production`: rolling a schema back is a restore, not a
 *    migration (A7). The wrapper offers no `down` of its own, which is the point -- local
 *    development and the scaffolding commands go through `kysely migrate:down`, the one thing
 *    `kysely.config.ts` exists for, and a bare `kysely` invocation is never what an operator is
 *    pointed at (`iridium migrate status|up|to`).
 *
 * `dbMaint` is the `iridium_migrator` role and exists only when `DATABASE_MIGRATE_URL` is configured.
 * The application's own `DATABASE_URL` (`iridium_app`) cannot execute DDL at all, so a runaway
 * application can never migrate.
 */
import { Kysely, MysqlDialect } from 'kysely';
import { Migrator, type MigrationResult } from 'kysely/migration';
import { createPool, type Pool } from 'mysql2';
import { createConnection, type RowDataPacket } from 'mysql2/promise';

import { readGrantProvenance } from './grants.ts';
import {
  bundledMigrationProvider,
  LONG_RUNNING_MIGRATIONS,
  MIGRATION_NAMES,
} from './migrations.ts';
import {
  DB_CONNECT_TIMEOUT_MS_DEFAULT,
  DB_POOL_SIZE,
  parseDatabaseUrl,
  poolOptions,
  type MysqlConnectionTarget,
} from './pool.ts';
import type { Database } from './schema.ts';
import type { DbLogger } from './version-floor.ts';

/** The named lock every migration run holds for its whole duration. */
export const MIGRATION_LOCK_NAME = 'iridium_migrate';

/** How long `GET_LOCK` waits before giving up, in seconds. */
export const MIGRATION_LOCK_TIMEOUT_SECONDS = 60;

/** Thrown when another process holds the migration lock; `main.ts` maps `exitCode` to `process.exit`. */
export class MigrationLockedError extends Error {
  readonly code = 'migrate.locked';
  readonly exitCode = 3;

  constructor(message: string) {
    super(message);
    this.name = 'MigrationLockedError';
  }
}

/** Thrown when `migrate to` would move the schema backwards in production. */
export class MigrationDirectionRefusedError extends Error {
  readonly code = 'migrate.down_refused';
  readonly exitCode = 3;

  constructor(message: string) {
    super(message);
    this.name = 'MigrationDirectionRefusedError';
  }
}

/** Rebuilds and full backfills require an explicit operator decision before any migration runs. */
export class MigrationLongRunningRefusedError extends Error {
  readonly code = 'migrate.long_running_refused';
  readonly exitCode = 3;
  readonly migrations: readonly string[];

  constructor(migrations: readonly string[]) {
    super(
      `operator action required: ${migrations.map((name) => `${name} [long-running]`).join(', ')}. ` +
        'Run iridium migrate up --allow-long-running during an approved maintenance window. ' +
        'No migration was applied; boot never authorizes long-running work.',
    );
    this.name = 'MigrationLongRunningRefusedError';
    this.migrations = migrations;
  }
}

/**
 * `dbMaint`: the `iridium_migrator` pool. Single connection, created lazily and only when
 * `DATABASE_MIGRATE_URL` is configured.
 */
export function createMaintDb(
  url: string,
  connectTimeoutMs: number = DB_CONNECT_TIMEOUT_MS_DEFAULT,
): { db: Kysely<Database>; pool: Pool; target: MysqlConnectionTarget } {
  const target = parseDatabaseUrl(url);
  const pool = createPool(poolOptions(target, DB_POOL_SIZE.maint, connectTimeoutMs));
  const db = new Kysely<Database>({ dialect: new MysqlDialect({ pool }) });
  return { db, pool, target };
}

/** The `Migrator` over the migration list compiled into the image. */
export function createMigrator(db: Kysely<Database>): Migrator {
  return new Migrator({ db, provider: bundledMigrationProvider });
}

/**
 * Runs `fn` while holding `GET_LOCK('iridium_migrate', 60)` on a connection of its own.
 *
 * The lock connection is deliberately outside `dbMaint`'s pool: that pool holds a single connection
 * and the migration statements need it, so taking the lock from the pool would deadlock the run
 * against itself.
 */
export async function withMigrationLock<T>(
  target: MysqlConnectionTarget,
  fn: () => Promise<T>,
): Promise<T> {
  const connection = await createConnection({
    host: target.host,
    port: target.port,
    user: target.user,
    password: target.password,
    database: target.database,
  });
  try {
    const [rows] = await connection.query<RowDataPacket[]>('SELECT GET_LOCK(?, ?) AS acquired', [
      MIGRATION_LOCK_NAME,
      MIGRATION_LOCK_TIMEOUT_SECONDS,
    ]);
    const acquired = rows[0]?.['acquired'];
    if (Number(acquired) !== 1) {
      throw new MigrationLockedError(
        `another process holds the '${MIGRATION_LOCK_NAME}' advisory lock; ` +
          `waited ${String(MIGRATION_LOCK_TIMEOUT_SECONDS)}s and gave up rather than interleaving two migration runs`,
      );
    }
    try {
      return await fn();
    } finally {
      await connection.query('SELECT RELEASE_LOCK(?)', [MIGRATION_LOCK_NAME]);
    }
  } finally {
    await connection.end();
  }
}

/** What `iridium migrate status` prints. */
export interface MigrationStatus {
  /** Names recorded in `kysely_migration`, in apply order. */
  readonly applied: readonly string[];
  /** Bundled names not yet applied, in apply order. */
  readonly pending: readonly string[];
  /** Pending migrations that require `--allow-long-running`; boot never opts in. */
  readonly pendingLongRunning: readonly string[];
  /** Recorded names the binary does not know: the schema is ahead of the code. */
  readonly unknown: readonly string[];
  /** `current` only when nothing is pending and nothing is unknown. */
  readonly status: 'current' | 'pending' | 'newer_schema';
}

/**
 * Compares `kysely_migration` with the list compiled into the image.
 *
 * This is the query behind the `/readyz` `migrations` check, and it is fail-closed on purpose: a
 * server whose schema is older than its code never serves traffic. `newer_schema` is reported
 * separately from `pending` because `IRIDIUM_ALLOW_NEWER_SCHEMA` tolerates it during a rollback.
 */
export async function migrationStatus(db: Kysely<Database>): Promise<MigrationStatus> {
  const migrator = createMigrator(db);
  const rows = await migrator.getMigrations();
  const bundled = new Set(MIGRATION_NAMES);
  const applied: string[] = [];
  const pending: string[] = [];
  const unknown: string[] = [];
  for (const row of rows) {
    if (row.executedAt === undefined) {
      pending.push(row.name);
    } else {
      applied.push(row.name);
      if (!bundled.has(row.name)) unknown.push(row.name);
    }
  }
  const status: MigrationStatus['status'] =
    pending.length > 0 ? 'pending' : unknown.length > 0 ? 'newer_schema' : 'current';
  return {
    applied,
    pending,
    pendingLongRunning: pending.filter((name) => LONG_RUNNING_MIGRATIONS.has(name)),
    unknown,
    status,
  };
}

export interface MigrationRunOptions {
  /** `dbMaint`, the `iridium_migrator` Kysely instance. */
  readonly db: Kysely<Database>;
  /** Where the advisory-lock connection is opened. */
  readonly target: MysqlConnectionTarget;
  readonly logger?: DbLogger;
  /** CLI operator or disposable fixture opt-in; deliberately absent from the boot path. */
  readonly allowLongRunning?: boolean;
}

export interface MigrationRunOutcome {
  readonly results: readonly MigrationResult[];
  readonly error: unknown;
}

async function run(
  options: MigrationRunOptions,
  label: string,
  action: (migrator: Migrator) => Promise<{ error?: unknown; results?: MigrationResult[] }>,
): Promise<MigrationRunOutcome> {
  return withMigrationLock(options.target, async () => {
    const migrator = createMigrator(options.db);
    const { error, results } = await action(migrator);
    for (const result of results ?? []) {
      if (result.status === 'Success') {
        options.logger?.info(
          { migration: result.migrationName, direction: result.direction },
          `migrate: applied ${result.migrationName}`,
        );
      } else if (result.status === 'Error') {
        options.logger?.warn(
          { migration: result.migrationName, direction: result.direction },
          `migrate: failed on ${result.migrationName}`,
        );
      }
    }
    if (error !== undefined) throw error;
    if (
      options.logger !== undefined &&
      results?.some(
        (result) => result.direction === 'Up' && result.migrationName.includes('grants'),
      )
    ) {
      const provenance = await readGrantProvenance(options.db);
      for (const record of provenance.skipped) {
        options.logger.warn(
          {
            event: 'migration.grants_skipped',
            table: record.table,
            metadata: { skipped: record.reason },
          },
          'Grant application is unverified; ask the DBA to apply docs/ops/db-grants.sql.',
        );
      }
    }
    options.logger?.info(
      { migration: label, applied: results?.length ?? 0 },
      `migrate: ${label} complete`,
    );
    return { results: results ?? [], error: undefined };
  });
}

/** `iridium migrate up`: apply everything pending. */
export async function migrateToLatest(options: MigrationRunOptions): Promise<MigrationRunOutcome> {
  return run(options, 'up', async (migrator) => {
    await assertLongRunningAdmission(migrator, options.allowLongRunning);
    return migrator.migrateToLatest();
  });
}

/** Check the entire selected path under the advisory lock, before Kysely executes its first step. */
async function assertLongRunningAdmission(
  migrator: Migrator,
  allowed: boolean | undefined,
  name?: string,
): Promise<void> {
  if (allowed === true) return;
  const rows = await migrator.getMigrations();
  const target = name === undefined ? rows.length - 1 : rows.findIndex((row) => row.name === name);
  // Let Kysely diagnose an unknown target without reporting unrelated pending work instead.
  if (target === -1) return;
  const head = rows.findLastIndex((row) => row.executedAt !== undefined);
  const selected = rows.filter((row, index) =>
    target < head
      ? index > target && row.executedAt !== undefined
      : index <= target && row.executedAt === undefined,
  );
  const longRunning = selected.filter((row) => LONG_RUNNING_MIGRATIONS.has(row.name));
  if (longRunning.length > 0) {
    throw new MigrationLongRunningRefusedError(longRunning.map((row) => row.name));
  }
}

/**
 * Refuses a target that sits behind the recorded head.
 *
 * An unknown name falls through: `migrator.migrateTo` reports it with an error that names what the
 * binary actually carries, and a direction refusal for a name that is not a migration at all would
 * be the wrong diagnosis.
 */
async function assertForward(migrator: Migrator, name: string): Promise<void> {
  const rows = await migrator.getMigrations();
  const target = rows.findIndex((row) => row.name === name);
  const head = rows.findLastIndex((row) => row.executedAt !== undefined);
  if (target === -1 || target >= head) return;
  throw new MigrationDirectionRefusedError(
    `migrate to ${name} would roll the schema back from ${rows[head]?.name ?? 'the current head'}, ` +
      'which is refused when NODE_ENV=production: rolling a schema back is a restore, not a ' +
      'migration. Fix a mistake with a new forward migration (A7).',
  );
}

/**
 * `iridium migrate to <name>`: apply, or outside production roll back, to a named migration
 * (11-operations-and-deployment.md, "Command inventory").
 *
 * The direction check runs inside the advisory lock and against the same `Migrator` the run uses, so
 * the head it reads is one no concurrent run can move underneath it. `nodeEnv` is a parameter rather
 * than a `process.env` read, because `apps/server/src/**` never touches the environment outside
 * `config/**` and `main.ts`.
 */
export async function migrateTo(
  options: MigrationRunOptions,
  name: string,
  nodeEnv: string | undefined,
): Promise<MigrationRunOutcome> {
  return run(options, `to ${name}`, async (migrator) => {
    if (nodeEnv === 'production') await assertForward(migrator, name);
    await assertLongRunningAdmission(migrator, options.allowLongRunning, name);
    return migrator.migrateTo(name);
  });
}

/**
 * The bundled names, re-exported beside the wrapper that compares them with `kysely_migration`.
 *
 * `migrations.integration` reads them here: it asserts the recorded set equals the bundled set after a
 * full `migrate up`, and reading the same list `migrationStatus` reads is what keeps that assertion
 * from passing against a second opinion about what "all migrations" means.
 *
 */
export { MIGRATION_NAMES } from './migrations.ts';
