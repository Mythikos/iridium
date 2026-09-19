/** The real proxy boundary controls correlation, logged peers and rate-limit buckets (ARCH-14). */
import { LIMITS } from '@iridium/contracts';
import { describe, expect, it } from 'vitest';

import { startCollab, type CollabHarness } from '../support/collab-harness.ts';
import { registerRecordingOpenApiMatcher } from '../support/openapi-coverage.ts';

registerRecordingOpenApiMatcher();

const GENERATED_REQUEST_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

async function startProxy(trustProxy: string): Promise<CollabHarness> {
  const target = await startCollab({
    extraEnv: {
      TRUST_PROXY: trustProxy,
      ARGON2_MEMORY_KIB: '8192',
      ARGON2_TIME_COST: '1',
    },
  });
  try {
    await target.server.waitReady();
    return target;
  } catch (error) {
    await target.close();
    throw error;
  }
}

function recorded(
  target: CollabHarness,
  event: string,
  requestId: string,
): readonly Record<string, unknown>[] {
  return target.logs
    .map((line): Record<string, unknown> => JSON.parse(line))
    .filter((line) => line['event'] === event && line['requestId'] === requestId);
}

async function loggedPeer(
  target: CollabHarness,
  forwardedFor: string,
  inboundId: string,
): Promise<string> {
  // A genuine credential-route CSRF refusal records request.ip before any password verification.
  const response = await target.server.rest({ client: 'web' }).post('/auth/sessions', {
    headers: { 'x-forwarded-for': forwardedFor, 'x-request-id': inboundId },
    json: {
      email: 'proxy-boundary@example.test',
      password: 'not-a-real-credential',
      client: 'desktop',
    },
  });
  expect(response.status).toBe(403);
  expect(response.body).toMatchObject({ code: 'csrf_rejected' });
  await expect(response).toMatchOpenApi('auth.createSession', 403);
  const requestId = response.headers.get('x-request-id');
  if (requestId === null) throw new Error('The real refusal did not echo its correlation id.');
  const refusals = recorded(target, 'authz.csrf_rejected', requestId);
  expect(refusals).toHaveLength(1);
  expect(recorded(target, 'http.request', requestId)).toHaveLength(1);
  const peer = refusals[0]?.['ip'];
  if (typeof peer !== 'string') throw new Error('The real refusal did not log its resolved peer.');
  return peer;
}

describe('ops.trust-proxy.integration [area:ops]', () => {
  it('accepts well-formed correlation ids and the forwarded peer only from the configured direct proxy', async () => {
    const target = await startProxy('127.0.0.1/32');
    try {
      const requestId = 'trusted.proxy-request_001';
      const response = await target.server.rest().get('/meta', {
        headers: { 'x-forwarded-for': '198.51.100.14', 'x-request-id': requestId },
      });
      expect(response.status).toBe(200);
      await expect(response).toMatchOpenApi('meta.get', 200);
      expect(response.headers.get('x-request-id')).toBe(requestId);
      expect(recorded(target, 'http.request', requestId)).toHaveLength(1);
      expect(await loggedPeer(target, '198.51.100.14', 'trusted.proxy-login_001')).toBe(
        '198.51.100.14',
      );

      for (const malformed of ['short', 'request id with spaces', 'x'.repeat(129)]) {
        // eslint-disable-next-line no-await-in-loop -- each wire response proves the inbound-id shape check
        const rejected = await target.server
          .rest()
          .get('/meta', { headers: { 'x-request-id': malformed } });
        expect(rejected.status).toBe(200);
        // eslint-disable-next-line no-await-in-loop -- every actual route response has the contract oracle
        await expect(rejected).toMatchOpenApi('meta.get', 200);
        expect(rejected.headers.get('x-request-id')).toMatch(GENERATED_REQUEST_ID);
        expect(rejected.headers.get('x-request-id')).not.toBe(malformed);
        expect(recorded(target, 'http.request', malformed)).toEqual([]);
      }
    } finally {
      await target.close();
    }
  });

  it('ignores rotating spoofed IPs and correlation ids from an untrusted peer for both logs and quota', async () => {
    const target = await startProxy('10.40.0.0/16');
    try {
      const spoofedId = 'untrusted-forged-request';
      expect(await loggedPeer(target, '203.0.113.99', spoofedId)).toBe('127.0.0.1');
      expect(recorded(target, 'authz.csrf_rejected', spoofedId)).toEqual([]);
      const client = target.server.rest();
      for (let index = 0; index < LIMITS.REST_UNAUTHENTICATED_PER_MINUTE; index++) {
        // eslint-disable-next-line no-await-in-loop -- exact sequential boundary, all requests use the same native TCP peer
        const response = await client.get('/meta', {
          headers: {
            'x-forwarded-for': '198.51.100.' + String(index + 1),
            'x-request-id': spoofedId,
          },
        });
        expect(response.status, 'request ' + String(index + 1)).toBe(200);
        // eslint-disable-next-line no-await-in-loop -- validate every consumed response
        await expect(response).toMatchOpenApi('meta.get', 200);
        expect(response.headers.get('x-request-id')).toMatch(GENERATED_REQUEST_ID);
        expect(response.headers.get('x-request-id')).not.toBe(spoofedId);
      }
      const refused = await client.get('/meta', { headers: { 'x-forwarded-for': '192.0.2.250' } });
      expect(refused.status).toBe(429);
      expect(refused.body).toMatchObject({ code: 'rate_limited', status: 429 });
      expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
      await expect(refused).toMatchOpenApi('meta.get', 429);
      expect(recorded(target, 'http.request', spoofedId)).toEqual([]);
    } finally {
      await target.close();
    }
  });

  it('stops the forwarded chain at its first untrusted hop and keeps independent client buckets', async () => {
    const target = await startProxy('127.0.0.0/8');
    try {
      const nearestUntrusted = '198.51.100.77';
      expect(
        await loggedPeer(
          target,
          '203.0.113.9, ' + nearestUntrusted + ', 127.0.0.2',
          'trusted-chain-probe',
        ),
      ).toBe(nearestUntrusted);
      const client = target.server.rest();
      for (let index = 0; index < LIMITS.REST_UNAUTHENTICATED_PER_MINUTE; index++) {
        // eslint-disable-next-line no-await-in-loop -- changing only the attacker-controlled leftmost entry must not replenish quota
        const response = await client.get('/meta', {
          headers: {
            'x-forwarded-for':
              '203.0.113.' + String(index + 1) + ', ' + nearestUntrusted + ', 127.0.0.2',
          },
        });
        expect(response.status, 'request ' + String(index + 1)).toBe(200);
        // eslint-disable-next-line no-await-in-loop -- every wire response retains its schema assertion
        await expect(response).toMatchOpenApi('meta.get', 200);
      }
      const blocked = await client.get('/meta', {
        headers: { 'x-forwarded-for': '192.0.2.250, ' + nearestUntrusted + ', 127.0.0.2' },
      });
      expect(blocked.status).toBe(429);
      await expect(blocked).toMatchOpenApi('meta.get', 429);
      const otherPeer = await client.get('/meta', {
        headers: { 'x-forwarded-for': '198.51.100.78, 127.0.0.2' },
      });
      expect(otherPeer.status).toBe(200);
      await expect(otherPeer).toMatchOpenApi('meta.get', 200);
    } finally {
      await target.close();
    }
  });
});
