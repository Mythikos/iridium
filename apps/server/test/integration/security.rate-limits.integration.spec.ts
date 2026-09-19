/**
 * `security.rate-limits.integration` (12-milestones.md §5.4 via the transport-security row of
 * 10-testing-and-quality.md; 09-api-reference.md §1.8; HP-5).
 *
 * Three tiers at M1: 600/min per principal, 60/min per IP, 10/min per IP on the three
 * credential-presenting routes. The inventory row asks for `429` with `Retry-After` and a `rate_limited`
 * `ProblemDetails` on each.
 *
 * **What runs now and what runs later.** The unauthenticated tier is driven end to end against a real
 * route: the budget is spent, the 61st request is refused, and the refusal's shape and headers are
 * asserted. The authenticated tier needs a principal and the login tier needs
 * `POST /auth/sessions` — both arrive with the `auth` stream — so their *policies* are asserted here as
 * the pure functions the limiter is configured with, which is the same code path the plugin calls once
 * those routes exist. That is deliberate rather than deferred: what M1 can prove about a tier with no
 * route is that the tier chooses the right budget and the right bucket, and that is exactly what is
 * asserted.
 *
 * The budget is spent against a probe route inside the `/__test__` namespace. The limiter is **global** —
 * "every route is limited unless it opted out" — so any route proves it, and a route this suite owns is
 * what keeps 60 requests from depending on whether `IRIDIUM_WEB_DIR` happened to be configured. Which
 * routes opt out is asserted separately: `/healthz`, `/readyz` and `/metrics` are on the allow list, and a
 * rate-limited readiness probe is how a degraded server becomes an unmonitored one.
 */
import { LIMITS } from '@iridium/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  globalRateLimitKey,
  globalRateLimitMax,
  LOGIN_RATE_LIMIT_POLICY,
  RATE_LIMIT_WINDOW,
} from '../../src/security/rate-limits.ts';
import { startPlatformApp, TEST_PUBLIC_ORIGIN, type PlatformApp } from './platform-app.ts';

const HOST = new URL(TEST_PUBLIC_ORIGIN).host;

/** The route the unauthenticated budget is spent against. */
const LIMITED_PATH = '/__test__/rate-limit-probe';

let booted: PlatformApp;

beforeAll(async () => {
  booted = await startPlatformApp({
    beforeReady: (app) => {
      // A route that declares nothing about rate limiting, so what it exercises is the *global* tier.
      app.get(LIMITED_PATH, { config: { auth: 'test-only' } }, async () => ({ counted: true }));
    },
  });
});

afterAll(async () => {
  await booted.close();
});

describe('security.rate-limits.integration [area:security]', () => {
  describe('the unauthenticated tier: 60/min per IP', () => {
    it('spends the budget, refuses the next request, and says when to retry', async () => {
      const budget = LIMITS.REST_UNAUTHENTICATED_PER_MINUTE;
      let last = await booted.app.inject({
        method: 'GET',
        url: LIMITED_PATH,
        headers: { host: HOST },
      });
      for (let sent = 1; sent < budget; sent += 1) {
        // eslint-disable-next-line no-await-in-loop -- the budget is per request; concurrency would race it
        last = await booted.app.inject({
          method: 'GET',
          url: LIMITED_PATH,
          headers: { host: HOST },
        });
        expect(last.statusCode, `request ${String(sent + 1)} of ${String(budget)}`).not.toBe(429);
      }

      const refused = await booted.app.inject({
        method: 'GET',
        url: LIMITED_PATH,
        headers: { host: HOST },
      });
      expect(refused.statusCode).toBe(429);
      expect(refused.headers['content-type']).toContain('application/problem+json');
      const problem: { code?: string; status?: number; retryAfterMs?: number; requestId?: string } =
        refused.json();
      expect(problem.code).toBe('rate_limited');
      expect(problem.status).toBe(429);
      expect(problem.retryAfterMs).toBeGreaterThan(0);
      expect(problem.requestId).toBe(refused.headers['x-request-id']);

      // `retry-after` is in seconds and the `x-ratelimit-*` trio is present on the refusal — which is
      // where 09 §1.2 requires them ("on `429` everywhere"; always on /mcp and PAT routes, from M3).
      expect(Number(refused.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      expect(refused.headers['x-ratelimit-limit']).toBe(String(budget));
      expect(refused.headers['x-ratelimit-remaining']).toBe('0');
      expect(refused.headers['x-ratelimit-reset']).toBeDefined();
    });

    it('never rate-limits the three operational routes', async () => {
      // The budget above is already spent for this IP, so an unexempted route would answer 429 here.
      for (const path of ['/healthz', '/readyz']) {
        // eslint-disable-next-line no-await-in-loop -- two probes, each named in the failure
        const response = await booted.app.inject({
          method: 'GET',
          url: path,
          headers: { host: HOST },
        });
        expect(`${path} -> ${String(response.statusCode)}`).not.toBe(`${path} -> 429`);
      }
      // `/metrics` answers 404 without a token or a CIDR, which is still not a 429.
      const metrics = await booted.app.inject({
        method: 'GET',
        url: '/metrics',
        headers: { host: HOST },
      });
      expect(metrics.statusCode).not.toBe(429);
    });
  });

  describe('the tiers as the limiter is configured with them', () => {
    it('gives an authenticated principal 600/min, keyed on the principal', () => {
      expect(globalRateLimitMax({ principalKey: 'ses:abc', ip: '10.0.0.1' })).toBe(
        LIMITS.REST_AUTHENTICATED_PER_MINUTE,
      );
      expect(globalRateLimitKey({ principalKey: 'ses:abc', ip: '10.0.0.1' })).toBe('ses:abc');
      // A PAT and an OAuth token are their own buckets, never their owner's.
      expect(globalRateLimitKey({ principalKey: 'pat:xyz', ip: '10.0.0.1' })).toBe('pat:xyz');
      expect(globalRateLimitKey({ principalKey: 'oat:xyz', ip: '10.0.0.1' })).toBe('oat:xyz');
    });

    it('gives an anonymous request 60/min, keyed on the resolved peer address', () => {
      expect(globalRateLimitMax({ principalKey: null, ip: '10.0.0.1' })).toBe(
        LIMITS.REST_UNAUTHENTICATED_PER_MINUTE,
      );
      expect(globalRateLimitKey({ principalKey: null, ip: '10.0.0.1' })).toBe('10.0.0.1');
    });

    it('gives the login routes 10/min per IP, keyed on the IP even once a principal exists', () => {
      expect(LOGIN_RATE_LIMIT_POLICY.max).toBe(LIMITS.LOGIN_PER_MINUTE_PER_IP);
      expect(LOGIN_RATE_LIMIT_POLICY.timeWindow).toBe(RATE_LIMIT_WINDOW);
      // The requests that matter have no principal yet, which is why this tier ignores `principalKey`.
      expect(
        LOGIN_RATE_LIMIT_POLICY.keyGenerator({ principalKey: 'ses:abc', ip: '10.0.0.2' }),
      ).toBe('10.0.0.2');
    });

    it('builds the same rate_limited problem for every tier', () => {
      // One refusal shape: the tier chooses the budget and the bucket, never the body.
      // The builder reads only the limiter's context — never the request — which is why the tiers share
      // one refusal and why this can be driven with no request at all.
      const problem = LOGIN_RATE_LIMIT_POLICY.errorResponseBuilder(null, { ttl: 12_000 });
      expect(problem.code).toBe('rate_limited');
      expect(problem.status).toBe(429);
      expect(problem.extensions.retryAfterMs).toBe(12_000);
    });
  });
});
