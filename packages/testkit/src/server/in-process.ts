import { existsSync } from 'node:fs';
/**
 * `startServer({ mode: 'in-process' })` — the default for the `integration`, `contract` and `mcp`
 * projects (10-testing-and-quality.md, "Server boot: `startServer`").
 *
 * It calls the product's own `buildApp({ mode: 'in-process' })` and then `listen({ port: 0 })`. There
 * is no second boot path: `guards.one-boot-path.guard.spec.ts` greps `apps/server/src` for a second
 * `Fastify(` construction site precisely so this file can never become one.
 *
 * The module is loaded **by path** rather than by package specifier. `@iridium/server` depends on
 * `@iridium/testkit` (never the other way round — `turbo boundaries` and `knip --production` enforce
 * it), so an import edge back would be a cycle across the boundary. A path import inside a
 * Vitest-transformed run is the honest expression of "the harness drives the server that is in this
 * repository", and the loader below turns every way it can fail — not built, not exported, wrong shape
 * — into one sentence naming what is missing.
 */
import { pathToFileURL } from 'node:url';

import { SERVER_APP_MODULE } from '../paths.ts';
import type { BuildAppLimits } from './limits.ts';

export type ServerMode = 'in-process' | 'child' | 'container';

/** The minimum of Fastify's surface the harness uses. A `FastifyInstance` satisfies it structurally. */
export interface TestAppInstance {
  listen(options: { port: number; host: string }): Promise<string>;
  close(): Promise<void>;
  /**
   * The ordered shutdown drain the ops plugin decorates (`app.drain()`, ARCH-06). Optional only so
   * that a double injected through `StartInProcessOptions.buildApp` need not implement it; every
   * instance `buildApp` returns has one, and `stop()` runs it before `close()`.
   */
  drain?(): Promise<void>;
  readonly server: { address(): { port: number } | string | null };
}

/**
 * The product's own factory (02-system-architecture.md, `apps/server/src/app.ts`).
 *
 * `TApp` is what the factory actually returns. It exists because 10-testing-and-quality.md's mode
 * table gives `in-process` one job the other two modes cannot do — *"gives direct access to
 * singletons for white-box assertions (`app.collab.gateway`, `app.authzBus`)"* — and a harness that
 * narrowed the instance to `TestAppInstance` would have thrown that away. A suite in `apps/server`
 * writes `startServer<FastifyInstance>({ … })` and reads the decorators it declared.
 */
export type BuildApp<TApp extends TestAppInstance = TestAppInstance> = (options: {
  mode: ServerMode;
  env?: Readonly<Record<string, string | undefined>>;
  limits?: BuildAppLimits;
}) => Promise<TApp>;

function describeMissing(reason: string): Error {
  return new Error(
    `@iridium/testkit: cannot start an in-process server — ${reason}. ` +
      `The harness calls buildApp({ mode: 'in-process' }) from ${SERVER_APP_MODULE} ` +
      '(02-system-architecture.md, boot order; 12-milestones.md §4.3 `apps/server`). ' +
      "Until that module exports it, use startServer({ mode: 'child' }) against the built binary.",
  );
}

/**
 * Import `apps/server/src/app.ts` and return its `buildApp`, or throw a sentence that says which half
 * is missing. Isolated so a missing export never surfaces as `TypeError: buildApp is not a function`
 * three frames inside a `beforeAll`.
 */
export async function loadBuildApp<TApp extends TestAppInstance = TestAppInstance>(): Promise<
  BuildApp<TApp>
> {
  if (!existsSync(SERVER_APP_MODULE)) {
    return Promise.reject(describeMissing('apps/server/src/app.ts does not exist'));
  }
  // A dynamic import of a computed specifier is untyped, so the module's declared contract is stated
  // here once and checked at runtime below — the "clear error, not a crash" half of the seam.
  let module: { buildApp?: BuildApp<TApp> };
  try {
    module = await import(pathToFileURL(SERVER_APP_MODULE).href);
  } catch (error) {
    throw describeMissing(
      `importing it failed: ${error instanceof Error ? error.message : 'unknown reason'}`,
    );
  }
  const buildApp = module.buildApp;
  if (typeof buildApp !== 'function') {
    throw describeMissing('it exports no `buildApp` function');
  }
  return buildApp;
}

export interface InProcessServer<TApp extends TestAppInstance = TestAppInstance> {
  readonly app: TApp;
  readonly port: number;
  close(): Promise<void>;
}

export interface StartInProcessOptions<TApp extends TestAppInstance = TestAppInstance> {
  /** Inject the factory instead of importing it — used by the harness's own tests. */
  readonly buildApp?: BuildApp<TApp>;
  /** Per-instance raw configuration; omitted only when a direct caller chooses ambient defaults. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** The port reserved before boot so `PUBLIC_ORIGIN` can name it (see `harness/free-port.ts`). */
  readonly port?: number;
  /** The per-boot collaboration overrides; see `BuildAppLimits` in `server/limits.ts`. */
  readonly limits?: BuildAppLimits;
}

/** Build and listen on loopback. */
export async function startInProcessServer<TApp extends TestAppInstance = TestAppInstance>(
  options: StartInProcessOptions<TApp> = {},
): Promise<InProcessServer<TApp>> {
  const factory = options.buildApp ?? (await loadBuildApp<TApp>());
  const app = await factory({
    mode: 'in-process',
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  });
  await app.listen({ port: options.port ?? 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (address === null || typeof address === 'string') {
    await app.close();
    throw new Error('@iridium/testkit: the in-process server did not report a TCP port');
  }
  return {
    app,
    port: address.port,
    async close(): Promise<void> {
      await app.close();
    },
  };
}
