import { LIMITS } from '@iridium/contracts';
import { describe, expect, it } from 'vitest';

import { ManualClock } from '../../test/support/manual-clock.ts';
import {
  InMemoryRateLimitStore,
  RateLimitStoreError,
  type FixedWindowPolicy,
} from './rate-limit-store.ts';
import { FastifyFixedWindowStore } from './rate-limits.ts';

const POLICY: FixedWindowPolicy = { max: 3, timeWindowMs: 2_000 };

function memory(
  maxEntries: number = LIMITS.REST_RATE_LIMIT_CACHE_MAX_ENTRIES,
): InMemoryRateLimitStore {
  return new InMemoryRateLimitStore(new Map([['requests', POLICY]]), maxEntries);
}

function call(
  store: FastifyFixedWindowStore,
  operation: 'incr' | 'read',
  key = 'client',
  timeWindow = POLICY.timeWindowMs,
  max = POLICY.max,
): Promise<{ current: number; ttl: number }> {
  return new Promise((resolve, reject) => {
    store[operation](
      key,
      (error, result) => {
        if (error !== null) reject(error);
        else if (result === undefined) reject(new Error('store returned no counter result'));
        else resolve(result);
      },
      timeWindow,
      max,
    );
  });
}

describe('security.rate-limit-store.unit [area:security]', () => {
  it('counts weighted and refused attempts in the same fixed window', async () => {
    const store = memory();
    expect(await store.consume('requests', 'client', 2, 1_000)).toEqual({
      allowed: true,
      remaining: 1,
      resetAt: 3_000,
    });
    expect(await store.consume('requests', 'client', 2, 1_500)).toEqual({
      allowed: false,
      remaining: 0,
      resetAt: 3_000,
    });
    expect(store.readResolved('requests', 'client', 1_500, POLICY)).toEqual({
      current: 4,
      resetAt: 3_000,
    });
    expect(await store.consume('requests', 'client', 1, 2_999)).toEqual({
      allowed: false,
      remaining: 0,
      resetAt: 3_000,
    });
    expect(await store.consume('requests', 'client', 1, 3_000)).toEqual({
      allowed: true,
      remaining: 2,
      resetAt: 5_000,
    });
  });

  it('does not duplicate remaining points when consumes are issued concurrently', async () => {
    const store = memory();
    const decisions = await Promise.all(
      Array.from({ length: 20 }, () => store.consume('requests', 'client', 1, 1_000)),
    );
    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(POLICY.max);
    expect(store.readResolved('requests', 'client', 1_000, POLICY).current).toBe(20);
  });

  it('uses collision-free bucket and key identities, including delimiter-containing names', async () => {
    const store = new InMemoryRateLimitStore(
      new Map([
        ['a', POLICY],
        ['a:b', POLICY],
        ['a\u0000b', POLICY],
      ]),
    );
    await store.consume('a', 'b:c', POLICY.max, 1_000);
    await store.consume('a', 'b\u0000c', POLICY.max, 1_000);
    expect(await store.consume('a:b', 'c', 1, 1_000)).toMatchObject({
      allowed: true,
      remaining: 2,
    });
    expect(await store.consume('a\u0000b', 'c', 1, 1_000)).toMatchObject({
      allowed: true,
      remaining: 2,
    });
  });

  it('resets only the named counter and can reset an absent key repeatedly', async () => {
    const store = new InMemoryRateLimitStore(
      new Map([
        ['first', POLICY],
        ['second', POLICY],
      ]),
    );
    await store.consume('first', 'client', POLICY.max, 1_000);
    await store.consume('first', 'other', POLICY.max, 1_000);
    await store.consume('second', 'client', POLICY.max, 1_000);
    await store.reset('first', 'client');
    await store.reset('first', 'client');
    expect(await store.consume('first', 'client', 1, 1_500)).toEqual({
      allowed: true,
      remaining: 2,
      resetAt: 3_500,
    });
    expect(await store.consume('first', 'other', 1, 1_500)).toMatchObject({ allowed: false });
    expect(await store.consume('second', 'client', 1, 1_500)).toMatchObject({ allowed: false });
  });

  it('copies policy inputs so a caller cannot change a live budget through its original map', async () => {
    const policy = { ...POLICY };
    const policies = new Map([['requests', policy]]);
    const store = new InMemoryRateLimitStore(policies);
    policy.max = 1_000;
    policies.clear();
    expect(await store.consume('requests', 'client', POLICY.max + 1, 1_000)).toMatchObject({
      allowed: false,
    });
  });

  it('reads missing and expired keys without allocating or renewing a window', async () => {
    const store = memory();
    expect(store.readResolved('requests', 'absent', 1_000, POLICY)).toEqual({
      current: 0,
      resetAt: 1_000,
    });
    expect(store.size).toBe(0);
    await store.consume('requests', 'client', 2, 1_000);
    expect(store.readResolved('requests', 'client', 1_750, POLICY)).toEqual({
      current: 2,
      resetAt: 3_000,
    });
    expect(store.readResolved('requests', 'client', 3_000, POLICY)).toEqual({
      current: 0,
      resetAt: 3_000,
    });
    expect(store.size).toBe(1);
    expect(store.readResolved('requests', 'client', 3_500, POLICY)).toEqual({
      current: 0,
      resetAt: 3_500,
    });
    expect(await store.consume('requests', 'client', 1, 4_000)).toEqual({
      allowed: true,
      remaining: 2,
      resetAt: 6_000,
    });
  });

  it('evicts the least-recently-used key and treats a read as an access without spending a point', async () => {
    const store = memory(2);
    await store.consume('requests', 'a', 1, 1_000);
    await store.consume('requests', 'b', 2, 1_000);
    expect(store.readResolved('requests', 'a', 1_100, POLICY).current).toBe(1);
    await store.consume('requests', 'c', 1, 1_100);
    expect(store.size).toBe(2);
    expect(store.readResolved('requests', 'b', 1_100, POLICY).current).toBe(0);
    expect(store.readResolved('requests', 'a', 1_100, POLICY).current).toBe(1);
    expect(store.readResolved('requests', 'c', 1_100, POLICY).current).toBe(1);
  });

  it('bounds the production default at exactly the registered cache capacity', () => {
    expect(LIMITS.REST_RATE_LIMIT_CACHE_MAX_ENTRIES).toBe(5_000);
    const store = memory();
    for (let index = 0; index <= LIMITS.REST_RATE_LIMIT_CACHE_MAX_ENTRIES; index += 1) {
      store.consumeResolved('requests', String(index), 1, 1_000, POLICY);
    }
    expect(store.size).toBe(LIMITS.REST_RATE_LIMIT_CACHE_MAX_ENTRIES);
    expect(store.readResolved('requests', '0', 1_000, POLICY).current).toBe(0);
    expect(store.readResolved('requests', '1', 1_000, POLICY).current).toBe(1);
  });

  it.each([0, -1, 1.5, NaN, Infinity, LIMITS.REST_RATE_LIMIT_CACHE_MAX_ENTRIES + 1])(
    'refuses invalid or unbounded cache capacity %s',
    (capacity) => {
      expect(() => memory(capacity)).toThrow(/cache must be an integer between/);
    },
  );

  it.each([
    { max: -1, timeWindowMs: 1_000 },
    { max: Infinity, timeWindowMs: 1_000 },
    { max: 1.5, timeWindowMs: 1_000 },
    { max: 1, timeWindowMs: -1 },
    { max: 1, timeWindowMs: NaN },
  ])('rejects invalid policies before admitting counters: %j', (policy) => {
    expect(() => new InMemoryRateLimitStore(new Map([['requests', policy]]))).toThrow(
      RateLimitStoreError,
    );
  });

  it('refuses an unknown generic bucket instead of inventing an unlimited policy', async () => {
    const store = memory();
    await expect(store.consume('missing', 'client', 1, 1_000)).rejects.toThrow(/unknown bucket/);
    expect(store.size).toBe(0);
  });

  it.each([0, -1, 0.5, NaN, Infinity])(
    'rejects invalid points %s without resetting the existing count',
    async (points) => {
      const store = memory();
      await store.consume('requests', 'client', 1, 1_000);
      await expect(store.consume('requests', 'client', points, 1_100)).rejects.toThrow(
        /points must be/,
      );
      expect(store.readResolved('requests', 'client', 1_100, POLICY).current).toBe(1);
    },
  );

  it('fails closed on counter overflow rather than wrapping or refunding a point', () => {
    const store = memory();
    store.consumeResolved('requests', 'client', Number.MAX_SAFE_INTEGER, 1_000, POLICY);
    expect(() => store.consumeResolved('requests', 'client', 1, 1_100, POLICY)).toThrow(
      /counter must be/,
    );
    expect(store.readResolved('requests', 'client', 1_100, POLICY).current).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });

  it('rejects invalid clock values and unrepresentable expiry before allocating a counter', () => {
    const store = memory();
    expect(() => store.consumeResolved('requests', 'client', 1, -1, POLICY)).toThrow(/now must be/);
    expect(() => store.readResolved('requests', 'client', NaN, POLICY)).toThrow(/now must be/);
    expect(() =>
      store.consumeResolved('requests', 'client', 1, Number.MAX_SAFE_INTEGER, POLICY),
    ).toThrow(/resetAt must be/);
    expect(store.size).toBe(0);
  });

  it('preserves zero-budget and zero-window fixed-window behavior', () => {
    const store = memory();
    const policy = { max: 0, timeWindowMs: 0 };
    expect(store.consumeResolved('requests', 'client', 1, 1_000, policy)).toEqual({
      current: 1,
      resetAt: 1_000,
    });
    expect(store.consumeResolved('requests', 'client', 1, 1_000, policy)).toEqual({
      current: 1,
      resetAt: 1_000,
    });
    expect(store.readResolved('requests', 'client', 1_000, policy)).toEqual({
      current: 0,
      resetAt: 1_000,
    });
  });

  it('bridges resolved dynamic limits without splitting counts, and uses the passed time window', async () => {
    const clock = new ManualClock(1_000);
    const store = new FastifyFixedWindowStore(clock, {});
    expect(await call(store, 'incr', 'client', 2_000, 2)).toEqual({ current: 1, ttl: 2_000 });
    clock.jump(1_500);
    expect(await call(store, 'incr', 'client', 2_000, 1)).toEqual({ current: 2, ttl: 1_500 });
    expect(await call(store, 'incr', 'client', 2_000, 4)).toEqual({ current: 3, ttl: 1_500 });
    expect(await call(store, 'read', 'client', 4_000, 4)).toEqual({ current: 3, ttl: 3_500 });
    clock.jump(3_000);
    expect(await call(store, 'read')).toEqual({ current: 0, ttl: 0 });
    clock.jump(4_000);
    expect(await call(store, 'incr')).toEqual({ current: 1, ttl: 2_000 });
  });

  it('gives every child independent counters and cache pressure while sharing the injected clock', async () => {
    const clock = new ManualClock(1_000);
    const parent = new FastifyFixedWindowStore(clock, { cache: 2 });
    const first = parent.child({ cache: 1 });
    const second = parent.child({ cache: 1 });
    await call(parent, 'incr');
    await call(first, 'incr');
    await call(first, 'incr');
    expect(await call(second, 'incr')).toEqual({ current: 1, ttl: 2_000 });
    await call(first, 'incr', 'another-key');
    expect(await call(first, 'read')).toEqual({ current: 0, ttl: 0 });
    expect(await call(parent, 'read')).toEqual({ current: 1, ttl: 2_000 });
    expect(await call(second, 'read')).toEqual({ current: 1, ttl: 2_000 });
    clock.jump(3_000);
    expect(await call(parent, 'read')).toEqual({ current: 0, ttl: 0 });
    expect(await call(second, 'read')).toEqual({ current: 0, ttl: 0 });
  });

  it.each([
    { continueExceeding: true },
    { exponentialBackoff: true },
    { continueExceeding: 'false' },
    { cache: 0 },
    { cache: '5000' },
    null,
  ])('fails visibly for unsupported Fastify store options %j', (options) => {
    const clock = new ManualClock();
    expect(() => new FastifyFixedWindowStore(clock, options)).toThrow(RateLimitStoreError);
    const parent = new FastifyFixedWindowStore(clock, {});
    expect(() => parent.child(options)).toThrow(RateLimitStoreError);
  });

  it('returns backend errors through the pinned callback API without admitting a request', async () => {
    const clock = new ManualClock(1_000);
    const store = new FastifyFixedWindowStore(clock, {
      continueExceeding: false,
      exponentialBackoff: false,
    });
    await expect(call(store, 'incr', 'client', -1)).rejects.toThrow(/timeWindowMs must be/);
    await expect(call(store, 'read', 'client', 2_000, NaN)).rejects.toThrow(/max must be/);
    expect(await call(store, 'incr')).toEqual({ current: 1, ttl: 2_000 });
  });

  it('forwards a clock failure and invokes a throwing consumer callback only once', async () => {
    const failure = new Error('clock failed');
    const broken = new FastifyFixedWindowStore(
      {
        now() {
          throw failure;
        },
      },
      {},
    );
    await expect(call(broken, 'incr')).rejects.toBe(failure);
    const nonError = new FastifyFixedWindowStore(
      {
        now() {
          throw 'clock failed';
        },
      },
      {},
    );
    await expect(call(nonError, 'read')).rejects.toThrow(/clock failed/);
    const store = new FastifyFixedWindowStore(new ManualClock(), {});
    let calls = 0;
    expect(() =>
      store.incr(
        'client',
        () => {
          calls += 1;
          throw failure;
        },
        2_000,
        3,
      ),
    ).toThrow(failure);
    expect(calls).toBe(1);
  });
});
