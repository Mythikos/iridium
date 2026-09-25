/** The durable release floor changes the next real request while discovery remains readable (A54). */
import { API_VERSION, Meta, RELEASE_MIN_CLIENT_VERSION } from '@iridium/contracts';
import { describe, expect, it } from 'vitest';

import { createMaintDb } from '../../src/db/migrator.ts';
import { startAuthServer, desktopClient, type AuthTestServer } from '../support/auth-app.ts';
import { seedUser, signInDesktop } from '../support/seed.ts';

async function withFloor(
  target: AuthTestServer,
  run: (setFloor: (value: string) => Promise<void>) => Promise<void>,
): Promise<void> {
  const url = target.app.iridiumConfig.db.migrateUrl;
  if (url === null) throw new Error('The release policy fixture requires the real migrator role.');
  const { db } = createMaintDb(url);
  try {
    const original = await db
      .selectFrom('schema_meta')
      .select('value')
      .where('key', '=', 'min_client_version')
      .executeTakeFirstOrThrow();
    const setFloor = async (value: string): Promise<void> => {
      await db.transaction().execute(async (transaction) => {
        await transaction
          .updateTable('schema_meta')
          .set({ value })
          .where('key', '=', 'min_client_version')
          .executeTakeFirstOrThrow();
      });
    };
    try {
      await run(setFloor);
    } finally {
      await setFloor(original.value);
    }
  } finally {
    await db.destroy();
  }
}

describe('meta.apiversion.integration [area:ops]', () => {
  it('publishes the real M1 discovery shape, initial persisted floor and matching response counter', async () => {
    const target = await startAuthServer();
    try {
      const response = await target.server.rest().get('/meta');
      expect(response.status).toBe(200);
      const meta = Meta.parse(response.body);
      expect(meta).toMatchObject({
        apiVersion: API_VERSION,
        minClientVersion: RELEASE_MIN_CLIENT_VERSION,
        features: [],
        publicOrigin: target.origin,
        collab: { path: '/collab' },
        mcp: { path: '/mcp', enabled: false },
      });
      expect(Number.isInteger(meta.apiVersion)).toBe(true);
      expect(meta.serverVersion).toMatch(/^[0-9]+\.[0-9]+\.[0-9]+/);
      expect(response.headers.get('x-iridium-api-version')).toBe(String(meta.apiVersion));
      expect(response.headers.get('cache-control')).toBe('public, max-age=300');
      const row = await target.db
        .selectFrom('schema_meta')
        .select('value')
        .where('key', '=', 'min_client_version')
        .executeTakeFirstOrThrow();
      // A fresh schema carries 0055's seeded operator floor, which never lowers the release floor the
      // binary carries: the served floor is their SemVer maximum (09 section 7.1; A54 as amended).
      expect(row.value).toBe('0.0.0');
    } finally {
      await target.stop();
    }
  });

  it('uses a committed mid-session floor immediately for both reads and writes and preserves the refused mutation', async () => {
    const target = await startAuthServer();
    try {
      const user = await seedUser(target, { email: 'live-version-floor@example.test' });
      const session = await signInDesktop(target, user);
      const client = desktopClient(target, session.token);
      expect((await client.get('/auth/me')).status).toBe(200);
      const beforeSessions = await target.db.selectFrom('sessions').select('id').execute();
      await withFloor(target, async (setFloor) => {
        await setFloor('0.1.0');
        const discovery = await client.get('/meta');
        expect(discovery.status).toBe(200);
        expect(Meta.parse(discovery.body).minClientVersion).toBe('0.1.0');
        const beforeWork = target.app.auth.hasher.operationCounts();
        for (const version of ['0.0.0', '0.1.0-rc.1']) {
          const headers = { 'x-iridium-client-version': version };
          // eslint-disable-next-line no-await-in-loop -- both requests follow the observed policy COMMIT
          const read = await client.get('/auth/me', { headers });
          expect(read.status).toBe(426);
          expect(read.body).toMatchObject({
            code: 'client_outdated',
            status: 426,
            detail: '0.1.0',
            requestId: read.headers.get('x-request-id'),
          });
          expect(read.headers.get('x-iridium-api-version')).toBe('1');
          expect(read.contentType).toBe('application/problem+json');
          // eslint-disable-next-line no-await-in-loop -- a correct credential must not cause the refused write
          const write = await desktopClient(target).post('/auth/sessions', {
            headers,
            json: {
              email: user.email,
              password: user.password,
              client: 'desktop',
              deviceName: 'refused',
            },
          });
          expect(write.status).toBe(426);
          expect(write.body).toMatchObject({ code: 'client_outdated', detail: '0.1.0' });
          expect(write.headers.get('x-iridium-api-version')).toBe('1');
        }
        expect(target.app.auth.hasher.operationCounts()).toEqual(beforeWork);
        expect(await target.db.selectFrom('sessions').select('id').execute()).toEqual(
          beforeSessions,
        );
        expect(
          (
            await client.get('/auth/me', {
              headers: { 'x-iridium-client-version': '0.1.0+build.42' },
            })
          ).status,
        ).toBe(200);
        await setFloor('0.0.0');
        expect((await client.get('/auth/me')).status).toBe(200);
      });
    } finally {
      await target.stop();
    }
  });

  it('preserves auth and CSRF priority, rejects malformed versions without floor SQL, and keeps absent-version callers', async () => {
    const target = await startAuthServer();
    try {
      const beforeAuth = target.app.database.queryCounts().app;
      const unauthorized = await target.server
        .rest({ bearer: 'malformed-bearer' })
        .get('/auth/me', { headers: { 'x-iridium-client-version': 'not-a-version' } });
      expect(unauthorized.status).toBe(401);
      expect(unauthorized.headers.get('x-iridium-api-version')).toBe('1');
      expect(target.app.database.queryCounts().app - beforeAuth).toBe(0);
      const csrf = await target.server.rest({ client: 'web' }).post('/auth/sessions', {
        headers: {
          origin: 'https://attacker.example',
          'sec-fetch-site': 'cross-site',
          'x-iridium-client-version': 'not-a-version',
        },
        json: {
          email: 'version-csrf@example.test',
          password: 'not-a-real-password',
          client: 'web',
        },
      });
      expect(csrf.status).toBe(403);
      expect(csrf.body).toMatchObject({ code: 'csrf_rejected' });
      expect(target.app.database.queryCounts().app - beforeAuth).toBe(0);
      for (const version of ['1.2', '01.0.0', '1.0.0-' + 'x'.repeat(64)]) {
        // eslint-disable-next-line no-await-in-loop -- each real explicit malformed header is independently refused
        const response = await desktopClient(target).post('/auth/sessions', {
          headers: { 'x-iridium-client-version': version },
          json: {
            email: 'version-input@example.test',
            password: 'not-a-real-password',
            client: 'desktop',
          },
        });
        expect(response.status).toBe(422);
        expect(response.body).toMatchObject({ code: 'validation_failed' });
      }
      expect(target.app.database.queryCounts().app - beforeAuth).toBe(0);
      await withFloor(target, async (setFloor) => {
        await setFloor('999.0.0');
        const beforeAbsent = target.app.auth.hasher.operationCounts().dummyVerifications;
        const raw = await fetch(target.origin + '/api/v1/auth/sessions', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-iridium-client': 'desktop' },
          body: JSON.stringify({
            email: 'unversioned@example.test',
            password: 'not-a-real-password',
            client: 'desktop',
          }),
        });
        const body: unknown = await raw.json();
        expect(raw.status).toBe(401);
        expect(body).toMatchObject({ code: 'invalid_credentials' });
        expect(target.app.auth.hasher.operationCounts().dummyVerifications - beforeAbsent).toBe(1);
        await expect({
          status: raw.status,
          contentType: 'application/problem+json',
          body,
        }).toMatchOpenApi('auth.createSession', 401);
        expect((await target.server.rest().request('GET', '/healthz')).status).toBe(200);
        const discovery = await target.server
          .rest()
          .get('/meta', { headers: { 'x-iridium-client-version': 'broken' } });
        expect(discovery.status).toBe(200);
        expect(Meta.parse(discovery.body).minClientVersion).toBe('999.0.0');
      });
    } finally {
      await target.stop();
    }
  });

  it('fails closed for a corrupt durable floor and recovers from an authoritative correction', async () => {
    const target = await startAuthServer();
    try {
      await withFloor(target, async (setFloor) => {
        await setFloor('not-semver');
        const broken = await target.server.rest().get('/meta');
        expect(broken.status).toBe(503);
        expect(broken.body).toMatchObject({ code: 'unavailable' });
        await setFloor('0.0.0');
        expect((await target.server.rest().get('/meta')).status).toBe(200);
      });
    } finally {
      await target.stop();
    }
  });
});
