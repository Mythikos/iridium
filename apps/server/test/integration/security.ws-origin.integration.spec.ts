/**
 * `security.ws-origin.integration` (12-milestones.md §5.4; 04-auth-and-access-control.md §7.5;
 * skeleton A24).
 *
 * The contract is four rows: an upgrade **without** an `Origin` is `403`, a foreign `Origin` is `403`, a
 * case- or port-mutated `PUBLIC_ORIGIN` is `403`, and the two allowlisted values pass. There is no bypass
 * switch — `IRIDIUM_ALLOW_NO_ORIGIN_WS` is refused *by name* by `EnvSchema`, which this file also asserts,
 * because the whole point of A24 is that the flag cannot be reintroduced as configuration.
 *
 * **How it is driven before `/collab` exists.** The guard is a `preValidation` hook `security/` owns and
 * the `collab` stream mounts; the mount arrives with the `collab-server` stream in wave 2. So the suite
 * registers the real hook on a probe route inside the `/__test__` namespace — the same function, over real
 * HTTP, with the same header handling — and drives the table against **every** route that carries it. The
 * moment `GET /collab` is registered, `routesUnderGuard()` includes it and the same table runs against the
 * upgrade path with no edit here. The probe is always in the list, so the loop is never vacuous.
 *
 * The other half of the exit criterion — *"the ticket is accepted only in the auth message, never in the
 * URL"* — is the `collab` stream's `onAuthenticate`, and `tickets.batch-and-limits.integration` owns it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config/env.ts';
import {
  collabAllowedOrigins,
  collabOriginDecision,
  collabOriginPolicy,
  createCollabOriginGuard,
  DESKTOP_ORIGIN,
} from '../../src/security/ws-origin.ts';
import { startPlatformApp, TEST_PUBLIC_ORIGIN, type PlatformApp } from './platform-app.ts';

/** Where the real hook is mounted so the table can run before `/collab` is registered. */
const PROBE_PATH = '/__test__/ws-origin';

const HOST = new URL(TEST_PUBLIC_ORIGIN).host;

let booted: PlatformApp;

/** Every route that carries the origin allowlist: the probe, plus `/collab` once it is registered. */
function routesUnderGuard(): readonly string[] {
  const collab = booted.app
    .routes()
    .some((route) => route.method === 'GET' && route.url === '/collab');
  return collab ? [PROBE_PATH, '/collab'] : [PROBE_PATH];
}

beforeAll(async () => {
  booted = await startPlatformApp({
    beforeReady: (app) => {
      app.get(
        PROBE_PATH,
        {
          config: { auth: 'test-only' },
          preValidation: [createCollabOriginGuard(collabOriginPolicy(app.iridiumConfig))],
        },
        async () => ({ upgraded: true }),
      );
    },
  });
});

afterAll(async () => {
  await booted.close();
});

describe('security.ws-origin.integration [area:security]', () => {
  it('guards at least one route, so the table below is not vacuous', () => {
    expect(routesUnderGuard().length).toBeGreaterThan(0);
  });

  describe('the four rows of §7.5', () => {
    it('refuses an upgrade with no Origin at all', async () => {
      for (const url of routesUnderGuard()) {
        // eslint-disable-next-line no-await-in-loop -- one request at a time keeps a failure attributable
        const response = await booted.app.inject({ method: 'GET', url, headers: { host: HOST } });
        expect(`${url} -> ${String(response.statusCode)}`).toBe(`${url} -> 403`);
        const problem: { code?: string; detail?: string } = response.json();
        expect(problem.code).toBe('forbidden');
        expect(problem.detail).toContain('no bypass');
      }
    });

    it('refuses a foreign Origin', async () => {
      for (const url of routesUnderGuard()) {
        // eslint-disable-next-line no-await-in-loop -- one request at a time keeps a failure attributable
        const response = await booted.app.inject({
          method: 'GET',
          url,
          headers: { host: HOST, origin: 'https://evil.example' },
        });
        expect(`${url} -> ${String(response.statusCode)}`).toBe(`${url} -> 403`);
      }
    });

    it('refuses a case-mutated host and a different port on the right scheme', async () => {
      const publicOrigin = new URL(TEST_PUBLIC_ORIGIN);
      for (const origin of [
        `http://${publicOrigin.hostname}:${String(Number(publicOrigin.port) + 1)}`,
        `HTTP://${publicOrigin.host}`,
        `https://${publicOrigin.host}`,
      ]) {
        for (const url of routesUnderGuard()) {
          // eslint-disable-next-line no-await-in-loop -- one request at a time keeps a failure attributable
          const response = await booted.app.inject({
            method: 'GET',
            url,
            headers: { host: HOST, origin },
          });
          expect(response.statusCode, `${url} ${origin}`).toBe(403);
        }
      }
    });

    it('accepts PUBLIC_ORIGIN', async () => {
      const response = await booted.app.inject({
        method: 'GET',
        url: PROBE_PATH,
        headers: { host: HOST, origin: TEST_PUBLIC_ORIGIN },
      });
      expect(response.statusCode).toBe(200);
    });

    it('accepts the Electron renderer origin app://iridium, exactly as sent', async () => {
      // Spike S3 observed the bare 21-byte serialised origin — no trailing slash, no port — on all 50
      // observations, which is why the allowlist carries that literal and the comparison is exact.
      expect(DESKTOP_ORIGIN).toBe('app://iridium');
      const response = await booted.app.inject({
        method: 'GET',
        url: PROBE_PATH,
        headers: { host: HOST, origin: DESKTOP_ORIGIN },
      });
      expect(response.statusCode).toBe(200);
      const withSlash = await booted.app.inject({
        method: 'GET',
        url: PROBE_PATH,
        headers: { host: HOST, origin: `${DESKTOP_ORIGIN}/` },
      });
      expect(withSlash.statusCode).toBe(403);
    });
  });

  describe('the allowlist itself', () => {
    it('carries PUBLIC_ORIGIN and app://iridium, and no dev origin outside development', () => {
      expect(collabAllowedOrigins(collabOriginPolicy(booted.app.iridiumConfig))).toEqual([
        TEST_PUBLIC_ORIGIN,
        DESKTOP_ORIGIN,
      ]);
      expect(
        collabAllowedOrigins({
          env: 'production',
          publicOrigin: 'https://iridium.test',
          devOrigins: ['http://localhost:5173'],
        }),
      ).not.toContain('http://localhost:5173');
      expect(
        collabAllowedOrigins({
          env: 'development',
          publicOrigin: 'http://127.0.0.1:4000',
          devOrigins: ['http://localhost:5173'],
        }),
      ).toContain('http://localhost:5173');
    });

    it('names the absent-Origin case separately from the not-allowed case', () => {
      const allowed = collabAllowedOrigins(collabOriginPolicy(booted.app.iridiumConfig));
      expect(collabOriginDecision(undefined, allowed)).toEqual({ allow: false, reason: 'absent' });
      expect(collabOriginDecision('https://evil.example', allowed)).toEqual({
        allow: false,
        reason: 'not_allowed',
      });
      expect(collabOriginDecision(TEST_PUBLIC_ORIGIN, allowed)).toEqual({ allow: true });
    });
  });

  describe('there is no bypass switch (A24)', () => {
    it('refuses IRIDIUM_ALLOW_NO_ORIGIN_WS by name, with the reason', () => {
      // An environment flag would inevitably be enabled in production "to make the desktop work" and would
      // then accept any CLI or server-side attacker that reaches the port. So the flag is not merely
      // unimplemented: the schema refuses to start when it is present.
      expect(() =>
        loadConfig({
          NODE_ENV: 'test',
          PUBLIC_ORIGIN: TEST_PUBLIC_ORIGIN,
          DATABASE_URL: 'mysql://iridium_app:x@127.0.0.1:3306/iridium',
          IRIDIUM_ALLOW_NO_ORIGIN_WS: 'true',
        }),
      ).toThrow(/IRIDIUM_ALLOW_NO_ORIGIN_WS is refused/);
    });
  });
});
