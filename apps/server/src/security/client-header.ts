/**
 * The `X-Iridium-Client` contract (09-api-reference.md section 1.2; 04-auth-and-access-control.md
 * section 4.4).
 *
 * The header carries exactly two values, `web` and `desktop`, and it is required on every
 * state-changing request that is **not** bearer-authenticated — which is the custom-header half of
 * the CSRF defence (skeleton A27). Absent, or anything other than those two spellings, is
 * `403 csrf_rejected`. Both hosts also send it on every other request, where it is informational
 * and is what `iridium_http_requests_total` and the access log record as the calling surface.
 *
 * The CSRF *guard* arrives with the auth plugin in M1, because it needs a principal to know whether
 * the request is cookie-authenticated (12-milestones.md section 5.2, `apps/server/src/security`).
 * What lives here at M0 is what M0 has a caller for: the closed value set, the two header names, and
 * the `onRequest` parser that decorates every request — which is what `iridium_http_requests_total`
 * and the access log record as the calling surface.
 */
import type { FastifyRequest } from 'fastify';

/** The closed value set of `X-Iridium-Client`. `bridge` and `cli` identify themselves elsewhere. */
export const IRIDIUM_CLIENTS = ['web', 'desktop'] as const;

/** A value of `X-Iridium-Client`. */
export type IridiumClient = (typeof IRIDIUM_CLIENTS)[number];

/** The request header carrying the client kind. */
export const CLIENT_HEADER = 'x-iridium-client';
/** The request header carrying the client's semantic version, compared with `minClientVersion`. */
export const CLIENT_VERSION_HEADER = 'x-iridium-client-version';

declare module 'fastify' {
  interface FastifyRequest {
    /** The parsed `X-Iridium-Client`, or `null` when absent or not one of the two values. */
    iridiumClient: IridiumClient | null;
    /** The raw `X-Iridium-Client-Version`, length-capped; `null` when absent. */
    iridiumClientVersion: string | null;
  }
}

const CLIENT_VERSION_MAX_LENGTH = 64;

function headerValue(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** Parses the header. Anything outside the closed set is `null`, never a third value. */
export function parseClientHeader(request: FastifyRequest): IridiumClient | null {
  const value = headerValue(request, CLIENT_HEADER);
  // `find` rather than `includes` plus an assertion: the match is already the narrowed value.
  return IRIDIUM_CLIENTS.find((candidate) => candidate === value) ?? null;
}

/** The client version, capped because it is untrusted text that reaches a log line. */
export function parseClientVersion(request: FastifyRequest): string | null {
  const value = headerValue(request, CLIENT_VERSION_HEADER);
  return value === undefined ? null : value.slice(0, CLIENT_VERSION_MAX_LENGTH);
}

/** Decorates the request with both parsed values. Registered as an `onRequest` hook. */
export function attachClientHeaders(request: FastifyRequest): void {
  request.iridiumClient = parseClientHeader(request);
  request.iridiumClientVersion = parseClientVersion(request);
}

// The safe-method set and the `Sec-Fetch-Site` / `Origin` / `Referer` comparison arrive with the
// guard in M1, in the same change as the routes that need them and the `security.csrf.integration`
// table that drives them. Writing them here first would mean committing an untested reading of
// 04-auth-and-access-control.md section 4.4 a milestone before anything can call it — and a
// security comparison nothing exercises is the kind of code a later reader trusts by mistake.
