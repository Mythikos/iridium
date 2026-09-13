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
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { DatabaseHandle } from '../boot/db.ts';
import type { IridiumConfig } from '../config/env.ts';
import { ipInRanges, parseIpRanges } from '../security/ip-range.ts';
import { sendProblem } from '../security/problem.ts';
import { BUILD_INFO } from './build-info.ts';
import { elapsedMs, type Clock, type TimerHandle } from './clock.ts';
import type { ServerLogger } from './logging.ts';
import { createMetrics, type Metrics } from './metrics.ts';
import { isOpsPath } from './paths.ts';
import { httpStatusFor, type Readiness, type ReadyzBody } from './readiness.ts';

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
    /** Starts the drain and resolves when it has finished or its deadline has expired. */
    drain(): Promise<void>;
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

/** Applies boot step 11. */
export function applyOpsPlugin(app: FastifyInstance, options: OpsPluginOptions): void {
  const { config, readiness, clock, logger, database } = options;
  const bootTimestampMs = clock.now();
  const metrics = createMetrics(bootTimestampMs);

  app.decorate('metrics', metrics);
  app.decorate('readiness', readiness);
  app.decorateRequest('startedAt', 0);

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

  // ---- the not-ready gate (ARCH-02) -------------------------------------------------------------
  app.addHook('onRequest', async (request, reply) => {
    if (isOpsPath(request.url)) return undefined;
    if (readiness.state === 'ready') return undefined;
    await sendProblem(request, reply, 'not_ready', {
      detail: readiness.reason,
      retryAfterMs: NOT_READY_RETRY_AFTER_SECONDS * MS_PER_SECOND,
      headers: { 'retry-after': String(NOT_READY_RETRY_AFTER_SECONDS) },
    });
    return reply;
  });

  readiness.onTransition((state, reason) => {
    logger.warn(
      { event: state === 'ready' ? 'readyz.recovered' : 'readyz.degraded', state, reason },
      `readiness is now ${state}`,
    );
  });

  // ---- the three routes ------------------------------------------------------------------------
  const lagProbe = createLagProbe(clock);

  app.get('/healthz', { config: { auth: { public: true } } }, async (request, reply) => {
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
  });

  app.get('/readyz', { config: { auth: { public: true } } }, async (_request, reply) => {
    const body = await evaluate(readiness, metrics, database);
    return reply.code(httpStatusFor(body.status)).header('cache-control', 'no-store').send(body);
  });

  if (config.ops.metricsEnabled) {
    const { ranges: allowRanges } = parseIpRanges(config.ops.metricsAllowCidrs);
    const token = config.ops.metricsToken;
    const unprotected = token === null && allowRanges.length === 0;

    app.get('/metrics', { config: { auth: { public: true } } }, async (request, reply) => {
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
    });
  }

  // ---- the three readiness checks this plugin owns ----------------------------------------------
  readiness.register('attachment_store', async () => {
    if (config.storage.driver !== 'fs') {
      return {
        status: 'warn',
        detail: 'the s3 driver probe arrives with the attachment service (M6)',
      };
    }
    const dir = config.storage.dir;
    const probe = join(dir, `.iridium-probe-${String(process.pid)}`);
    const startedAt = clock.monotonic();
    await mkdir(dir, { recursive: true });
    await writeFile(probe, 'iridium', 'utf8');
    await readFile(probe, 'utf8');
    await rm(probe, { force: true });
    const elapsed = elapsedMs(clock, startedAt);
    return elapsed > ATTACHMENT_PROBE_WARN_MS
      ? { status: 'warn', detail: `probe took ${String(elapsed)}ms` }
      : { status: 'ok', detail: `${dir} (${String(elapsed)}ms)` };
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

  let draining: Promise<void> | null = null;
  app.decorate('drain', async (): Promise<void> => {
    draining ??= (async () => {
      logger.info({ event: 'shutdown.started' }, 'draining');
      readiness.beginDrain();
      recheck?.cancel();
      recheck = null;
      // Steps 2 to 5 of ARCH-06 — closing collaboration connections, emptying every NoteWriter,
      // flushing pending stores and stopping the scheduler — belong to the plugins that own those
      // subsystems and register their own `onClose` hooks as they land (M1, M2). The readiness flip
      // and the deadline are this plugin's, because there is exactly one owner of "is this process
      // accepting work".
      logger.info({ event: 'shutdown.drained' }, 'drained');
    })();
    return draining;
  });

  app.addHook('onClose', async () => {
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
