/**
 * The writer's retry policy (05-collaboration-and-durability.md, "Failure handling, retry and
 * `persist-failed`"): exponential backoff from 200 ms to a 5 s ceiling with full jitter, `failed`
 * after 10 consecutive attempts or 30 s in `retrying`, and a 30 s cadence while `failed`.
 *
 * Pure, so `writer.backoff.prop` can state the properties — bounded by the ceiling, never negative,
 * the ceiling monotone in the attempt count — without a writer. The randomness is injected: the
 * writer passes `Math.random`, a test passes what it wants.
 */

/** The first retry delay. */
export const BACKOFF_BASE_MS = 200;
/** No retry waits longer than this while the writer is `retrying`. */
export const BACKOFF_CEILING_MS = 5_000;
/** Consecutive failed attempts after which the writer enters `failed`. */
export const FAILED_AFTER_ATTEMPTS = 10;
/** Time in `retrying` after which the writer enters `failed`. */
export const FAILED_AFTER_MS = 30_000;
/** The retry cadence of a `failed` writer. */
export const FAILED_RETRY_INTERVAL_MS = 30_000;

/** The exponential ceiling for one attempt (1-based), before jitter. */
export function backoffCeilingMs(attempt: number): number {
  const exponent = Math.max(0, Math.floor(attempt) - 1);
  return Math.min(BACKOFF_CEILING_MS, BACKOFF_BASE_MS * 2 ** exponent);
}

/**
 * The delay before retry number `attempt`, with full jitter: uniform in `[0, ceiling]`.
 *
 * Full jitter rather than a jittered band, because a MySQL outage ends for every writer at once and
 * the point of the jitter is that their first retries do not.
 */
export function retryDelayMs(attempt: number, random: () => number): number {
  const ceiling = backoffCeilingMs(attempt);
  const unit = Math.min(1, Math.max(0, random()));
  return Math.round(unit * ceiling);
}

/** Whether a writer in `retrying` has escalated to `failed`. */
export function hasFailed(attempts: number, retryingForMs: number): boolean {
  return attempts >= FAILED_AFTER_ATTEMPTS || retryingForMs >= FAILED_AFTER_MS;
}
