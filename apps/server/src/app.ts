/**
 * `buildApp({ mode })` — the one boot path (02-system-architecture.md, "Boot sequence and plugin
 * order"; ARCH-01; invariant 1).
 *
 * There is exactly one `Fastify(` construction site in `apps/server/src`, and
 * `guards.one-boot-path.guard` asserts it. The three modes share one plugin tree and differ only in
 * listening, signal handling and whether the scheduler starts:
 *
 * | mode         | listens                                  | signals          | scheduler |
 * |--------------|------------------------------------------|------------------|-----------|
 * | `container`  | `BIND_ADDRESS:PORT`                      | SIGTERM/SIGINT   | on        |
 * | `child`      | ephemeral port, `{"listening":<port>}`    | SIGTERM          | on unless `JOBS_ENABLED=false` |
 * | `in-process` | never by default (`app.inject()`)        | none             | off       |
 *
 * Registration order is `config → db → security → auth → authz → audit → rest → collab → mcp → ops
 * → jobs`, and the later steps are empty stubs at M0 so that a milestone adds behaviour to a named
 * step rather than a new step.
 *
 * **Iridium's own plugins are applied, not `register`ed.** `fastify-plugin` is not a declared
 * dependency of this package, and `app.register(fn)` on a bare function encapsulates it — which
 * would hide its hooks and decorators from every later plugin, silently. Applying the function to
 * the root instance keeps the documented order and keeps the hooks global. Third-party plugins are
 * `register`ed as usual: each carries its own `fastify-plugin` wrapper.
 *
 * Nothing listens until the last step. `app.ready()` runs the route-policy boot assertion, which
 * refuses to start the server when any route does not declare `config.auth`.
 */
import { LIMITS, newId } from '@iridium/contracts';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';

import { applyAuditPlugin } from './audit/plugin.ts';
import { applyAuthPlugin } from './auth/plugin.ts';
import { applyRoutePolicyPlugin } from './authz/route-policy.ts';
import { applyDbPlugin, type DatabaseMode } from './boot/db.ts';
import { applyCollabPlugin } from './collab/plugin.ts';
import { loadConfigDetailed, type IridiumConfig, type RawEnv } from './config/env.ts';
import { applyJobsPlugin } from './jobs/plugin.ts';
import { applyMcpPlugin } from './mcp/plugin.ts';
import { systemClock, type Clock } from './ops/clock.ts';
import { createLogger, newInstanceId, type ServerLogger } from './ops/logging.ts';
import { applyOpsPlugin } from './ops/plugin.ts';
import { Readiness } from './ops/readiness.ts';
import { applyRestPlugin } from './rest/plugin.ts';
import { applySecurityPlugin } from './security/plugin.ts';

/** The three boot modes of ARCH-01. */
export type ServerMode = 'in-process' | 'child' | 'container';

/** What `buildApp` accepts. Everything but `mode` has a documented default. */
export interface BuildAppOptions {
  readonly mode: ServerMode;
  /**
   * An already-parsed configuration. Tests build one directly rather than mutating `process.env`,
   * which is what makes "configuration is parsed exactly once" a property of the code.
   */
  readonly config?: IridiumConfig;
  /** The environment to parse when `config` is absent. Defaults to `process.env`. */
  readonly env?: RawEnv;
  /**
   * `'connect'` (the default) opens the pools; `'none'` boots without a database, which is the mode
   * `pnpm gen` uses to export the OpenAPI document from `app.swagger()` with no container.
   */
  readonly database?: DatabaseMode;
  /** Injected for deterministic tests (ARCH-18). */
  readonly clock?: Clock;
  /** An already-built logger, so a test can capture the stream (`logging-redaction.integration`). */
  readonly logger?: ServerLogger;
}

declare module 'fastify' {
  interface FastifyInstance {
    /** The frozen configuration this process parsed once. */
    iridiumConfig: IridiumConfig;
    /** The mode this instance was built in. */
    mode: ServerMode;
    /** `<hostname>:<pid>:<boot-uuid-short>`; the `locked_by` value the job scheduler claims with. */
    instanceId: string;
    /** The injected clock, so a service never reaches for the global one. */
    clock: Clock;
  }
}

/**
 * Builds the application. The returned instance has not listened and has not run `ready()`; the
 * caller does both, which is what lets `in-process` mode call `app.inject()` without a socket.
 */
export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  // ---- 1. config --------------------------------------------------------------------------------
  const loaded = options.config === undefined ? loadConfigDetailed(options.env) : null;
  const config = options.config ?? loaded?.config;
  if (config === undefined) throw new Error('buildApp received no configuration');

  const clock = options.clock ?? systemClock;
  const bootId = newId();
  const instanceId = newInstanceId(bootId);
  const logger =
    options.logger ??
    createLogger({
      level: config.ops.logLevel,
      format: config.ops.logFormat,
      instanceId,
    });

  if (loaded !== null) {
    logger.info(
      {
        event: 'config.loaded',
        mode: options.mode,
        config: loaded.redacted,
        ignoredHarnessKeys: loaded.diagnostics.ignoredHarnessKeys,
        cpuCeiling: {
          cpus: loaded.diagnostics.cpuCeiling.cpus,
          bound: loaded.diagnostics.cpuCeiling.bound,
        },
      },
      'configuration loaded',
    );
    for (const warning of loaded.diagnostics.warnings) logger.warn({ warning }, warning);
  }

  // Typed as `FastifyBaseLogger` rather than as pino's `Logger`, so the instance keeps Fastify's
  // default logger generic and every plugin can take a plain `FastifyInstance`.
  const baseLogger: FastifyBaseLogger = logger;
  const app = Fastify({
    loggerInstance: baseLogger,
    // One `http.request` line per response is written by the ops plugin (ARCH-15), so Fastify's own
    // two lines per request are off. `logController` is the Fastify 5.12 form; the top-level
    // `disableRequestLogging` option it replaces is deprecated and goes away in Fastify 6.
    logController: new LogController({
      disableRequestLogging: true,
      requestIdLogLabel: 'requestId',
    }),
    trustProxy: config.server.trustProxy === false ? false : [...config.server.trustProxy],
    genReqId: () => newId(),
    bodyLimit: LIMITS.BODY_MAX_BYTES_JSON,
    routerOptions: { ignoreTrailingSlash: true },
    // The route-policy assertion walks method+path pairs, so an auto-generated HEAD route must carry
    // the same `config` as its GET. Fastify does that already; keeping the option explicit records
    // that the assertion depends on it.
    exposeHeadRoutes: true,
  });

  app.decorate('iridiumConfig', config);
  app.decorate('mode', options.mode);
  app.decorate('instanceId', instanceId);
  app.decorate('clock', clock);

  const readiness = new Readiness(clock);

  // ---- 2. db ------------------------------------------------------------------------------------
  const database = await applyDbPlugin({
    config,
    mode: options.database ?? 'connect',
    logger,
    readiness,
    clock,
  });
  app.decorate('database', database);

  // ---- 3. security ------------------------------------------------------------------------------
  await applySecurityPlugin(app, { config });

  // ---- 4. auth · 5. authz · 6. audit -------------------------------------------------------------
  applyAuthPlugin(app);
  applyRoutePolicyPlugin(app);
  applyAuditPlugin(app);

  // ---- 7. rest · 8. collab · 9. mcp --------------------------------------------------------------
  await applyRestPlugin(app, { config, logger });
  applyCollabPlugin(app);
  applyMcpPlugin(app);

  // ---- 10. ops · 11. jobs -------------------------------------------------------------------------
  applyOpsPlugin(app, { config, readiness, clock, logger, database });
  applyJobsPlugin(app);

  app.addHook('onClose', async () => {
    await database.destroy();
  });

  // Leaves `starting` once every plugin has registered, which is what ARCH-02's state machine means
  // by "until step 12 completes".
  app.addHook('onReady', async () => {
    await readiness.finishBoot();
  });

  return app;
}

/** What `startServer` resolves to: the instance plus the address it actually listened on. */
export interface StartedServer {
  readonly app: FastifyInstance;
  readonly port: number;
  readonly address: string;
}

/**
 * Builds, readies and listens according to the mode (ARCH-01).
 *
 * `child` mode ignores `PORT`, listens on an ephemeral port and prints `{"listening":<port>}` on
 * stdout, which is the line `@iridium/testkit`'s `startServer({mode:'child'})` waits for. That one
 * line is deliberately not a pino record: it is a handshake with the parent process, read before the
 * server has said anything else, and the harness parses it rather than the log stream.
 */
export async function startServer(options: BuildAppOptions): Promise<StartedServer> {
  const app = await buildApp(options);
  const config = app.iridiumConfig;
  await app.ready();

  const port = options.mode === 'child' ? 0 : config.server.port;
  const address = await app.listen({ port, host: config.server.bindAddress });
  const bound = app.server.address();
  const listeningPort = typeof bound === 'object' && bound !== null ? bound.port : port;

  if (options.mode === 'child') {
    process.stdout.write(`${JSON.stringify({ listening: listeningPort })}\n`);
  }
  app.log.info(
    { address, port: listeningPort, mode: options.mode, instanceId: app.instanceId },
    'listening',
  );

  if (options.mode !== 'in-process') installSignalHandlers(app);
  return { app, port: listeningPort, address };
}

/** SIGTERM (and SIGINT in `container` mode) start the drain of ARCH-06. */
function installSignalHandlers(app: FastifyInstance): void {
  const signals: NodeJS.Signals[] = app.mode === 'container' ? ['SIGTERM', 'SIGINT'] : ['SIGTERM'];
  let closing = false;
  for (const signal of signals) {
    process.once(signal, () => {
      if (closing) return;
      closing = true;
      void (async () => {
        try {
          await app.drain();
          await app.close();
          process.exitCode = 0;
        } catch (error) {
          app.log.error({ err: error, event: 'persist.drain_timeout' }, 'drain failed');
          process.exitCode = 1;
        }
      })();
    });
  }
}
