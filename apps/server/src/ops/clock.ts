/**
 * The injected clock (ARCH-18) and the one place `apps/server/src` is allowed to read wall time or
 * schedule a timer.
 *
 * Two guards depend on that exclusivity: `guards.no-direct-date.guard` fails on `Date.now()`,
 * `new Date()` or a bare `setTimeout` anywhere under `apps/server/src` outside this module, and the
 * deterministic-time rules of 10-testing-and-quality.md require every TTL, expiry and retry window
 * to be drivable from a test without sleeping. Every service therefore receives a `Clock` rather
 * than reaching for the global.
 *
 * `SQL NOW()` stays out of the product too, with one deliberate exception the plan names: the job
 * claim statement, where the database's clock is the arbiter on purpose.
 */

/** A cancellable timer handle, free of Node's `Timeout` type so a fake clock can return one. */
export interface TimerHandle {
  cancel(): void;
}

/** Wall time and timers, injected so tests need neither sleeps nor a real clock. */
export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
  /** The current instant as a `Date`, for `DATETIME(6)` parameters. */
  date(): Date;
  /** A monotonic reading in milliseconds, for durations that must survive a clock step. */
  monotonic(): number;
  /** Runs `fn` once after `ms`. The handle is cancellable and the timer never holds the loop open. */
  after(ms: number, fn: () => void): TimerHandle;
  /** Runs `fn` every `ms`. The handle is cancellable and the timer never holds the loop open. */
  every(ms: number, fn: () => void): TimerHandle;
}

/**
 * The real clock. `unref()` on both timers is deliberate: a readiness re-check or a metrics sampler
 * must never be the reason a process refuses to exit after its drain has finished.
 */
export const systemClock: Clock = Object.freeze({
  now(): number {
    return Date.now();
  },
  date(): Date {
    return new Date();
  },
  monotonic(): number {
    return performance.now();
  },
  after(ms: number, fn: () => void): TimerHandle {
    const handle = setTimeout(fn, ms);
    handle.unref();
    return { cancel: () => clearTimeout(handle) };
  },
  every(ms: number, fn: () => void): TimerHandle {
    const handle = setInterval(fn, ms);
    handle.unref();
    return { cancel: () => clearInterval(handle) };
  },
});

/** RFC 3339 UTC with millisecond precision — the wire rendering of every timestamp (ARCH-18). */
export function toRfc3339(value: Date): string {
  return value.toISOString();
}

/**
 * Races `work` against a deadline, rejecting with a named error when the deadline wins.
 *
 * It lives here rather than beside its callers because a deadline is a timer, and every timer in
 * `apps/server/src` goes through `Clock` so `guards.no-direct-date.guard` can be an absolute rule
 * and a readiness probe can be driven without sleeping.
 */
export async function withDeadline<T>(
  clock: Clock,
  work: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: TimerHandle | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = clock.after(ms, () => {
          reject(new Error(`${label} did not answer within ${String(ms)}ms`));
        });
      }),
    ]);
  } finally {
    timer?.cancel();
  }
}

/** Elapsed milliseconds since a `clock.monotonic()` reading, rounded. */
export function elapsedMs(clock: Clock, since: number): number {
  return Math.round(clock.monotonic() - since);
}
