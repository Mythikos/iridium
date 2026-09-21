/**
 * Boot step 11, the `ops` plugin: `/healthz`, `/readyz`, `/metrics`, the not-ready gate, the one
 * `http.request` log line per response, and the shutdown drain
 * (02-system-architecture.md ARCH-02, ARCH-06, ARCH-15; 11-operations-and-deployment.md, "Health";
 * 09-api-reference.md section 2.17).
 *
 * The three routes are exempt from the Host guard, from rate limiting, from load shedding and from
 * the not-ready gate. The last exemption is the one that matters most: while migrations are pending
 * the process answers `/healthz` (so an orchestrator does not restart-loop it), `/readyz` (so the
 * proxy stops routing) and `/metrics` (so `iridium_migrations_pending` and the readiness gauges keep
 * feeding the dashboard through the outage) — and every other route answers `503 not_ready` with
 * `Retry-After: 5`. That is the fail-closed contract: a server whose schema is behind its code never
 * handles a request.
 *
 * `/metrics` is protected by `METRICS_TOKEN` or `METRICS_ALLOW_CIDR`; with neither configured it
 * answers `404`, so an operator cannot accidentally publish it, and `METRICS_ENABLED=false` removes
 * the route entirely. A bad token gets a bare `401` with no body: Prometheus does not parse
 * `application/problem+json` (D09-11).
 */
import { X509Certificate } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { routeByOperationId } from '@iridium/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { DatabaseHandle } from '../boot/db.ts';
import type { IridiumConfig } from '../config/env.ts';
import { ipInRanges, parseIpRanges } from '../security/ip-range.ts';
import { sendProblem } from '../security/problem.ts';
import { BUILD_INFO } from './build-info.ts';
import { elapsedMs, type Clock, type TimerHandle } from './clock.ts';
import { FaultRegistry } from './faults.ts';
import type { ServerLogger } from './logging.ts';
import { createMetrics, DB_POOL_LABELS, type Metrics } from './metrics.ts';
import { isOpsPath } from './paths.ts';
import { httpStatusFor, type Readiness, type ReadyzBody } from './readiness.ts';
import { ShutdownDrain, type DrainHook } from './shutdown.ts';
import { applyTestRoutes } from './test-routes.ts';

/**
 * The documentation members of one operations route, taken from its `API_ROUTES` row.
 *
 * The three rows carry `plugin: 'ops'` precisely so the boot assertion, the route index and the
 * OpenAPI coverage check all see them (`@iridium/contracts/rest/routes.ts`), and an operation with
 * no `operationId` can be covered by no test: `scripts/check-openapi-coverage.ts` reports it and
 * `toMatchOpenApi` cannot locate it. The OpenAPI response schemas come from the same manifest;
 * `ReadyzBody` and the runtime readiness state share the complete contract check-name vocabulary.
 */
const opsSchema = (
  operationId: string,
): { operationId: string; tags: string[]; summary: string } => {
  const row = routeByOperationId(operationId);
  return {
    operationId,
    tags: [row?.tag ?? 'ops'],
    summary: row?.summary ?? operationId,
  };
};

/** What the ops plugin needs. */
export interface OpsPluginOptions {
  readonly config: IridiumConfig;
  readonly readiness: Readiness;
  readonly clock: Clock;
  readonly logger: ServerLogger;
  readonly database: DatabaseHandle;
}

declare module 'fastify' {
  interface FastifyInstance {
    /** The metric registry, so a later plugin can register its own numbers on the same one. */
    metrics: Metrics;
    /** The readiness state machine — the single decider of whether this process accepts work. */
    readiness: Readiness;
    /**
     * Starts the drain and resolves when it has finished.
     *
     * @throws DrainTimeoutError when `SHUTDOWN_DRAIN_MS` expired first; `main.ts` maps that to exit `1`.
     */
    drain(): Promise<void>;
    /**
     * Registers one hook in the ordered shutdown sequence of ARCH-06 (`ops/shutdown.ts`).
     *
     * Each subsystem registers at its own boot step — `jobs` stops claiming, `collab` broadcasts
     * `closing` and closes, `writers` drain to COMMIT, `unload` flushes and destroys — because the order
     * is what makes invariant I-10 true and a hook in the wrong phase breaks it silently.
     */
    onDrain(hook: DrainHook): void;
    /**
     * The fault registry (10-testing-and-quality.md, "Fault injection"). Inert unless `NODE_ENV=test`, so
     * a product call site reads `app.faults.fire(point)` unconditionally and it costs one map lookup.
     */
    faults: FaultRegistry;
  }
  interface FastifyRequest {
    /** `clock.monotonic()` at `onRequest`, for the one `http.request` line per response. */
    startedAt: number;
  }
}

/** The `/readyz` migration re-check interval of ARCH-02. */
export const READINESS_RECHECK_MS = 5_000;
/** `Retry-After` on every `503 not_ready` (ARCH-02). */
export const NOT_READY_RETRY_AFTER_SECONDS = 5;
/** Event-loop lag above which `/healthz` reports the process unusable. */
export const HEALTHZ_MAX_EVENT_LOOP_LAG_MS = 1_000;

const MS_PER_SECOND = 1000;
const MS_PER_DAY = 86_400_000;
const HTTP_UNAUTHORIZED = 401;
/** `/readyz` `attachment_store` warns above this probe latency (11, "Health"). */
const ATTACHMENT_PROBE_WARN_MS = 1_000;
/** `/readyz` `tls_cert` warns inside this many days of expiry (11, "Health"). */
const TLS_RENEWAL_WARN_DAYS = 30;

/** The `GET /healthz` body of 09-api-reference.md section 2.17. */
export interface HealthzBody {
  readonly status: 'ok';
  readonly version: string;
  readonly uptimeSeconds: number;
  readonly eventLoopLagMs: number;
}

/** Install before authentication so an unavailable owner performs no product request work. */
export function applyReadinessGate(app: FastifyInstance, readiness: Readiness): void {
  app.addHook('onRequest', async (request, reply) => {
    if (isOpsPath(request.url)) return undefined;
    if (readiness.state === 'ready') return undefined;
    // A valid upgrade receives the protocol refusal without authenticating or loading a document.
    // Ordinary HTTP, malformed upgrades, pending migrations and shutdown remain HTTP fail-closed.
    if (
      !readiness.draining &&
      readiness.lastEvaluation?.checks.find((check) => check.name === 'migrations')?.status ===
        'ok' &&
      request.routeOptions.url === '/collab' &&
      request.headers.upgrade?.toLowerCase() === 'websocket' &&
      request.headers.connection
        ?.toLowerCase()
        .split(',')
        .some((token) => token.trim() === 'upgrade') &&
      request.headers['sec-websocket-version'] === '13' &&
      typeof request.headers['sec-websocket-key'] === 'string' &&
      /^[+/0-9A-Za-z]{22}==$/.test(request.headers['sec-websocket-key']) &&
      app.hasDecorator('collab') &&
      !app.collab.ownerLease.held
    ) {
      return undefined;
    }
    await sendProblem(request, reply, 'not_ready', {
      detail: readiness.reason,
      retryAfterMs: NOT_READY_RETRY_AFTER_SECONDS * MS_PER_SECOND,
      headers: { 'retry-after': String(NOT_READY_RETRY_AFTER_SECONDS) },
    });
    return reply;
  });
}

/** Applies boot step 11. */
export function applyOpsPlugin(app: FastifyInstance, options: OpsPluginOptions): void {
  const { config, readiness, clock, logger, database } = options;
  const bootTimestampMs = clock.now();
  const metrics = createMetrics(bootTimestampMs, {
    docsLoaded: () => app.collab.server.hocuspocus.documents.size,
  });

  app.decorate('metrics', metrics);
  app.decorate('readiness', readiness);
  app.decorateRequest('startedAt', 0);

  const stopReadinessLogging = readiness.onTransition((state, reason) => {
    logger.warn(
      { event: state === 'ready' ? 'readyz.recovered' : 'readyz.degraded', state, reason },
      `readiness is now ${state}`,
    );
  });

  // ---- the fault registry and the test-only namespace (D10-6) -----------------------------------
  const faults = new FaultRegistry({
    nodeEnv: config.env,
    spec: config.lifecycle.fault,
    clock,
    logger,
  });
  app.decorate('faults', faults);
  // The whole `/__test__` prefix is registered only when the registry is active, so the not-found
  // handler answers `404` for it in production and in development alike.
  if (faults.enabled) applyTestRoutes(app, faults);

  // ---- the admission budgets, published from configuration -------------------------------------
  // The gauges the `doc_budget` alert divides. Their numerators are the collaboration server's; the
  // denominators are configuration and are therefore known from boot.
  metrics.docsLoadedMax.set(config.collab.maxLoadedDocs);
  metrics.collabStateBytesMax.set(config.collab.maxStateBytesTotal);
  metrics.dbPoolSize.set({ pool: 'app' }, config.db.poolApp);
  metrics.dbPoolSize.set({ pool: 'persist' }, config.db.poolPersist);
  // `maint` exists only when `DATABASE_MIGRATE_URL` is configured, and it is a single-connection pool.
  metrics.dbPoolSize.set({ pool: 'maint' }, config.db.migrateUrl === null ? 0 : 1);
  for (const pool of DB_POOL_LABELS) metrics.dbPoolInUse.set({ pool }, 0);

  // ---- one `http.request` line per response, and the two HTTP metrics -------------------------
  app.addHook('onRequest', async (request) => {
    request.startedAt = clock.monotonic();
  });

  app.addHook('onResponse', async (request, reply) => {
    const durationMs = elapsedMs(clock, request.startedAt);
    // The route *template*, never the concrete path: an id must never become a metric label.
    const route = request.routeOptions.url ?? 'unmatched';
    metrics.observeResponse(route, request.method, reply.statusCode, durationMs);
    request.log.info(
      {
        event: 'http.request',
        method: request.method,
        route,
        status: reply.statusCode,
        durationMs,
        bytesOut: Number(reply.getHeader('content-length') ?? 0),
      },
      'request',
    );
  });

  // ---- the three routes ------------------------------------------------------------------------
  const lagProbe = createLagProbe(clock);

  app.get(
    '/healthz',
    { config: { auth: { public: true } }, schema: opsSchema('ops.healthz') },
    async (request, reply) => {
      const eventLoopLagMs = lagProbe.lagMs();
      if (healthzIsDegraded(eventLoopLagMs)) {
        // The one condition that should make a supervisor restart this process. A database outage
        // deliberately does not: a restart loses every loaded Y.Doc and the in-process TicketStore,
        // turning a recoverable blip into a reconnect storm.
        return sendProblem(request, reply, 'unavailable', {
          detail: `event loop lag ${String(eventLoopLagMs)}ms`,
        });
      }
      const body: HealthzBody = {
        status: 'ok',
        version: BUILD_INFO.version,
        uptimeSeconds: Math.round((clock.now() - bootTimestampMs) / MS_PER_SECOND),
        eventLoopLagMs,
      };
      return reply.header('cache-control', 'no-store').send(body);
    },
  );

  app.get(
    '/readyz',
    { config: { auth: { public: true } }, schema: opsSchema('ops.readyz') },
    async (_request, reply) => {
      const body = await evaluate(readiness, metrics, database);
      return reply.code(httpStatusFor(body.status)).header('cache-control', 'no-store').send(body);
    },
  );

  if (config.ops.metricsEnabled) {
    const { ranges: allowRanges } = parseIpRanges(config.ops.metricsAllowCidrs);
    const token = config.ops.metricsToken;
    const unprotected = token === null && allowRanges.length === 0;

    app.get(
      '/metrics',
      { config: { auth: { public: true } }, schema: opsSchema('ops.metrics') },
      async (request, reply) => {
        // Unprotected: 404 rather than an anonymous exposition, so a misconfiguration cannot publish
        // loaded-document counts and token counts to anyone who asks (11, "Metrics").
        if (unprotected) return reply.callNotFound();
        if (!metricsRequestIsAllowed(request, token, allowRanges)) {
          // A bare 401: Prometheus does not parse application/problem+json (D09-11).
          return reply.code(HTTP_UNAUTHORIZED).send();
        }
        const text = await metrics.render();
        return reply
          .header('content-type', metrics.registry.contentType)
          .header('cache-control', 'no-store')
          .send(text);
      },
    );
  }

  // ---- the three readiness checks this plugin owns ----------------------------------------------
  readiness.register('attachment_store', async () => {
    const startedAt = clock.monotonic();
    await app.attachmentStorage.healthcheck();
    const elapsed = elapsedMs(clock, startedAt);
    return elapsed > ATTACHMENT_PROBE_WARN_MS
      ? { status: 'warn', detail: `probe took ${String(elapsed)}ms` }
      : { status: 'ok', detail: `${config.storage.driver} (${String(elapsed)}ms)` };
  });

  readiness.register('tls_cert', async () => {
    const tls = config.server.tls;
    if (tls === null) {
      // Not a gap: in every profile but the air-gapped one, TLS terminates at the proxy and the
      // certificate is not this process's to check. The name still appears, because the served
      // check-name set must always equal `ReadyzCheckName`.
      return { status: 'ok', detail: 'not configured (TLS terminates at the reverse proxy)' };
    }
    const certificate = await readFile(tls.certFile, 'utf8');
    const notAfter = new X509Certificate(certificate).validTo;
    const daysLeft = Math.floor((Date.parse(notAfter) - clock.now()) / MS_PER_DAY);
    if (Number.isNaN(daysLeft)) return { status: 'fail', detail: 'the certificate has no validTo' };
    if (daysLeft <= 0) return { status: 'fail', detail: `expired ${String(-daysLeft)} days ago` };
    return daysLeft < TLS_RENEWAL_WARN_DAYS
      ? { status: 'warn', detail: `expires in ${String(daysLeft)} days` }
      : { status: 'ok', detail: `expires in ${String(daysLeft)} days` };
  });

  readiness.register('shutdown', () =>
    readiness.draining
      ? { status: 'fail', detail: 'the shutdown drain has started' }
      : { status: 'ok', detail: 'not draining' },
  );

  // ---- the readiness re-check, and the drain ---------------------------------------------------
  let recheck: TimerHandle | null = clock.every(READINESS_RECHECK_MS, () => {
    void evaluate(readiness, metrics, database).catch((error: unknown) => {
      logger.warn({ err: error }, 'readiness re-check failed');
    });
  });

  // ---- the ordered drain (ARCH-06) --------------------------------------------------------------
  // The sequence and its deadline live in `ops/shutdown.ts`; each subsystem registers a hook in its own
  // phase at its own boot step. This plugin owns the readiness flip, because there is exactly one owner
  // of "is this process accepting work", and it stops the re-check timer in the first phase so a drain
  // cannot be un-drained by an evaluation that lands mid-sequence.
  const shutdown = new ShutdownDrain({
    readiness,
    clock,
    logger,
    budgetMs: config.ops.shutdownDrainMs,
  });
  shutdown.register({
    phase: 'jobs',
    name: 'ops.readiness-recheck',
    run: async () => {
      recheck?.cancel();
      recheck = null;
    },
  });
  app.decorate('onDrain', (hook: DrainHook): void => {
    shutdown.register(hook);
  });
  app.decorate('drain', async (): Promise<void> => shutdown.run());

  app.addHook('onClose', async () => {
    stopReadinessLogging();
    recheck?.cancel();
    recheck = null;
    lagProbe.stop();
  });
}

async function evaluate(
  readiness: Readiness,
  metrics: Metrics,
  database: DatabaseHandle,
): Promise<ReadyzBody> {
  const body = await readiness.evaluate();
  metrics.observeReadiness(body, database.migrations()?.pending.length ?? 0);
  // Sampled here rather than on a timer of its own: the readiness evaluation already runs every 5 s, and
  // a second timer for two gauges would be a second thing to stop during the drain.
  const pools = database.poolsInUse();
  metrics.dbPoolInUse.set({ pool: 'app' }, pools.app);
  metrics.dbPoolInUse.set({ pool: 'persist' }, pools.persist);
  return body;
}

function metricsRequestIsAllowed(
  request: FastifyRequest,
  token: string | null,
  allowRanges: ReturnType<typeof parseIpRanges>['ranges'],
): boolean {
  if (token !== null) {
    const header = request.headers.authorization;
    const value = Array.isArray(header) ? header[0] : header;
    if (
      value !== undefined &&
      value.startsWith('Bearer ') &&
      value.slice('Bearer '.length) === token
    ) {
      return true;
    }
  }
  // Evaluated after `TRUST_PROXY` resolution, which is what `request.ip` already is.
  return ipInRanges(request.ip, allowRanges);
}

/**
 * Event-loop lag for `/healthz`, sampled rather than measured per request: the question `/healthz`
 * answers is "should the supervisor restart this process?", and the honest input to that is whether
 * the loop has been responsive, not how long one request took.
 */
function createLagProbe(clock: Clock): { lagMs: () => number; stop: () => void } {
  const intervalMs = 500;
  let lag = 0;
  let expected = clock.monotonic() + intervalMs;
  const handle = clock.every(intervalMs, () => {
    const now = clock.monotonic();
    lag = Math.max(0, Math.round(now - expected));
    expected = now + intervalMs;
  });
  return { lagMs: () => lag, stop: () => handle.cancel() };
}

/** Whether `/healthz` should report the process unusable (event-loop lag at or above the cap). */
export function healthzIsDegraded(lagMs: number): boolean {
  return lagMs >= HEALTHZ_MAX_EVENT_LOOP_LAG_MS;
}
