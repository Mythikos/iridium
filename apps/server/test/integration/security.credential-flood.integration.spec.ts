/** Malformed bearers do no SQL; admitted unknown-account logins pay exactly one bounded native verify. */
import { stat } from 'node:fs/promises';

import { LIMITS } from '@iridium/contracts';
import { describe, expect, it } from 'vitest';

import { desktopClient, startAuthServer } from '../support/auth-app.ts';
import { seedUser } from '../support/seed.ts';

const METRICS_TOKEN = 'credential-flood-metrics-not-a-secret';
const MALFORMED_BEARERS = [
  'not-a-credential',
  'irid_ses_short',
  'irid_pat_' + '0'.repeat(16) + '_' + '0'.repeat(49),
  'irid_ses_' + '0'.repeat(16) + '_' + '0'.repeat(49),
] as const;
const BEARER_REQUESTS = 10_000;
const HTTP_CONCURRENCY = 50;
const FLOOD_SOURCES = 4;
const LOGIN_REQUESTS_PER_SOURCE = 24;

describe('security.credential-flood.integration [area:security]', () => {
  it('rejects ten thousand real malformed bearer requests before SQL or native password work', async () => {
    const target = await startAuthServer({ extraEnv: { METRICS_TOKEN } });
    try {
      const before = target.app.database.queryCounts();
      const nativeBefore = target.app.auth.hasher.operationCounts();
      const metricsBefore = await target.server.metrics();
      for (let offset = 0; offset < BEARER_REQUESTS; offset += HTTP_CONCURRENCY) {
        // The clock stays fixed so unrelated scheduled probes cannot be mistaken for request SQL.
        // eslint-disable-next-line no-await-in-loop -- bounded batches exercise all10000 real requests without an unbounded client socket pool
        const responses = await Promise.all(
          Array.from({ length: HTTP_CONCURRENCY }, async (_, index) => {
            const credential = MALFORMED_BEARERS[(offset + index) % MALFORMED_BEARERS.length];
            if (credential === undefined) throw new Error('The malformed bearer fixture is empty.');
            // The explicit malformed version also proves auth refusal precedes compatibility reads.
            return target.server
              .rest({ bearer: credential })
              .get('/auth/me', { headers: { 'x-iridium-client-version': 'invalid-version' } });
          }),
        );
        expect(responses.map((response) => response.status)).toEqual(
          Array.from({ length: HTTP_CONCURRENCY }, () => 401),
        );
        for (const response of responses) {
          expect(response.contentType).toBe('application/problem+json');
          expect(response.body).toMatchObject({ code: 'unauthenticated' });
        }
        expect(target.app.database.queryCounts()).toEqual(before);
        expect(target.app.database.pendingAcquisitions()).toEqual({ app: 0, persist: 0 });
        expect(target.app.auth.hasher.operationCounts()).toEqual(nativeBefore);
      }
      const metricsAfter = await target.server.metrics();
      expect(
        (metricsAfter['iridium_token_auth_failures_total{reason="bad_format"}'] ?? 0) -
          (metricsBefore['iridium_token_auth_failures_total{reason="bad_format"}'] ?? 0),
      ).toBe(BEARER_REQUESTS);
      expect(metricsAfter['iridium_db_pool_in_use{pool="app"}']).toBe(0);
      expect((await target.server.rest().request('GET', '/healthz')).status).toBe(200);
      expect((await target.server.rest().request('GET', '/readyz')).status).toBe(200);
    } finally {
      await target.stop();
    }
  }, 120_000);

  it('bounds real native dummy work, throttles each attacking IP and admits a real account from another source', async () => {
    const target = await startAuthServer({
      extraEnv: { METRICS_TOKEN, ARGON2_MEMORY_KIB: '65536', ARGON2_TIME_COST: '3' },
    });
    try {
      const user = await seedUser(target, { email: 'legitimate-during-flood@example.test' });
      const before = target.app.auth.hasher.operationCounts();
      const metricsBefore = await target.server.metrics();
      const responses = Promise.all(
        Array.from({ length: FLOOD_SOURCES * LOGIN_REQUESTS_PER_SOURCE }, async (_, index) => {
          const source = index % FLOOD_SOURCES;
          return desktopClient(target, undefined, '198.51.100.' + String(source + 1)).post(
            '/auth/sessions',
            {
              json: {
                email: 'unknown-' + String(index) + '@example.test',
                password: 'not-a-real-password',
                client: 'desktop',
              },
            },
          );
        }),
      );
      // Every rejection remains owned even if a following observer fails.
      const settled = responses.then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      try {
        await expect
          .poll(() => target.app.auth.hasher.operationCounts().active, { timeout: 10_000 })
          .toBeGreaterThan(1);
        const [health, file, legitimate] = await Promise.all([
          target.server.rest().request('GET', '/healthz'),
          stat(import.meta.filename),
          desktopClient(target, undefined, '203.0.113.250').post<{ token: string }>(
            '/auth/sessions',
            {
              json: {
                email: user.email,
                password: user.password,
                client: 'desktop',
                deviceName: 'legitimate',
              },
            },
          ),
        ]);
        expect(health.status).toBe(200);
        expect(file.isFile()).toBe(true);
        expect(legitimate.status).toBe(201);
        const observed = await settled;
        if (!observed.ok) throw observed.error;
        const allowedAttempts = FLOOD_SOURCES * LIMITS.LOGIN_PER_MINUTE_PER_IP;
        expect(observed.value.filter((response) => response.status === 401)).toHaveLength(
          allowedAttempts,
        );
        expect(observed.value.filter((response) => response.status === 429)).toHaveLength(
          FLOOD_SOURCES * LOGIN_REQUESTS_PER_SOURCE - allowedAttempts,
        );
        for (const response of observed.value) {
          expect(response.body).toMatchObject({
            code: response.status === 401 ? 'invalid_credentials' : 'rate_limited',
          });
        }
        for (const response of observed.value.filter((candidate) => candidate.status === 429)) {
          expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
        }
        const after = target.app.auth.hasher.operationCounts();
        expect(after.dummyVerifications - before.dummyVerifications).toBe(allowedAttempts);
        expect(after.verifications - before.verifications).toBe(1);
        expect(after.hashes).toBe(before.hashes);
        expect(after.completed - before.completed).toBe(allowedAttempts + 1);
        expect(after.active).toBe(0);
        expect(after.maxActive).toBeLessThanOrEqual(4); // D04-03's default leaves other libuv work serviceable.
        expect(target.app.auth.hasher.waiting).toBe(0);
        expect(target.app.database.pendingAcquisitions()).toEqual({ app: 0, persist: 0 });
        const blockedLegitimate = await desktopClient(target, undefined, '198.51.100.1').post(
          '/auth/sessions',
          { json: { email: user.email, password: user.password, client: 'desktop' } },
        );
        expect(blockedLegitimate.status).toBe(429);
        expect(
          (await desktopClient(target, legitimate.body.token, '203.0.113.250').get('/auth/me'))
            .status,
        ).toBe(200);
        expect(target.app.auth.hasher.operationCounts()).toEqual(after);
        const metricsAfter = await target.server.metrics();
        expect(
          (metricsAfter['iridium_login_failures_total{reason="unknown_user"}'] ?? 0) -
            (metricsBefore['iridium_login_failures_total{reason="unknown_user"}'] ?? 0),
        ).toBe(allowedAttempts);
        expect(metricsAfter['iridium_db_pool_in_use{pool="app"}']).toBe(0);
        expect((await target.server.rest().request('GET', '/readyz')).status).toBe(200);
      } finally {
        await settled;
      }
    } finally {
      await target.stop();
    }
  }, 120_000);
});
