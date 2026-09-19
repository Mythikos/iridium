/**
 * `authenticate(request)` — cookie or bearer → `Principal | null` (04-auth-and-access-control.md
 * section 6.1; A26; D04-28).
 *
 * One instance-level `onRequest` hook, registered by the auth plugin in boot step 4, before body
 * parsing. It runs before any route-level hook, which is why `bearerOnly` is what keeps a session
 * cookie from producing a principal on the MCP mounts: `ignoreCookies` (route-level, M3) has not
 * run yet when this function executes.
 *
 * The decision is `authenticateView()`, a function of four request fields and the two verifiers, so
 * `auth.authenticate.unit` drives every branch of section 6.1 without a server — the same shape the
 * CSRF guard takes (`security/csrf.ts`). The hook itself only builds the view, applies the answer to
 * the request and turns a refusal into the one `401` problem.
 *
 * Rules that follow from the pseudo-code and are asserted by `auth.authenticate.unit`:
 *
 *  - The three operational paths are left to their own guards. `/metrics` carries `METRICS_TOKEN`,
 *    which is not an `irid_` credential, and a bad token there is the ops plugin's bare `401` with
 *    no body (D09-11) — exactly as the Host guard, the limiter, load shedding and the not-ready gate
 *    skip `isOpsPath()`.
 *  - A request never mixes credential channels: an `Authorization` header suppresses cookie reading
 *    completely, so a stolen cookie cannot be combined with a low-privilege bearer or vice versa.
 *  - Collab tickets, set-password links, authorization codes and refresh tokens are not HTTP
 *    credentials: presenting one as a bearer is `401`, and none of them is consumed.
 *  - Malformed credentials cost nothing: the CRC and shape check happens before any query.
 *  - `401` bodies never say whether the credential existed; the code is `unauthenticated`
 *    (`token_expired` only for a well-formed token past its expiry, 09-api-reference.md 1.5).
 */
import {
  parseTokenDetailed,
  type BearerMount,
  type Principal,
  type RouteAuth,
} from '@iridium/contracts';
import type { FastifyReply, FastifyRequest, onRequestAsyncHookHandler } from 'fastify';

import { isOpsPath } from '../ops/paths.ts';
import { ProblemError } from '../security/problem.ts';
import { SESSION_COOKIE_NAME } from './sessions/cookie.ts';
import type { SessionVerifier } from './sessions/verify.ts';
import type { TokenDenial, TokenDenialReason, TokenVerifier } from './tokens/verify.ts';

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * The principal `authenticate()` resolved, or `null` for an anonymous request on a public
     * route. Every handler, hook and tool reads this and nothing else to decide "who" (section 5.1).
     */
    principal: Principal | null;
  }
}

/** The request fields section 6.1 reads, extracted so the decision is a function of them. */
export interface AuthenticateView {
  /** The route's policy; `undefined` only before the boot assertion has run. */
  readonly auth: RouteAuth | undefined;
  /** The raw `Authorization` header, when present. */
  readonly authorization?: string | undefined;
  /** The `__Host-iridium_session` cookie value, when the jar carries one. */
  readonly sessionCookie?: string | undefined;
}

/** What the hook needs. */
export interface AuthenticateDeps {
  readonly sessions: Pick<SessionVerifier, 'verifySession'>;
  readonly tokens: Pick<TokenVerifier, 'verifyToken'>;
  /** `<PUBLIC_ORIGIN>/mcp` and `<PUBLIC_ORIGIN>/mcp/connect`, the two canonical resource URIs. */
  readonly resources: { readonly mcp: string; readonly mcpConnect: string };
  /** A real token row refused in steps 4–9: the caller audits `token.denied`, bounded. */
  readonly onTokenDenied: (request: FastifyRequest, denial: TokenDenial) => Promise<void>;
  /** Every refused bearer token, by reason: `iridium_token_auth_failures_total{reason}`. */
  readonly countTokenFailure: (reason: TokenDenialReason) => void;
}

/** What `authenticateView` answers: a principal (or anonymity), or the one refusal. */
export type AuthenticationOutcome =
  | { readonly ok: true; readonly principal: Principal | null }
  | {
      readonly ok: false;
      readonly code: 'unauthenticated' | 'token_expired';
      /** ASCII, never any part of the credential; absent for the shape refusals. */
      readonly detail?: string;
      /** The token row a denial concerns, for the bounded `token.denied` audit; else `null`. */
      readonly denial: TokenDenial | null;
      /**
       * Why a bearer token was refused, for `iridium_token_auth_failures_total{reason}`; absent
       * when the refusal was not a token's (no credential, a session bearer, a foreign scheme).
       */
      readonly tokenReason?: TokenDenialReason;
    };

const BEARER_SCHEME = 'bearer';

const REFUSED = {
  ok: false,
  code: 'unauthenticated',
  denial: null,
} as const satisfies AuthenticationOutcome;

/** Whether a policy lets an anonymous request through. */
function isOptional(auth: RouteAuth | undefined): boolean {
  return auth === undefined || auth === 'test-only' || 'public' in auth;
}

function isBearerOnly(auth: RouteAuth | undefined): boolean {
  return (
    auth !== undefined &&
    auth !== 'test-only' &&
    'permission' in auth &&
    !('serverAdmin' in auth) &&
    auth.bearerOnly === true
  );
}

/** Which bearer mount a route is, from its `mcpAudience`; the REST reads are `'rest'`. */
function mountOf(auth: RouteAuth | undefined): BearerMount {
  if (
    auth === undefined ||
    auth === 'test-only' ||
    !('permission' in auth) ||
    'serverAdmin' in auth
  ) {
    return 'rest';
  }
  if (auth.mcpAudience === 'pat') return 'mcp';
  if (auth.mcpAudience === 'oauth') return 'mcp-connect';
  return 'rest';
}

/** The rate-limit key of 09 section 1.8 for a principal. */
export function principalKeyOf(principal: Principal): string | null {
  if (principal.kind === 'user') return `ses:${principal.sessionId}`;
  if (principal.kind === 'token') {
    return `${principal.tokenKind === 'pat' ? 'pat' : 'oat'}:${principal.tokenId}`;
  }
  return null;
}

/** The bearer credential of an `Authorization` header, or `null` for any other shape. */
function bearerOf(authorization: string): string | null {
  const parts = authorization.split(' ');
  const [scheme, raw] = parts;
  if (parts.length !== 2 || scheme === undefined || raw === undefined) return null;
  return scheme.toLowerCase() === BEARER_SCHEME ? raw : null;
}

/** The view section 6.1 reads, built from a live request. */
export function authenticateView(request: FastifyRequest): AuthenticateView {
  const authorization = request.headers.authorization;
  const sessionCookie = request.cookies[SESSION_COOKIE_NAME];
  return {
    auth: request.routeOptions.config.auth,
    ...(authorization === undefined ? {} : { authorization }),
    ...(sessionCookie === undefined ? {} : { sessionCookie }),
  };
}

/**
 * Section 6.1's algorithm over a view. Exported so `auth.authenticate.unit` can drive every branch
 * without a server; the hook below applies its answer to the request.
 */
export async function authenticate(
  view: AuthenticateView,
  deps: Pick<AuthenticateDeps, 'sessions' | 'tokens' | 'resources'>,
): Promise<AuthenticationOutcome> {
  let principal: Principal | null = null;

  if (view.authorization !== undefined) {
    const raw = bearerOf(view.authorization);
    if (raw === null) return REFUSED;
    const parsed = parseTokenDetailed(raw);
    if (!parsed.ok) return { ...REFUSED, tokenReason: parsed.reason };
    const { kind } = parsed.token;
    if (kind === 'ses') {
      principal = await deps.sessions.verifySession(raw, 'bearer');
    } else if (kind === 'pat' || kind === 'oat') {
      const mount = mountOf(view.auth);
      const resource =
        mount === 'mcp'
          ? deps.resources.mcp
          : mount === 'mcp-connect'
            ? deps.resources.mcpConnect
            : undefined;
      const result = await deps.tokens.verifyToken(raw, {
        mount,
        ...(resource === undefined ? {} : { resource }),
      });
      if (!result.ok) {
        return {
          ok: false,
          code: result.reason === 'expired' ? 'token_expired' : 'unauthenticated',
          detail: result.publicReason,
          denial: result.denial,
          tokenReason: result.reason,
        };
      }
      principal = result.principal;
    } else {
      // `tkt`, `spl`, `oac`, `ort` are not HTTP credentials, and none is consumed here; to the
      // token metric they are a kind this surface does not know.
      return { ...REFUSED, tokenReason: 'unknown_kind' };
    }
    // Cookies are ignored entirely on this request (A26).
  } else if (view.sessionCookie !== undefined && !isBearerOnly(view.auth)) {
    principal = await deps.sessions.verifySession(view.sessionCookie, 'cookie');
  }

  if (principal === null && !isOptional(view.auth)) return REFUSED;
  return { ok: true, principal };
}

/** Builds the hook. The plugin registers it once on the root instance. */
export function createAuthenticateHook(deps: AuthenticateDeps): onRequestAsyncHookHandler {
  return async function authenticateRequest(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    void reply;
    // `/healthz`, `/readyz` and `/metrics` carry their own guards (`ops/plugin.ts`); a `METRICS_TOKEN`
    // bearer is not an `irid_` credential and must never be answered by this hook.
    if (isOpsPath(request.url)) return;

    const outcome = await authenticate(authenticateView(request), deps);
    if (!outcome.ok) {
      if (outcome.tokenReason !== undefined) deps.countTokenFailure(outcome.tokenReason);
      if (outcome.denial !== null) {
        request.log.warn(
          { event: 'authz.denied', reason: 'token', tokenReason: outcome.denial.reason },
          'token refused',
        );
        await deps.onTokenDenied(request, outcome.denial);
      }
      throw new ProblemError(
        outcome.code,
        outcome.detail === undefined ? {} : { detail: outcome.detail },
      );
    }
    request.principal = outcome.principal;
    request.principalKey = outcome.principal === null ? null : principalKeyOf(outcome.principal);
  };
}
