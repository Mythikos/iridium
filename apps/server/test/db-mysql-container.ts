/**
 * The MySQL fixture adapter the database suites use.
 *
 * 10-testing-and-quality.md gives the whole harness **one** fixture, in `@iridium/testkit`:
 * `MySqlContainer(process.env.IRIDIUM_MYSQL_IMAGE ?? 'mysql:8.4.11')` with the shipped
 * `infra/docker/mysql/my.cnf` mounted at `/etc/mysql/conf.d/iridium.cnf` and the shipped
 * `infra/docker/mysql/init/01_roles.sh` in `/docker-entrypoint-initdb.d/`, so the three roles of
 * 03-data-model.md section 2 exist in tests exactly as in production. This module does not reproduce
 * that container -- it calls `startMysql()` -- and exists only to give the three database suites the
 * two things they need that the harness does not yet expose:
 *
 *  - a per-role connection **URL** for a named schema, including `root`, which the grant and
 *    `mysql.user` assertions need and which `databaseUrl()` (app/migrator/backup only) does not cover;
 *  - one place to start an image the harness never selects, so `db.version-floor.integration` can
 *    prove the refusal against a server that really is MySQL 8.0.46 or an innovation release.
 *
 * It is deliberately shaped to be deleted: every suite imports only this file, so when `startTestEnv`
 * grows a per-role URL accessor the change is one module, not three.
 */
import {
  DEFAULT_DATABASE_NAME,
  REQUIRED_MYSQL_IMAGES,
  resolveMysqlImage,
  startMysql,
  TEST_DB_PASSWORDS,
} from '@iridium/testkit';

/** The schema every Iridium deployment uses, and the one `init/01_roles.sh` grants on. */
export const IRIDIUM_SCHEMA = DEFAULT_DATABASE_NAME;

type StartedMysql = Awaited<ReturnType<typeof startMysql>>;

/** `IRIDIUM_MYSQL_IMAGE`, or the compatibility floor. */
export function selectedMysqlImage(): string {
  return resolveMysqlImage();
}

export interface MysqlLaneExpectation {
  readonly image: string;
  readonly required: boolean;
  readonly allowUntestedMysql: boolean;
  readonly versionPattern: RegExp;
}

/** Keep required-engine assertions exact while admitting the explicitly selected advisory lane. */
export function selectedMysqlLane(): MysqlLaneExpectation {
  const image = selectedMysqlImage();
  const required = REQUIRED_MYSQL_IMAGES.includes(image);
  const allowUntestedMysql = !required && process.env['IRIDIUM_ALLOW_UNTESTED_MYSQL'] === 'true';
  if (!required && !allowUntestedMysql) {
    throw new Error(`The selected test image ${image} requires IRIDIUM_ALLOW_UNTESTED_MYSQL=true`);
  }
  const version = /:(\d+\.\d+(?:\.\d+)?)(?:[-@]|$)/.exec(image)?.[1];
  if (version === undefined)
    throw new Error(`The selected MySQL image has no version tag: ${image}`);
  return {
    image,
    required,
    allowUntestedMysql,
    versionPattern: new RegExp(`^${version.replaceAll('.', '\\.')}\\b`),
  };
}

export interface StartMysqlOptions {
  /** Defaults to `selectedMysqlImage()`. */
  readonly image?: string;
}

export interface IridiumMysql {
  readonly image: string;
  readonly container: StartedMysql;
  readonly host: string;
  readonly port: number;
  /** `mysql://iridium_app:...@host:port/<schema>` */
  appUrl(schema?: string): string;
  /** `mysql://iridium_migrator:...@host:port/<schema>` */
  migratorUrl(schema?: string): string;
  /** `mysql://iridium_backup:...@host:port/<schema>` */
  backupUrl(schema?: string): string;
  /** `mysql://root:...@host:port/<schema>` */
  rootUrl(schema?: string): string;
  stop(): Promise<void>;
}

function url(user: string, password: string, host: string, port: number, schema: string): string {
  return `mysql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${String(port)}/${encodeURIComponent(schema)}`;
}

/** Starts the harness fixture and wraps it in per-role URL accessors. */
export async function startIridiumMysql(options: StartMysqlOptions = {}): Promise<IridiumMysql> {
  const image = options.image ?? selectedMysqlImage();
  const started = await startMysql({ image });
  const host = started.getHost();
  const port = started.getPort();

  return {
    image,
    container: started,
    host,
    port,
    appUrl: (schema = IRIDIUM_SCHEMA) =>
      url('iridium_app', TEST_DB_PASSWORDS.app, host, port, schema),
    migratorUrl: (schema = IRIDIUM_SCHEMA) =>
      url('iridium_migrator', TEST_DB_PASSWORDS.migrator, host, port, schema),
    backupUrl: (schema = IRIDIUM_SCHEMA) =>
      url('iridium_backup', TEST_DB_PASSWORDS.backup, host, port, schema),
    rootUrl: (schema = IRIDIUM_SCHEMA) => url('root', TEST_DB_PASSWORDS.root, host, port, schema),
    stop: async () => {
      await started.stop();
    },
  };
}
