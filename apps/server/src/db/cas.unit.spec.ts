/**
 * `db.cas.unit` — the compare-and-set statement contract of 03-data-model.md §7.2 and §7.4.
 *
 * The three statement shapes differ only in what `0n` means, and that difference is the whole contract:
 * a conflict on the versioned shape, **corruption** on the content head, and the designed outcome on the
 * monotonic guard. Getting the third one wrong makes a rebuild impossible; getting the second one wrong
 * turns two writers on one note into a silent retry loop.
 *
 * There is no inventory row for this name yet; the platform stream's report asks for one.
 */
import { describe, expect, it } from 'vitest';

import { ProblemError } from '../security/problem.ts';
import {
  assertHeadCas,
  assertVersionedUpdate,
  HeadSeqCasViolation,
  matchedOne,
  monotonicGuardApplied,
  requireIfMatch,
} from './cas.ts';

const NODE = { table: 'nodes', id: '0190f2a0-0000-7000-8000-000000000001', expected: 4 };

/**
 * The value a call threw, or `undefined` when it did not throw.
 *
 * Returning the error rather than asserting inside a `catch` is what keeps every `expect` below
 * unconditional: an assertion that only runs when the call happened to throw passes when it did not.
 */
function thrown(call: () => void): unknown {
  try {
    call();
    return undefined;
  } catch (error) {
    return error;
  }
}

/** The `ProblemError` a call threw, or `null` — so the code and the status are asserted, never guessed. */
function problemFrom(call: () => void): ProblemError | null {
  const error = thrown(call);
  return error instanceof ProblemError ? error : null;
}

describe('db.cas.unit [area:db]', () => {
  it('accepts exactly one matched row and nothing else', () => {
    expect(matchedOne({ numUpdatedRows: 1n })).toBe(true);
    expect(matchedOne({ numUpdatedRows: 0n })).toBe(false);
    // Two matched rows is not "more successful": an unqualified predicate is the bug §7.2 forbids.
    expect(matchedOne({ numUpdatedRows: 2n })).toBe(false);
  });

  describe('shape 1: the versioned metadata update', () => {
    it('passes on one matched row', () => {
      expect(thrown(() => assertVersionedUpdate({ numUpdatedRows: 1n }, NODE))).toBeUndefined();
    });

    it('answers 409 stale_version with the freshly read representation', () => {
      const current = { id: NODE.id, version: 5, name: 'Readme' };
      const problem = problemFrom(() =>
        assertVersionedUpdate({ numUpdatedRows: 0n }, NODE, { current }),
      );
      expect(problem?.code).toBe('stale_version');
      expect(problem?.status).toBe(409);
      expect(problem?.extensions.current).toEqual(current);
    });

    it('answers 409 node_trashed when the row is no longer live', () => {
      const problem = problemFrom(() =>
        assertVersionedUpdate({ numUpdatedRows: 0n }, NODE, { trashed: true }),
      );
      expect(problem?.code).toBe('node_trashed');
      expect(problem?.status).toBe(409);
    });
  });

  describe('shape 2: the content head CAS', () => {
    it('passes on one matched row', () => {
      expect(thrown(() => assertHeadCas({ numUpdatedRows: 1n }, NODE))).toBeUndefined();
    });

    it('raises a corruption error rather than a ProblemDetails, because no request is waiting', () => {
      // §8.4: `0n` here is never a conflict to retry. The writer broadcasts `persist-failed`, increments
      // `iridium_persist_failures_total{reason="cas_mismatch"}` and logs `persist.cas_mismatch`; there is
      // no HTTP response to shape, so this is deliberately not a `ProblemError`.
      const error = thrown(() => assertHeadCas({ numUpdatedRows: 0n }, NODE));
      expect(error).toBeInstanceOf(HeadSeqCasViolation);
      expect(error).not.toBeInstanceOf(ProblemError);
      // The message names the operator's first two checks: the repair command and the boot lease.
      expect(error instanceof Error ? error.message : '').toContain(
        'iridium doctor --repair-heads',
      );
      expect(error instanceof Error ? error.message : '').toContain('iridium_collab_owner');
    });
  });

  describe('shape 3: the monotonic guard', () => {
    it('reports whether the write applied and never throws', () => {
      expect(monotonicGuardApplied({ numUpdatedRows: 1n })).toBe(true);
      // A newer snapshot already landed: skip silently, which is the designed outcome.
      expect(monotonicGuardApplied({ numUpdatedRows: 0n })).toBe(false);
    });
  });

  describe('the validator requirement', () => {
    it('returns the version a caller sent', () => {
      expect(requireIfMatch(7, 'this node')).toBe(7);
      expect(requireIfMatch(0, 'this node')).toBe(0);
    });

    it('answers 428 precondition_required when the header is absent', () => {
      const problem = problemFrom(() => {
        requireIfMatch(undefined, 'this vault');
      });
      expect(problem?.code).toBe('precondition_required');
      expect(problem?.status).toBe(428);
      expect(problem?.extensions.detail).toContain('this vault');
    });
  });
});
