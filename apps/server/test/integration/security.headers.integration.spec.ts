/** Real M1 response headers and static nonce substitution (07 §6.2, D07-41; 10 Transport security). */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RestResponse } from '@iridium/testkit';
import { describe, expect, it } from 'vitest';

import { startAuthServer, type AuthTestServer } from '../support/auth-app.ts';

// Committed independent response snapshot. Do not generate expected values from the CSP renderer.
const HEADER_SNAPSHOT = {
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'cross-origin-embedder-policy': 'credentialless',
  'permissions-policy':
    'camera=(), microphone=(), geolocation=(), usb=(), serial=(), hid=(), payment=(), idle-detection=()',
  'x-permitted-cross-domain-policies': 'none',
  'x-powered-by': null,
} as const;
const CSP_SNAPSHOT =
  "default-src 'none'; script-src 'self'; style-src 'self' 'nonce-<nonce>'; img-src 'self' data: blob: https:; font-src 'self'; connect-src 'self' wss://<host>; worker-src 'self' blob:; manifest-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

function assertHeaders(response: RestResponse, origin: string): string {
  expect(
    Object.fromEntries(Object.keys(HEADER_SNAPSHOT).map((key) => [key, response.headers.get(key)])),
  ).toEqual(HEADER_SNAPSHOT);
  const csp = response.headers.get('content-security-policy');
  expect(csp).not.toBeNull();
  const nonce = csp?.match(/'nonce-([0-9a-f]{32})'/u)?.[1];
  if (csp === null || nonce === undefined)
    throw new Error('Every response must carry the actual per-response style nonce.');
  expect(
    csp
      .replace("'nonce-" + nonce + "'", "'nonce-<nonce>'")
      .replaceAll(new URL(origin).host, '<host>'),
  ).toBe(CSP_SNAPSHOT);
  expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/u);
  return nonce;
}

describe('security.headers.integration [area:security]', () => {
  it('serves the exact hardening policy and no-store on authenticated M1 JSON, docs, ops and refusals', async () => {
    const target = await startAuthServer({
      extraEnv: { METRICS_TOKEN: 'headers-metrics-not-a-secret' },
    });
    try {
      const admin = await target.server.seed.admin();
      const member = await target.server.seed.user({ email: 'headers-member@example.test', admin });
      const memberSession = await target.server.sessions.current(member);
      const samples = [
        { client: admin.client, path: '/api/v1/auth/me', status: 200 },
        { client: admin.client, path: '/api/v1/admin/users', status: 200 },
        { client: admin.client, path: '/api/v1/openapi.json', status: 200 },
        { client: admin.client, path: '/api/v1/docs', status: 200 },
        { client: memberSession.client, path: '/api/v1/admin/users', status: 403 },
        { client: target.server.rest(), path: '/api/v1/auth/me', status: 401 },
        { client: target.server.rest(), path: '/healthz', status: 200 },
        { client: target.server.rest(), path: '/readyz', status: 200 },
      ];
      const nonces = new Set<string>();
      for (const sample of samples) {
        // eslint-disable-next-line no-await-in-loop -- each real route response contributes one independent nonce observation
        const response = await sample.client.request('GET', sample.path);
        expect(response.status, sample.path).toBe(sample.status);
        expect(response.headers.get('cache-control')).toBe('no-store');
        const nonce = assertHeaders(response, target.origin);
        expect(nonces.has(nonce)).toBe(false);
        nonces.add(nonce);
      }
      expect(nonces.size).toBe(samples.length);
    } finally {
      await target.stop();
    }
  });

  it('substitutes a new nonce into every served entry/fallback and preserves immutable asset and metadata caches', async () => {
    const root = await mkdtemp(join(tmpdir(), 'iridium-header-bundle-'));
    let target: AuthTestServer | undefined;
    try {
      await mkdir(join(root, 'assets'));
      // This is input to the real static-file adapter, not a substitute handler or application UI.
      await writeFile(
        join(root, 'index.html'),
        '<!doctype html><meta name="csp-nonce" content="__IRIDIUM_CSP_NONCE__"><style nonce="__IRIDIUM_CSP_NONCE__">body{color:black}</style><script src="/app/assets/app.a1b2c3d4.js"></script>',
      );
      await writeFile(join(root, 'assets/app.a1b2c3d4.js'), 'window.headerFixture = true;');
      await writeFile(join(root, 'manifest.webmanifest'), '{"name":"header fixture"}');
      target = await startAuthServer({ extraEnv: { IRIDIUM_WEB_DIR: root } });
      const client = target.server.rest();
      const canonical = await client.request('GET', '/app');
      expect(canonical.status).toBe(302);
      expect(canonical.headers.get('location')).toBe('/app/');
      assertHeaders(canonical, target.origin);
      const nonces = new Set<string>();
      for (const path of [
        '/app/',
        '/app/?entry=1',
        '/app/index.html',
        '/app/vaults/fallback-route',
      ]) {
        // eslint-disable-next-line no-await-in-loop -- nonce uniqueness spans repeated entry and SPA fallback responses
        const response = await client.request<string>('GET', path);
        expect(response.status).toBe(200);
        expect(response.contentType).toBe('text/html');
        expect(response.headers.get('cache-control')).toBe('no-store');
        const nonce = assertHeaders(response, target.origin);
        expect(nonces.has(nonce)).toBe(false);
        nonces.add(nonce);
        expect(response.body).toContain('content="' + nonce + '"');
        expect(response.body).toContain('nonce="' + nonce + '"');
        expect(response.body).not.toContain('__IRIDIUM_CSP_NONCE__');
      }
      const asset = await client.request('GET', '/app/assets/app.a1b2c3d4.js');
      expect(asset.status).toBe(200);
      expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
      assertHeaders(asset, target.origin);
      const metadata = await client.request('GET', '/app/manifest.webmanifest');
      expect(metadata.status).toBe(200);
      expect(metadata.headers.get('cache-control')).toBe('public, max-age=3600');
      assertHeaders(metadata, target.origin);
    } finally {
      try {
        await target?.stop();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });
});
