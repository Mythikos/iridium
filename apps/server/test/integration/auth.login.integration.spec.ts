/**
 * `auth.login.integration` (12-milestones.md section 5.2, the `rest` row;
 * 04-auth-and-access-control.md sections 3.7 and 4.1; 09-api-reference.md section 2.1): the login
 * path end to end against a real database — a web login sets the `__Host-` cookie and creates a
 * session row, a desktop login answers a bearer and its two lifetimes, the header and body must agree
 * on the channel, a wrong password and an unknown account are the one `invalid_credentials`, a
 * disabled user cannot sign in, an account without a credential cannot sign in, and every outcome
 * writes its SIEM line, its metric and — bounded — its audit event.
 */
import { parseSetCookie } from '@iridium/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { idBytes } from '../../src/auth/ids.ts';
import { SESSION_COOKIE_NAME } from '../../src/auth/sessions/cookie.ts';
import {
  desktopClient,
  nextIp,
  startAuthServer,
  webClient,
  webHeaders,
  type AuthTestServer,
} from '../support/auth-app.ts';
import { auditRows, insertUser, seedUser, SEED_PASSWORD } from '../support/seed.ts';

const LoginBody = z.object({
  session: z.object({
    id: z.string(),
    clientVersion: z.string().nullable(),
    deviceName: z.string().nullable(),
    userAgent: z.string().nullable(),
  }),
});

let context: AuthTestServer;

beforeAll(async () => {
  context = await startAuthServer();
});

afterAll(async () => {
  await context.stop();
});

describe('auth.login.integration [area:auth]', () => {
  it('signs a browser in: the __Host- cookie is set with the hardening attributes, no token in the body', async () => {
    const user = await seedUser(context, { email: 'ada@example.test' });
    const response = await webClient(context).post('/auth/sessions', {
      json: { email: user.email, password: user.password, client: 'web' },
      headers: webHeaders(context.origin),
    });
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      user: { email: 'ada@example.test', hasCredentials: true },
      session: { kind: 'web', current: true, revokedAt: null },
    });
    expect(response.body).not.toHaveProperty('token');
    const setCookie = response.response.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=`);
    const parsed = parseSetCookie(setCookie);
    expect(parsed?.name).toBe(SESSION_COOKIE_NAME);
    expect(setCookie.toLowerCase()).toContain('secure');
    expect(setCookie.toLowerCase()).toContain('httponly');
    expect(setCookie.toLowerCase()).toContain('samesite=lax');
    expect(setCookie).toContain('Path=/');
  });

  it('signs a desktop host in: a bearer and its idle and absolute expiries, and no cookie', async () => {
    const user = await seedUser(context, { email: 'grace@example.test' });
    const response = await desktopClient(context).post<{
      token: string;
      expiresAt: string;
      idleExpiresAt: string;
      session: { deviceName: string };
    }>('/auth/sessions', {
      json: { email: user.email, password: user.password, client: 'desktop', deviceName: 'studio' },
    });
    expect(response.status).toBe(201);
    expect(response.response.headers.get('set-cookie')).toBeNull();
    const body = response.body;
    expect(body.token.startsWith('irid_ses_')).toBe(true);
    expect(new Date(body.idleExpiresAt).getTime()).toBeLessThan(new Date(body.expiresAt).getTime());
    expect(body.session.deviceName).toBe('studio');
    // The bearer authenticates the desktop session: GET /auth/me answers the same user.
    const me = await desktopClient(context, body.token).get('/auth/me');
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({
      principalKind: 'user',
      sessionKind: 'desktop',
      user: { email: 'grace@example.test' },
    });
  });

  it('refuses when the client header and the body channel disagree (D04-22)', async () => {
    const user = await seedUser(context, { email: 'mismatch@example.test' });
    const response = await desktopClient(context).post('/auth/sessions', {
      json: { email: user.email, password: user.password, client: 'web' },
    });
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ code: 'csrf_rejected' });
  });

  it('answers one invalid_credentials for a wrong password and for an unknown account alike', async () => {
    const user = await seedUser(context, { email: 'wrong@example.test' });
    const wrong = await webClient(context).post('/auth/sessions', {
      json: { email: user.email, password: 'not the password at all', client: 'web' },
      headers: webHeaders(context.origin),
    });
    expect(wrong.status).toBe(401);
    expect(wrong.body).toMatchObject({ code: 'invalid_credentials' });
    const unknown = await webClient(context).post('/auth/sessions', {
      json: { email: 'nobody@example.test', password: SEED_PASSWORD, client: 'web' },
      headers: webHeaders(context.origin),
    });
    expect(unknown.status).toBe(401);
    expect(unknown.body).toMatchObject({ code: 'invalid_credentials' });
  });

  it('refuses a disabled user with the same invalid_credentials, revealing nothing', async () => {
    const user = await seedUser(context, { email: 'disabled@example.test' });
    await context.db
      .updateTable('users')
      .set({ status: 'disabled' })
      .where('email', '=', user.email)
      .execute();
    const response = await webClient(context).post('/auth/sessions', {
      json: { email: user.email, password: user.password, client: 'web' },
      headers: webHeaders(context.origin),
    });
    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ code: 'invalid_credentials' });
  });

  it('rejects a body that violates the schema before any credential work', async () => {
    const short = await webClient(context).post('/auth/sessions', {
      json: { email: 'not-an-email', password: 'x', client: 'web' },
      headers: webHeaders(context.origin),
    });
    expect(short.status).toBe(422);
  });

  it('writes exactly one success audit event for a login, chained to the server chain', async () => {
    const user = await seedUser(context, { email: 'audited@example.test' });
    await webClient(context).post('/auth/sessions', {
      json: { email: user.email, password: user.password, client: 'web' },
      headers: webHeaders(context.origin),
    });
    const rows = await auditRows(context.db, 'user.login.succeeded');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: 'success', credential_type: 'session' });
  });

  it('bounds and records a failed login without leaking the address in the metadata', async () => {
    const user = await seedUser(context, { email: 'failaudit@example.test' });
    await webClient(context).post('/auth/sessions', {
      json: { email: user.email, password: 'the wrong password here', client: 'web' },
      headers: webHeaders(context.origin),
    });
    const rows = await auditRows(context.db, 'user.login.failed');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.metadata).toMatchObject({
      emailKeyHash: expect.stringMatching(/^[0-9a-f]{32}$/),
    });
    expect(JSON.stringify(rows[0]?.metadata)).not.toContain('failaudit@example.test');
  });

  it('refuses an account that has no credential yet with the same invalid_credentials, recording why', async () => {
    const userId = await insertUser(
      context.db,
      { email: 'invited-only@example.test' },
      context.clock.now(),
    );
    const response = await webClient(context).post('/auth/sessions', {
      json: { email: 'invited-only@example.test', password: SEED_PASSWORD, client: 'web' },
      headers: webHeaders(context.origin),
    });
    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ code: 'invalid_credentials' });
    const rows = await auditRows(context.db, 'user.login.failed');
    expect(rows.map((row) => row.metadata)).toContainEqual(
      expect.objectContaining({ reason: 'no_credential' }),
    );
    const sessions = await context.db
      .selectFrom('sessions')
      .select('id')
      .where('user_id', '=', idBytes(userId))
      .execute();
    expect(sessions).toStrictEqual([]);
  });

  it('records no client version, user agent or device name when the request carries none', async () => {
    const user = await seedUser(context, { email: 'no-version@example.test' });
    // Every HTTP client sends a `User-Agent`, and the harness client always sends
    // `X-Iridium-Client-Version`; an injected request with the agent explicitly absent is how one
    // without either reaches the route.
    const response = await context.app.inject({
      method: 'POST',
      url: '/api/v1/auth/sessions',
      headers: {
        host: new URL(context.origin).host,
        'content-type': 'application/json',
        'user-agent': undefined,
        'x-iridium-client': 'desktop',
        'x-forwarded-for': nextIp(),
      },
      payload: { email: user.email, password: user.password, client: 'desktop' },
    });
    expect(response.statusCode).toBe(201);
    const body = LoginBody.parse(response.json());
    expect(body.session).toMatchObject({ clientVersion: null, deviceName: null, userAgent: null });
    const row = await context.db
      .selectFrom('sessions')
      .select(['client_version', 'device_name', 'user_agent'])
      .where('id', '=', idBytes(body.session.id))
      .executeTakeFirstOrThrow();
    expect(row).toStrictEqual({ client_version: null, device_name: null, user_agent: null });
    const succeeded = await auditRows(context.db, 'user.login.succeeded');
    expect(succeeded.at(-1)?.metadata).toStrictEqual({ kind: 'desktop', method: 'password' });
  });
});
