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
 * | `child`      | `BIND_ADDRESS:PORT`, port reported on stdout | SIGTERM          | on unless `JOBS_ENABLED=false` |
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
import { applyDbPlugin, type DatabaseHandle, type DatabaseMode } from './boot/db.ts';
import { applyCollabPlugin, type CollabLimitOverrides } from './collab/plugin.ts';
import { loadConfigDetailed, type IridiumConfig, type RawEnv } from './config/env.ts';
import { toProblem as toDatabaseProblem } from './db/failure.ts';
import { applyJobsPlugin } from './jobs/plugin.ts';
import { applyMcpPlugin } from './mcp/plugin.ts';
import { systemClock, type Clock } from './ops/clock.ts';
import { createLogger, newInstanceId, type ServerLogger } from './ops/logging.ts';
import { applyOpsPlugin, applyReadinessGate } from './ops/plugin.ts';
import { Readiness } from './ops/readiness.ts';
import { applyDocsRoutePolicy } from './rest/docs.ts';
import { applyRequestOwnership } from './rest/ownership.ts';
import { applyRestPlugin } from './rest/plugin.ts';
import { applyClientVersionGate } from './rest/version.ts';
import { applyCsrfGuard } from './security/csrf.ts';
import { applySecurityPlugin } from './security/plugin.ts';

/** The three boot modes of ARCH-01. */
export type ServerMode = 'in-process' | 'child' | 'container';

/**
 * What this process was booted to *be*, which `mode` cannot express.
 *
 * `in-process` is both the harness's server and every CLI command, and the two differ in one way that
 * matters: a server serves documents and therefore competes for the `iridium_collab_owner` lease,
 * while `iridium migrate status` must never take it — a command run while the server is down would
 * otherwise hold the lock for the length of the command, and one run *beside* a healthy server would
 * be refused the lease it has no use for. So the collaboration subsystem is gated on the role rather
 * than on the mode (05-collaboration-and-durability.md, the owner lease; 12-milestones.md §5.2).
 */
export type ServerRole = 'server' | 'cli';

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
  /**
   * What this process is: a server that serves documents, or a CLI command. Defaults to `'server'`,
   * because every boot that listens is one; `apps/server/src/cli` passes `'cli'`.
   */
  readonly role?: ServerRole;
  /**
   * Per-boot overrides of the collaboration limits (12-milestones.md §5.4:
   * `startServer({ limits: { maxLoadedDocs: 8, … } })`). Numbers only; a suite that wants `'2MiB'`
   * converts it. Absent members keep the configured value, and every knob an operator can set
   * travels through the environment instead — this carries exactly what `EnvSchema` has no key for
   * (`scratchpad/m1/seams/testkit.md` §1).
   */
  readonly limits?: CollabLimitOverrides;
}

declare module 'fastify' {
  interface FastifyInstance {
    /** The frozen configuration this process parsed once. */
    iridiumConfig: IridiumConfig;
    /** The mode this instance was built in. */
    mode: ServerMode;
    /** What this instance was built to be: a document-serving server, or a CLI command. */
    role: ServerRole;
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
    // onReady completes the serial readiness scan before listening. The framework's 10 s
    // default cannot accommodate sixteen real probes under CH-16's 500 ms database latency.
    // Keep boot bounded while allowing the same 60 s budget as the child startup handshake.
    pluginTimeout: 60_000,
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
  app.decorate('role', options.role ?? 'server');
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
  // Registered *here*, at the step that opened the pools, and not at the end of the factory. A boot
  // that throws in a later step never reaches the end, and the caller never receives an instance it
  // could close — so a hook registered later would leave step 2's pools holding the event loop open
  // and turn a one-line configuration error into a process that prints it and then hangs.
  app.addHook('onClose', async () => {
    await database.destroy();
  });

  try {
    await applyRemainingSteps(app, { config, database, clock, logger, readiness, options });
  } catch (error) {
    // Everything the steps that did run had opened is released before the error leaves this
    // function, because nobody else can: the instance is never returned.
    await abandonBoot(app, database, logger);
    throw error;
  }

  return app;
}

/** What the steps after the database need, gathered so the guarded region is one call. */
interface RemainingStepsContext {
  readonly config: IridiumConfig;
  readonly database: DatabaseHandle;
  readonly clock: Clock;
  readonly logger: ServerLogger;
  readonly readiness: Readiness;
  readonly options: BuildAppOptions;
}

/**
 * Releases what a failed boot had already opened, then lets the original error propagate.
 *
 * `close()` drains every `onClose` hook the steps that ran had registered — step 2's pools among
 * them, and the collaboration lease when step 8 got that far — which is more than destroying the
 * handle by hand would release. Its own failure is logged and swallowed: the error worth reporting
 * is the one that stopped the boot, never a second one raised while cleaning up after it. The handle
 * is then destroyed directly because `destroy()` is idempotent and `close()` can reject before it
 * reaches the hooks at all, and the pools are the resource that holds the event loop open.
 */
async function abandonBoot(
  app: FastifyInstance,
  database: DatabaseHandle,
  logger: FastifyBaseLogger,
): Promise<void> {
  for (const release of [async () => app.close(), async () => database.destroy()]) {
    try {
      // eslint-disable-next-line no-await-in-loop -- the handle is destroyed after `close()` had its turn
      await release();
    } catch (teardownError) {
      logger.error(
        { err: teardownError, event: 'boot.teardown_failed' },
        'releasing resources after a failed boot failed; the boot error follows',
      );
    }
  }
}

/**
 * Boot steps 3 to 11, as one call so that `buildApp` can release what they opened if one throws.
 *
 * The step order and the comments are 02-system-architecture.md's and are unchanged by the
 * extraction; only the enclosing function is new.
 */
async function applyRemainingSteps(
  app: FastifyInstance,
  context: RemainingStepsContext,
): Promise<void> {
  const { config, database, clock, logger, readiness, options } = context;

  // ---- 3. security ------------------------------------------------------------------------------
  await applySecurityPlugin(app, { config });
  // Reject non-serving traffic before credential verification or any authentication side effect.
  applyReadinessGate(app, readiness);
  applyRequestOwnership(app);
  // The `db` area's own problem mappings, registered from here because `app.problems` is decorated by
  // step 3 and the database handle is built in step 2 — the registry cannot exist before the step that
  // owns the envelope, and the area that owns the errors has no plugin of its own (`boot/db.ts` is an
  // adapter). Every other area registers its mapper at its own boot step (`security/problem-registry.ts`).
  app.problems.register('db', (error) => toDatabaseProblem(error));

  // ---- 4. auth · 5. authz · 6. audit -------------------------------------------------------------
  applyAuthPlugin(app);
  // The CSRF guard is `security/`'s, but 04-auth-and-access-control.md section 6.1 requires
  // `authenticate()` to run before it, and Fastify runs instance-level `onRequest` hooks in
  // registration order. So the hook is added here, inside step 4's neighbourhood, and the step order of
  // 02-system-architecture.md is unchanged. Moving this call above `applyAuthPlugin` would let a failed
  // bearer fall through to the guard's cookie branches.
  applyCsrfGuard(app, { config });
  applyClientVersionGate(app);
  // The Swagger UI's own routes are `rest`'s (step 7), but the hook that gives them a policy has to
  // be registered before the route policy's collector: Fastify runs a scope's `onRoute` hooks in
  // registration order, and the collector snapshots `config.auth` as it sees it. Same reasoning as
  // the CSRF guard above, and the step order of 02-system-architecture.md is again unchanged.
  applyDocsRoutePolicy(app, config);
  applyRoutePolicyPlugin(app);
  applyAuditPlugin(app, { config, database, clock, logger, readiness });

  // ---- 7. rest · 8. collab · 9. mcp --------------------------------------------------------------
  await applyRestPlugin(app, { config, logger });
  await applyCollabPlugin(app, {
    config,
    database,
    clock,
    logger,
    readiness,
    role: app.role,
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  });
  applyMcpPlugin(app);

  // ---- 10. ops · 11. jobs -------------------------------------------------------------------------
  applyOpsPlugin(app, { config, readiness, clock, logger, database });
  applyJobsPlugin(app);

  // Leaves `starting` once every plugin has registered, which is what ARCH-02's state machine means
  // by "until step 12 completes".
  app.addHook('onReady', async () => {
    await readiness.finishBoot();
  });
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
 * `child` mode honors `PORT` (zero selects an ephemeral port) and prints `{"listening":<port>}` on
 * stdout, which is the line `@iridium/testkit`'s `startServer({mode:'child'})` waits for. That one
 * line is deliberately not a pino record: it is a handshake with the parent process, read before the
 * server has said anything else, and the harness parses it rather than the log stream.
 */
export async function startServer(options: BuildAppOptions): Promise<StartedServer> {
  const app = await buildApp(options);
  try {
    await app.ready();
    const { port, bindAddress } = app.iridiumConfig.server;
    const address = await app.listen({ port, host: bindAddress });
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
  } catch (error) {
    // `ready()` can acquire the owner lease before either an onReady hook or listen() fails.
    // The caller never receives this app, so startup owns releasing it just as buildApp does.
    await abandonBoot(app, app.database, app.log);
    throw error;
  }
}

/** SIGTERM (and SIGINT in `container` mode) start the drain of ARCH-06. */
function installSignalHandlers(app: FastifyInstance): void {
  const signals: NodeJS.Signals[] = app.mode === 'container' ? ['SIGTERM', 'SIGINT'] : ['SIGTERM'];
  let closing = false;
  for (const signal of signals) {
    process.once(signal, () => {
      if (closing) return;
      closing = true;
      void shutdownServer(app);
    });
  }
}

/**
 * The process owns one deadline across the ordered drain and the remaining close hooks. A failed
 * drain must not call close(): its hooks release the owner lease while a writer may still be running.
 * Terminating the process instead ends that writer and its database sessions together; committed
 * acknowledgements remain durable. On success, natural exit lets pending log writes finish.
 */
async function shutdownServer(app: FastifyInstance): Promise<void> {
  // Start the drain first so its deadline can report the active phase before the outer watchdog.
  const drain = app.drain();
  const budgetMs = app.iridiumConfig.ops.shutdownDrainMs;
  const deadline = app.clock.after(budgetMs, () => {
    terminateFailedShutdown(
      app,
      new Error(`server shutdown did not finish within SHUTDOWN_DRAIN_MS (${String(budgetMs)}ms)`),
    );
  });
  try {
    await drain;
    await app.close();
    process.exitCode = 0;
  } catch (error) {
    terminateFailedShutdown(app, error);
  } finally {
    deadline.cancel();
  }
}

/** A hard failure cannot rely on exitCode: the listener, a pool or a close hook may still be live. */
function terminateFailedShutdown(app: FastifyInstance, error: unknown): never {
  try {
    app.log.error({ err: error, event: 'persist.drain_timeout' }, 'shutdown failed; terminating');
  } finally {
    // The deadline also bounds logging/cleanup. Never release the lease ahead of unfinished writers.
    process.exit(1);
  }
}
