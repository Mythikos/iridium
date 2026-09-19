/**
 * The one way the platform suites boot the application (`app.boot-modes.integration` establishes the
 * pattern; 10-testing-and-quality.md, "Server boot: `startServer`").
 *
 * These suites need the **instance**, not a socket: the route table (`app.routes()`), the fault registry,
 * the database handle and `app.inject()` are what they assert against, and `light-my-request` is the only
 * way to control `Origin`, `Sec-Fetch-Site` and `Cookie` per request without a browser. So they call the
 * product's own `buildApp` directly — the same single boot path `startServer({ mode: 'in-process' })`
 * calls — rather than a second harness.
 *
 * `buildApp` returns an instance that has **not** been readied, which is what lets a suite add a probe
 * route inside the `/__test__` namespace before `app.ready()` runs the route-policy assertion.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildServerEnv, workerSchemaName, type ServerEnvOptions } from '@iridium/testkit';
import type { FastifyInstance } from 'fastify';
import { inject } from 'vitest';

import { buildApp } from '../../src/app.ts';
import type { ServerLogger } from '../../src/ops/logging.ts';

/**
 * The schema `global/worker-schema.setup.ts` created, named the way that file names it.
 *
 * `workerSchema()` is the accessor for exactly this and cannot be used from a spec file: the setup file is
 * loaded by source path while `@iridium/testkit` resolves through the package's `exports` to `dist/`, so
 * the barrel's copy of the module never sees the setup's write. Deriving the name from the same worker id
 * is the honest reading of the same fact; the seam is `@iridium/testkit`'s to close.
 */
export const WORKER_SCHEMA = workerSchemaName(process.env['VITEST_WORKER_ID'] ?? '1');

/** The origin every suite configures, so `Origin` comparisons have one expected value. */
export const TEST_PUBLIC_ORIGIN = 'http://127.0.0.1:4000';

export interface PlatformAppOptions {
  /** Extra environment on top of the harness's, merged last so a suite can override a default. */
  readonly extraEnv?: Readonly<Record<string, string>>;
  /** Called after `buildApp` and before `ready()`, for a suite that needs a probe route. */
  readonly beforeReady?: (app: FastifyInstance) => void;
  /** An explicit fixture for production credentials; otherwise use this worker's migrated schema. */
  readonly connection?: Pick<ServerEnvOptions, 'host' | 'port' | 'schema' | 'passwords'>;
  /** 'none' is reserved for schema/code-generation probes that perform no product requests. */
  readonly database?: 'connect' | 'none';
  /**
   * An already-built logger, so a suite can capture the stream.
   *
   * `logging-redaction.integration` is the caller: the contract it asserts covers **every** line the
   * process writes, boot lines included, and the only way to hold the boot lines to it is to hand
   * `buildApp` the logger it will use before it writes the first one.
   */
  readonly logger?: ServerLogger;
}

/** An application under test, with the scratch directory it wrote to. */
export interface PlatformApp {
  readonly app: FastifyInstance;
  readonly scratchDir: string;
  close(): Promise<void>;
}

/** Builds, optionally decorates and readies the application against the worker schema. */
export async function startPlatformApp(options: PlatformAppOptions = {}): Promise<PlatformApp> {
  const mysql = inject('iridiumMysql');
  const scratchDir = mkdtempSync(join(tmpdir(), 'iridium-platform-'));
  const app = await buildApp({
    mode: 'in-process',
    env: buildServerEnv({
      host: mysql.host,
      port: mysql.port,
      schema: WORKER_SCHEMA,
      ...options.connection,
      publicOrigin: TEST_PUBLIC_ORIGIN,
      attachmentsDir: scratchDir,
      ...(options.extraEnv === undefined ? {} : { extraEnv: options.extraEnv }),
    }),
    database: options.database ?? 'connect',
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
  options.beforeReady?.(app);
  await app.ready();
  return {
    app,
    scratchDir,
    async close(): Promise<void> {
      // A harness stops a server the way production does (ARCH-06): the drain flushes the writers
      // and returns every reservation, then `close()` destroys the pools. A close without a drain
      // would wait on the collaboration lease's dedicated connection.
      await app.drain();
      await app.close();
      rmSync(scratchDir, { recursive: true, force: true });
    },
  };
}
