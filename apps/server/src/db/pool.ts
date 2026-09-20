/**
 * mysql2 pool construction from a connection URL, and the one place the pool options of
 * 03-data-model.md section 1.3 / 11-operations-and-deployment.md OPS-12 are written down.
 *
 * Nothing in this module reads the environment: `apps/server/src/**` is forbidden `process.env`
 * outside `config/**` and `main.ts`, so every value arrives as a parameter and the `db` plugin is
 * what turns `DATABASE_URL`, `DATABASE_MIGRATE_URL`, `DB_POOL_APP`, `DB_POOL_PERSIST` and
 * `DB_CONNECT_TIMEOUT_MS` into the objects below.
 */
import type { PoolOptions, TypeCastField, TypeCastNext } from 'mysql2';

/** Everything needed to reach one MySQL server as one role. */
export interface MysqlConnectionTarget {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
}

/** Pool sizes of OPS-12. `dbMaint` and the CLI-only `dbBackup` are single-connection pools. */
export const DB_POOL_SIZE = Object.freeze({
  app: 20,
  persist: 4,
  maint: 1,
  backup: 1,
});

/** The mysql2 connect timeout the `db` plugin overrides from `DB_CONNECT_TIMEOUT_MS`. */
export const DB_CONNECT_TIMEOUT_MS_DEFAULT = 10_000;

/** Request/persistence statement and pool-acquisition deadline; migration DDL has its own policy. */
export const DB_QUERY_TIMEOUT_MS_DEFAULT = 10_000;

/** Allow a one-second lock wait, MySQL's one-second timeout sweep, and a response second. */
export const DB_QUERY_TIMEOUT_MS_MIN = 3_000;

/** Node and mysql2 timers clamp larger delays to 1 ms; reject those values rather than invert policy. */
export const DB_QUERY_TIMEOUT_MS_MAX = 2_147_483_647;

/**
 * `TINYINT(1)` is Iridium's boolean (03-data-model.md section 1.2). mysql2 hands a driver-level
 * `TINY` field with `length === 1` for exactly those columns; every other type falls through to the
 * driver's own conversion, which is what keeps `supportBigNumbers`, `decimalNumbers` and
 * `jsonStrings` meaningful.
 */
export function tinyint1ToBoolean(field: TypeCastField, next: TypeCastNext): unknown {
  if (field.type === 'TINY' && field.length === 1) {
    const raw = field.string();
    return raw === null ? null : raw !== '0';
  }
  return next();
}

/**
 * Parses `mysql://user:password@host:port/database`. Percent-encoding is decoded, which is how a
 * generated password containing `@`, `/` or `:` survives the URL round trip.
 */
export function parseDatabaseUrl(url: string): MysqlConnectionTarget {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      'database url is not a URL (expected mysql://user:password@host:port/database)',
    );
  }
  if (parsed.protocol !== 'mysql:') {
    throw new Error(`database url protocol must be mysql:, received ${parsed.protocol}`);
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (database === '') {
    throw new Error('database url must name a schema (mysql://user:password@host:port/database)');
  }
  if (parsed.username === '') {
    throw new Error('database url must carry a user (mysql://user:password@host:port/database)');
  }
  return {
    host: parsed.hostname,
    port: parsed.port === '' ? 3306 : Number(parsed.port),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database,
  };
}

/**
 * The pool options, identical on every instance except `connectionLimit`:
 *
 *  - `supportBigNumbers` + `bigNumberStrings:false` make every `BIGINT UNSIGNED` a JS `number`, which
 *    is what lets every sequence counter be a `number` end to end and leaves Kysely's own
 *    `numUpdatedRows` as the only `bigint` in the persistence path.
 *  - `jsonStrings:false` lets mysql2 parse JSON, so `ParseJSONResultsPlugin` is not installed.
 *  - `decimalNumbers:false` keeps DECIMAL as a string; the schema declares none, and the option is
 *    stated so a later one cannot silently arrive as a lossy float.
 *  - `enableKeepAlive` + `idleTimeout` keep a reverse proxy or a cloud load balancer from silently
 *    collecting idle connections.
 *  - `typeCast` is the `TINYINT(1)` -> boolean mapping above.
 *  - `dateStrings:false` (mysql2's default, stated) is what makes `DATETIME(6)` a `Date`.
 */
export function poolOptions(
  target: MysqlConnectionTarget,
  connectionLimit: number,
  connectTimeoutMs: number = DB_CONNECT_TIMEOUT_MS_DEFAULT,
): PoolOptions {
  return {
    host: target.host,
    port: target.port,
    user: target.user,
    password: target.password,
    database: target.database,
    connectionLimit,
    connectTimeout: connectTimeoutMs,
    supportBigNumbers: true,
    bigNumberStrings: false,
    jsonStrings: false,
    decimalNumbers: false,
    dateStrings: false,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
    idleTimeout: 60_000,
    waitForConnections: true,
    charset: 'utf8mb4_0900_ai_ci',
    timezone: 'Z',
    multipleStatements: false,
    typeCast: tinyint1ToBoolean,
  };
}
