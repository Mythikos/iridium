/**
 * The REST rate-limit tiers (09-api-reference.md §1.8; skeleton A.1's limits, read from
 * `@iridium/contracts/limits.ts`).
 *
 * The M1 tiers use `@fastify/rate-limit` 11.2.0 with the injected-clock fixed-window store:
 *
 * | Tier | Budget | Key |
 * |---|---|---|
 * | authenticated | `REST_AUTHENTICATED_PER_MINUTE` (600/min) | the principal (`ses:<id>`, `pat:<id>`, `oat:<id>`) |
 * | unauthenticated | `REST_UNAUTHENTICATED_PER_MINUTE` (60/min) | the IP, after `TRUST_PROXY` resolution |
 * | login | `LOGIN_PER_MINUTE_PER_IP` (10/min) | the IP, on the three credential-presenting routes |
 *
 * The first two are the **global** limiter, because "every route is limited unless it opted out" is the
 * only version of this that a new route cannot forget. The third is a per-route override the `auth` stream
 * attaches as `config.rateLimit`, because it applies to exactly three routes and must not be reachable by
 * a name a fourth route could copy by accident.
 *
 * Two shapes are worth stating:
 *
 *  - **The bucket key comes from `request.principalKey`**, which the `auth` plugin sets once per request
 *    (`ses:<id>` / `pat:<id>` / `oat:<id>`) and the security plugin initialises to `null`. One key source,
 *    so "authenticated" and "which bucket" cannot disagree; `null` selects the per-IP tier.
 *  - **A refusal is a `ProblemError`, not a plain body.** `@fastify/rate-limit` *throws* whatever
 *    `errorResponseBuilder` returns, so returning a `ProblemError` puts the refusal through the one error
 *    handler and it comes out as `application/problem+json` with `code: 'rate_limited'` — beside the
 *    `x-ratelimit-*` and `retry-after` headers the plugin has already set (09 §1.2).
 *
 * The four later tiers of §1.8 — collab tickets, the `?fresh=true` pair, uploads and the PAT/OAuth token
 * budgets — arrive with the routes that need them (M1's ticket route, M2's content routes, M3's MCP
 * limiter), each as a per-route override built from this module's helper.
 */
import type { FastifyRateLimitStore, FastifyRateLimitStoreCtor } from '@fastify/rate-limit';
import { LIMITS } from '@iridium/contracts';
import type { RouteShorthandOptions } from 'fastify';

import type { Clock } from '../ops/clock.ts';
import { ProblemError } from './problem.ts';
import { InMemoryRateLimitStore, RateLimitStoreError } from './rate-limit-store.ts';

/** The window every REST tier is counted over. `@fastify/rate-limit` parses the string form. */
export const RATE_LIMIT_WINDOW = '1 minute';

/** What `@fastify/rate-limit` hands `errorResponseBuilder`. Only `ttl` is read. */
interface RateLimitContext {
  readonly ttl: number;
}

/**
 * The two request fields a tier reads — a slice, never the whole request, so every tier is a pure
 * function `security.rate-limits.integration` can drive without a server.
 */
export interface RateLimitedRequest {
  /** `ses:<id>` / `pat:<id>` / `oat:<id>` once a principal exists, `null` until then. */
  readonly principalKey: string | null;
  /** The peer address, already resolved through `TRUST_PROXY`. */
  readonly ip: string;
}

/**
 * The `ProblemError` a refusal becomes.
 *
 * `retryAfterMs` carries the limiter's own remaining TTL, so the body's `retryAfterMs` and the
 * `retry-after` header the plugin has already set describe the same wait rather than two different
 * guesses.
 */
export function rateLimitProblem(_request: unknown, context: RateLimitContext): ProblemError {
  return new ProblemError('rate_limited', {
    detail: 'Too many requests. Retry after the interval this response names.',
    retryAfterMs: context.ttl,
  });
}

/** The per-request budget of the global limiter: 600/min with a principal, 60/min without one. */
export function globalRateLimitMax(request: RateLimitedRequest): number {
  return request.principalKey === null
    ? LIMITS.REST_UNAUTHENTICATED_PER_MINUTE
    : LIMITS.REST_AUTHENTICATED_PER_MINUTE;
}

/** The bucket key: the principal when there is one, the resolved peer address otherwise. */
export function globalRateLimitKey(request: RateLimitedRequest): string {
  return request.principalKey ?? request.ip;
}

/** One per-route override, in the shape `@fastify/rate-limit` reads it from `config.rateLimit`. */
export interface RouteRateLimit {
  readonly max: number;
  readonly timeWindow: string;
  keyGenerator(request: RateLimitedRequest): string;
  errorResponseBuilder(request: unknown, context: RateLimitContext): ProblemError;
}

/**
 * The per-route override for the three credential-presenting routes of §1.8 —
 * `POST /auth/sessions`, `POST /auth/reauthenticate`, `POST /auth/set-password`.
 *
 * It is keyed on the IP rather than on the principal for the obvious reason: the requests that matter
 * have no principal yet. `login_throttle` (5 failures per `email|ip`, 100/day per IP) is the *other* half
 * of the login defence and lives in `auth/throttle.ts`; this tier bounds the request rate, that one bounds
 * the failure rate, and neither substitutes for the other.
 *
 * Spread into a route's options: `app.post('/auth/sessions', { ...LOGIN_RATE_LIMIT, config: {…} }, …)`.
 */
export const LOGIN_RATE_LIMIT_POLICY: RouteRateLimit = Object.freeze({
  max: LIMITS.LOGIN_PER_MINUTE_PER_IP,
  timeWindow: RATE_LIMIT_WINDOW,
  keyGenerator: (request: RateLimitedRequest): string => request.ip,
  errorResponseBuilder: rateLimitProblem,
});

/** The same policy in the shape a route spreads into its options. */
export const LOGIN_RATE_LIMIT: RouteShorthandOptions = Object.freeze({
  config: { rateLimit: LOGIN_RATE_LIMIT_POLICY },
});

type StoreCallback = Parameters<FastifyRateLimitStore['incr']>[1];
interface StoreResult {
  readonly current: number;
  readonly ttl: number;
}

function storeCapacity(options: unknown): number {
  if (typeof options !== 'object' || options === null) {
    throw new RateLimitStoreError('Fastify store options must be an object');
  }
  for (const option of ['continueExceeding', 'exponentialBackoff']) {
    const value: unknown = Reflect.get(options, option);
    if (value !== undefined && value !== false) {
      throw new RateLimitStoreError(
        `${option} is unsupported by the REST fixed-window store; keep it false`,
      );
    }
  }
  const capacity: unknown = Reflect.get(options, 'cache');
  if (capacity === undefined) return LIMITS.REST_RATE_LIMIT_CACHE_MAX_ENTRIES;
  if (typeof capacity !== 'number') {
    throw new RateLimitStoreError('cache must be a positive bounded integer');
  }
  return capacity;
}

function storeCallback(callback: StoreCallback, operation: () => StoreResult): void {
  let result: StoreResult;
  try {
    result = operation();
  } catch (error) {
    callback(error instanceof Error ? error : new RateLimitStoreError(String(error)));
    return;
  }
  // A consumer callback throwing is its own error, never a reason to call it twice.
  callback(null, result);
}

/**
 * @fastify/rate-limit 11.2.0 bridge over the production RateLimitStore backend. Fastify resolves
 * callable max/timeWindow before incr/read, and retains ownership of headers, bans and hooks.
 * Its constructor options omit the top-level cache setting, so the default capacity is the
 * contract constant; a child can request a smaller bounded cache explicitly.
 */
export class FastifyFixedWindowStore implements FastifyRateLimitStore {
  readonly #clock: Pick<Clock, 'now'>;
  readonly #store: InMemoryRateLimitStore;

  constructor(clock: Pick<Clock, 'now'>, options: unknown) {
    this.#clock = clock;
    this.#store = new InMemoryRateLimitStore(new Map(), storeCapacity(options));
  }

  incr(key: string, callback: StoreCallback, timeWindow: number, max: number): void {
    storeCallback(callback, () => {
      const now = this.#clock.now();
      const snapshot = this.#store.consumeResolved('rest', key, 1, now, {
        max,
        timeWindowMs: timeWindow,
      });
      return { current: snapshot.current, ttl: snapshot.resetAt - now };
    });
  }

  /** The pinned optional read API must neither spend a point nor start or renew a window. */
  read(key: string, callback: StoreCallback, timeWindow: number, max: number): void {
    storeCallback(callback, () => {
      const now = this.#clock.now();
      const snapshot = this.#store.readResolved('rest', key, now, {
        max,
        timeWindowMs: timeWindow,
      });
      return { current: snapshot.current, ttl: snapshot.resetAt - now };
    });
  }

  child(options: unknown): FastifyFixedWindowStore {
    return new FastifyFixedWindowStore(this.#clock, options);
  }
}

/** Bind the instance clock before handing Fastify its one-argument custom-store constructor. */
export function createRestRateLimitStore(clock: Pick<Clock, 'now'>): FastifyRateLimitStoreCtor {
  return class extends FastifyFixedWindowStore {
    constructor(options: unknown) {
      super(clock, options);
    }
  };
}
