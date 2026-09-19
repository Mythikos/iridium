/**
 * The compare-and-set statement contract of 03-data-model.md §7.2 — the three statement shapes every
 * mutating service uses, and the assertion that makes them safe.
 *
 * All three assert **matched** rows, not changed rows, which is why the `FOUND_ROWS` client flag is
 * verified at boot (`db/assertFoundRows.ts`): without it an update that sets a column to the value it
 * already holds reports `0` and every one of these statements would misread a successful write as a
 * conflict — or, on the persistence writer's `head_seq` CAS, as corruption.
 *
 * | Shape | Statement | `0n` means |
 * |---|---|---|
 * | versioned metadata | `… SET version = version + 1 WHERE id = ? AND version = ?` | a conflict: re-read and answer `409 stale_version` (or `409 node_trashed`) |
 * | content head | `UPDATE note_docs SET head_seq = ? WHERE note_id = ? AND head_seq = ?` | corruption, never a retry (§8.4) |
 * | monotonic guard | `… WHERE snapshot_through_seq < ?` / `WHERE revision < ?` | the designed outcome: a newer write already landed, skip silently |
 *
 * The three are deliberately three functions rather than one with a mode flag, because the *response*
 * to `0n` is what differs and a shared function would have to be told which one at every call site
 * anyway — at which point the flag is the name.
 */
import type { ErrorCode } from '@iridium/contracts';

import { ProblemError } from '../security/problem.ts';

/** What a Kysely mutation reports. Narrowed to the one field the contract reads. */
export interface MatchedRows {
  readonly numUpdatedRows: bigint;
}

/** Which row a CAS was attempted on, for the message a failure carries. */
export interface CasSubject {
  /** The table, as 03-data-model.md spells it. */
  readonly table: string;
  /** The primary key value, rendered — an id, never a secret. */
  readonly id: string;
  /** The version, sequence or predicate value the statement compared against. */
  readonly expected?: number;
}

/**
 * Thrown when a statement whose `0n` means corruption matched no row — the `head_seq` CAS of §8.4.
 *
 * It is deliberately not a `ProblemError`: there is no HTTP request to answer. 05's persistence writer
 * catches it, broadcasts `persist-failed`, increments
 * `iridium_persist_failures_total{reason="cas_mismatch"}` and logs `persist.cas_mismatch`, and the
 * document is never silently reconciled.
 */
export class HeadSeqCasViolation extends Error {
  readonly code = 'db.cas_mismatch';
  readonly table: string;
  readonly id: string;

  constructor(subject: CasSubject) {
    super(
      `the ${subject.table} head compare-and-set for ${subject.id} matched no row at head_seq = ` +
        `${String(subject.expected ?? 0)}. This is corruption, never a conflict to retry: another ` +
        'writer advanced the head of a note this process believed it owned (03-data-model.md §8.4). ' +
        'Stop writing to this note, check `iridium doctor --repair-heads`, and look for a second ' +
        'server process against this schema — the `iridium_collab_owner` boot lease is what normally ' +
        'refuses that before any document loads.',
    );
    this.name = 'HeadSeqCasViolation';
    this.table = subject.table;
    this.id = subject.id;
  }
}

/** Whether a mutation matched exactly one row. */
export function matchedOne(result: MatchedRows): boolean {
  return result.numUpdatedRows === 1n;
}

/**
 * Shape 1: the versioned metadata update. A `0n` is a conflict, and the caller supplies the freshly
 * read representation the `409` carries (`A13`) plus whether the row is now trashed.
 *
 * @throws ProblemError `409 stale_version`, or `409 node_trashed` when `trashed` is true.
 */
export function assertVersionedUpdate(
  result: MatchedRows,
  subject: CasSubject,
  conflict: { readonly current?: unknown; readonly trashed?: boolean } = {},
): void {
  if (matchedOne(result)) return;
  const code: ErrorCode = conflict.trashed === true ? 'node_trashed' : 'stale_version';
  throw new ProblemError(code, {
    detail:
      conflict.trashed === true
        ? 'The row was moved to the trash by another request; re-read it before retrying.'
        : 'The row changed since the version you sent; re-read it and retry with the new version.',
    ...(conflict.current === undefined ? {} : { current: conflict.current }),
  });
}

/**
 * Shape 2: the content head CAS, used by the persistence writer and by nothing else.
 *
 * @throws HeadSeqCasViolation when the statement matched no row.
 * @internal Exercised by the unit contract; not part of the production module API.
 */
export function assertHeadCas(result: MatchedRows, subject: CasSubject): void {
  if (matchedOne(result)) return;
  throw new HeadSeqCasViolation(subject);
}

/**
 * Shape 3: the monotonic projection or snapshot guard. `0n` is the designed outcome — a newer writer
 * already landed — so this returns whether the write applied and never throws.
 */
export function monotonicGuardApplied(result: MatchedRows): boolean {
  return result.numUpdatedRows > 0n;
}

/**
 * The `428 precondition_required` of §7.4: a route that requires a validator was called without one.
 *
 * It lives beside the CAS helpers because the three are one contract read from two ends — the header
 * the client must send and the predicate the statement must carry — and separating them is how a route
 * ends up accepting a mutation with no validator at all.
 *
 * @throws ProblemError `428 precondition_required`.
 * @internal Exercised by the unit contract; not part of the production module API.
 */
export function requireIfMatch(value: number | undefined, what: string): number {
  if (value !== undefined) return value;
  throw new ProblemError('precondition_required', {
    detail: `This request changes ${what} and requires an If-Match header carrying the version you read.`,
  });
}
