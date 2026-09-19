/**
 * Boot step 2, the `db` plugin: a thin adapter over the database layer.
 *
 * `apps/server/src/db/**` is the database stream's module and is reached through this one seam, so a
 * missing export is a compile error in one file rather than a crash spread over the boot path. The
 * adapter lives under `boot/` rather than in `db/` for the same reason: `db/` owns the pools, the
 * schema types, the migrator and the boot checks, and the Fastify wiring that arranges them into a
 * plugin is not part of that ownership.
 *
 * Three properties are load-bearing.
 *
 * **`mode: 'none'` boots the app without a database**, which is what lets `pnpm gen` call
 * `app.swagger()` in `in-process` mode with no container. Every database-backed readiness check then
 * reports `warn` naming that mode rather than disappearing, because the served `/readyz` check-name
 * set must always equal `ReadyzCheckName`.
 *
 * **A database that is absent, unreachable or not yet migrated does not fail the boot.** The process
 * comes up in `not_ready`, answers `/healthz`, `/readyz` and `/metrics`, answers everything else with
 * `503 not_ready`, and re-checks every 5 s — which is what lets an operator apply `iridium migrate`
 * from a sidecar and have the server come up without a restart (02-system-architecture.md boot step 2
 * and ARCH-02; the documented HA procedure in 11-operations-and-deployment.md). That tolerance
 * matters more than it looks: on a pristine schema `iridium_app` holds `USAGE` and nothing else until
 * migration `0034_grants` runs, so MySQL refuses its connection outright, and a boot that treated
 * that as fatal could never reach the not-ready state the plan specifies.
 *
 * **Two conditions stay fatal**, because neither is transient and both are configuration: an
 * unsupported MySQL line (`config.mysql_unsupported`, exit `2`, unless `IRIDIUM_ALLOW_UNTESTED_MYSQL`)
 * and `innodb_flush_log_at_trx_commit ≠ 1` under `READYZ_STRICT_DURABILITY`.
 *
 * Within the step the order is 02-system-architecture.md's and is not interchangeable:
 * optional migrate-on-boot (migrator role) → pools → version floor → durability → the Yjs
 * single-instance guard → `FOUND_ROWS`. The `FOUND_ROWS` probe reads a `schema_meta` row migration
 * `0032` creates, so it is deferred — once, memoised — to the moment the `migrations` check first
 * observes `current`.
 */
import { sql, type Kysely } from 'kysely';

import type { IridiumConfig } from '../config/env.ts';
import { AppGrantVerifier } from '../db/grants-readiness.ts';
import {
  assertFoundRows,
  createDatabaseLayer,
  MysqlUnsupportedError,
  type Database,
  type DatabaseLayer,
  type MysqlServerVersion,
  type PoolsInUse,
  type PendingAcquisitions,
  type QueryCounts,
} from '../db/index.ts';
import {
  createMaintDb,
  migrateToLatest,
  migrationStatus,
  type MigrationStatus,
} from '../db/migrator.ts';
import { elapsedMs, withDeadline, type Clock } from '../ops/clock.ts';
import type { ServerLogger } from '../ops/logging.ts';
import type { CheckOutcome, Readiness } from '../ops/readiness.ts';
import { assertSingleYjsInstance } from '../ops/yjs-single-instance.ts';

/** Whether this boot opens a database at all. */
export type DatabaseMode = 'connect' | 'none';

/** The database as the rest of the app sees it. */
export interface DatabaseHandle {
  readonly mode: DatabaseMode;
  /** `null` in `mode: 'none'`, and until a reachable database has been connected. */
  readonly dbApp: Kysely<Database> | null;
  readonly dbPersist: Kysely<Database> | null;
  readonly serverVersion: MysqlServerVersion | null;
  /** The most recent `migrations` evaluation, so `/readyz` and `/metrics` agree. */
  migrations(): MigrationStatus | null;
  /** Connections checked out of each pool, for `iridium_db_pool_in_use{pool}`; zeros when absent. */
  poolsInUse(): PoolsInUse;
  /** Serving-pool borrowers still waiting within their acquisition deadline. */
  pendingAcquisitions(): PendingAcquisitions;
  /** Completed SQL attempts per serving pool, including failures; contains no query data. */
  queryCounts(): QueryCounts;
  /** Why the database is not connected, or `null` when it is. */
  connectionError(): string | null;
  destroy(): Promise<void>;
}

declare module 'fastify' {
  interface FastifyInstance {
    /** The database handle of boot step 2. */
    database: DatabaseHandle;
  }
}

/** What the db plugin needs; slices, never the whole configuration object. */
export interface DbPluginOptions {
  readonly config: IridiumConfig;
  readonly mode: DatabaseMode;
  readonly logger: ServerLogger;
  readonly readiness: Readiness;
  readonly clock: Clock;
}

const PING_WARN_MS = 500;
const PING_TIMEOUT_MS = 2_000;
const CLOCK_SKEW_WARN_MS = 5_000;
const CLOCK_SKEW_FAIL_MS = 30_000;
const NOT_CONNECTED_MODE = 'no database in this boot (mode: none — the OpenAPI export path)';

/** Thrown when the durability setting is wrong and `READYZ_STRICT_DURABILITY` makes that fatal. */
export class DurabilityRefusedError extends Error {
  readonly code = 'config.durability_unsafe';
  readonly exitCode = 2;

  constructor(observed: string | null) {
    super(
      `innodb_flush_log_at_trx_commit is ${observed ?? 'unreadable'}, not 1, and ` +
        'READYZ_STRICT_DURABILITY=true. Iridium acknowledges a save only after COMMIT, so a setting ' +
        'that lets MySQL lose the last second of committed transactions would make that ' +
        'acknowledgement untrue (HP-1). Set innodb_flush_log_at_trx_commit=1 in my.cnf, or set ' +
        'READYZ_STRICT_DURABILITY=false to accept the risk with a permanent /readyz warning.',
    );
    this.name = 'DurabilityRefusedError';
  }
}

interface GlobalVariableRow {
  readonly value: string | null;
}

async function readGlobalVariable(db: Kysely<Database>, name: string): Promise<string | null> {
  const result = await sql<GlobalVariableRow>`
    SELECT VARIABLE_VALUE AS value
    FROM performance_schema.global_variables
    WHERE VARIABLE_NAME = ${name}
  `.execute(db);
  return result.rows[0]?.value ?? null;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The state the adapter carries between the boot attempt and every later re-check. */
class DatabaseAdapter implements DatabaseHandle {
  readonly mode: DatabaseMode;
  #layer: DatabaseLayer | null = null;
  #error: string | null = null;
  #migrations: MigrationStatus | null = null;
  #foundRowsAsserted = false;
  #connecting: Promise<void> | null = null;
  readonly #options: DbPluginOptions;

  constructor(options: DbPluginOptions) {
    this.#options = options;
    this.mode = options.mode;
    if (options.mode === 'none') this.#error = NOT_CONNECTED_MODE;
  }

  get dbApp(): Kysely<Database> | null {
    return this.#layer?.dbApp ?? null;
  }

  get dbPersist(): Kysely<Database> | null {
    return this.#layer?.dbPersist ?? null;
  }

  get serverVersion(): MysqlServerVersion | null {
    return this.#layer?.serverVersion ?? null;
  }

  migrations(): MigrationStatus | null {
    return this.#migrations;
  }

  poolsInUse(): PoolsInUse {
    return this.#layer?.poolsInUse() ?? { app: 0, persist: 0 };
  }

  pendingAcquisitions(): PendingAcquisitions {
    return this.#layer?.pendingAcquisitions() ?? { app: 0, persist: 0 };
  }

  queryCounts(): QueryCounts {
    return this.#layer?.queryCounts() ?? { app: 0, persist: 0 };
  }

  connectionError(): string | null {
    return this.#error;
  }

  recordMigrations(status: MigrationStatus): void {
    this.#migrations = status;
  }

  async destroy(): Promise<void> {
    await this.#layer?.destroy();
    this.#layer = null;
  }

  /**
   * Connects if not connected, at most one attempt at a time. Resolves whether or not the attempt
   * succeeded: a failure is recorded in `connectionError()` and surfaces through `/readyz`, because
   * an unreachable database is a not-ready server rather than a dead process.
   */
  async ensureConnected(): Promise<void> {
    if (this.#layer !== null || this.mode === 'none') return;
    this.#connecting ??= this.#connect().finally(() => {
      this.#connecting = null;
    });
    return this.#connecting;
  }

  async ensureFoundRows(): Promise<void> {
    const layer = this.#layer;
    if (this.#foundRowsAsserted || layer === null) return;
    await assertFoundRows(layer.dbApp);
    this.#foundRowsAsserted = true;
  }

  async #connect(): Promise<void> {
    const { config, logger, clock } = this.#options;
    let layer: DatabaseLayer | null = null;
    try {
      layer = await createDatabaseLayer({
        url: config.db.appUrl,
        poolApp: config.db.poolApp,
        poolPersist: config.db.poolPersist,
        connectTimeoutMs: config.db.connectTimeoutMs,
        queryTimeoutMs: config.db.queryTimeoutMs,
        clock,
        allowUntestedMysql: config.lifecycle.allowUntestedMysql,
        logger,
      });
      await withDeadline(clock, sql`SELECT 1`.execute(layer.dbApp), PING_TIMEOUT_MS, 'dbApp');
      await withDeadline(
        clock,
        sql`SELECT 1`.execute(layer.dbPersist),
        PING_TIMEOUT_MS,
        'dbPersist',
      );

      const durability = await readGlobalVariable(layer.dbApp, 'innodb_flush_log_at_trx_commit');
      if (durability !== '1') {
        if (config.ops.readyzStrictDurability) throw new DurabilityRefusedError(durability);
        logger.warn(
          { event: 'readyz.degraded', check: 'durability', observed: durability },
          'innodb_flush_log_at_trx_commit is not 1 and READYZ_STRICT_DURABILITY=false',
        );
      }
    } catch (error) {
      await layer?.destroy();
      // Neither of these is transient, and neither is fixed by waiting: they are configuration.
      if (error instanceof MysqlUnsupportedError || error instanceof DurabilityRefusedError)
        throw error;
      this.#error = reasonOf(error);
      logger.warn(
        { err: error },
        'the database is not reachable yet; serving 503 not_ready and re-checking every 5 s',
      );
      return;
    }
    this.#layer = layer;
    this.#error = null;
    logger.info(
      {
        mysqlVersion: layer.serverVersion.raw,
        poolApp: config.db.poolApp,
        poolPersist: config.db.poolPersist,
      },
      'database connected',
    );
  }
}

/**
 * Applies boot step 2 and registers the eight database-backed readiness checks.
 *
 * @throws MysqlUnsupportedError on an uncertified MySQL line (exit `2`).
 * @throws DurabilityRefusedError when durability is unsafe and `READYZ_STRICT_DURABILITY=true`.
 */
export async function applyDbPlugin(options: DbPluginOptions): Promise<DatabaseHandle> {
  const { config, logger, readiness, clock } = options;
  const adapter = new DatabaseAdapter(options);
  const grants = new AppGrantVerifier();

  if (options.mode === 'connect' && config.lifecycle.migrateOnBoot) {
    // Before the pools, because on a pristine schema the app role cannot connect until 0034_grants.
    await migrateOnBoot(options);
  }
  await adapter.ensureConnected();

  // 02-system-architecture.md places the Yjs single-instance guard in this step.
  assertSingleYjsInstance();

  const absent = (): CheckOutcome => ({
    status: 'warn',
    detail: adapter.connectionError() ?? NOT_CONNECTED_MODE,
  });

  readiness.register('mysql_version', () => {
    const version = adapter.serverVersion;
    return version === null ? absent() : mysqlVersionOutcome(version);
  });

  readiness.register('db_app', async () => {
    await adapter.ensureConnected();
    const db = adapter.dbApp;
    if (db === null) {
      return adapter.mode === 'none'
        ? absent()
        : { status: 'fail', detail: adapter.connectionError() ?? 'not connected' };
    }
    return ping(clock, db, 'dbApp');
  });

  readiness.register('db_persist', async () => {
    const db = adapter.dbPersist;
    if (db === null) {
      return adapter.mode === 'none'
        ? absent()
        : { status: 'fail', detail: adapter.connectionError() ?? 'not connected' };
    }
    return ping(clock, db, 'dbPersist');
  });

  readiness.register('migrations', async () => {
    const db = adapter.dbApp;
    // Deliberately `warn`, not `fail`, when the database is unreachable: `migrations` is the one
    // fail-closed check, and it means "the schema is behind the code", not "the database is down".
    // `db_app` carries the outage, so a blip does not flip the not-ready gate.
    if (db === null) return absent();
    const status = await migrationStatus(db);
    adapter.recordMigrations(status);
    if (status.status === 'current') {
      await adapter.ensureFoundRows();
      return { status: 'ok', detail: `${String(status.applied.length)} applied` };
    }
    if (status.status === 'newer_schema') {
      if (config.lifecycle.allowNewerSchema) {
        logger.warn(
          { event: 'migration.newer_schema_tolerated', unknown: status.unknown },
          'unknown newer migrations tolerated by IRIDIUM_ALLOW_NEWER_SCHEMA',
        );
        return { status: 'warn', detail: `newer schema tolerated: ${status.unknown.join(', ')}` };
      }
      return {
        status: 'fail',
        detail: `unknown newer migrations recorded: ${status.unknown.join(', ')}`,
      };
    }
    return { status: 'fail', detail: `pending: ${status.pending.join(', ')}` };
  });

  readiness.register('grants', async () => {
    const status = adapter.migrations();
    if (status === null) return absent();
    const db = adapter.dbApp;
    if (db === null) return absent();
    if (status.status === 'pending') {
      return { status: 'warn', detail: 'grants unverified: migrations pending' };
    }
    return grants.check(db);
  });

  readiness.register('durability', async () => {
    const db = adapter.dbApp;
    if (db === null) return absent();
    const flush = await readGlobalVariable(db, 'innodb_flush_log_at_trx_commit');
    const syncBinlog = await readGlobalVariable(db, 'sync_binlog');
    if (flush !== '1') {
      const detail = `innodb_flush_log_at_trx_commit=${flush ?? 'unreadable'}`;
      return config.ops.readyzStrictDurability
        ? { status: 'fail', detail }
        : { status: 'warn', detail: `${detail} (READYZ_STRICT_DURABILITY=false)` };
    }
    if (syncBinlog !== '1')
      return { status: 'warn', detail: `sync_binlog=${syncBinlog ?? 'unreadable'}` };
    return { status: 'ok', detail: 'innodb_flush_log_at_trx_commit=1, sync_binlog=1' };
  });

  readiness.register('clock_skew', async () => {
    const db = adapter.dbApp;
    if (db === null) return absent();
    const result = await sql<{ now: Date | string }>`SELECT NOW(6) AS now`.execute(db);
    const raw = result.rows[0]?.now;
    if (raw === undefined) return { status: 'fail', detail: 'NOW(6) returned no row' };
    const dbTime = raw instanceof Date ? raw.getTime() : Date.parse(`${raw}Z`);
    const skew = Math.abs(dbTime - clock.now());
    const detail = `${Math.round(skew).toString()}ms`;
    if (skew > CLOCK_SKEW_FAIL_MS) return { status: 'fail', detail };
    if (skew > CLOCK_SKEW_WARN_MS) return { status: 'warn', detail };
    return { status: 'ok', detail };
  });

  readiness.register('key_versions', () => {
    // The full check compares every `user_credentials.pepper_version` and `audit_events.key_version`
    // with the configured keyrings; both tables arrive with M1's auth and audit plugins. What can be
    // asserted now is the floor those comparisons rest on: a keyring that carries no version at all
    // cannot sign anything, and a deployment in that state fails at its first login rather than here.
    const missing = (['pepper', 'auditHmac', 'mcpCursor'] as const).filter(
      (kind) => config.keys[kind].versions.size === 0,
    );
    return missing.length === 0
      ? { status: 'ok', detail: 'every keyring carries at least one configured version' }
      : { status: 'fail', detail: `no key material configured for: ${missing.join(', ')}` };
  });

  readiness.register('access_log_partitions', () => ({
    status: 'warn',
    detail:
      'scheduled access_log partition maintenance arrives with M2; the p_overflow catch-all ' +
      'keeps inserts working (D03-03, invariant I-20)',
  }));

  return adapter;
}

/**
 * The `mysql_version` mapping, extracted so `readyz.integration` can assert both branches without
 * starting an uncertified MySQL of its own — `db.version-floor.integration` already pays that cost,
 * and duplicating a container start to re-prove one mapping is a slow test for no extra coverage.
 *
 * It can never be `fail`: an unsupported version without `IRIDIUM_ALLOW_UNTESTED_MYSQL` is refused at
 * boot with `config.mysql_unsupported` and exit `2`, so a *running* process has already passed that
 * gate and the only remaining state is the permanent warning the override leaves behind (OPS-62).
 */
export function mysqlVersionOutcome(version: MysqlServerVersion): CheckOutcome {
  return version.verdict === 'supported'
    ? { status: 'ok', detail: version.raw }
    : {
        status: 'warn',
        detail: `${version.raw} is outside the supported set and IRIDIUM_ALLOW_UNTESTED_MYSQL=true`,
      };
}

async function migrateOnBoot(options: DbPluginOptions): Promise<void> {
  const { config, logger } = options;
  if (config.db.migrateUrl === null) {
    throw new Error(
      'IRIDIUM_MIGRATE_ON_BOOT=true requires DATABASE_MIGRATE_URL: applying a migration needs the ' +
        'iridium_migrator role, and the serving process deliberately does not hold it otherwise (A7, A8).',
    );
  }
  const maint = createMaintDb(config.db.migrateUrl, config.db.connectTimeoutMs);
  try {
    const outcome = await migrateToLatest({ db: maint.db, target: maint.target, logger });
    for (const result of outcome.results) {
      logger.info(
        { event: 'migration.applied', migration: result.migrationName },
        'migration applied',
      );
    }
  } finally {
    await maint.db.destroy();
  }
}

async function ping(clock: Clock, db: Kysely<Database>, label: string): Promise<CheckOutcome> {
  const startedAt = clock.monotonic();
  await withDeadline(clock, sql`SELECT 1`.execute(db), PING_TIMEOUT_MS, label);
  const elapsed = elapsedMs(clock, startedAt);
  return elapsed > PING_WARN_MS
    ? { status: 'warn', detail: `SELECT 1 took ${String(elapsed)}ms` }
    : { status: 'ok', detail: `${String(elapsed)}ms` };
}
