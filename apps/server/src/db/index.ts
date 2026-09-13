/**
 * The database layer: the Kysely instances, their pools, and the two boot checks that run before
 * the server accepts a request.
 *
 * Four instances are specified (03-data-model.md section 1.3, 11-operations-and-deployment.md
 * OPS-12). Two of them are the request path and are built here for every boot:
 *
 *   `dbApp`     `iridium_app`, pool 20 -- REST, MCP, jobs, projections, CLI read commands
 *   `dbPersist` `iridium_app`, pool 4  -- the persistence writer and the compactor only, so a REST
 *                                        burst can never starve a save
 *
 * The other two are created on demand by the code that owns them: `dbMaint` (`iridium_migrator`,
 * pool 1, only when `DATABASE_MIGRATE_URL` is configured -- migrations, `access_log` partition DDL,
 * the audit archive, `migrate ensure-guards`) is `createMaintDb` in `migrator.ts`, and the CLI-only
 * `dbBackup` (`iridium_backup`, pool 1) belongs to the ops CLI.
 *
 * Neither `ParseJSONResultsPlugin` nor `CamelCasePlugin` is installed: mysql2 parses JSON, column
 * names are snake_case end to end, and `Database` mirrors them.
 *
 * Nothing here reads `process.env`; the `db` plugin supplies the values.
 */
import { Kysely, MysqlDialect } from 'kysely';
import { createPool, type Pool } from 'mysql2';

import {
  DB_CONNECT_TIMEOUT_MS_DEFAULT,
  DB_POOL_SIZE,
  parseDatabaseUrl,
  poolOptions,
  type MysqlConnectionTarget,
} from './pool.ts';
import type { Database } from './schema.ts';
import {
  assertMysqlVersionFloor,
  type DbLogger,
  type MysqlServerVersion,
} from './version-floor.ts';

// What this module re-exports is what something outside `db/` actually reaches it for. Everything
// else stays behind its own file: `pool.ts` is reached directly by `kysely.config.ts`, the version
// floor by `createDatabaseLayer` below, and a consumer that wants `poolOptions` or the `TINYINT(1)`
// typeCast wants `pool.ts`, not "the database layer".
export type { Database } from './schema.ts';
export type { MysqlConnectionTarget } from './pool.ts';
export { assertFoundRows } from './assertFoundRows.ts';
export { MysqlUnsupportedError, type DbLogger, type MysqlServerVersion } from './version-floor.ts';

/**
 * Reached through this module by the integration suites that open a connection of their own against a
 * container -- `migrations.integration` connects as root to read `information_schema.TABLE_PRIVILEGES`
 * and as the migrator to race two `migrate up` runs, `migrations.parity.integration` compares the
 * schema the two required MySQL lines produce. They parse the container URL exactly as
 * `createDatabaseLayer` does rather than assembling a `PoolOptions` of their own.
 *
 * @internal
 */
export { parseDatabaseUrl } from './pool.ts';

/**
 * Reached through this module by `db.version-floor.integration`, which drives the classification and
 * the refusal message against real servers: both required lines, a refused 8.0 and a refused
 * innovation release. The serving path never calls them directly -- it gets the verdict back from
 * `createDatabaseLayer`, which is what `/readyz` reports.
 *
 * @internal
 */
export { describeMysqlVersion, MYSQL_80_END_OF_LIFE, parseMysqlVersion } from './version-floor.ts';

export interface DatabaseLayerOptions {
  /** `DATABASE_URL` -- the `iridium_app` role. */
  readonly url: string;
  /** `DB_POOL_APP`, default 20. */
  readonly poolApp?: number;
  /** `DB_POOL_PERSIST`, default 4. */
  readonly poolPersist?: number;
  /** `DB_CONNECT_TIMEOUT_MS`. */
  readonly connectTimeoutMs?: number;
  /** `IRIDIUM_ALLOW_UNTESTED_MYSQL`: downgrades the version-floor refusal to a permanent warning. */
  readonly allowUntestedMysql?: boolean;
  readonly logger?: DbLogger;
}

export interface DatabaseLayer {
  /** REST, MCP, jobs, projections. */
  readonly dbApp: Kysely<Database>;
  /** The persistence writer and the compactor, and nothing else. */
  readonly dbPersist: Kysely<Database>;
  /** What `SELECT VERSION()` reported, for the `/readyz` `mysql_version` check. */
  readonly serverVersion: MysqlServerVersion;
  /** Closes both pools. Safe to call twice. */
  destroy(): Promise<void>;
}

/** Builds one Kysely instance over its own mysql2 pool. */
export function createDb(
  target: MysqlConnectionTarget,
  connectionLimit: number,
  connectTimeoutMs: number = DB_CONNECT_TIMEOUT_MS_DEFAULT,
): { db: Kysely<Database>; pool: Pool } {
  const pool = createPool(poolOptions(target, connectionLimit, connectTimeoutMs));
  const db = new Kysely<Database>({ dialect: new MysqlDialect({ pool }) });
  return { db, pool };
}

/**
 * Builds `dbApp` and `dbPersist` and runs the version floor before either is handed out.
 *
 * **Boot ordering, stated here so it cannot be guessed.** On a database that has not been migrated,
 * `iridium_app` holds `USAGE ON *.*` and nothing else -- its per-table rights arrive with migration
 * `0034_grants` -- so MySQL refuses the connection itself before any check in this module could run.
 * The order is therefore:
 *
 *   1. `main.ts serve`, when `IRIDIUM_MIGRATE_ON_BOOT=true`, calls `assertMysqlVersionFloor` on the
 *      migrator connection and then migrates. Running the check there is what makes an unsupported
 *      engine exit `2` with `config.mysql_unsupported` instead of failing somewhere inside a
 *      migration: the first connection a fresh deployment makes is the migrator's.
 *   2. `createDatabaseLayer` builds `dbApp` and `dbPersist` and re-runs the version floor, which is
 *      the check `/readyz` reports and the one a deployment that migrates out of band still gets.
 *   3. `assertFoundRows(layer.dbApp)` -- separate, because it probes the `schema_meta` row migration
 *      `0032` creates and is meaningless before that has run.
 */
export async function createDatabaseLayer(options: DatabaseLayerOptions): Promise<DatabaseLayer> {
  const target = parseDatabaseUrl(options.url);
  const connectTimeoutMs = options.connectTimeoutMs ?? DB_CONNECT_TIMEOUT_MS_DEFAULT;
  const app = createDb(target, options.poolApp ?? DB_POOL_SIZE.app, connectTimeoutMs);
  const persist = createDb(target, options.poolPersist ?? DB_POOL_SIZE.persist, connectTimeoutMs);

  let destroyed = false;
  const destroy = async (): Promise<void> => {
    if (destroyed) return;
    destroyed = true;
    await Promise.all([app.db.destroy(), persist.db.destroy()]);
  };

  try {
    const versionOptions: { allowUntested?: boolean; logger?: DbLogger } = {};
    if (options.allowUntestedMysql !== undefined) {
      versionOptions.allowUntested = options.allowUntestedMysql;
    }
    if (options.logger !== undefined) {
      versionOptions.logger = options.logger;
    }
    const serverVersion = await assertMysqlVersionFloor(app.db, versionOptions);
    return { dbApp: app.db, dbPersist: persist.db, serverVersion, destroy };
  } catch (error) {
    await destroy();
    throw error;
  }
}
