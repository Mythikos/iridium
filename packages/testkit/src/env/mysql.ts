/**
 * The MySQL fixture: one container per Vitest run, a migrated template schema, and one schema per
 * worker (10-testing-and-quality.md, "Environment: `startTestEnv`").
 *
 * Four properties are load-bearing and each one is enforced here rather than assumed:
 *
 * - **The shipped configuration is the tested configuration.** `infra/docker/mysql/my.cnf` and
 *   `infra/docker/mysql/init/01_roles.sh` are *mounted*, never re-implemented, so the three roles
 *   (`iridium_app`, `iridium_migrator`, `iridium_backup`) and every server variable in tests are the
 *   ones production gets. A copy here would be a second source of truth and would drift.
 * - **Migrations run through the product.** The template and every worker schema are built by
 *   `iridium migrate up`, not by a SQL file, so the migration code path is exercised on every run
 *   (fixture policy rule 2).
 * - **One fixture provisioning transport.** Environment setup uses the container's own `mysql`
 *   client (`MysqlAdmin`), not a second Node pool. Named testkit database probes may use Kysely over
 *   a caller-owned executor; they neither provision an alternate schema nor replace product seeding.
 * - **The mount is verified, not assumed.** A `my.cnf` the server declined to read and an
 *   `01_roles.sh` the entrypoint executed instead of sourcing both produce a database that looks
 *   plausible and is not the tested one, so `assertShippedConfiguration()` reads the server back
 *   before `startMysql` hands the container out.
 *
 * Exactly one shipped value is overridden, `innodb_redo_log_capacity` — see
 * `FIXTURE_REDO_LOG_CAPACITY` for why it is the one variable a fixture on `tmpfs` may not inherit,
 * and why the parity fingerprint excludes it.
 *
 * `withReuse()` is never called: schema names are per run and per worker (fixture policy rule 10).
 */
import { MySqlContainer } from '@testcontainers/mysql';
import type { StartedMySqlContainer } from '@testcontainers/mysql';
import { getContainerRuntimeClient } from 'testcontainers';
import type { ExecResult, StartedNetwork } from 'testcontainers';

import { MYSQL_CONF_FILE, MYSQL_INIT_ROLES_FILE, requireExistingPath } from '../paths.ts';
import type { DatabasePasswords } from '../server/env.ts';
import { DEFAULT_DATABASE_NAME, TEST_DB_PASSWORDS } from '../server/env.ts';

/** The compatibility floor every unset selector resolves to (03-data-model.md; D10-42). */
export const DEFAULT_MYSQL_IMAGE = 'mysql:8.4.11';

/** The other required line. Named so a suite can assert the matrix rather than spell a tag. */
export const REQUIRED_MYSQL_IMAGES: readonly string[] = [
  DEFAULT_MYSQL_IMAGE,
  'mysql:9.7.2-oraclelinux9',
];

/** The network alias other containers reach MySQL by (`mysql:3306` is Toxiproxy's upstream). */
export const MYSQL_NETWORK_ALIAS = 'mysql';

/** The three roles `01_roles.sh` creates (03-data-model.md §2; skeleton A8). */
export const DB_ROLES: readonly string[] = ['iridium_app', 'iridium_migrator', 'iridium_backup'];

/** Where the shipped configuration is mounted, matching `infra/compose.yaml` exactly. */
export const MYSQL_CONF_TARGET = '/etc/mysql/conf.d/iridium.cnf';
export const MYSQL_INIT_TARGET = '/docker-entrypoint-initdb.d/01_roles.sh';

/**
 * The mode every file this fixture copies in arrives with: readable by everyone, writable by nobody,
 * and **not executable**. `infra/compose.yaml` stages the same two files at the same `0444`.
 *
 * The execute bit is the load-bearing part, and it is `01_roles.sh` it bears on. The official MySQL
 * entrypoint *executes* an executable `.sh` in `/docker-entrypoint-initdb.d` and *sources* one that
 * is not, and only the sourced form runs inside the entrypoint's own shell, where the
 * `docker_process_sql` and `mysql_error` helpers the shipped script is written against exist
 * (03-data-model.md §2). An executed copy falls back to a `mysql` client of its own in a subshell,
 * where `mysql_error`'s `exit` ends that subshell rather than container initialisation — so the
 * script's closing authentication-plugin assertion stops being able to fail the container, and an
 * assertion that cannot fail is documentation.
 */
export const MOUNTED_FILE_MODE = 0o444;

/**
 * The single shipped value this fixture overrides, and the only one it may.
 *
 * `my.cnf` sets `innodb_redo_log_capacity = 2G`, which InnoDB materialises as 32 redo files in the
 * data directory — and here the data directory is a `tmpfs`, so that capacity is RAM rather than
 * disk. A freshly started fixture container holds about 950 MB of redo before a single row exists
 * and grows toward the full 2 GB under write load; five worker containers at the shipped size would
 * ask a 16 GB CI runner for more than it has. 64 MB is orders above the write rate any suite
 * produces, and `tooling/sql/schema-fingerprint.json` excludes this variable from the list the
 * parity suite compares precisely so the fixture may set it: nothing in the schema or in a
 * documented guarantee reads it.
 *
 * It is passed as a `mysqld` argument rather than written into a second option file because a
 * command-line argument outranks every `[mysqld]` section without editing, shadowing or reordering
 * the mounted one — what production gets stays byte-identical to what the fixture mounts.
 */
export const FIXTURE_REDO_LOG_CAPACITY = '64M';

/** The image's own `CMD` plus that one override; `docker-entrypoint.sh` remains the entrypoint. */
export const MYSQL_FIXTURE_COMMAND: readonly string[] = [
  'mysqld',
  `--innodb-redo-log-capacity=${FIXTURE_REDO_LOG_CAPACITY}`,
];

/**
 * Server variables `assertShippedConfiguration` reads back after every start.
 *
 * They are not a sample. Both are set only by the mounted `my.cnf`, and both differ from the server's
 * own defaults (`sql_require_primary_key` defaults to `OFF`, `innodb_ft_min_token_size` to `3`), so a
 * server reporting a default is a server that never read the option file — which on this fixture
 * means the schema's `FULLTEXT` index would be built with the wrong token floor and a migration could
 * create a table with no primary key.
 */
export const SHIPPED_VARIABLES: Readonly<Record<string, string>> = {
  innodb_ft_min_token_size: '2',
  sql_require_primary_key: 'ON',
};

/** The plugin `01_roles.sh` creates the three roles with, and asserts on before it lets the server up. */
export const ROLE_AUTH_PLUGIN = 'caching_sha2_password';

/**
 * Where `01_roles.sh` reads each role password from. The names mirror `infra/compose.yaml`'s
 * `IRIDIUM_DB_APP_PASSWORD_FILE: /run/secrets/db_app_password`; the plain form is set alongside because
 * 03-data-model.md §2 renders the script's SQL with `${IRIDIUM_DB_MIGRATOR_PASSWORD}`, and the harness
 * must work whichever of the two spellings the shipped script reads.
 */
export const ROLE_SECRET_FILES = {
  app: '/run/secrets/db_app_password',
  migrator: '/run/secrets/db_migrator_password',
  backup: '/run/secrets/db_backup_password',
} as const;

/**
 * Tables per-test truncation leaves alone: the migration ledger and the two rows the boot sequence
 * reads before it will serve anything (02-system-architecture.md boot step 2 loads `schema_meta` and
 * `server_settings` into the `SettingsStore`, and collaboration claims the seeded singleton in
 * `collab_owner_fence`). Truncating them would leave the schema looking
 * unmigrated to a server that is already running, which is a harness bug wearing a product failure's
 * clothes. A suite that means to change settings does it through `PUT /admin/settings`.
 */
export const PRESERVED_TABLES: readonly string[] = [
  'kysely_migration',
  'kysely_migration_lock',
  'schema_meta',
  'server_settings',
  'collab_owner_fence',
];

export interface StartMysqlOptions {
  /** Random material for a production-mode server, otherwise obvious fixture credentials. */
  readonly passwords?: DatabasePasswords;
  /** Defaults to `IRIDIUM_MYSQL_IMAGE`, then to the floor. */
  readonly image?: string;
  /** Join a shared Docker network so Toxiproxy can reach `mysql:3306`. */
  readonly network?: StartedNetwork;
}

/** The image this run uses: the selector, then the compatibility floor (D10-42). */
export function resolveMysqlImage(explicit?: string): string {
  return explicit ?? process.env['IRIDIUM_MYSQL_IMAGE'] ?? DEFAULT_MYSQL_IMAGE;
}

/**
 * Start the fixture. `tmpfs` on the data directory is what makes migrating a schema per worker
 * affordable; it is also why the container is never reused.
 */
export async function startMysql(options: StartMysqlOptions = {}): Promise<StartedMySqlContainer> {
  const image = resolveMysqlImage(options.image);
  const passwords = options.passwords ?? TEST_DB_PASSWORDS;
  requireExistingPath(
    MYSQL_CONF_FILE,
    'the shipped MySQL configuration (infra/docker/mysql/my.cnf)',
    'It is owned by infra/ and mounted, never copied — see 11-operations-and-deployment.md.',
  );
  requireExistingPath(
    MYSQL_INIT_ROLES_FILE,
    'the shipped role bootstrap (infra/docker/mysql/init/01_roles.sh)',
    'It creates iridium_app, iridium_migrator and iridium_backup (03-data-model.md §2).',
  );

  let container = new MySqlContainer(image)
    .withDatabase(DEFAULT_DATABASE_NAME)
    .withUsername('iridium')
    .withUserPassword(passwords.app)
    .withRootPassword(passwords.root)
    .withTmpFs({ '/var/lib/mysql': 'rw' })
    // The image's own `CMD`, plus the one override of `FIXTURE_REDO_LOG_CAPACITY`. `ENTRYPOINT` is
    // untouched, so `docker-entrypoint.sh` still initialises the data directory and still runs
    // `/docker-entrypoint-initdb.d`.
    .withCommand([...MYSQL_FIXTURE_COMMAND])
    .withCopyFilesToContainer([
      { source: MYSQL_CONF_FILE, target: MYSQL_CONF_TARGET, mode: MOUNTED_FILE_MODE },
      { source: MYSQL_INIT_ROLES_FILE, target: MYSQL_INIT_TARGET, mode: MOUNTED_FILE_MODE },
    ])
    .withCopyContentToContainer([
      { content: passwords.app, target: ROLE_SECRET_FILES.app, mode: MOUNTED_FILE_MODE },
      {
        content: passwords.migrator,
        target: ROLE_SECRET_FILES.migrator,
        mode: MOUNTED_FILE_MODE,
      },
      {
        content: passwords.backup,
        target: ROLE_SECRET_FILES.backup,
        mode: MOUNTED_FILE_MODE,
      },
    ])
    .withEnvironment({
      IRIDIUM_DB_APP_PASSWORD_FILE: ROLE_SECRET_FILES.app,
      IRIDIUM_DB_MIGRATOR_PASSWORD_FILE: ROLE_SECRET_FILES.migrator,
      IRIDIUM_DB_BACKUP_PASSWORD_FILE: ROLE_SECRET_FILES.backup,
      IRIDIUM_DB_APP_PASSWORD: passwords.app,
      IRIDIUM_DB_MIGRATOR_PASSWORD: passwords.migrator,
      IRIDIUM_DB_BACKUP_PASSWORD: passwords.backup,
    });

  if (options.network !== undefined) {
    container = container.withNetwork(options.network).withNetworkAliases(MYSQL_NETWORK_ALIAS);
  }

  const started = await container.start();
  // Both mounts are silent when they miss: a server that never read the option file starts happily
  // on its own defaults, and a role bootstrap that never ran leaves a database that answers every
  // query the harness asks next. Reading the server back here turns either into one failure with a
  // cause, instead of a migration or a grant failing three layers away.
  await assertShippedConfiguration(mysqlAdmin(started, passwords.root));
  return started;
}

/**
 * The privileged SQL surface the harness itself uses: the container's own `mysql` client, invoked as
 * `root`. It exists so the harness never needs `mysql2`/`kysely` of its own — the only first-party SQL
 * in the repository stays the product's — and so a Vitest worker, which has no container object, can do
 * the same work by container id through the runtime client `testcontainers` already provides.
 */
export interface MysqlAdmin {
  /**
   * Run one or more `;`-separated statements in a single session and return the client's **standard
   * output** — never its standard error, which `rows` would otherwise parse as data.
   */
  run(sql: string, flags?: readonly string[]): Promise<string>;
  /** Run a query and return its rows as column arrays, with no header. */
  rows(sql: string): Promise<readonly (readonly string[])[]>;
}

/**
 * The `mysql` client's `--batch --raw --skip-column-names` output: one row per line, tab-separated.
 *
 * The caller must hand this the client's standard output alone. `ExecResult.output` is testcontainers'
 * *interleaving* of both streams, and the `mysql` client writes its diagnostics to standard error, so
 * any line the client chooses to warn about would otherwise arrive here as a single-column row — and
 * a row is an identifier to `listTables`, `truncateAll` and `dropSchema`.
 */
export function parseMysqlRows(output: string): readonly (readonly string[])[] {
  return output
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line !== '')
    .map((line) => line.split('\t'));
}

/**
 * The root password reaches the client through `MYSQL_PWD` in the exec's environment rather than
 * through `-p`, which is what the shipped `01_roles.sh` does and for the same reason: `-p` on the
 * command line makes the client print "Using a password on the command line interface can be
 * insecure" on every single invocation. That warning is the *source* of the parsing hazard, and
 * removing it here removes it at the source; `parseMysqlRows` reading only standard output is the
 * second line of defence, for a warning some future client emits for a reason of its own.
 */

function mysqlArgv(sql: string, flags: readonly string[]): string[] {
  return ['mysql', '-h', '127.0.0.1', '-u', 'root', ...flags, '-e', sql];
}

/**
 * The one capability both admin flavours need: run an argv in the container, with an environment, and
 * get the two streams back *apart*. `StartedMySqlContainer.exec` and the runtime client's
 * `container.exec` both return testcontainers 12's `ExecResult`, whose `stdout` and `stderr` are
 * separate fields alongside the interleaved `output`.
 */
type ExecInContainer = (
  argv: string[],
  env: Readonly<Record<string, string>>,
) => Promise<Pick<ExecResult, 'stdout' | 'stderr' | 'exitCode'>>;

function adminOver(
  exec: ExecInContainer,
  rootPassword: string = TEST_DB_PASSWORDS.root,
): MysqlAdmin {
  const run = async (sql: string, flags: readonly string[] = []): Promise<string> => {
    const result = await exec(mysqlArgv(sql, flags), { MYSQL_PWD: rootPassword });
    if (result.exitCode !== 0) {
      throw new Error(
        `@iridium/testkit: mysql exited ${String(result.exitCode)} for: ${sql}\n${result.stderr}`,
      );
    }
    return result.stdout;
  };
  return {
    run,
    async rows(sql: string): Promise<readonly (readonly string[])[]> {
      return parseMysqlRows(await run(sql, ['--batch', '--raw', '--skip-column-names']));
    },
  };
}

/** An admin over a container this process started. */
export function mysqlAdmin(
  container: StartedMySqlContainer,
  rootPassword: string = TEST_DB_PASSWORDS.root,
): MysqlAdmin {
  return adminOver(async (argv, env) => container.exec(argv, { env }), rootPassword);
}

/**
 * An admin over a container **another process** started, addressed by id. This is what lets
 * `global/worker-schema.setup.ts` create and truncate its own schema: `globalSetup` provides the id,
 * and `testcontainers`' own runtime client reaches the same daemon from the worker.
 */
export async function mysqlAdminByContainerId(
  containerId: string,
  rootPassword: string = TEST_DB_PASSWORDS.root,
): Promise<MysqlAdmin> {
  const client = await getContainerRuntimeClient();
  const container = client.container.getById(containerId);
  return adminOver(
    async (argv, env) => client.container.exec(container, argv, { env }),
    rootPassword,
  );
}

/**
 * Read the server back and refuse a container that is not running the shipped configuration.
 *
 * `startMysql` calls this on every start, because both mounts fail *silently*. A `my.cnf` the server
 * declined to read (a mode or an ownership it distrusts, a path a future image stops scanning) leaves
 * a server that starts perfectly well on its own defaults, and an `01_roles.sh` that never ran leaves
 * a database that answers every query the harness asks next. Either one would be discovered later as
 * a migration, a grant or a FULLTEXT assertion failing for no visible reason.
 *
 * The two variables and the three roles are one query because they are one question: is this the
 * database 03-data-model.md describes?
 */
export async function assertShippedConfiguration(admin: MysqlAdmin): Promise<void> {
  const rows = await admin.rows(
    `SELECT 'variable', VARIABLE_NAME, VARIABLE_VALUE FROM performance_schema.global_variables ` +
      `WHERE VARIABLE_NAME IN (${Object.keys(SHIPPED_VARIABLES)
        .map((name) => `'${name}'`)
        .join(', ')}) ` +
      `UNION ALL SELECT 'role', USER, PLUGIN FROM mysql.user ` +
      `WHERE USER IN (${DB_ROLES.map((role) => `'${role}'`).join(', ')})`,
  );

  const observed = new Map<string, string>();
  for (const row of rows) {
    const [kind, name, value] = row;
    if (kind !== undefined && name !== undefined && value !== undefined) {
      observed.set(`${kind}:${name}`, value);
    }
  }

  const problems: string[] = [];
  for (const [name, expected] of Object.entries(SHIPPED_VARIABLES)) {
    const actual = observed.get(`variable:${name}`);
    if (actual !== expected) {
      problems.push(`${name} is ${actual ?? 'not reported by this server'}, expected ${expected}`);
    }
  }
  for (const role of DB_ROLES) {
    const actual = observed.get(`role:${role}`);
    if (actual === undefined) {
      problems.push(`the role ${role} does not exist`);
    } else if (actual !== ROLE_AUTH_PLUGIN) {
      problems.push(`the role ${role} authenticates with ${actual}, expected ${ROLE_AUTH_PLUGIN}`);
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `@iridium/testkit: this MySQL container is not running the shipped configuration: ` +
        `${problems.join('; ')}. ${MYSQL_CONF_FILE} is mounted at ${MYSQL_CONF_TARGET} and ` +
        `${MYSQL_INIT_ROLES_FILE} at ${MYSQL_INIT_TARGET}, both at mode ` +
        `0${MOUNTED_FILE_MODE.toString(8)} — a variable at its default means the server ignored the ` +
        `option file, and a missing role means the entrypoint never ran the bootstrap.`,
    );
  }
}

/** `CREATE DATABASE`, dropping any leftover of the same name first. */
export async function createSchema(admin: MysqlAdmin, schema: string): Promise<void> {
  assertSchemaName(schema);
  await admin.run(
    `DROP DATABASE IF EXISTS \`${schema}\`; CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4`,
  );
}

export async function dropSchema(admin: MysqlAdmin, schema: string): Promise<void> {
  assertSchemaName(schema);
  await admin.run(`DROP DATABASE IF EXISTS \`${schema}\``);
}

/**
 * Re-issue each role's schema-level grants against another schema.
 *
 * `01_roles.sh` grants `ON iridium.*`, so `iridium_tpl` and every `iridium_w<N>` would otherwise be
 * invisible to the migrator and the app role. The statements are **read back from MySQL** rather than
 * restated here, so the harness has no second copy of the grant matrix to drift from: `SHOW GRANTS`
 * reports what the shipped script actually did, and only the schema identifier is rewritten.
 */
export async function replicateSchemaGrants(
  admin: MysqlAdmin,
  from: string,
  to: string,
): Promise<void> {
  assertSchemaName(from);
  assertSchemaName(to);
  const statements: string[] = [];
  for (const role of DB_ROLES) {
    // One `mysql` invocation per role, in order: they share a container and concurrency would only
    // add processes, not speed.
    // eslint-disable-next-line no-await-in-loop -- one mysql client per role, in order; see above
    const rows = await admin.rows(`SHOW GRANTS FOR '${role}'@'%'`);
    for (const row of rows) {
      const grant = row[0];
      if (grant === undefined || !grant.includes(`\`${from}\`.*`)) {
        continue;
      }
      statements.push(grant.replaceAll(`\`${from}\`.*`, `\`${to}\`.*`));
    }
  }
  if (statements.length === 0) {
    throw new Error(
      `@iridium/testkit: no schema-level grants on \`${from}\` were found for ${DB_ROLES.join(', ')}. ` +
        'infra/docker/mysql/init/01_roles.sh did not run, or it granted on a different schema.',
    );
  }
  await admin.run(`${statements.join('; ')}; FLUSH PRIVILEGES`);
}

/** Every base table in a schema, excluding views. */
export async function listTables(admin: MysqlAdmin, schema: string): Promise<readonly string[]> {
  assertSchemaName(schema);
  const rows = await admin.rows(
    `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = '${schema}' AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`,
  );
  return rows.flatMap((row) => (row[0] === undefined ? [] : [row[0]]));
}

/**
 * Empty every table except `preserve`.
 *
 * MySQL refuses `TRUNCATE` on any table a foreign key references, empty or not
 * (`ER_TRUNCATE_ILLEGAL_FK`), so no ordering of `TRUNCATE` statements works on this engine: the
 * FK-safe form is one session with `FOREIGN_KEY_CHECKS = 0` around the whole set, restored at the end.
 * It is one session — one `mysql -e` — so the flag can never reach the server's own connections.
 */
export async function truncateAll(
  admin: MysqlAdmin,
  schema: string,
  preserve: readonly string[] = PRESERVED_TABLES,
): Promise<void> {
  const tables = (await listTables(admin, schema)).filter((t) => !preserve.includes(t));
  if (tables.length === 0) {
    return;
  }
  const truncations = tables.map((t) => `TRUNCATE TABLE \`${schema}\`.\`${t}\``).join('; ');
  await admin.run(`SET FOREIGN_KEY_CHECKS = 0; ${truncations}; SET FOREIGN_KEY_CHECKS = 1`);
}

/** Schema names are harness-generated; this refuses anything that is not, before it reaches SQL. */
export function assertSchemaName(schema: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(schema)) {
    throw new Error(`@iridium/testkit: "${schema}" is not a valid harness schema name`);
  }
  return schema;
}
