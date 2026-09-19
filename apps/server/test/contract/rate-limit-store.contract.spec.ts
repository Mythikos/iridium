/**
 * ARCH-19's parameterised RateLimitStore contract, plus the actual REST plugin binding. The MVP
 * binding is a bounded fixed window: refused attempts cost points and never postpone refill.
 * Every expiry, header and reset assertion uses the injected clock, without sleeps or I/O mocks.
 */
import { LIMITS } from '@iridium/contracts';
import Fastify, { type FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config/env.ts';
import { applySecurityPlugin } from '../../src/security/plugin.ts';
import {
  InMemoryRateLimitStore,
  type FixedWindowPolicy,
  type RateLimitStore,
} from '../../src/security/rate-limit-store.ts';
import { LOGIN_RATE_LIMIT_POLICY } from '../../src/security/rate-limits.ts';
import { ManualClock } from '../support/manual-clock.ts';

const WINDOW_MS = 60_000;
const POLICY: FixedWindowPolicy = { max: 5, timeWindowMs: WINDOW_MS };
const POLICIES: ReadonlyMap<string, FixedWindowPolicy> = new Map([
  ['first', POLICY],
  ['second', POLICY],
]);

interface Implementation {
  readonly name: string;
  create(policies: ReadonlyMap<string, FixedWindowPolicy>): RateLimitStore;
}

const IMPLEMENTATIONS: readonly Implementation[] = [
  { name: 'InMemoryRateLimitStore', create: (policies) => new InMemoryRateLimitStore(policies) },
];
const HOST = '127.0.0.1:4000';

async function withRestPlugin(
  run: (app: FastifyInstance, clock: ManualClock) => Promise<void>,
): Promise<void> {
  const clock = new ManualClock();
  const app = Fastify({ logger: false });
  app.decorate('clock', clock);
  try {
    await applySecurityPlugin(app, {
      config: loadConfig({
        NODE_ENV: 'test',
        PUBLIC_ORIGIN: `http://${HOST}`,
        DATABASE_URL: 'mysql://unused:unused@127.0.0.1:3306/unused',
      }),
    });
    // This contract owns only the security plugin. Authentication's existing wire suites prove
    // credential verification; this fixture supplies the same principalKey seam before the route hook.
    app.addHook('onRequest', async (request) => {
      const principal = request.headers['x-contract-principal'];
      request.principalKey = typeof principal === 'string' ? principal : null;
    });
    for (const path of ['/__test__/global-a', '/__test__/global-b']) {
      app.get(path, { config: { auth: 'test-only' } }, async () => ({ ok: true }));
    }
    for (const path of ['/__test__/login-a', '/__test__/login-b']) {
      app.post(
        path,
        { config: { auth: 'test-only', rateLimit: LOGIN_RATE_LIMIT_POLICY } },
        async () => ({ ok: true }),
      );
    }
    app.get('/healthz', { config: { auth: 'test-only' } }, async () => ({ ok: true }));
    const globalLimiter = app.createRateLimit();
    app.get('/__test__/peek', { config: { auth: 'test-only', rateLimit: false } }, (request) =>
      globalLimiter(request, { increment: false }),
    );
    app.post(
      '/__test__/dynamic',
      {
        config: {
          auth: 'test-only',
          rateLimit: {
            max: (request) => Number(request.headers['x-contract-max']),
            timeWindow: 2_000,
            keyGenerator: () => 'the-same-key',
          },
        },
      },
      async () => ({ ok: true }),
    );
    await app.ready();
    await run(app, clock);
  } finally {
    await app.close();
  }
}

async function spend(
  app: FastifyInstance,
  count: number,
  url: string,
  options: {
    readonly principal?: string;
    readonly ip?: string;
    readonly method?: 'GET' | 'POST';
  } = {},
): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    // eslint-disable-next-line no-await-in-loop -- the refusal boundary belongs to the next sequential request
    const response = await app.inject({
      method: options.method ?? 'GET',
      url,
      remoteAddress: options.ip ?? '127.0.0.1',
      headers: {
        host: HOST,
        ...(options.principal === undefined ? {} : { 'x-contract-principal': options.principal }),
      },
    });
    expect(response.statusCode, `${url} request ${String(index + 1)} of ${String(count)}`).toBe(
      200,
    );
  }
}

describe('rate-limit-store.contract [area:seams]', () => {
  describe.each(IMPLEMENTATIONS)('$name', (implementation) => {
    let store: RateLimitStore;
    let clock: ManualClock;
    beforeEach(() => {
      clock = new ManualClock();
      store = implementation.create(POLICIES);
    });

    it('permits exactly the weighted burst and reports the fixed refill instant on refusal', async () => {
      const resetAt = clock.now() + WINDOW_MS;
      expect(await store.consume('first', 'client', 3, clock.now())).toEqual({
        allowed: true,
        remaining: 2,
        resetAt,
      });
      expect(await store.consume('first', 'client', 2, clock.now())).toEqual({
        allowed: true,
        remaining: 0,
        resetAt,
      });
      clock.jump(clock.now() + 1_234);
      expect(await store.consume('first', 'client', 1, clock.now())).toEqual({
        allowed: false,
        remaining: 0,
        resetAt,
      });
      expect(resetAt - clock.now()).toBe(58_766);
    });

    it('refills at the exact deadline even after repeated refused attempts', async () => {
      const resetAt = clock.now() + WINDOW_MS;
      await store.consume('first', 'client', POLICY.max, clock.now());
      clock.jump(resetAt - 1);
      expect(await store.consume('first', 'client', 1, clock.now())).toEqual({
        allowed: false,
        remaining: 0,
        resetAt,
      });
      clock.jump(resetAt);
      expect(await store.consume('first', 'client', 1, clock.now())).toEqual({
        allowed: true,
        remaining: POLICY.max - 1,
        resetAt: resetAt + WINDOW_MS,
      });
    });

    it('isolates keys and buckets and resets only the requested tuple', async () => {
      await store.consume('first', 'client', POLICY.max, clock.now());
      await store.consume('first', 'other', POLICY.max, clock.now());
      expect(await store.consume('second', 'client', 1, clock.now())).toMatchObject({
        allowed: true,
        remaining: POLICY.max - 1,
      });
      await store.reset('first', 'client');
      await store.reset('first', 'client');
      expect(await store.consume('first', 'client', 1, clock.now())).toMatchObject({
        allowed: true,
        remaining: POLICY.max - 1,
      });
      expect(await store.consume('first', 'other', 1, clock.now())).toMatchObject({
        allowed: false,
        remaining: 0,
      });
      expect(await store.consume('second', 'client', 1, clock.now())).toMatchObject({
        allowed: true,
        remaining: POLICY.max - 2,
      });
    });

    it('reserves each point once under concurrent consumption', async () => {
      const decisions = await Promise.all(
        Array.from({ length: POLICY.max * 2 }, () =>
          store.consume('first', 'client', 1, clock.now()),
        ),
      );
      expect(decisions.filter((decision) => decision.allowed)).toHaveLength(POLICY.max);
      expect(decisions.filter((decision) => !decision.allowed)).toHaveLength(POLICY.max);
      expect(new Set(decisions.map((decision) => decision.resetAt))).toEqual(
        new Set([clock.now() + WINDOW_MS]),
      );
    });
  });

  describe('production Fastify binding', () => {
    it('uses the injected clock for shared global quotas, ProblemDetails and Retry-After rounding', async () => {
      await withRestPlugin(async (app, clock) => {
        await spend(app, LIMITS.REST_UNAUTHENTICATED_PER_MINUTE, '/__test__/global-a');
        clock.jump(clock.now() + 1_234);
        const refused = await app.inject({
          method: 'GET',
          url: '/__test__/global-b',
          headers: { host: HOST },
        });
        expect(refused.statusCode).toBe(429);
        expect(refused.headers['content-type']).toContain('application/problem+json');
        expect(refused.headers['x-ratelimit-limit']).toBe(
          String(LIMITS.REST_UNAUTHENTICATED_PER_MINUTE),
        );
        expect(refused.headers['x-ratelimit-remaining']).toBe('0');
        expect(refused.headers['x-ratelimit-reset']).toBe('59');
        expect(refused.headers['retry-after']).toBe('59');
        expect(refused.json()).toMatchObject({
          code: 'rate_limited',
          status: 429,
          retryAfterMs: 58_766,
          requestId: refused.headers['x-request-id'],
        });
        clock.jump(clock.now() + 58_765);
        const lastMillisecond = await app.inject({
          method: 'GET',
          url: '/__test__/global-a',
          headers: { host: HOST },
        });
        expect(lastMillisecond.statusCode).toBe(429);
        expect(lastMillisecond.headers['retry-after']).toBe('1');
        expect(lastMillisecond.json()).toMatchObject({ retryAfterMs: 1 });
        clock.jump(clock.now() + 1);
        const renewed = await app.inject({
          method: 'GET',
          url: '/__test__/global-b',
          headers: { host: HOST },
        });
        expect(renewed.statusCode).toBe(200);
        expect(renewed.headers['x-ratelimit-remaining']).toBe(
          String(LIMITS.REST_UNAUTHENTICATED_PER_MINUTE - 1),
        );
        expect(renewed.headers['x-ratelimit-reset']).toBe('60');
      });
    });

    it('keeps each credential route independent from other routes, the global quota and other peers', async () => {
      await withRestPlugin(async (app) => {
        await spend(app, LIMITS.LOGIN_PER_MINUTE_PER_IP, '/__test__/login-a', { method: 'POST' });
        const refused = await app.inject({
          method: 'POST',
          url: '/__test__/login-a',
          headers: { host: HOST, 'x-contract-principal': 'ses:one' },
        });
        expect(refused.statusCode).toBe(429);
        expect(refused.headers['x-ratelimit-limit']).toBe(String(LIMITS.LOGIN_PER_MINUTE_PER_IP));
        await spend(app, LIMITS.LOGIN_PER_MINUTE_PER_IP, '/__test__/login-b', { method: 'POST' });
        await spend(app, 1, '/__test__/login-a', { method: 'POST', ip: '127.0.0.2' });
        await spend(app, LIMITS.REST_UNAUTHENTICATED_PER_MINUTE, '/__test__/global-a');
        const globalRefused = await app.inject({
          method: 'GET',
          url: '/__test__/global-a',
          headers: { host: HOST },
        });
        expect(globalRefused.statusCode).toBe(429);
        const health = await app.inject({
          method: 'GET',
          url: '/healthz',
          headers: { host: HOST },
        });
        expect(health.statusCode).toBe(200);
      });
    });

    it('uses the authenticated quota and separates principals from one another and their peer IP', async () => {
      await withRestPlugin(async (app) => {
        await spend(app, LIMITS.REST_AUTHENTICATED_PER_MINUTE, '/__test__/global-a', {
          principal: 'ses:one',
        });
        const refused = await app.inject({
          method: 'GET',
          url: '/__test__/global-b',
          headers: { host: HOST, 'x-contract-principal': 'ses:one' },
        });
        expect(refused.statusCode).toBe(429);
        expect(refused.headers['x-ratelimit-limit']).toBe(
          String(LIMITS.REST_AUTHENTICATED_PER_MINUTE),
        );
        const other = await app.inject({
          method: 'GET',
          url: '/__test__/global-b',
          headers: { host: HOST, 'x-contract-principal': 'ses:two' },
        });
        expect(other.statusCode).toBe(200);
        expect(other.headers['x-ratelimit-remaining']).toBe(
          String(LIMITS.REST_AUTHENTICATED_PER_MINUTE - 1),
        );
        const anonymous = await app.inject({
          method: 'GET',
          url: '/__test__/global-a',
          headers: { host: HOST },
        });
        expect(anonymous.statusCode).toBe(200);
        expect(anonymous.headers['x-ratelimit-remaining']).toBe(
          String(LIMITS.REST_UNAUTHENTICATED_PER_MINUTE - 1),
        );
      });
    });

    it('keeps counts when callable max changes for the same key', async () => {
      await withRestPlugin(async (app) => {
        const first = await app.inject({
          method: 'POST',
          url: '/__test__/dynamic',
          headers: { host: HOST, 'x-contract-max': '2' },
        });
        expect(first.statusCode).toBe(200);
        expect(first.headers['x-ratelimit-remaining']).toBe('1');
        const lower = await app.inject({
          method: 'POST',
          url: '/__test__/dynamic',
          headers: { host: HOST, 'x-contract-max': '1' },
        });
        expect(lower.statusCode).toBe(429);
        const higher = await app.inject({
          method: 'POST',
          url: '/__test__/dynamic',
          headers: { host: HOST, 'x-contract-max': '4' },
        });
        expect(higher.statusCode).toBe(200);
        expect(higher.headers['x-ratelimit-remaining']).toBe('1');
      });
    });

    it('supports the pinned non-mutating read without allocating or renewing an expired window', async () => {
      await withRestPlugin(async (app, clock) => {
        const absent = await app.inject({
          method: 'GET',
          url: '/__test__/peek',
          headers: { host: HOST },
        });
        expect(absent.statusCode).toBe(200);
        expect(absent.json()).toMatchObject({
          remaining: LIMITS.REST_UNAUTHENTICATED_PER_MINUTE,
          ttl: 0,
          isExceeded: false,
        });
        await spend(app, 1, '/__test__/global-a');
        clock.jump(clock.now() + 1_000);
        const active = await app.inject({
          method: 'GET',
          url: '/__test__/peek',
          headers: { host: HOST },
        });
        expect(active.json()).toMatchObject({
          remaining: LIMITS.REST_UNAUTHENTICATED_PER_MINUTE - 1,
          ttl: 59_000,
          isExceeded: false,
        });
        clock.jump(clock.now() + 59_000);
        const expired = await app.inject({
          method: 'GET',
          url: '/__test__/peek',
          headers: { host: HOST },
        });
        expect(expired.json()).toMatchObject({
          remaining: LIMITS.REST_UNAUTHENTICATED_PER_MINUTE,
          ttl: 0,
        });
        clock.jump(clock.now() + 5_000);
        const renewed = await app.inject({
          method: 'GET',
          url: '/__test__/global-a',
          headers: { host: HOST },
        });
        expect(renewed.statusCode).toBe(200);
        expect(renewed.headers['x-ratelimit-remaining']).toBe(
          String(LIMITS.REST_UNAUTHENTICATED_PER_MINUTE - 1),
        );
        expect(renewed.headers['x-ratelimit-reset']).toBe('60');
      });
    });
  });
});
