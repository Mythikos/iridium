/**
 * `ManualClock` — the injected clock the DB-backed suites drive (10-testing-and-quality.md,
 * "Deterministic time"; ARCH-18).
 *
 * It implements the server's `Clock` so `buildApp({ clock })` runs every TTL, expiry and timer off
 * a value a test advances. `advance(ms)` fires due timers in order and awaits their microtasks, so
 * a sweep scheduled with `every()` runs exactly when a test says it does and never in between;
 * `jump()` moves the wall clock without firing anything, which is what an "age this session out"
 * step needs. Fake timers (`vi.useFakeTimers`) are not used here because a real mysql2 pool and
 * fake timers do not coexist.
 *
 * It lives beside the tests rather than in `@iridium/testkit` because the `Clock` interface is the
 * server's own (`apps/server/src/ops/clock.ts`); the testkit's copy is the wave-2 seam that adopts
 * this one.
 */
import type { Clock, TimerHandle } from '../../src/ops/clock.ts';

interface ScheduledTimer {
  readonly id: number;
  at: number;
  readonly fn: () => void;
  readonly everyMs: number | null;
}

/** A clock a test moves by hand. */
export class ManualClock implements Clock {
  #nowMs: number;
  #monotonicMs = 0;
  #nextId = 1;
  /**
   * The sub-millisecond remainder of the advances made so far. `now()` is an epoch millisecond,
   * exactly as `Date.now()` is, and the server asserts that where it matters: the rate-limit store
   * refuses a fractional instant outright. A clock paced against `performance.now()` supplies
   * fractional deltas, so the fraction is carried here instead of reaching `#nowMs`, which keeps
   * the reported instant whole without losing the elapsed time a run of small deltas adds up to.
   */
  #carryMs = 0;
  readonly #timers = new Map<number, ScheduledTimer>();

  constructor(start: string | number = '2026-09-13T12:00:00.000Z') {
    this.#nowMs = Math.trunc(typeof start === 'number' ? start : Date.parse(start));
  }

  now(): number {
    return this.#nowMs;
  }

  date(): Date {
    return new Date(this.#nowMs);
  }

  monotonic(): number {
    return this.#monotonicMs;
  }

  after(ms: number, fn: () => void): TimerHandle {
    return this.#schedule(ms, fn, null);
  }

  every(ms: number, fn: () => void): TimerHandle {
    return this.#schedule(ms, fn, ms);
  }

  /** Timers currently scheduled, for assertions that a sweep exists (or was cancelled). */
  get pendingTimers(): number {
    return this.#timers.size;
  }

  /** Moves both clocks forward, firing every timer that becomes due, in due order. */
  async advance(ms: number): Promise<void> {
    const target = this.#wholeTarget(ms);
    for (;;) {
      const next = this.#nextDue(target);
      if (next === null) break;
      this.#nowMs = next.at;
      this.#monotonicMs += 0;
      if (next.everyMs === null) this.#timers.delete(next.id);
      else next.at += next.everyMs;
      next.fn();
      // eslint-disable-next-line no-await-in-loop -- timers fire in due order, each with its microtasks
      await Promise.resolve();
    }
    this.#monotonicMs += target - this.#nowMs;
    this.#nowMs = target;
  }

  /** Delivers overdue timers once after a blocked event loop, at the actual elapsed clock time. */
  async stall(ms: number): Promise<void> {
    this.jump(this.#wholeTarget(ms));
    for (;;) {
      const next = this.#nextDue(this.#nowMs);
      if (next === null) return;
      if (next.everyMs === null) this.#timers.delete(next.id);
      else next.at = this.#nowMs + next.everyMs;
      next.fn();
      // eslint-disable-next-line no-await-in-loop -- deliver overdue callbacks in their scheduled order
      await Promise.resolve();
    }
  }

  /** Moves the wall clock to an instant without firing anything. */
  jump(to: string | number): void {
    const target = Math.trunc(typeof to === 'number' ? to : Date.parse(to));
    this.#monotonicMs += Math.max(0, target - this.#nowMs);
    this.#nowMs = target;
  }

  /** The whole-millisecond instant `ms` reaches, carrying whatever fraction it leaves behind. */
  #wholeTarget(ms: number): number {
    const total = this.#carryMs + ms;
    const whole = Math.floor(total);
    this.#carryMs = total - whole;
    return this.#nowMs + whole;
  }

  #schedule(ms: number, fn: () => void, everyMs: number | null): TimerHandle {
    const id = this.#nextId;
    this.#nextId += 1;
    this.#timers.set(id, { id, at: this.#nowMs + ms, fn, everyMs });
    return { cancel: () => this.#timers.delete(id) };
  }

  #nextDue(before: number): ScheduledTimer | null {
    let due: ScheduledTimer | null = null;
    for (const timer of this.#timers.values()) {
      if (
        timer.at <= before &&
        (due === null || timer.at < due.at || (timer.at === due.at && timer.id < due.id))
      ) {
        due = timer;
      }
    }
    return due;
  }
}
