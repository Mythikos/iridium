/**
 * `routes.test-namespace-absent.integration` (12-milestones.md §5.4; 10-testing-and-quality.md D10-6).
 *
 * Three claims, and the milestone row states them together because each one alone would be satisfiable
 * without the others:
 *
 *  1. the whole `/__test__` prefix returns `404` when `NODE_ENV=production`;
 *  2. the control routes exist and actually arm faults when `NODE_ENV=test`;
 *  3. the route-policy boot assertion refuses to start if any `/__test__` route lacks
 *     `config.auth = 'test-only'`.
 *
 * The first is the one that matters in a deployment and the one an implementation can get subtly wrong: a
 * namespace that is *registered* and then guarded by a hook is one forgotten branch away from being
 * reachable. So the assertion is about the **route table**, not only about the status code — the routes
 * are not registered at all outside `NODE_ENV=test`, and the `404` an operator would see comes from the
 * ordinary not-found handler.
 *
 * `development` is asserted beside `production` on purpose: `IRIDIUM_FAULT` is refused in both
 * (`config.test_knob_in_production`), and a namespace that appeared on a developer's machine would be a
 * namespace that eventually appeared in a container built from a developer's habits.
 */
import { startTestEnv } from '@iridium/testkit';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { assertRoutePolicies, RoutePolicyError } from '../../src/authz/route-policy.ts';
import { FAULT_CONTROL_PATH, TEST_NAMESPACE_PREFIX } from '../../src/ops/test-routes.ts';
import { startPlatformApp, TEST_PUBLIC_ORIGIN, type PlatformApp } from './platform-app.ts';

/**
 * What a browser request to this server carries: the CSRF guard's custom header and `Origin` (04 §4.4),
 * plus the `Host` the Host guard compares with `PUBLIC_HOST` (ARCH-03) — `light-my-request` defaults to
 * `localhost:80`, which is a different host and is answered `421 host_rejected`.
 */
const WEB_HEADERS = {
  'x-iridium-client': 'web',
  origin: TEST_PUBLIC_ORIGIN,
  host: new URL(TEST_PUBLIC_ORIGIN).host,
};

let testEnv: PlatformApp;

function routesUnder(app: FastifyInstance, prefix: string): readonly string[] {
  return app
    .routes()
    .filter((route) => route.url.startsWith(prefix))
    .map((route) => `${route.method} ${route.url}`)
    .toSorted((left, right) => left.localeCompare(right));
}

beforeAll(async () => {
  testEnv = await startPlatformApp();
});

afterAll(async () => {
  await testEnv.close();
});

describe('routes.test-namespace-absent.integration [area:ops]', () => {
  describe('under NODE_ENV=test', () => {
    it('registers exactly the two control routes, each declaring test-only', () => {
      expect(routesUnder(testEnv.app, TEST_NAMESPACE_PREFIX)).toEqual([
        `DELETE ${FAULT_CONTROL_PATH}`,
        `POST ${FAULT_CONTROL_PATH}`,
      ]);
      for (const route of testEnv.app.routes()) {
        if (!route.url.startsWith(TEST_NAMESPACE_PREFIX)) continue;
        expect(route.auth).toBe('test-only');
      }
    });

    it('arms a fault point over the control route and disarms it again', async () => {
      const armed = await testEnv.app.inject({
        method: 'POST',
        url: FAULT_CONTROL_PATH,
        headers: WEB_HEADERS,
        payload: { point: 'store.throw', count: 1 },
      });
      expect(armed.statusCode).toBe(204);
      expect(testEnv.app.faults.armed.map((fault) => fault.point)).toEqual(['store.throw']);

      const cleared = await testEnv.app.inject({
        method: 'DELETE',
        url: FAULT_CONTROL_PATH,
        headers: WEB_HEADERS,
      });
      expect(cleared.statusCode).toBe(204);
      expect(testEnv.app.faults.armed).toEqual([]);
    });

    it('refuses an unknown point with 422 and names the registry, rather than arming nothing', async () => {
      const response = await testEnv.app.inject({
        method: 'POST',
        url: FAULT_CONTROL_PATH,
        headers: WEB_HEADERS,
        payload: { point: 'store.explode' },
      });
      expect(response.statusCode).toBe(422);
      const problem: { code?: string; detail?: string } = response.json();
      expect(problem.code).toBe('validation_failed');
      expect(problem.detail).toContain('store.throw');
      expect(testEnv.app.faults.armed).toEqual([]);
    });

    it('retains a valid acknowledgement selector and refuses invalid or misplaced selectors', async () => {
      const ack = { noteId: '01980000-0000-7000-8000-000000000001', afterSeq: 4 };
      const armed = await testEnv.app.inject({
        method: 'POST',
        url: FAULT_CONTROL_PATH,
        headers: WEB_HEADERS,
        payload: { point: 'store.kill-after-ack', ack },
      });
      expect(armed.statusCode).toBe(204);
      expect(testEnv.app.faults.armed[0]?.ack).toEqual(ack);
      await testEnv.app.inject({ method: 'DELETE', url: FAULT_CONTROL_PATH, headers: WEB_HEADERS });
      for (const payload of [
        { point: 'store.throw', ack },
        { point: 'store.kill-after-ack', ack: null },
        { point: 'store.kill-after-ack', ack: { ...ack, afterSeq: -1 } },
      ]) {
        // eslint-disable-next-line no-await-in-loop -- each refused request must leave the registry empty
        const refused = await testEnv.app.inject({
          method: 'POST',
          url: FAULT_CONTROL_PATH,
          headers: WEB_HEADERS,
          payload,
        });
        expect(refused.statusCode).toBe(422);
        expect(testEnv.app.faults.armed).toEqual([]);
      }
    });

    it('refuses a body with no point, and a malformed argument', async () => {
      const noPoint = await testEnv.app.inject({
        method: 'POST',
        url: FAULT_CONTROL_PATH,
        headers: WEB_HEADERS,
        payload: {},
      });
      expect(noPoint.statusCode).toBe(422);

      const badArgument = await testEnv.app.inject({
        method: 'POST',
        url: FAULT_CONTROL_PATH,
        headers: WEB_HEADERS,
        payload: { point: 'store.slow', arg: -1 },
      });
      expect(badArgument.statusCode).toBe(422);
    });
  });

  describe('under NODE_ENV=production and NODE_ENV=development', () => {
    it.each(['production', 'development'])(
      'registers no /__test__ route at all and answers 404 under NODE_ENV=%s',
      async (nodeEnv) => {
        const env = await startTestEnv({ productionCredentials: true });
        let booted: PlatformApp | undefined;
        try {
          booted = await startPlatformApp({
            connection: { ...env.mysql, schema: env.mysql.templateSchema },
            extraEnv: {
              ...env.serverEnv,
              NODE_ENV: nodeEnv,
              PUBLIC_ORIGIN: nodeEnv === 'production' ? 'https://iridium.test' : TEST_PUBLIC_ORIGIN,
            },
          });
          expect(booted.app.readiness.state).toBe('ready');
          expect(booted.app.collab.ownerLease.held).toBe(true);
          // The namespace is absent from the route table, not merely guarded: there is no hook to forget.
          expect(routesUnder(booted.app, TEST_NAMESPACE_PREFIX)).toEqual([]);
          expect(booted.app.faults.enabled).toBe(false);

          const publicOrigin = booted.app.iridiumConfig.server.publicOrigin.origin;
          const headers = {
            'x-iridium-client': 'web',
            origin: publicOrigin,
            host: booted.app.iridiumConfig.server.publicHost,
          };
          for (const method of ['POST', 'DELETE'] as const) {
            // eslint-disable-next-line no-await-in-loop -- two requests, each named in its own failure
            const response = await booted.app.inject({
              method,
              url: FAULT_CONTROL_PATH,
              headers,
              ...(method === 'POST' ? { payload: { point: 'store.throw' } } : {}),
            });
            expect(response.statusCode).toBe(404);
            expect(response.json<{ code?: string }>().code).toBe('not_found');
          }

          // And nothing else under the prefix either — the claim is the prefix, not the two paths.
          const other = await booted.app.inject({
            method: 'GET',
            url: `${TEST_NAMESPACE_PREFIX}/anything`,
            headers,
          });
          expect(other.statusCode).toBe(404);
        } finally {
          try {
            await booted?.close();
          } finally {
            await env.stop();
          }
        }
      },
      120_000,
    );
  });

  describe('the boot assertion behind the namespace', () => {
    it('refuses to start when a /__test__ route declares anything but test-only', () => {
      // The assertion is a pure function over the route table, so the refusal is driven directly rather
      // than by booting a deliberately broken server (`authz.route-policy.boot.guard` owns the boot half).
      expect(() =>
        assertRoutePolicies([
          { method: 'POST', url: `${TEST_NAMESPACE_PREFIX}/faults`, auth: { public: true } },
        ]),
      ).toThrow(RoutePolicyError);
      expect(() =>
        assertRoutePolicies([
          { method: 'POST', url: `${TEST_NAMESPACE_PREFIX}/faults`, auth: undefined },
        ]),
      ).toThrow(RoutePolicyError);
    });

    it('refuses a test-only policy outside the namespace, so the carve-out cannot spread', () => {
      expect(() =>
        assertRoutePolicies([{ method: 'POST', url: '/api/v1/vaults', auth: 'test-only' }]),
      ).toThrow(RoutePolicyError);
    });

    it('accepts the namespace as it is actually registered', () => {
      expect(() => assertRoutePolicies(testEnv.app.routes())).not.toThrow();
    });
  });
});
