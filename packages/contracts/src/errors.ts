/**
 * The error envelope (09-api-reference.md sections 1.4 and 1.5; 02-system-architecture.md,
 * "Error envelope"; ARCH-12, skeleton A6).
 *
 * Every REST error body is a `ProblemDetails` object (RFC 9457) served as
 * `application/problem+json`, and `code` is the only field a client switches on. The vocabulary
 * below is closed: `security/problem.unit` asserts that every code `apps/server/src` throws is a
 * member, and `openapi.contract` asserts that every member appears in a documented response —
 * with the single enumerated exception `updates_manual_only`, which is raised over desktop IPC
 * and nowhere else.
 *
 * `type` is a URN rather than a resolvable URL so the contract does not depend on a documentation
 * host; `title` is fixed per code and is what a client shows when it has no better string.
 */

import { z } from 'zod';

import { NoteId } from './ids.ts';
import type { EnumOf } from './schema.ts';

/** Closed structural refusal reasons, shared by preview, move and restore (12 section 6.4). */
export const INVALID_MOVE_REASONS = [
  'cycle',
  'depth',
  'cross_vault',
  'parent_not_category',
] as const;

/** A structural refusal that a client can explain without interpreting free text. */
export type InvalidMoveReason = (typeof INVALID_MOVE_REASONS)[number];

/** The wire schema for a structural refusal reason. */
export const InvalidMoveReason: EnumOf<typeof INVALID_MOVE_REASONS> = z.enum(INVALID_MOVE_REASONS);

/** The closed error-code vocabulary of 09-api-reference.md section 1.5. */
export const ERROR_CODES = [
  'unauthenticated',
  'invalid_credentials',
  'invalid_link',
  'csrf_rejected',
  'host_rejected',
  'step_up_required',
  'token_expired',
  'token_scope_insufficient',
  'client_outdated',
  'precondition_required',
  'stale_version',
  'name_conflict',
  'invalid_move',
  'category_not_empty',
  'node_trashed',
  'invalid_name',
  'email_conflict',
  'not_found',
  'method_not_allowed',
  'forbidden',
  'vault_archived',
  'attachment_referenced',
  'invalid_state',
  'updates_manual_only',
  'token_not_rotatable',
  'note_oversized',
  'content_invalid',
  'rate_limited',
  'malformed_request',
  'request_timeout',
  'payload_too_large',
  'uri_too_long',
  'request_headers_too_large',
  'unsupported_media',
  'validation_failed',
  'capacity',
  'busy',
  'not_ready',
  'unavailable',
  'server_error',
] as const;

/** A member of the closed error-code vocabulary. */
export type ErrorCode = (typeof ERROR_CODES)[number];

/** The closed error-code vocabulary as a schema. */
export const ErrorCode: EnumOf<typeof ERROR_CODES> = z.enum(ERROR_CODES);

/** The default HTTP status each code is emitted with. */
export const ERROR_CODE_STATUS: Readonly<Record<ErrorCode, number>> = {
  unauthenticated: 401,
  invalid_credentials: 401,
  invalid_link: 410,
  csrf_rejected: 403,
  host_rejected: 421,
  step_up_required: 403,
  token_expired: 401,
  token_scope_insufficient: 403,
  client_outdated: 426,
  precondition_required: 428,
  stale_version: 409,
  name_conflict: 409,
  invalid_move: 409,
  category_not_empty: 409,
  node_trashed: 409,
  invalid_name: 422,
  email_conflict: 409,
  not_found: 404,
  method_not_allowed: 405,
  forbidden: 403,
  vault_archived: 409,
  attachment_referenced: 409,
  invalid_state: 409,
  updates_manual_only: 409,
  token_not_rotatable: 409,
  note_oversized: 409,
  content_invalid: 409,
  rate_limited: 429,
  malformed_request: 400,
  request_timeout: 408,
  payload_too_large: 413,
  uri_too_long: 414,
  request_headers_too_large: 431,
  unsupported_media: 415,
  validation_failed: 422,
  capacity: 503,
  busy: 503,
  not_ready: 503,
  unavailable: 503,
  server_error: 500,
};

/** The two attachment transport exceptions explicitly specified in 08 section 9 and 09 section 2.11. */
export const PROBLEM_VARIANTS: Readonly<
  Record<
    'attachment-range' | 'attachment-missing',
    { readonly code: ErrorCode; readonly status: number }
  >
> = {
  'attachment-range': { code: 'validation_failed', status: 416 },
  'attachment-missing': { code: 'server_error', status: 503 },
};

/** A named, closed exception to an error code's default status. */
export type ProblemVariant = keyof typeof PROBLEM_VARIANTS;

/** Resolves the declared status; a mismatched variant is a programming error. */
export function problemStatus(code: ErrorCode, variant?: ProblemVariant): number {
  if (variant === undefined) return ERROR_CODE_STATUS[code];
  const declared = PROBLEM_VARIANTS[variant];
  if (declared.code !== code)
    throw new TypeError(`Problem variant ${variant} cannot carry ${code}`);
  return declared.status;
}

/** The human summary each code carries. Fixed per code, English, never request-specific. */
export const ERROR_CODE_TITLE: Readonly<Record<ErrorCode, string>> = {
  unauthenticated: 'Not signed in',
  invalid_credentials: 'Incorrect e-mail address or password',
  invalid_link: 'This link is no longer valid',
  csrf_rejected: 'Request rejected',
  host_rejected: 'Wrong host',
  step_up_required: 'Re-authentication required',
  token_expired: 'This token has expired',
  token_scope_insufficient: 'This token cannot do that',
  client_outdated: 'Update required',
  precondition_required: 'A version is required for this change',
  stale_version: 'This has changed since you loaded it',
  name_conflict: 'That name is already taken here',
  invalid_move: 'That move is not allowed',
  category_not_empty: 'This category is not empty',
  node_trashed: 'This item is in the trash',
  invalid_name: 'That name cannot be used',
  email_conflict: 'That e-mail address is already registered',
  not_found: 'Not found',
  method_not_allowed: 'Method not allowed',
  forbidden: 'You do not have permission to do that',
  vault_archived: 'This vault is archived',
  attachment_referenced: 'This attachment is still in use',
  invalid_state: 'Not possible in the current state',
  updates_manual_only: 'This build installs updates manually',
  token_not_rotatable: 'This token cannot be rotated',
  note_oversized: 'This note is too large',
  content_invalid: 'This note needs repair',
  rate_limited: 'Too many requests',
  malformed_request: 'That request could not be read',
  request_timeout: 'The request timed out',
  payload_too_large: 'That is too large to send',
  uri_too_long: 'That address is too long',
  request_headers_too_large: 'Those request headers are too large',
  unsupported_media: 'Unsupported content type',
  validation_failed: 'Some fields need attention',
  capacity: 'The server is at capacity',
  busy: 'Busy — try again',
  not_ready: 'The server is not ready',
  unavailable: 'Temporarily unavailable',
  server_error: 'Something went wrong',
};

/** The stable URN prefix of `ProblemDetails.type` (ARCH-12). */
export const PROBLEM_TYPE_PREFIX = 'urn:iridium:problem:';

/** The `type` URN for a code. */
export function problemType(code: ErrorCode): string {
  return `${PROBLEM_TYPE_PREFIX}${code}`;
}

/**
 * The codes that carry `retryAfterMs`, mirroring the `Retry-After` header
 * (09-api-reference.md section 1.4).
 */
export const RETRY_AFTER_CODES: readonly ErrorCode[] = [
  'rate_limited',
  'capacity',
  'unavailable',
  'not_ready',
  'busy',
];

/**
 * The one code that cannot reach HTTP: it is raised over desktop IPC by
 * `iridium:updates:install` and nowhere else, so `openapi.contract` carries it in a one-element
 * allowlist and fails if that list grows (09-api-reference.md section 1.5, D07-44).
 */
export const IPC_ONLY_CODES: readonly ErrorCode[] = ['updates_manual_only'];

/**
 * The RFC 6749 / 6750 / 8707 error values the MCP mounts and the `/oauth/*` endpoints answer
 * with. They are a separate vocabulary carried by a separate envelope and are deliberately not
 * members of `ErrorCode`; `security.problem-details.unit` asserts the two are disjoint apart from
 * `server_error`, which means the same thing in both.
 */
export const OAUTH_ERROR_CODES = [
  'invalid_request',
  'invalid_client',
  'invalid_grant',
  'invalid_token',
  'unauthorized_client',
  'unsupported_grant_type',
  'unsupported_response_type',
  'invalid_scope',
  'invalid_target',
  'access_denied',
  'insufficient_scope',
  'temporarily_unavailable',
  'mcp_disabled',
  'server_error',
] as const;

/** A member of the OAuth-shaped error vocabulary. */
export type OAuthErrorCode = (typeof OAUTH_ERROR_CODES)[number];

/** The OAuth-shaped error vocabulary as a schema. */
export const OAuthErrorCode: EnumOf<typeof OAUTH_ERROR_CODES> = z.enum(OAUTH_ERROR_CODES);

/** One entry of `ProblemDetails.errors`, present only with `validation_failed`. */
export const ProblemValidationIssue: z.ZodObject<
  { path: z.ZodString; message: z.ZodString; code: z.ZodString },
  z.core.$strict
> = z
  .strictObject({
    /** Dotted location: `body.name`, `query.limit`, `headers.if-match`. */
    path: z.string(),
    message: z.string(),
    /** A zod issue code or a policy code (`too_short`, `breached`, `invalid_name`). */
    code: z.string(),
  })
  .meta({ id: 'ProblemValidationIssue' });

/** One entry of `ProblemDetails.references`, present only with `attachment_referenced`. */
export const ProblemReference: z.ZodObject<
  { noteId: typeof NoteId; path: z.ZodString },
  z.core.$strict
> = z.strictObject({ noteId: NoteId, path: z.string() }).meta({ id: 'ProblemReference' });

/** The RFC 9457 body every REST error carries. */
export const ProblemDetails: z.ZodObject<
  {
    type: z.ZodString;
    title: z.ZodString;
    status: z.ZodInt;
    code: typeof ErrorCode;
    detail: z.ZodOptional<z.ZodString>;
    current: z.ZodOptional<z.ZodUnknown>;
    requestId: z.ZodString;
    errors: z.ZodOptional<z.ZodArray<typeof ProblemValidationIssue>>;
    references: z.ZodOptional<z.ZodArray<typeof ProblemReference>>;
    retryAfterMs: z.ZodOptional<z.ZodInt>;
  },
  z.core.$strict
> = z
  .strictObject({
    /** `urn:iridium:problem:<code>`. */
    type: z.string(),
    /** Human-readable, stable per code, English. */
    title: z.string(),
    status: z.int().min(400).max(599),
    code: ErrorCode,
    /** Request-specific; never note content, credentials, stack traces or SQL. */
    detail: z.string().optional(),
    /** The current representation on `stale_version` / `precondition_required`. */
    current: z.unknown().optional(),
    /** Always present; echoed in `X-Request-Id`. */
    requestId: z.string(),
    errors: z.array(ProblemValidationIssue).optional(),
    references: z.array(ProblemReference).optional(),
    /** Mirrors `Retry-After`, in milliseconds. */
    retryAfterMs: z.int().optional(),
  })
  .meta({ id: 'ProblemDetails' });

/** The RFC 9457 body every REST error carries. */
export type ProblemDetails = z.infer<typeof ProblemDetails>;

/** The OAuth-shaped body the MCP mounts and the `/oauth/*` endpoints answer with. */
export const OAuthErrorBody: z.ZodObject<
  {
    error: typeof OAuthErrorCode;
    error_description: z.ZodOptional<z.ZodString>;
    error_uri: z.ZodOptional<z.ZodString>;
  },
  z.core.$strict
> = z
  .strictObject({
    error: OAuthErrorCode,
    error_description: z.string().optional(),
    error_uri: z.string().optional(),
  })
  .meta({ id: 'OAuthErrorBody' });

/** The OAuth-shaped body the MCP mounts and the `/oauth/*` endpoints answer with. */
export type OAuthErrorBody = z.infer<typeof OAuthErrorBody>;
