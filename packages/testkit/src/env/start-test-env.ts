import { randomBytes } from 'node:crypto';

import type { StartedMySqlContainer } from '@testcontainers/mysql';
/**
 * `startTestEnv()` — the once-per-run environment (10-testing-and-quality.md, "Environment:
 * `startTestEnv`").
 *
 * It is called from a `globalSetup` and hands its coordinates to workers with `project.provide()`.
 * It never starts a server: boot is `startServer`'s job, three modes from one `buildApp`, and keeping
 * the two apart is what lets the chaos project kill and restart a process against a database that
 * outlives it.
 */
import { Network } from 'testcontainers';
import type { StartedNetwork } from 'testcontainers';

import { migrateSchema } from '../server/cli.ts';
import type { DatabasePasswords } from '../server/env.ts';
import { DEFAULT_DATABASE_NAME, TEMPLATE_SCHEMA, TEST_DB_PASSWORDS } from '../server/env.ts';
import type { MysqlAdmin } from './mysql.ts';
import {
  MYSQL_NETWORK_ALIAS,
  createSchema,
  mysqlAdmin,
  replicateSchemaGrants,
  resolveMysqlImage,
  startMysql,
} from './mysql.ts';
import type { ProxyHandle, ToxiproxyFixture } from './toxiproxy.ts';
import { MYSQL_PROXY_NAME, startToxiproxy } from './toxiproxy.ts';

export interface TestEnvOptions {
  /** Generate disposable database passwords and signing keys accepted by production validation. */
  readonly productionCredentials?: boolean;
  /** Defaults to `IRIDIUM_MYSQL_IMAGE`, then to the floor `mysql:8.4.11`. */
  readonly mysqlImage?: string;
  /** The `chaos` project only: start Toxiproxy on a shared network and proxy MySQL through it. */
  readonly toxiproxy?: boolean;
  /** An existing shared network; one is created when Toxiproxy is on and none is given. */
  readonly network?: StartedNetwork;
  /** Skip migrating the template schema. Only for a suite that provisions its own (the ops drills). */
  readonly skipTemplate?: boolean;
}

export interface TestEnvMysql {
  readonly passwords: DatabasePasswords;
  /** `mysql://root:…@host:port/iridium` — the harness's own admin connection string. */
  readonly rootUri: string;
  readonly host: string;
  readonly port: number;
  /** The schema per-worker schemas are cloned from. */
  readonly templateSchema: string;
  /** The image this run resolved to, so a failure names the engine it happened on. */
  readonly image: string;
  /**
   * The Docker container id. A Vitest worker has no container object, so this is how
   * `global/worker-schema.setup.ts` reaches the same container through `mysqlAdminByContainerId`.
   */
  readonly containerId: string;
}

export interface TestEnv {
  /** Pass to startServer({extraEnv}) so migration and runtime audit chains share their keys. */
  readonly serverEnv: Readonly<Record<string, string>>;
  readonly mysql: TestEnvMysql;
  /** The same MySQL, reached through Toxiproxy. Present only when `toxiproxy: true`. */
  readonly mysqlViaToxiproxy?: ProxyHandle;
  readonly toxiproxy?: ToxiproxyFixture;
  /** The started container, for the process that owns it. */
  readonly container: StartedMySqlContainer;
  /** The privileged SQL surface, for the process that owns the container. */
  readonly admin: MysqlAdmin;
  readonly network?: StartedNetwork;
  stop(): Promise<void>;
}

const fresh = (): string => randomBytes(32).toString('base64url');

/**
 * Start MySQL (and, for the chaos project, Toxiproxy), then migrate the template schema through
 * `iridium migrate up` under the migrator role — the product's own path, never a SQL file.
 */
export async function startTestEnv(options: TestEnvOptions = {}): Promise<TestEnv> {
  const image = resolveMysqlImage(options.mysqlImage);
  const passwords: DatabasePasswords =
    options.productionCredentials === true
      ? { root: fresh(), app: fresh(), migrator: fresh(), backup: fresh() }
      : TEST_DB_PASSWORDS;
  const serverEnv: Record<string, string> =
    options.productionCredentials === true
      ? {
          AUTH_PASSWORD_PEPPER: fresh(),
          AUDIT_HMAC_KEY: fresh(),
          MCP_CURSOR_KEY: fresh(),
          METRICS_TOKEN: fresh(),
        }
      : {};
  const wantsNetwork = options.toxiproxy === true;
  const network = options.network ?? (wantsNetwork ? await new Network().start() : undefined);

  const container = await startMysql({
    image,
    passwords,
    ...(network === undefined ? {} : { network }),
  });
  const admin = mysqlAdmin(container, passwords.root);

  let toxiproxy: ToxiproxyFixture | undefined;
  let mysqlViaToxiproxy: ProxyHandle | undefined;
  if (wantsNetwork) {
    if (network === undefined) {
      throw new Error('@iridium/testkit: toxiproxy requires a shared network');
    }
    toxiproxy = await startToxiproxy({ network });
    mysqlViaToxiproxy = await toxiproxy.createProxy(
      MYSQL_PROXY_NAME,
      `${MYSQL_NETWORK_ALIAS}:3306`,
    );
  }

  const host = container.getHost();
  const port = container.getPort();

  if (options.skipTemplate !== true) {
    await createSchema(admin, TEMPLATE_SCHEMA);
    await replicateSchemaGrants(admin, DEFAULT_DATABASE_NAME, TEMPLATE_SCHEMA);
    await migrateSchema({ host, port, schema: TEMPLATE_SCHEMA, passwords, extraEnv: serverEnv });
  }

  const env: TestEnv = {
    serverEnv,
    mysql: {
      passwords,
      rootUri: container.getConnectionUri(true),
      host,
      port,
      templateSchema: TEMPLATE_SCHEMA,
      image,
      containerId: container.getId(),
    },
    ...(mysqlViaToxiproxy === undefined ? {} : { mysqlViaToxiproxy }),
    ...(toxiproxy === undefined ? {} : { toxiproxy }),
    container,
    admin,
    ...(network === undefined ? {} : { network }),
    async stop(): Promise<void> {
      // Stop in reverse order of creation so a proxy is never left pointing at a dead upstream.
      await toxiproxy?.stop();
      await container.stop();
      if (options.network === undefined) {
        await network?.stop();
      }
    },
  };
  return env;
}
