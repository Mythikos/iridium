/**
 * The one boot path without a database, for the unit specs of the plugins' wiring
 * (02-system-architecture.md invariant 1; `guards.one-boot-path.guard`): `buildApp({ mode:
 * 'in-process', database: 'none' })` over a configuration parsed from a minimal environment, with a
 * scratch attachments directory that `close()` removes. The caller registers what it needs and
 * calls `ready()` itself, so a spec can also prove that the boot assertion refuses to start.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';

import { buildApp } from '../../src/app.ts';
import { loadConfig, type RawEnv } from '../../src/config/env.ts';
import type { ServerLogger } from '../../src/ops/logging.ts';

/** The origin the configuration names; the `Host` guard accepts its host on every API route. */
export const NO_DATABASE_ORIGIN = 'http://127.0.0.1:4000';

/** The `Host` header a request to the app must carry. */
export const NO_DATABASE_HOST = '127.0.0.1:4000';

export interface NoDatabaseAppOptions {
  /** Keys added to (or overriding) the minimal environment. */
  readonly extraEnv?: Partial<RawEnv>;
  /** An already-built logger, so a spec can capture what the process logs. */
  readonly logger?: ServerLogger;
}

export interface NoDatabaseApp {
  readonly app: FastifyInstance;
  /** Closes the instance and removes the scratch directory. */
  close(): Promise<void>;
}

/** Builds the instance; it is not yet `ready()`. */
export async function buildWithoutDatabase(
  options: NoDatabaseAppOptions = {},
): Promise<NoDatabaseApp> {
  const scratch = mkdtempSync(join(tmpdir(), 'iridium-no-database-'));
  const env: RawEnv = {
    NODE_ENV: 'test',
    PUBLIC_ORIGIN: NO_DATABASE_ORIGIN,
    DATABASE_URL: 'mysql://iridium_app:pw@127.0.0.1:3306/iridium',
    ATTACHMENTS_DIR: join(scratch, 'attachments'),
    LOG_LEVEL: 'fatal',
    ...options.extraEnv,
  };
  const app = await buildApp({
    mode: 'in-process',
    database: 'none',
    config: loadConfig(env),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
  return {
    app,
    async close(): Promise<void> {
      await app.close();
      rmSync(scratch, { recursive: true, force: true });
    },
  };
}
