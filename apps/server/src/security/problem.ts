/**
 * The `ProblemDetails` envelope (09-api-reference.md sections 1.4 and 1.5; ARCH-12; skeleton A6).
 *
 * One function maps every failure to one body shape, so the `code`, the status, the headers and the
 * logged SIEM event are identical wherever the failure was raised. `security.problem.unit` asserts
 * that every code this server throws is a member of the closed `ErrorCode` enum in
 * `@iridium/contracts` and that the OAuth error vocabulary and that enum stay disjoint.
 *
 * Two route families are exempt and both exemptions are enumerated, never inferred: the two MCP
 * mounts answer the OAuth-shaped `{error, error_description}` object an MCP client's error path
 * reads, and `/oauth/token|revoke|register` answer the RFC 6749 section 5.2 object. Both arrive with
 * M3; `EXEMPT_PREFIXES` is the list the error handler consults so adding a third exemption is a
 * visible edit rather than a special case inside a handler.
 */
import {
  ERROR_CODE_STATUS,
  ERROR_CODE_TITLE,
  problemType,
  RETRY_AFTER_CODES,
  type ErrorCode,
  type ProblemDetails,
} from '@iridium/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type { LogEvent } from '../ops/events.ts';

/** `application/problem+json`, the one content type an error body is served as. */
export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

/** Path prefixes whose failures are *not* `ProblemDetails` (09 section 1.4's two exemptions). */
export const EXEMPT_PREFIXES: readonly string[] = Object.freeze([
  '/mcp',
  '/oauth/token',
  '/oauth/revoke',
  '/oauth/register',
]);

/** Extra members a specific code is allowed to carry (09 section 1.4). */
export interface ProblemExtensions {
  readonly detail?: string;
  readonly current?: unknown;
  readonly errors?: ProblemDetails['errors'];
  readonly references?: ProblemDetails['references'];
  readonly retryAfterMs?: number;
  /** Response headers this failure must carry, such as `Retry-After` or `WWW-Authenticate`. */
  readonly headers?: Readonly<Record<string, string>>;
  /** The SIEM event to log, when this failure has one. */
  readonly event?: LogEvent;
}

/**
 * The error every service throws deliberately. `code` decides the status, the title and the `type`
 * URN, so a handler never invents any of the three.
 */
export class ProblemError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly extensions: ProblemExtensions;

  constructor(code: ErrorCode, extensions: ProblemExtensions = {}) {
    super(extensions.detail ?? ERROR_CODE_TITLE[code]);
    this.name = 'ProblemError';
    this.code = code;
    this.status = ERROR_CODE_STATUS[code];
    this.extensions = extensions;
  }
}

/** `Retry-After` seconds for the codes that carry one, derived from `retryAfterMs` where given. */
const DEFAULT_RETRY_AFTER_SECONDS: Partial<Record<ErrorCode, number>> = Object.freeze({
  not_ready: 5,
  busy: 1,
});

const MS_PER_SECOND = 1000;

/**
 * Builds the body. `requestId` is always present and always equals the `X-Request-Id` header.
 *
 * The member set is exactly `@iridium/contracts`' `ProblemDetails`, which is a `z.strictObject`: an
 * extra member is a validation failure, not a harmless addition. That is why the request path is
 * **not** carried here — 09-api-reference.md section 1.4 is authoritative for the wire shape and its
 * schema has no `instance`, while 02-system-architecture.md's prose describes one. The path is already
 * on the `http.request` log line and in the response's own URL, so nothing is lost.
 */
export function toProblemDetails(
  code: ErrorCode,
  requestId: string,
  extensions: ProblemExtensions = {},
): ProblemDetails {
  const retryAfterMs =
    extensions.retryAfterMs ??
    (RETRY_AFTER_CODES.includes(code)
      ? (DEFAULT_RETRY_AFTER_SECONDS[code] ?? 0) * MS_PER_SECOND || undefined
      : undefined);

  return {
    type: problemType(code),
    title: ERROR_CODE_TITLE[code],
    status: ERROR_CODE_STATUS[code],
    code,
    requestId,
    ...(extensions.detail === undefined ? {} : { detail: extensions.detail }),
    ...(extensions.current === undefined ? {} : { current: extensions.current }),
    ...(extensions.errors === undefined ? {} : { errors: extensions.errors }),
    ...(extensions.references === undefined ? {} : { references: extensions.references }),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  };
}

/** Whether a path is one of the two enumerated envelope exemptions. */
export function isEnvelopeExempt(path: string): boolean {
  return EXEMPT_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/** Writes a `ProblemDetails` response, setting the content type and every declared header. */
export function sendProblem(
  request: FastifyRequest,
  reply: FastifyReply,
  code: ErrorCode,
  extensions: ProblemExtensions = {},
): FastifyReply {
  const body = toProblemDetails(code, request.requestId, extensions);
  for (const [name, value] of Object.entries(extensions.headers ?? {})) {
    reply.header(name, value);
  }
  const retryAfterMs = body.retryAfterMs;
  if (retryAfterMs !== undefined && reply.getHeader('retry-after') === undefined) {
    reply.header('retry-after', String(Math.ceil(retryAfterMs / MS_PER_SECOND)));
  }
  return reply.code(body.status).type(PROBLEM_CONTENT_TYPE).send(body);
}

/** Fastify's own error codes, mapped to the envelope (09 section 1.5, 02 "Error envelope"). */
const FASTIFY_CODE_MAP: Readonly<Record<string, ErrorCode>> = Object.freeze({
  FST_ERR_CTP_BODY_TOO_LARGE: 'payload_too_large',
  FST_ERR_CTP_INVALID_MEDIA_TYPE: 'unsupported_media',
  FST_ERR_CTP_EMPTY_JSON_BODY: 'validation_failed',
  FST_ERR_CTP_INVALID_JSON_BODY: 'validation_failed',
  FST_ERR_NOT_FOUND: 'not_found',
  FST_ERR_VALIDATION: 'validation_failed',
});

const HTTP_SERVER_ERROR = 500;
const HTTP_TOO_MANY_REQUESTS = 429;

/**
 * The order of 02-system-architecture.md, "Error envelope": a deliberate `ProblemError` first, then
 * schema validation, then Fastify's built-ins, then the rate limiter, then everything else as
 * `server_error` — whose body carries only the request id while the log line carries the stack.
 */
export function classifyError(error: unknown): { code: ErrorCode; extensions: ProblemExtensions } {
  if (error instanceof ProblemError) {
    return { code: error.code, extensions: error.extensions };
  }
  // Fastify 5 types the error handler's first parameter as `unknown`, which is honest: a route can
  // throw anything. Narrowing here rather than at the call site keeps one classifier.
  const thrown = asErrorLike(error);

  if (thrown.validation !== undefined && thrown.validation.length > 0) {
    return {
      code: 'validation_failed',
      extensions: {
        detail: thrown.message ?? 'the request did not match its schema',
        errors: thrown.validation.map((issue) => ({
          path: `${thrown.validationContext ?? 'body'}${issue.instancePath ?? ''}`,
          message: issue.message ?? 'invalid',
          code: issue.keyword ?? 'invalid',
        })),
      },
    };
  }
  const mapped = thrown.code === undefined ? undefined : FASTIFY_CODE_MAP[thrown.code];
  if (mapped !== undefined) {
    return mapped === 'not_found'
      ? { code: mapped, extensions: {} }
      : { code: mapped, extensions: { detail: thrown.message ?? '' } };
  }
  if (thrown.statusCode === HTTP_TOO_MANY_REQUESTS) {
    return { code: 'rate_limited', extensions: { detail: thrown.message ?? 'rate limited' } };
  }
  return { code: 'server_error', extensions: {} };
}

/** The subset of a thrown value the classifier reads. Everything is optional; nothing is trusted. */
interface ErrorLike {
  readonly code?: string;
  readonly statusCode?: number;
  readonly message?: string;
  readonly validationContext?: string;
  readonly validation?: readonly {
    readonly instancePath?: string;
    readonly message?: string;
    readonly keyword?: string;
  }[];
}

function asErrorLike(error: unknown): ErrorLike {
  return typeof error === 'object' && error !== null ? error : {};
}

/** The status a thrown value claims, or `500`. */
export function statusOf(error: unknown): number {
  return asErrorLike(error).statusCode ?? HTTP_SERVER_ERROR;
}

/** The `onError`-equivalent status a failure is logged at: 5xx is an error, 4xx a warning. */
export function logLevelForStatus(status: number): 'error' | 'warn' {
  return status >= HTTP_SERVER_ERROR ? 'error' : 'warn';
}
