/**
 * `auth.throttle.unit` (04-auth-and-access-control.md sections 3.7 and 10.2; D04-07): the pure
 * behaviour of the login throttle over in-memory limiters — five failures block, the block doubles
 * per prior block up to the cap, a success clears limiter A and the block counter but never limiter
 * B, the per-source day budget, and the key layout that keeps addresses out of the table.
 */
import { LIMITS } from '@iridium/contracts';
import { describe, expect, it } from 'vitest';

import { fakeDatabase } from '../../../test/support/fake-driver.ts';
import {
  accountSourceKey,
  blockSeconds,
  createMemoryLimiters,
  emailKeyHash,
  LoginThrottle,
  THROTTLE_PREFIX,
  type LoginThrottlePolicy,
  type ThrottleLimiter,
  type ThrottleVerdict,
} from './throttle.ts';

/** The plan's budgets (`LIMITS`), with a day budget small enough to spend in one test. */
const POLICY: LoginThrottlePolicy = {
  maxFailures: LIMITS.LOGIN_FAILURES_PER_ACCOUNT_SOURCE,
  blockBaseSeconds: LIMITS.LOGIN_BLOCK_BASE_SECONDS,
  blockMaxSeconds: LIMITS.LOGIN_BLOCK_MAX_SECONDS,
  sourcePerDay: 8,
};
const EMAIL = 'ada@example.test';
const IP = '203.0.113.7';

function throttle(policy: LoginThrottlePolicy = POLICY) {
  const limiters = createMemoryLimiters(policy);
  return { throttle: new LoginThrottle(limiters, policy, () => null), limiters };
}

/** The wait a refusal names, or `-1` for an allowance, so a bound is one unconditional assertion. */
function retryAfterOf(verdict: ThrottleVerdict): number {
  return verdict.allowed ? -1 : verdict.retryAfterMs;
}

async function failTimes(subject: LoginThrottle, times: number, ip: string = IP): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    // eslint-disable-next-line no-await-in-loop -- consecutive failures are sequential by definition
    await subject.recordFailure(EMAIL, ip);
  }
}

describe('auth.throttle.unit [area:auth]', () => {
  it('keys limiter A on the hashed address and the source, never on the address itself', () => {
    const key = accountSourceKey(EMAIL, IP);
    expect(key).toBe(`${emailKeyHash(EMAIL)}|${IP}`);
    expect(key).not.toContain('@');
    expect(emailKeyHash(EMAIL)).toMatch(/^[0-9a-f]{64}$/);
    expect(THROTTLE_PREFIX).toStrictEqual({
      accountSource: 'login',
      source: 'loginip',
      blocks: 'loginblocks',
    });
  });

  it('allows a fresh pair and counts failures without blocking below the threshold', async () => {
    const { throttle: subject } = throttle();
    await expect(subject.check(EMAIL, IP)).resolves.toStrictEqual({ allowed: true });
    const first = await subject.recordFailure(EMAIL, IP);
    expect(first).toStrictEqual({ attemptsInWindow: 1, blockedForMs: null });
    await failTimes(subject, 3);
    await expect(subject.check(EMAIL, IP)).resolves.toStrictEqual({ allowed: true });
  });

  it('blocks the pair on the fifth failure for the base duration, and reports it', async () => {
    const { throttle: subject } = throttle();
    await failTimes(subject, 4);
    const fifth = await subject.recordFailure(EMAIL, IP);
    expect(fifth).toStrictEqual({
      attemptsInWindow: 5,
      blockedForMs: POLICY.blockBaseSeconds * 1000,
    });
    const verdict = await subject.check(EMAIL, IP);
    expect(verdict).toMatchObject({ allowed: false, scope: 'account_source' });
    expect(retryAfterOf(verdict)).toBeGreaterThan(0);
    expect(retryAfterOf(verdict)).toBeLessThanOrEqual(POLICY.blockBaseSeconds * 1000);
  });

  it('does not lock the account from another source: the key is the pair', async () => {
    const { throttle: subject } = throttle();
    await failTimes(subject, 5);
    await expect(subject.check(EMAIL, '198.51.100.9')).resolves.toStrictEqual({ allowed: true });
  });

  it('doubles the block per prior block, capped at the maximum', async () => {
    expect(blockSeconds(0, POLICY)).toBe(900);
    expect(blockSeconds(1, POLICY)).toBe(1800);
    expect(blockSeconds(2, POLICY)).toBe(3600);
    expect(blockSeconds(6, POLICY)).toBe(57_600);
    expect(blockSeconds(7, POLICY)).toBe(86_400);
    expect(blockSeconds(20, POLICY)).toBe(86_400);

    const { throttle: subject, limiters } = throttle();
    await failTimes(subject, 5);
    // The block lapses (the window ends) but the block counter remembers it.
    await limiters.accountSource.delete(accountSourceKey(EMAIL, IP));
    await failTimes(subject, 4);
    const second = await subject.recordFailure(EMAIL, IP);
    expect(second.blockedForMs).toBe(1800 * 1000);
  });

  it('clears limiter A and the block counter on success, and limiter B never', async () => {
    const { throttle: subject, limiters } = throttle();
    await failTimes(subject, 5);
    await subject.recordSuccess(EMAIL, IP);
    await expect(subject.check(EMAIL, IP)).resolves.toStrictEqual({ allowed: true });
    await expect(limiters.blocks.get(accountSourceKey(EMAIL, IP))).resolves.toBeNull();
    // Limiter B kept its five failures: the source has used five of its eight.
    const source = await limiters.source.get(IP);
    expect(source?.consumedPoints).toBe(5);
    // A fresh block after a success starts again at the base duration.
    await failTimes(subject, 5);
    const again = await subject.check(EMAIL, IP);
    expect(again.allowed).toBe(false);
  });

  it('blocks every login from a source once its day budget is spent', async () => {
    const { throttle: subject } = throttle();
    await failTimes(subject, 5);
    await subject.recordSuccess(EMAIL, IP);
    await failTimes(subject, 3);
    const verdict = await subject.check('someone-else@example.test', IP);
    expect(verdict).toMatchObject({ allowed: false, scope: 'source' });
  });

  it('answers zero for the row maintenance when no database is connected', async () => {
    const { throttle: subject } = throttle();
    await expect(subject.clearAccount(EMAIL)).resolves.toBe(0);
    await expect(subject.sweepExpired(Date.now())).resolves.toBe(0);
  });

  it('clears an account across every source by hashed prefix, and sweeps ended windows, by row', async () => {
    const fake = fakeDatabase({ script: () => ({ numAffectedRows: 3n }) });
    const subject = new LoginThrottle(createMemoryLimiters(POLICY), POLICY, () => fake.db);
    await expect(subject.clearAccount(EMAIL)).resolves.toBe(3);
    const cleared = fake.executed[0];
    expect(cleared?.sql).toContain('delete from `login_throttle`');
    // Limiter A and the block counter of this account, any address; limiter B is left alone.
    expect(cleared?.parameters).toStrictEqual([
      `${THROTTLE_PREFIX.accountSource}:${emailKeyHash(EMAIL)}|%`,
      `${THROTTLE_PREFIX.blocks}:${emailKeyHash(EMAIL)}|%`,
    ]);
    expect(JSON.stringify(cleared?.parameters)).not.toContain('@');
    await expect(subject.sweepExpired(1_000)).resolves.toBe(3);
    expect(fake.executed[1]?.sql).toContain('`expire` is not null');
    expect(fake.executed[1]?.parameters).toStrictEqual([1_000]);
  });

  it('rethrows a store failure that is not a throttle answer', async () => {
    const limiters = createMemoryLimiters(POLICY);
    const base = limiters.accountSource;
    const failing: ThrottleLimiter = {
      get: (key) => base.get(key),
      consume: () => Promise.reject(new Error('store down')),
      block: (key, seconds) => base.block(key, seconds),
      penalty: (key, points) => base.penalty(key, points),
      delete: (key) => base.delete(key),
    };
    const broken = new LoginThrottle({ ...limiters, accountSource: failing }, POLICY, () => null);
    await expect(broken.recordFailure(EMAIL, IP)).rejects.toThrow('store down');
  });
});
