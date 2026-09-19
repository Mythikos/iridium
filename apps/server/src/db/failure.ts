/**
 * The database failure mapping of 03-data-model.md §7.4 — one table from a MySQL outcome to the
 * `ProblemDetails` code the caller answers with.
 *
 * Every mutating service in the server reaches the database through the same three statement shapes
 * (§7.2) and can therefore fail in the same handful of ways. Mapping those ways once is what makes
 * "an `ER_DUP_ENTRY` on `uq_sibling` is `409 name_conflict`" a property of the code rather than a
 * convention each service repeats slightly differently.
 *
 * Two rules are worth stating because they look like omissions:
 *
 *  - **A lock-wait timeout is never retried here.** §7.4: mutations are never retried server-side, so
 *    `ER_LOCK_WAIT_TIMEOUT` becomes `503 busy` with `Retry-After: 1` and the client decides. The one
 *    exception is a deadlock, which `withVaultLock` retries exactly once with a fresh read before
 *    giving the same `busy` answer.
 *  - **A `numUpdatedRows === 0n` is not a database error** and therefore not in this module's input
 *    domain: it is an application outcome the caller distinguishes (`stale_version` when the row is
 *    still live, `node_trashed` when it is not), which is why `db/cas.ts` owns it.
 */
import type { ErrorCode } from '@iridium/contracts';

import { ProblemError } from '../security/problem.ts';
import { asMysqlErrorLike, redactDatabaseError } from './redact-sql.ts';

/** MySQL error numbers this server maps deliberately; anything else propagates as `server_error`. */
export const MYSQL_ERRNO = Object.freeze({
  /** `ER_DUP_ENTRY` — a unique key was violated. */
  duplicateEntry: 1062,
  /** `ER_LOCK_WAIT_TIMEOUT` — `innodb_lock_wait_timeout` elapsed. */
  lockWaitTimeout: 1205,
  /** `ER_LOCK_DEADLOCK` — InnoDB chose this transaction as the deadlock victim. */
  deadlock: 1213,
  /** `ER_SIGNAL_EXCEPTION` — a trigger raised `SIGNAL SQLSTATE '45000'` (the audit tables). */
  signalException: 1644,
});

/** The unique keys 03-data-model.md §7.4 maps by name. */
export const CONSTRAINT_TO_CODE: Readonly<Record<string, ErrorCode>> = Object.freeze({
  uq_sibling: 'name_conflict',
  uq_vaults_name: 'name_conflict',
  uq_vaults_slug: 'name_conflict',
  uq_attachment_path: 'name_conflict',
  uq_users_email_key: 'email_conflict',
});

/** What a MySQL failure was, once classified. */
export type DatabaseFailure =
  | { readonly kind: 'duplicate_entry'; readonly constraint: string | null }
  | { readonly kind: 'lock_wait_timeout' }
  | { readonly kind: 'deadlock' }
  | { readonly kind: 'append_only_violation' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'other' };

/** Transport/driver availability, shared by HTTP mappings and the persistence writer. */
const UNAVAILABLE_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'EHOSTUNREACH',
  'ENOTFOUND',
  'PROTOCOL_CONNECTION_LOST',
  'PROTOCOL_SEQUENCE_TIMEOUT',
  'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR',
  'PROTOCOL_ENQUEUE_AFTER_QUIT',
  'ER_SERVER_SHUTDOWN',
  'ER_CON_COUNT_ERROR',
]);

const DUPLICATE_KEY_NAME = /for key '(?:[^'.]+\.)?([^']+)'/;

function errnoOf(error: unknown): number | null {
  return asMysqlErrorLike(error).errno ?? null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Classifies a thrown value as one of the outcomes §7.4 enumerates. */
export function classifyDatabaseFailure(error: unknown): DatabaseFailure {
  const code = asMysqlErrorLike(error).code;
  const message = error instanceof Error ? error.message : '';
  if (
    (code !== undefined && UNAVAILABLE_CODES.has(code)) ||
    message.includes('Pool is closed') ||
    message.includes('closed state')
  ) {
    return { kind: 'unavailable' };
  }
  switch (errnoOf(error)) {
    case MYSQL_ERRNO.duplicateEntry: {
      const match = DUPLICATE_KEY_NAME.exec(messageOf(error));
      return { kind: 'duplicate_entry', constraint: match?.[1] ?? null };
    }
    case MYSQL_ERRNO.lockWaitTimeout:
      return { kind: 'lock_wait_timeout' };
    case MYSQL_ERRNO.deadlock:
      return { kind: 'deadlock' };
    case MYSQL_ERRNO.signalException:
      return { kind: 'append_only_violation' };
    default:
      return { kind: 'other' };
  }
}

/** Whether a failure is the one `withVaultLock` retries once (§7.4). */
export function isRetryableDeadlock(error: unknown): boolean {
  return classifyDatabaseFailure(error).kind === 'deadlock';
}

/** Extra members a caller can attach to the problem a duplicate key becomes. */
export interface DatabaseFailureContext {
  /** `{parentId, name}`, `{name}`, `{pathHint}` — whatever §7.4's payload column states for the key. */
  readonly current?: unknown;
  readonly detail?: string;
}

/**
 * The `ProblemError` a classified failure becomes, or `null` when the failure is not one this table
 * maps — in which case the caller lets it propagate and the error handler answers `server_error` with
 * the stack on the log line and nothing but the request id in the body.
 */
export function toProblem(
  error: unknown,
  context: DatabaseFailureContext = {},
): ProblemError | null {
  const failure = classifyDatabaseFailure(error);
  const redacted = redactDatabaseError(error);

  switch (failure.kind) {
    case 'duplicate_entry': {
      const code = failure.constraint === null ? undefined : CONSTRAINT_TO_CODE[failure.constraint];
      if (code === undefined) return null;
      return new ProblemError(code, {
        detail:
          context.detail ??
          (code === 'email_conflict'
            ? 'An account with that email address already exists.'
            : 'A sibling with that name already exists.'),
        ...(context.current === undefined ? {} : { current: context.current }),
      });
    }
    case 'lock_wait_timeout':
      // `Retry-After: 1` comes from `security/problem.ts`'s default for `busy` (§7.4), so the second
      // copy this module would otherwise carry does not exist.
      return new ProblemError('busy', {
        detail:
          context.detail ??
          'The vault was locked by another change for longer than this request waits. Nothing was ' +
            'written; retry the request.',
      });
    case 'deadlock':
      return new ProblemError('busy', {
        detail:
          context.detail ??
          'Two changes to this vault deadlocked and this one was rolled back after a retry. Nothing ' +
            'was written; retry the request.',
      });
    case 'unavailable':
      // A lost COMMIT response says nothing about whether the write committed. Never promise rollback.
      return new ProblemError('unavailable', {
        detail:
          'The database did not confirm this operation. Check its current state before retrying a write.',
      });
    case 'append_only_violation':
      // A trigger refused an UPDATE or DELETE on `audit_events`. That is a bug in the caller, never a
      // client's doing, so it stays a `server_error` with the redacted driver text on the log line.
      return new ProblemError('server_error', { detail: redacted.message });
    case 'other':
      return null;
  }
  // Unreachable: the switch is exhaustive over `DatabaseFailure`. Stated so the function has one exit for
  // every path a reader (and `typescript/consistent-return`) can see.
  return null;
}
