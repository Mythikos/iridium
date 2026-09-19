/**
 * `RateWindow` — one fixed window of at most `max` events per `windowMs`, for one subject.
 *
 * Three limits of 09-api-reference.md §3.10 have this shape: 200 Yjs messages per 10 s per document
 * connection, 10 awareness frames per second per `(socket, documentName)`, and 6 `flush` messages per
 * minute per connection. Each subject owns one instance (held in a `WeakMap` keyed by the connection,
 * or in a per-socket `Map` keyed by document name), so there is no shared table to sweep and nothing
 * outlives the subject it counts for. The clock is the caller's: `take(nowMs)` takes the instant, so
 * a test drives the window with a `ManualClock` and the limiter itself owns no timer.
 *
 * A fixed window rather than a token bucket is deliberate: the plan states every one of these caps as
 * "N per window", the windows are short, and a fixed window's worst case (2N across a boundary) is the
 * documented tolerance of every other windowed budget in the server (`auth/tickets/ip-budget.ts`).
 */
export class RateWindow {
  readonly #max: number;
  readonly #windowMs: number;
  #startedAt = Number.NEGATIVE_INFINITY;
  #count = 0;

  constructor(max: number, windowMs: number) {
    this.#max = max;
    this.#windowMs = windowMs;
  }

  /**
   * Counts one event at `nowMs`. Answers `false` — and counts nothing — when the window is full, so
   * a refused event does not extend the refusal.
   */
  take(nowMs: number): boolean {
    if (nowMs - this.#startedAt >= this.#windowMs) {
      this.#startedAt = nowMs;
      this.#count = 0;
    }
    if (this.#count >= this.#max) return false;
    this.#count += 1;
    return true;
  }

  /** Events counted in the current window, for assertions. */
  get count(): number {
    return this.#count;
  }
}
