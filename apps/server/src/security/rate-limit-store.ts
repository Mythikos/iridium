/**
 * The process-local RateLimitStore seam (02-system-architecture.md, ARCH-19). The REST adapter
 * uses this same bounded fixed-window counter with @fastify/rate-limit's resolved per-request
 * policy. Persistent login-failure throttling and the ticket IP budget have separate owners.
 */
import { LIMITS } from '@iridium/contracts';

/** A consumption decision; resetAt is an absolute injected-clock time in milliseconds. */
export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly resetAt: number;
}

/** The implementation-independent counter contract; consuming a refused request still costs points. */
export interface RateLimitStore {
  consume(bucket: string, key: string, points: number, now: number): Promise<RateLimitDecision>;
  reset(bucket: string, key: string): Promise<void>;
}

/** A fixed window starts with the first consumption, rather than at a wall-clock minute boundary. */
export interface FixedWindowPolicy {
  readonly max: number;
  readonly timeWindowMs: number;
}

/** The raw count is needed by Fastify's dynamic max and ban handling, even after remaining reaches zero. */
export interface FixedWindowSnapshot {
  readonly current: number;
  readonly resetAt: number;
}

interface Counter {
  readonly current: number;
  readonly startedAt: number;
}

/** A misconfigured policy or an unrepresentable counter fails closed, without resetting its budget. */
export class RateLimitStoreError extends Error {
  constructor(detail: string) {
    super(`security/rate-limit-store: ${detail}`);
    this.name = 'RateLimitStoreError';
  }
}

function nonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RateLimitStoreError(
      `${label} must be a non-negative safe integer; received ${String(value)}`,
    );
  }
}

function validatePolicy(policy: FixedWindowPolicy): void {
  nonNegativeInteger(policy.max, 'max');
  nonNegativeInteger(policy.timeWindowMs, 'timeWindowMs');
}

function entryKey(bucket: string, key: string): string {
  // Tuple encoding prevents delimiter-containing keys from colliding with another bucket.
  return JSON.stringify([bucket, key]);
}

/**
 * Fixed-window counters bounded by one LRU capacity per store. The generic seam resolves a named
 * policy injected at construction; the REST bridge supplies its already-resolved policy to the
 * same counter operation. A changed max never creates a fresh key or window. Each route override
 * creates its own instance, matching @fastify/rate-limit 11.2.0's LocalStore.child isolation.
 *
 * No timers or global clock are retained. Reservations complete synchronously before the public
 * promise resolves, so concurrent consumes cannot spend the same remaining point twice.
 */
export class InMemoryRateLimitStore implements RateLimitStore {
  readonly #policies: ReadonlyMap<string, FixedWindowPolicy>;
  readonly #entries = new Map<string, Counter>();
  readonly #maxEntries: number;

  constructor(
    policies: ReadonlyMap<string, FixedWindowPolicy> = new Map(),
    maxEntries: number = LIMITS.REST_RATE_LIMIT_CACHE_MAX_ENTRIES,
  ) {
    if (
      !Number.isSafeInteger(maxEntries) ||
      maxEntries < 1 ||
      maxEntries > LIMITS.REST_RATE_LIMIT_CACHE_MAX_ENTRIES
    ) {
      throw new RateLimitStoreError(
        `cache must be an integer between 1 and ${String(LIMITS.REST_RATE_LIMIT_CACHE_MAX_ENTRIES)}; received ${String(maxEntries)}`,
      );
    }
    this.#maxEntries = maxEntries;
    this.#policies = new Map(
      [...policies].map(([bucket, policy]) => {
        validatePolicy(policy);
        return [bucket, Object.freeze({ ...policy })];
      }),
    );
  }

  /** Retained counters, including expired entries awaiting lookup or ordinary LRU eviction. */
  get size(): number {
    return this.#entries.size;
  }

  async consume(
    bucket: string,
    key: string,
    points: number,
    now: number,
  ): Promise<RateLimitDecision> {
    const policy = this.#policies.get(bucket);
    if (policy === undefined) {
      throw new RateLimitStoreError(
        `unknown bucket ${JSON.stringify(bucket)}; configure its fixed-window policy`,
      );
    }
    const snapshot = this.consumeResolved(bucket, key, points, now, policy);
    return {
      allowed: snapshot.current <= policy.max,
      remaining: Math.max(0, policy.max - snapshot.current),
      resetAt: snapshot.resetAt,
    };
  }

  async reset(bucket: string, key: string): Promise<void> {
    this.#entries.delete(entryKey(bucket, key));
  }

  /**
   * Fastify has already evaluated callable max/timeWindow options. Keep their resolved values
   * outside the storage identity, so lowering or raising max cannot reset an existing count.
   */
  consumeResolved(
    bucket: string,
    key: string,
    points: number,
    now: number,
    policy: FixedWindowPolicy,
  ): FixedWindowSnapshot {
    validatePolicy(policy);
    nonNegativeInteger(now, 'now');
    if (!Number.isSafeInteger(points) || points < 1) {
      throw new RateLimitStoreError(
        `points must be a positive safe integer; received ${String(points)}`,
      );
    }
    const storedKey = entryKey(bucket, key);
    const previous = this.#get(storedKey);
    const active = previous !== undefined && previous.startedAt + policy.timeWindowMs > now;
    const current = (active ? previous.current : 0) + points;
    const startedAt = active ? previous.startedAt : now;
    const resetAt = startedAt + policy.timeWindowMs;
    nonNegativeInteger(current, 'counter');
    nonNegativeInteger(resetAt, 'resetAt');
    this.#remember(storedKey, { current, startedAt });
    return { current, resetAt };
  }

  /**
   * Snapshot only: a missing/expired window reports zero without allocating or renewing it.
   * Like LocalStore.read, an existing key is an LRU access but its counter and start stay unchanged.
   */
  readResolved(
    bucket: string,
    key: string,
    now: number,
    policy: FixedWindowPolicy,
  ): FixedWindowSnapshot {
    validatePolicy(policy);
    nonNegativeInteger(now, 'now');
    const previous = this.#get(entryKey(bucket, key));
    if (previous === undefined || previous.startedAt + policy.timeWindowMs <= now) {
      return { current: 0, resetAt: now };
    }
    const resetAt = previous.startedAt + policy.timeWindowMs;
    nonNegativeInteger(resetAt, 'resetAt');
    return { current: previous.current, resetAt };
  }

  #get(key: string): Counter | undefined {
    const entry = this.#entries.get(key);
    if (entry !== undefined) {
      this.#entries.delete(key);
      this.#entries.set(key, entry);
    }
    return entry;
  }

  #remember(key: string, entry: Counter): void {
    if (!this.#entries.has(key) && this.#entries.size >= this.#maxEntries) {
      const oldest = this.#entries.keys().next().value;
      if (oldest !== undefined) this.#entries.delete(oldest);
    }
    this.#entries.set(key, entry);
  }
}
