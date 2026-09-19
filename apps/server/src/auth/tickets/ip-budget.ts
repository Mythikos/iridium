/**
 * The per-IP ticket budget (04-auth-and-access-control.md sections 7.4 and 10.1;
 * 09-api-reference.md section 1.8): 1 000 ticket requests per minute per address, beside the
 * 300 per minute per session that `@fastify/rate-limit` counts on the same route.
 *
 * It is not a second `@fastify/rate-limit` configuration because that plugin runs at most one
 * limiter per request: the first one marks the request as rated and every later handler returns
 * early. Two independent keys on one route therefore need a second counter, and this is the
 * smallest honest one — a fixed window per key on the injected clock, swept so the map stays
 * bounded by the addresses seen inside one window. `mcp/rate-limit.ts` (M3) is the module the plan
 * gives the multi-layer buckets a home in; this budget moves behind its `RateLimitStore` when it
 * lands.
 */
import type { Clock, TimerHandle } from '../../ops/clock.ts';

/** What one `hit()` answers. */
export type BudgetVerdict =
  | { readonly allowed: true; readonly remaining: number }
  | { readonly allowed: false; readonly retryAfterMs: number };

interface Window {
  readonly startedAt: number;
  count: number;
}

/** What the budget is built with. Every number arrives from `LIMITS` or configuration. */
export interface WindowedBudgetOptions {
  readonly clock: Clock;
  /** Hits allowed per key per window. */
  readonly max: number;
  /** The window length in milliseconds. */
  readonly windowMs: number;
}

/** A fixed-window counter per key. One instance per budget, owned by the auth plugin. */
export class WindowedBudget {
  readonly #clock: Clock;
  readonly #max: number;
  readonly #windowMs: number;
  readonly #windows = new Map<string, Window>();
  #sweep: TimerHandle | null;

  constructor(options: WindowedBudgetOptions) {
    this.#clock = options.clock;
    this.#max = options.max;
    this.#windowMs = options.windowMs;
    this.#sweep = options.clock.every(options.windowMs, () => {
      this.sweepExpired();
    });
  }

  /** Counts one hit against `key`, answering whether it is inside the budget. */
  hit(key: string): BudgetVerdict {
    const now = this.#clock.now();
    const current = this.#windows.get(key);
    const window =
      current === undefined || now - current.startedAt >= this.#windowMs
        ? { startedAt: now, count: 0 }
        : current;
    if (window !== current) this.#windows.set(key, window);
    if (window.count >= this.#max) {
      return { allowed: false, retryAfterMs: window.startedAt + this.#windowMs - now };
    }
    window.count += 1;
    return { allowed: true, remaining: this.#max - window.count };
  }

  /** Keys with a window on record, expired ones included until the next sweep. */
  get size(): number {
    return this.#windows.size;
  }

  /** Drops the windows that have ended; also run on the sweep timer. Answers how many. */
  sweepExpired(): number {
    const now = this.#clock.now();
    let dropped = 0;
    for (const [key, window] of this.#windows) {
      if (now - window.startedAt >= this.#windowMs) {
        this.#windows.delete(key);
        dropped += 1;
      }
    }
    return dropped;
  }

  /** Stops the sweep timer. The owner calls it once, on shutdown. */
  close(): void {
    this.#sweep?.cancel();
    this.#sweep = null;
  }
}
