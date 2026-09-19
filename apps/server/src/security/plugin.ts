/**
 * Boot step 3, the `security` plugin (02-system-architecture.md, "Boot sequence and plugin order").
 *
 * Helmet with a per-response CSP nonce, the cookie parser, load shedding, the Host guard, the
 * rate-limit buckets, request-id generation, the hardening headers, and the two handlers that make
 * every failure one shape: the `ProblemDetails` error handler and the not-found handler.
 *
 * Two deliberate choices, recorded here because both look like oversights otherwise:
 *
 *  - **Helmet emits every hardening header except the CSP, which Iridium emits itself.**
 *    `enableCSPNonces` is what generates the per-response nonce (the S4 mechanism, consumed by
 *    `EditorView.cspNonce` and by the `index.html` substitution), but it appends that nonce to
 *    `script-src` as well as `style-src`, and D07-41 pins a `script-src 'self'` that carries none —
 *    the SPA ships no inline script. So helmet runs with `contentSecurityPolicy: false` and the
 *    single normative policy string of `security/csp.ts` is written by one hook. The property that
 *    matters operationally — the application emits these headers and the proxy never does — is
 *    unchanged.
 *  - **Iridium's own plugins are applied, not `register`ed.** `fastify-plugin` is not a declared
 *    dependency of this package, and `app.register(fn)` on a bare function encapsulates it, which
 *    would hide these hooks and decorators from every later plugin. Applying the function to the
 *    root instance keeps the documented order and keeps the hooks global. Third-party plugins are
 *    `register`ed as usual: they carry their own `fastify-plugin` wrapper.
 */
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import underPressure from '@fastify/under-pressure';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { IridiumConfig } from '../config/env.ts';
import { isOpsPath } from '../ops/paths.ts';
import { attachClientHeaders } from './client-header.ts';
import { HARDENING_HEADERS, HSTS_MAX_AGE_SECONDS, renderCsp, webCspDirectives } from './csp.ts';
import { parseIpRanges, type IpRange } from './ip-range.ts';
import { ProblemRegistry } from './problem-registry.ts';
import {
  classifyError,
  isEnvelopeExempt,
  logLevelForStatus,
  sendProblem,
  statusOf,
} from './problem.ts';
import {
  createRestRateLimitStore,
  globalRateLimitKey,
  globalRateLimitMax,
  RATE_LIMIT_WINDOW,
  rateLimitProblem,
} from './rate-limits.ts';
import { attachRequestId } from './request-id.ts';

/** What the security plugin needs; a slice, never the whole configuration object. */
export interface SecurityPluginOptions {
  readonly config: IridiumConfig;
}

declare module 'fastify' {
  interface FastifyInstance {
    /** The parsed `TRUST_PROXY` ranges, so the ops plugin can reuse them for `/metrics`. */
    trustProxyRanges: readonly IpRange[];
  }
  interface FastifyRequest {
    /**
     * The rate-limit bucket key of 09 section 1.8: `ses:<id>`, `pat:<id>` or `oat:<id>` once a
     * principal exists, and `null` until then, which selects the per-IP unauthenticated tier. The
     * auth plugin sets it in M1; the security plugin declares and initialises it so the limiter has
     * one key source rather than two.
     */
    principalKey: string | null;
  }
}

const PRESSURE_RETRY_AFTER_SECONDS = 10;

/** `Cache-Control: no-store` on every authenticated JSON response (09 section 1.2). */
const NO_STORE_PREFIXES: readonly string[] = Object.freeze([
  '/api/v1',
  '/oauth',
  '/docs',
  '/openapi.json',
]);

function needsNoStore(path: string): boolean {
  return NO_STORE_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/** Applies boot step 3 to the root instance. */
export async function applySecurityPlugin(
  app: FastifyInstance,
  options: SecurityPluginOptions,
): Promise<void> {
  const { config } = options;
  const { ranges: trustProxyRanges, invalid } = parseIpRanges(
    config.server.trustProxy === false ? [] : config.server.trustProxy,
  );
  if (invalid.length > 0) {
    throw new Error(
      `TRUST_PROXY contains entries that are neither an address nor a CIDR: ${invalid.join(', ')}`,
    );
  }
  app.decorate('trustProxyRanges', trustProxyRanges);
  // The problem-mapping registry every later area adds its own error classes to (`problem-registry.ts`).
  // It is decorated here, in the step that owns the envelope, so a mapper can be registered from the
  // boot step that owns the errors it maps.
  app.decorate('problems', new ProblemRegistry());

  // ---- helmet: every hardening header except the CSP, plus the per-response nonce ---------------
  await app.register(helmet, {
    enableCSPNonces: true,
    contentSecurityPolicy: false,
    strictTransportSecurity: { maxAge: HSTS_MAX_AGE_SECONDS, includeSubDomains: true },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    crossOriginEmbedderPolicy: { policy: 'credentialless' },
    xFrameOptions: { action: 'deny' },
    xContentTypeOptions: true,
    xPermittedCrossDomainPolicies: { permittedPolicies: 'none' },
    xPoweredBy: false,
  });

  await app.register(cookie, {});

  // ---- load shedding (11, "Metrics"): never on the ops routes, never on /collab frames ----------
  await app.register(underPressure, {
    maxEventLoopDelay: config.ops.pressureMaxEventLoopDelayMs,
    maxHeapUsedBytes: config.ops.pressureMaxHeapBytes,
    maxRssBytes: 0,
    retryAfter: PRESSURE_RETRY_AFTER_SECONDS,
    exposeStatusRoute: false,
    pressureHandler: (
      request: FastifyRequest,
      reply: FastifyReply,
      type: string,
      value?: number,
    ) => {
      if (isOpsPath(request.url) || request.url.startsWith('/collab')) return;
      request.log.warn({ event: 'pressure.shed', pressureType: type, value }, 'shedding load');
      reply.header('retry-after', String(PRESSURE_RETRY_AFTER_SECONDS));
      sendProblem(request, reply, 'unavailable', {
        detail: 'The server is shedding load; retry shortly.',
        retryAfterMs: PRESSURE_RETRY_AFTER_SECONDS * 1000,
      });
    },
  });

  // ---- rate limits: the three REST tiers of 09 section 1.8 --------------------------------------
  // The two global tiers are `security/rate-limits.ts`'s, and so is the refusal: returning a
  // `ProblemError` from `errorResponseBuilder` is what puts a `429` through the one error handler and
  // out as `application/problem+json`, because @fastify/rate-limit *throws* whatever the builder
  // returns. The login tier is a per-route override the `auth` stream attaches (`LOGIN_RATE_LIMIT`).
  await app.register(rateLimit, {
    store: createRestRateLimitStore(app.clock),
    global: true,
    timeWindow: RATE_LIMIT_WINDOW,
    max: globalRateLimitMax,
    keyGenerator: globalRateLimitKey,
    errorResponseBuilder: rateLimitProblem,
    allowList: (request: FastifyRequest) => isOpsPath(request.url),
    enableDraftSpec: false,
    addHeadersOnExceeding: {
      'x-ratelimit-limit': true,
      'x-ratelimit-remaining': true,
      'x-ratelimit-reset': true,
    },
    addHeaders: {
      'x-ratelimit-limit': true,
      'x-ratelimit-remaining': true,
      'x-ratelimit-reset': true,
      'retry-after': true,
    },
  });

  // ---- request ids, the client header, the Host guard -------------------------------------------
  app.decorateRequest('principalKey', null);

  // ---- the CSP and the headers helmet does not emit ---------------------------------------------
  const csp = (styleNonce: string): string =>
    renderCsp(
      webCspDirectives(
        config.server.publicHost,
        styleNonce,
        config.env === 'development' ? config.server.devOrigins : [],
      ),
    );

  app.addHook('onRequest', async (request, reply) => {
    attachRequestId(request, reply, trustProxyRanges);
    attachClientHeaders(request);
    reply.header('content-security-policy', csp(reply.cspNonce.style));
    for (const [name, value] of Object.entries(HARDENING_HEADERS)) {
      reply.header(name, value);
    }
    if (needsNoStore(request.url)) reply.header('cache-control', 'no-store');

    const host = request.headers.host;
    if (!isOpsPath(request.url) && host !== undefined && host !== config.server.publicHost) {
      request.log.warn(
        { event: 'authz.origin_rejected', route: request.url },
        'host header is not PUBLIC_HOST',
      );
      await sendProblem(request, reply, 'host_rejected', {
        detail: `This server answers only to ${config.server.publicHost}.`,
      });
      return reply;
    }
    // A known path with an unsupported method is a routing refusal, before body parsing,
    // authentication or CSRF can mistake an absent handler for a product operation.
    if (request.routeOptions.url === undefined) {
      const allowed = app.supportedMethods.filter(
        (method) => app.findRoute({ method, url: request.url }) !== null,
      );
      if (allowed.length > 0) {
        await sendProblem(request, reply, 'method_not_allowed', {
          headers: { Allow: allowed.toSorted().join(', ') },
        });
        return reply;
      }
    }
    return undefined;
  });

  // ---- one shape for every failure ---------------------------------------------------------------
  app.setNotFoundHandler(async (request, reply) => {
    await sendProblem(request, reply, 'not_found', {
      detail: `No route for ${request.method} ${request.url}.`,
    });
  });

  app.setErrorHandler(async (error, request, reply) => {
    // An area's own error classes first (`ProblemRegistry`), then this module's classification. The order
    // is what lets `db/failure.ts` answer `409 name_conflict` for an `ER_DUP_ENTRY` on `uq_sibling`
    // without every area's classes reaching into one growing `instanceof` chain.
    const mapped = app.problems.map(error);
    const { code, extensions } =
      mapped === null ? classifyError(error) : { code: mapped.code, extensions: mapped.extensions };
    const level = logLevelForStatus(mapped?.status ?? statusOf(error));
    request.log[level]({ err: error, code, route: request.routeOptions.url }, 'request failed');

    if (isEnvelopeExempt(request.url)) {
      // The two enumerated exemptions answer their own vocabulary; their plugins own those bodies.
      await reply.code(statusOf(error)).send({ error: 'server_error' });
      return;
    }
    await sendProblem(request, reply, code, extensions);
  });
}
