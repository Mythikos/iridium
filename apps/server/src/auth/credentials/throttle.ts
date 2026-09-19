/**
 * Login throttling (04-auth-and-access-control.md sections 3.7 and 10.2; D04-07; A8).
 *
 * Three `rate-limiter-flexible` 11.2.0 limiters over one `login_throttle` table:
 *
 *  | limiter | prefix        | key                    | budget                          |
 *  |---------|---------------|------------------------|---------------------------------|
 *  | A       | `login`       | `<email hash>\|<ip>`   | 5 failures / 24 h, then a block |
 *  | B       | `loginip`     | `<ip>`                 | 100 failures / day              |
 *  | blocks  | `loginblocks` | `<email hash>\|<ip>`   | counts prior blocks (24 h)      |
 *
 * After the fifth consecutive failure limiter A blocks the key for `900 · 2^(n-1)` seconds, capped
 * at 24 h, where `n` counts the blocks already applied to that key. Keys are read before the
 * password is verified, consumed only on failure, and limiter A plus the block counter are deleted
 * on success; limiter B is never cleared by a success. Keying A on `email|ip` rather than on the
 * account alone means an attacker cannot lock a legitimate user out from the user's own network.
 *
 * The email half of a key is `SHA-256(email_key)` in hex: it keeps every key inside the column's
 * 191 bytes (03-data-model.md section 3) and keeps third-party addresses out of the table, while an
 * administrator reset can still clear every source for one account by prefix (`clearAccount`).
 *
 * `RateLimiterMySQL` is constructed with `tableCreated: true` so it never issues DDL under the
 * `iridium_app` role (A8) and with an in-memory insurance limiter, which keeps throttling working —
 * fail-closed in the sense that matters — while MySQL is briefly unavailable (section 10.2).
 */
import { createHash } from 'node:crypto';

import type { Kysely } from 'kysely';
import { RateLimiterMemory, RateLimiterMySQL, RateLimiterRes } from 'rate-limiter-flexible';

import type { Database } from '../../db/index.ts';
import { createThrottleStoreClient, type DbSource } from './throttle-store.ts';

/** `login_throttle`, created by migration `0005`. */
export const LOGIN_THROTTLE_TABLE = 'login_throttle';

/** The three key prefixes of section 10.1, as the rows are stored (`<prefix>:<key>`). */
export const THROTTLE_PREFIX = Object.freeze({
  accountSource: 'login',
  source: 'loginip',
  blocks: 'loginblocks',
});

/** The window limiters A and B count over (section 3.7: "24 h", "per day") — a unit, not a limit. */
const SECONDS_PER_DAY = 24 * 60 * 60;
const MS_PER_SECOND = 1000;

/** The subset of a `rate-limiter-flexible` limiter the throttle drives; any store implements it. */
export interface ThrottleLimiter {
  get(key: string): Promise<RateLimiterRes | null>;
  consume(key: string, points?: number): Promise<RateLimiterRes>;
  block(key: string, secDuration: number): Promise<RateLimiterRes>;
  penalty(key: string, points?: number): Promise<RateLimiterRes>;
  delete(key: string): Promise<boolean>;
}

/** The three limiters, injected so the unit test can hand in in-memory ones. */
export interface LoginThrottleLimiters {
  readonly accountSource: ThrottleLimiter;
  readonly source: ThrottleLimiter;
  readonly blocks: ThrottleLimiter;
}

/** The numbers, read from configuration (their defaults are the `LIMITS` members). */
export interface LoginThrottlePolicy {
  /** `LOGIN_THROTTLE_MAX_FAILURES`, default `LIMITS.LOGIN_FAILURES_PER_ACCOUNT_SOURCE`. */
  readonly maxFailures: number;
  /** `LOGIN_THROTTLE_BLOCK_MIN` in seconds, default `LIMITS.LOGIN_BLOCK_BASE_SECONDS`. */
  readonly blockBaseSeconds: number;
  /** `LIMITS.LOGIN_BLOCK_MAX_SECONDS`. */
  readonly blockMaxSeconds: number;
  /** `LOGIN_THROTTLE_IP_PER_DAY`, default `LIMITS.LOGIN_FAILURES_PER_IP_PER_DAY`. */
  readonly sourcePerDay: number;
}

/** What `check()` answers before any password work happens. */
export type ThrottleVerdict =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      /** Which budget refused: the account+source pair, or the source alone. */
      readonly scope: 'account_source' | 'source';
      readonly retryAfterMs: number;
    };

/** What `recordFailure()` reports, for the bounded `user.login.failed` audit row. */
export interface FailureRecord {
  /** Failures counted against the pair in the current window, this one included. */
  readonly attemptsInWindow: number;
  /** The block this failure applied, in milliseconds, or `null` when none was applied. */
  readonly blockedForMs: number | null;
}

/** `SHA-256(email_key)` in hex — the account half of a key. */
export function emailKeyHash(emailKey: string): string {
  return createHash('sha256').update(emailKey, 'utf8').digest('hex');
}

/** `<email hash>|<ip>`, before the limiter adds its prefix. */
export function accountSourceKey(emailKey: string, ip: string): string {
  return `${emailKeyHash(emailKey)}|${ip}`;
}

/** The block length after `n` prior blocks: `base · 2^(n)`, capped (section 10.2). */
export function blockSeconds(priorBlocks: number, policy: LoginThrottlePolicy): number {
  return Math.min(policy.blockBaseSeconds * 2 ** priorBlocks, policy.blockMaxSeconds);
}

/**
 * `consume()` rejects with a `RateLimiterRes` once the budget is exceeded and with an `Error` when
 * the store failed without insurance; only the first is a throttle answer.
 */
async function consumeOrResult(limiter: ThrottleLimiter, key: string): Promise<RateLimiterRes> {
  try {
    return await limiter.consume(key);
  } catch (error) {
    if (error instanceof RateLimiterRes) return error;
    throw error;
  }
}

/** The login throttle. One instance per process, owned by the auth plugin. */
export class LoginThrottle {
  readonly #limiters: LoginThrottleLimiters;
  readonly #policy: LoginThrottlePolicy;
  readonly #db: DbSource;

  constructor(limiters: LoginThrottleLimiters, policy: LoginThrottlePolicy, db: DbSource) {
    this.#limiters = limiters;
    this.#policy = policy;
    this.#db = db;
  }

  /** Step 4 of the login path: read both budgets before any password work. */
  async check(emailKey: string, ip: string): Promise<ThrottleVerdict> {
    const pair = await this.#limiters.accountSource.get(accountSourceKey(emailKey, ip));
    if (pair !== null && pair.remainingPoints <= 0) {
      return { allowed: false, scope: 'account_source', retryAfterMs: pair.msBeforeNext };
    }
    const source = await this.#limiters.source.get(ip);
    if (source !== null && source.remainingPoints <= 0) {
      return { allowed: false, scope: 'source', retryAfterMs: source.msBeforeNext };
    }
    return { allowed: true };
  }

  /** Step 7: consume both budgets and, when limiter A is exhausted, apply the doubling block. */
  async recordFailure(emailKey: string, ip: string): Promise<FailureRecord> {
    const key = accountSourceKey(emailKey, ip);
    const [pair] = await Promise.all([
      consumeOrResult(this.#limiters.accountSource, key),
      consumeOrResult(this.#limiters.source, ip),
    ]);
    if (pair.remainingPoints > 0) {
      return { attemptsInWindow: pair.consumedPoints, blockedForMs: null };
    }
    const prior = await this.#limiters.blocks.penalty(key);
    // `penalty` returns the count after this increment; the first block is `n = 1`, so the prior
    // count is one less and the first block is exactly the base duration.
    const seconds = blockSeconds(prior.consumedPoints - 1, this.#policy);
    await this.#limiters.accountSource.block(key, seconds);
    return { attemptsInWindow: pair.consumedPoints, blockedForMs: seconds * MS_PER_SECOND };
  }

  /** Step 8: a success clears limiter A and the block counter; limiter B is never cleared. */
  async recordSuccess(emailKey: string, ip: string): Promise<void> {
    const key = accountSourceKey(emailKey, ip);
    await Promise.all([
      this.#limiters.accountSource.delete(key),
      this.#limiters.blocks.delete(key),
    ]);
  }

  /**
   * Clears limiter A and the block counter for one account across every source — the
   * administrator reset of section 3.3 (D04-07). Rows only; the in-memory insurance keys expire
   * on their own. Answers the number of rows removed.
   */
  async clearAccount(emailKey: string, executor?: Kysely<Database>): Promise<number> {
    const db = executor ?? this.#db();
    if (db === null) return 0;
    const hash = emailKeyHash(emailKey);
    const result = await db
      .deleteFrom(LOGIN_THROTTLE_TABLE)
      .where((expression) =>
        expression.or([
          expression('key', 'like', `${THROTTLE_PREFIX.accountSource}:${hash}|%`),
          expression('key', 'like', `${THROTTLE_PREFIX.blocks}:${hash}|%`),
        ]),
      )
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }

  /**
   * Removes rows whose window has ended. Exposed for a maintenance job rather than run on the
   * library's own timer, so every background task in the process has an owner (10, "Concurrency").
   */
  async sweepExpired(nowMs: number): Promise<number> {
    const db = this.#db();
    if (db === null) return 0;
    const result = await db
      .deleteFrom(LOGIN_THROTTLE_TABLE)
      .where('expire', 'is not', null)
      .where('expire', '<', nowMs)
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }
}

/** The three in-memory limiters as concrete instances, so they also serve as insurance limiters. */
export interface MemoryThrottleLimiters extends LoginThrottleLimiters {
  readonly accountSource: RateLimiterMemory;
  readonly source: RateLimiterMemory;
  readonly blocks: RateLimiterMemory;
}

/** The three in-memory limiters, for the unit test and as the insurance behind the MySQL ones. */
export function createMemoryLimiters(policy: LoginThrottlePolicy): MemoryThrottleLimiters {
  return {
    accountSource: new RateLimiterMemory({
      keyPrefix: THROTTLE_PREFIX.accountSource,
      points: policy.maxFailures,
      duration: SECONDS_PER_DAY,
    }),
    source: new RateLimiterMemory({
      keyPrefix: THROTTLE_PREFIX.source,
      points: policy.sourcePerDay,
      duration: SECONDS_PER_DAY,
    }),
    blocks: new RateLimiterMemory({
      keyPrefix: THROTTLE_PREFIX.blocks,
      points: Number.MAX_SAFE_INTEGER,
      duration: SECONDS_PER_DAY,
    }),
  };
}

/** What the MySQL-backed throttle needs from the database layer. */
export interface MysqlThrottleOptions {
  /** The `dbApp` instance, read per acquisition so a late connection is picked up. */
  readonly db: () => Kysely<Database> | null;
  /** The schema the `login_throttle` table lives in (the app URL's database). */
  readonly schema: string;
  /** The configured budgets; the plugin derives them from `LOGIN_THROTTLE_*` (11, configuration). */
  readonly policy: LoginThrottlePolicy;
}

/** The production throttle: `RateLimiterMySQL` on `login_throttle` with memory insurance. */
export function createMysqlLoginThrottle(options: MysqlThrottleOptions): LoginThrottle {
  const { policy } = options;
  const insurance = createMemoryLimiters(policy);
  const storeClient = createThrottleStoreClient(options.db);
  const shared = {
    storeClient,
    storeType: 'pool',
    dbName: options.schema,
    tableName: LOGIN_THROTTLE_TABLE,
    tableCreated: true,
    clearExpiredByTimeout: false,
  };
  return new LoginThrottle(
    {
      accountSource: new RateLimiterMySQL({
        ...shared,
        keyPrefix: THROTTLE_PREFIX.accountSource,
        points: policy.maxFailures,
        duration: SECONDS_PER_DAY,
        insuranceLimiter: insurance.accountSource,
      }),
      source: new RateLimiterMySQL({
        ...shared,
        keyPrefix: THROTTLE_PREFIX.source,
        points: policy.sourcePerDay,
        duration: SECONDS_PER_DAY,
        insuranceLimiter: insurance.source,
      }),
      blocks: new RateLimiterMySQL({
        ...shared,
        keyPrefix: THROTTLE_PREFIX.blocks,
        points: Number.MAX_SAFE_INTEGER,
        duration: SECONDS_PER_DAY,
        insuranceLimiter: insurance.blocks,
      }),
    },
    policy,
    options.db,
  );
}
