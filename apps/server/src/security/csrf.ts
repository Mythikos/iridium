/**
 * The CSRF guard (04-auth-and-access-control.md §4.4; skeleton A27; 09-api-reference.md §1.2).
 *
 * No per-request synchronizer token. The defence is the OWASP custom-header pattern plus Fetch Metadata
 * resource isolation with the mandatory `Origin`/`Referer` fallback, and `SameSite=Lax` as defence in
 * depth. §4.4's algorithm is implemented here line for line, and the ordering is load-bearing:
 *
 * ```
 * safe method                                  → pass
 * Authorization header present                 → pass   (a bearer carries no ambient credential)
 * route.config.auth.bearerOnly                 → pass   (authentication already required a bearer)
 * route.config.csrfExempt                      → pass   (the closed enumeration in @iridium/contracts)
 * X-Iridium-Client ∉ {web, desktop}            → 403 csrf_rejected
 * desktop: any Cookie                          → 403 csrf_rejected   (D04-06 channel binding)
 * desktop: a non-public route                  → 403 csrf_rejected   (belt and braces after 401)
 * desktop                                      → pass
 * web: Sec-Fetch-Site present                  → same-origin | none ? pass : 403
 * web: Origin ?? originOf(Referer) = PUBLIC_ORIGIN ? pass : 403
 * ```
 *
 * Four properties are easy to lose in a refactor and each is why a line above reads as it does:
 *
 *  - **It runs in `onRequest`, before body parsing**, so it covers multipart uploads and any future
 *    form-encoded route. The guard is policy by route, not by content type — and a 1 MiB body with a
 *    missing header is answered `403` rather than `413`, which is how `security.csrf.integration` proves
 *    the phase.
 *  - **It reads the `Authorization` *header*, not `request.principal`.** §4.4's rule is "a bearer request
 *    carries no ambient credential", and that is a property of the request, not of whether authentication
 *    succeeded. Reading the principal instead would let a *failed* bearer fall through to the cookie
 *    branches, which is the combination `authenticate()` exists to make impossible (§6.1).
 *  - **The Fetch-Metadata, `Origin` and `Referer` comparisons are `web`-only.** A main-process
 *    `net.fetch` sends none of those headers, so applying them to a desktop request would reject every
 *    desktop login.
 *  - **A `desktop` request carrying a `Cookie` is refused.** The desktop host never sends cookies
 *    (`useSessionCookies: false`), so a `desktop` header beside a cookie is either a mistake or an
 *    attempt to borrow an ambient credential under the branch that skips the Origin comparison.
 *
 * Rejections are the SIEM event `authz.csrf_rejected` with the request id and the IP. They are **not**
 * audit events: unauthenticated noise must not touch the chain.
 *
 * **Where it is registered.** `applySecurityPlugin` is boot step 3 and `authenticate()` is boot step 4,
 * and §6.1 requires `authenticate()` to run *before* this guard — Fastify runs instance-level `onRequest`
 * hooks in registration order, so `app.ts` calls `applyCsrfGuard` immediately after the auth plugin. The
 * step order of 02-system-architecture.md is unchanged; the hook simply belongs to the later step's
 * neighbourhood, and the call site is named in `scratchpad/m1/seams/platform.md` so the wave-2 owner of
 * `app.ts` keeps it there.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { RouteAuth } from '../authz/route-policy.ts';
import type { IridiumConfig } from '../config/env.ts';
import { IRIDIUM_CLIENTS, type IridiumClient } from './client-header.ts';
import { sendProblem } from './problem.ts';

/** Methods the guard never inspects (§4.4). `TRACE` is not routed, so the set is these three. */
export const CSRF_SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

/** `Sec-Fetch-Site` values a same-site request carries (§4.4). */
export const CSRF_ALLOWED_FETCH_SITES: ReadonlySet<string> = new Set(['same-origin', 'none']);

/** Why a request was refused, for the SIEM line and for the test table. */
export type CsrfRejection =
  | 'client_header'
  | 'desktop_cookie'
  | 'desktop_non_public'
  | 'fetch_site'
  | 'origin';

/** What the guard decided. `pass` carries no reason; every refusal names one. */
export type CsrfDecision =
  | { readonly pass: true }
  | { readonly pass: false; readonly reason: CsrfRejection };

const PASS: CsrfDecision = { pass: true };

/** The request fields §4.4 reads — extracted so the decision is a pure function of them. */
export interface CsrfRequestView {
  readonly method: string;
  /** The route *template*, so the exemption set matches a registration and never a concrete path. */
  readonly route: string;
  readonly hasAuthorization: boolean;
  readonly hasCookie: boolean;
  readonly client: IridiumClient | null;
  readonly secFetchSite?: string | undefined;
  readonly origin?: string | undefined;
  readonly referer?: string | undefined;
  readonly auth?: RouteAuth | undefined;
  /**
   * `config.csrfExempt`, declared by exactly the members of `CSRF_EXEMPT_ROUTES` (D04-32).
   *
   * The guard reads the declaration rather than matching the route string, because
   * `authz.route-policy.boot.guard` already refuses to start the server unless the declared set equals
   * that constant exactly — in both directions. Two independent readings of one closed set is how the
   * two eventually disagree; one reading plus a boot assertion cannot.
   */
  readonly csrfExempt?: boolean | undefined;
}

/** Whether a route policy makes authentication bearer-only (the two MCP mounts). */
function isBearerOnly(auth: RouteAuth | undefined): boolean {
  if (auth === undefined || auth === 'test-only') return false;
  return 'bearerOnly' in auth && auth.bearerOnly !== undefined;
}

/** Whether a route policy is `public`. */
function isPublic(auth: RouteAuth | undefined): boolean {
  if (auth === undefined || auth === 'test-only') return false;
  return 'public' in auth;
}

/** The serialised origin of a `Referer`, or `undefined` when it is absent or unparsable (§4.4). */
export function originOfReferer(referer: string | undefined): string | undefined {
  if (referer === undefined) return undefined;
  try {
    return new URL(referer).origin;
  } catch {
    return undefined;
  }
}

/**
 * §4.4's algorithm, as a pure function of the request and the configured public origin.
 *
 * It is exported so `security.csrf.unit` can drive the whole table without a server, and so
 * `security.csrf.integration` can assert that the mounted hook agrees with it rather than re-deriving the
 * rules a second time.
 */
export function csrfDecision(view: CsrfRequestView, publicOrigin: string): CsrfDecision {
  if (CSRF_SAFE_METHODS.has(view.method)) return PASS;
  if (view.hasAuthorization) return PASS;
  if (isBearerOnly(view.auth)) return PASS;
  if (view.csrfExempt === true) return PASS;

  if (view.client === null) return { pass: false, reason: 'client_header' };

  if (view.client === 'desktop') {
    if (view.hasCookie) return { pass: false, reason: 'desktop_cookie' };
    if (!isPublic(view.auth)) return { pass: false, reason: 'desktop_non_public' };
    return PASS;
  }

  if (view.secFetchSite !== undefined) {
    return CSRF_ALLOWED_FETCH_SITES.has(view.secFetchSite)
      ? PASS
      : { pass: false, reason: 'fetch_site' };
  }

  const origin = view.origin ?? originOfReferer(view.referer);
  return origin === publicOrigin ? PASS : { pass: false, reason: 'origin' };
}

function headerValue(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** The view §4.4 reads, built from a live request. */
export function csrfRequestView(request: FastifyRequest): CsrfRequestView {
  const secFetchSite = headerValue(request, 'sec-fetch-site');
  const origin = headerValue(request, 'origin');
  const referer = headerValue(request, 'referer');
  const auth = request.routeOptions.config.auth;
  const csrfExempt = request.routeOptions.config.csrfExempt;
  // The parsed header is `null` for an absent or unrecognised value, which is the one thing §4.4 needs;
  // the client-header module owns the closed value set so two readings of it cannot diverge.
  const client = IRIDIUM_CLIENTS.find((candidate) => candidate === request.iridiumClient) ?? null;
  return {
    method: request.method,
    route: request.routeOptions.url ?? request.url,
    hasAuthorization: request.headers.authorization !== undefined,
    hasCookie: request.headers.cookie !== undefined,
    client,
    ...(secFetchSite === undefined ? {} : { secFetchSite }),
    ...(origin === undefined ? {} : { origin }),
    ...(referer === undefined ? {} : { referer }),
    ...(auth === undefined ? {} : { auth }),
    ...(csrfExempt === undefined ? {} : { csrfExempt }),
  };
}

/** What the guard needs: the configured public origin. */
export interface CsrfGuardOptions {
  readonly config: IridiumConfig;
}

/**
 * Registers the guard as an instance-level `onRequest` hook.
 *
 * Called from `app.ts` straight after the auth plugin, so `authenticate()` has already answered `401`
 * for a credential that does not verify (§6.1).
 */
export function applyCsrfGuard(app: FastifyInstance, options: CsrfGuardOptions): void {
  const publicOrigin = options.config.server.publicOrigin.origin;

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const decision = csrfDecision(csrfRequestView(request), publicOrigin);
    if (decision.pass) return undefined;

    request.log.warn(
      {
        event: 'authz.csrf_rejected',
        route: request.routeOptions.url ?? request.url,
        reason: decision.reason,
        ip: request.ip,
      },
      'csrf rejected',
    );
    await sendProblem(request, reply, 'csrf_rejected', {
      detail: CSRF_REJECTION_DETAIL[decision.reason],
    });
    return reply;
  });
}

/** One operator-facing sentence per refusal, so a client author can fix the request. */
const CSRF_REJECTION_DETAIL: Readonly<Record<CsrfRejection, string>> = Object.freeze({
  client_header:
    'Every state-changing request that is not bearer-authenticated must carry X-Iridium-Client: web or desktop.',
  desktop_cookie:
    'X-Iridium-Client: desktop was sent with a Cookie header. A desktop host holds its credential in the main process and never sends cookies.',
  desktop_non_public:
    'X-Iridium-Client: desktop was sent without a bearer on an authenticated route. A desktop caller presents Authorization: Bearer.',
  fetch_site:
    'Sec-Fetch-Site indicates a cross-site request. State-changing requests must originate from this application.',
  origin:
    'Neither Origin nor Referer matched this server’s public origin, and no Sec-Fetch-Site header was present.',
});
