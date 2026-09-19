/**
 * `auth.sessions-web.integration` (04-auth-and-access-control.md sections 4.1 to 4.3 and 4.7;
 * D04-01; D04-06; 09-api-reference.md sections 2.1 and 2.3): the web session over the real routes
 * and a real database — the `__Host-` cookie carries exactly the hardening attributes and an
 * absolute `Max-Age`; the idle window slides on use and lapses without it; the absolute cap ends a
 * session however often it is touched; a lapsed row is finalised `expired`; the cookie value is
 * refused as a bearer; the per-kind cap replaces the oldest session; and revoking the current
 * session by id behaves like logout. Time is the server's `ManualClock`, so every window is exact.
 */
import { LIMITS, mintToken } from '@iridium/contracts';
import { parseSetCookie, type CookieJar } from '@iridium/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { idBytes } from '../../src/auth/ids.ts';
import { SESSION_COOKIE_NAME } from '../../src/auth/sessions/cookie.ts';
import {
  desktopClient,
  startAuthServer,
  webClient,
  webHeaders,
  type AuthTestServer,
} from '../support/auth-app.ts';
import { seedUser, signInWeb, type SeededUser } from '../support/seed.ts';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** The web lifetimes of section 4.1 as the harness configures them (the `EnvSchema` defaults). */
const WEB_IDLE_MS = 24 * HOUR_MS;
const WEB_ABSOLUTE_MS = 14 * DAY_MS;

let context: AuthTestServer;

beforeAll(async () => {
  context = await startAuthServer();
});

afterAll(async () => {
  await context.stop();
});

interface SessionColumns {
  readonly kind: string;
  readonly created_at: Date;
  readonly last_seen_at: Date;
  readonly last_authenticated_at: Date;
  readonly idle_expires_at: Date;
  readonly absolute_expires_at: Date;
  readonly revoked_at: Date | null;
  readonly revoked_reason: string | null;
}

async function sessionsOf(user: SeededUser): Promise<readonly SessionColumns[]> {
  return context.db
    .selectFrom('sessions')
    .select([
      'kind',
      'created_at',
      'last_seen_at',
      'last_authenticated_at',
      'idle_expires_at',
      'absolute_expires_at',
      'revoked_at',
      'revoked_reason',
    ])
    .where('user_id', '=', idBytes(user.id))
    .orderBy('created_at', 'asc')
    .execute();
}

async function onlySession(user: SeededUser): Promise<SessionColumns> {
  const rows = await sessionsOf(user);
  expect(rows).toHaveLength(1);
  const [row] = rows;
  if (row === undefined) throw new Error('no session row');
  return row;
}

/** `GET /auth/me` with the jar, from a fresh address so no per-IP bucket is shared. */
async function me(jar: CookieJar): Promise<number> {
  return (await webClient(context, jar).get('/auth/me')).status;
}

describe('auth.sessions-web.integration [area:auth]', () => {
  it('issues the __Host- cookie with Secure, HttpOnly, SameSite=Lax, Path=/ and the absolute Max-Age', async () => {
    const user = await seedUser(context, { email: 'web-issue@example.test' });
    const response = await webClient(context).post('/auth/sessions', {
      json: { email: user.email, password: user.password, client: 'web' },
      headers: webHeaders(context.origin),
    });
    expect(response.status).toBe(201);
    expect(response.body).not.toHaveProperty('token');
    expect(response.response.headers.get('cache-control')).toContain('no-store');
    const setCookie = response.response.headers.get('set-cookie') ?? '';
    const cookie = parseSetCookie(setCookie);
    expect(cookie?.name).toBe(SESSION_COOKIE_NAME);
    expect(cookie?.value.startsWith('irid_ses_')).toBe(true);
    expect(setCookie).toMatch(/;\s*Secure/i);
    expect(setCookie).toMatch(/;\s*HttpOnly/i);
    expect(setCookie).toMatch(/;\s*SameSite=Lax/i);
    expect(setCookie).toMatch(/;\s*Path=\//);
    expect(setCookie).not.toMatch(/Domain=/i);
    // `Max-Age` is the seconds to the absolute expiry; idle expiry is not represented in the cookie.
    expect(setCookie).toMatch(new RegExp(`Max-Age=${String(WEB_ABSOLUTE_MS / 1000)}\\b`));

    const row = await onlySession(user);
    expect(row.kind).toBe('web');
    expect(row.last_authenticated_at.getTime()).toBe(row.created_at.getTime());
    expect(row.idle_expires_at.getTime()).toBe(row.created_at.getTime() + WEB_IDLE_MS);
    expect(row.absolute_expires_at.getTime()).toBe(row.created_at.getTime() + WEB_ABSOLUTE_MS);
  });

  it('slides the idle window on use and lets it lapse without use, finalising the row as expired', async () => {
    const user = await seedUser(context, { email: 'web-idle@example.test' });
    const jar = await signInWeb(context, user);
    const issued = await onlySession(user);

    // Twelve hours in, a request slides the idle expiry forward to now + 24 h.
    context.clock.jump(context.clock.now() + 12 * HOUR_MS);
    expect(await me(jar)).toBe(200);
    const slid = await onlySession(user);
    expect(slid.idle_expires_at.getTime()).toBe(context.clock.now() + WEB_IDLE_MS);
    expect(slid.last_seen_at.getTime()).toBe(context.clock.now());
    expect(slid.idle_expires_at.getTime()).toBeGreaterThan(issued.idle_expires_at.getTime());

    // Another twenty hours later — past the original idle expiry, inside the slid one — still live.
    context.clock.jump(context.clock.now() + 20 * HOUR_MS);
    expect(await me(jar)).toBe(200);

    // Then twenty-four hours of silence: refused, and the row is finalised rather than left live.
    context.clock.jump(context.clock.now() + WEB_IDLE_MS);
    expect(await me(jar)).toBe(401);
    const lapsed = await onlySession(user);
    expect(lapsed.revoked_reason).toBe('expired');
    expect(lapsed.revoked_at).not.toBeNull();
    // Refused once expired, whatever the clock says afterwards.
    expect(await me(jar)).toBe(401);
  });

  it('ends the session at the absolute cap however often it is touched', async () => {
    const user = await seedUser(context, { email: 'web-absolute@example.test' });
    const jar = await signInWeb(context, user);
    const issued = await onlySession(user);
    const absoluteAt = issued.absolute_expires_at.getTime();

    // Touch every twenty hours, inside the idle window each time, until just before the cap.
    for (let touches = 0; touches < 16; touches += 1) {
      context.clock.jump(context.clock.now() + 20 * HOUR_MS);
      // eslint-disable-next-line no-await-in-loop -- the touches are sequential by definition
      expect(await me(jar)).toBe(200);
      // eslint-disable-next-line no-await-in-loop -- the row is read after each touch
      const row = await onlySession(user);
      // The slid idle expiry never passes the absolute cap.
      expect(row.idle_expires_at.getTime()).toBeLessThanOrEqual(absoluteAt);
    }
    expect(context.clock.now()).toBeLessThan(absoluteAt);

    context.clock.jump(absoluteAt);
    expect(await me(jar)).toBe(401);
    expect((await onlySession(user)).revoked_reason).toBe('expired');
  });

  it('refuses the cookie value as a bearer and a desktop bearer as a cookie (D04-06)', async () => {
    const user = await seedUser(context, { email: 'web-binding@example.test' });
    const jar = await signInWeb(context, user);
    const cookieValue = jar.header('/')?.split('=')[1] ?? '';
    expect(cookieValue.startsWith('irid_ses_')).toBe(true);
    // The very same live credential, on the other channel, is nothing.
    expect((await desktopClient(context, cookieValue).get('/auth/me')).status).toBe(401);
    expect(await me(jar)).toBe(200);

    const desktop = await desktopClient(context).post<{ token: string }>('/auth/sessions', {
      json: { email: user.email, password: user.password, client: 'desktop' },
    });
    expect(desktop.status).toBe(201);
    const asCookie = await webClient(context).get('/auth/me', {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${desktop.body.token}` },
    });
    expect(asCookie.status).toBe(401);
  });

  it('replaces the oldest web session once the per-kind cap is exceeded', async () => {
    const user = await seedUser(context, { email: 'web-cap@example.test' });
    const jars: CookieJar[] = [];
    for (let index = 0; index < LIMITS.SESSIONS_PER_USER_PER_KIND; index += 1) {
      // Each login is one clock tick later, so `last_seen_at` orders the rows unambiguously.
      context.clock.jump(context.clock.now() + 1000);
      // eslint-disable-next-line no-await-in-loop -- twenty sequential logins by design
      jars.push(await signInWeb(context, user));
    }
    const [oldest] = jars;
    if (oldest === undefined) throw new Error('no session');
    expect(await me(oldest)).toBe(200);

    context.clock.jump(context.clock.now() + 1000);
    const newest = await signInWeb(context, user);
    expect(await me(newest)).toBe(200);
    expect(await me(oldest)).toBe(401);
    const rows = await sessionsOf(user);
    expect(rows).toHaveLength(LIMITS.SESSIONS_PER_USER_PER_KIND + 1);
    expect(rows[0]?.revoked_reason).toBe('replaced');
    expect(rows.filter((row) => row.revoked_at === null)).toHaveLength(
      LIMITS.SESSIONS_PER_USER_PER_KIND,
    );
  });

  it('treats revoking the current session by id like logout: cookie cleared, cookie refused', async () => {
    const user = await seedUser(context, { email: 'web-self-revoke@example.test' });
    const jar = await signInWeb(context, user);
    const listed = await webClient(context, jar).get<{ items: { id: string; current: boolean }[] }>(
      '/me/sessions',
    );
    const current = listed.body.items.find((item) => item.current)?.id;
    expect(current).toBeDefined();
    const revoked = await webClient(context, jar).del(`/me/sessions/${current ?? ''}`, {
      headers: webHeaders(context.origin),
    });
    expect(revoked.status).toBe(204);
    expect(revoked.response.headers.get('set-cookie')).toMatch(/max-age=0/i);
    expect(revoked.response.headers.get('clear-site-data')).toContain('"cookies"');
    expect((await onlySession(user)).revoked_reason).toBe('logout');
    expect(await me(jar)).toBe(401);
  });

  it('refuses a live session whose owner was disabled', async () => {
    const user = await seedUser(context, { email: 'web-disabled@example.test' });
    const jar = await signInWeb(context, user);
    expect(await me(jar)).toBe(200);
    await context.db
      .updateTable('users')
      .set({ status: 'disabled' })
      .where('id', '=', idBytes(user.id))
      .execute();
    expect(await me(jar)).toBe(401);
    // The row itself is untouched: the refusal comes from `users.status`, not from a revocation.
    expect((await onlySession(user)).revoked_at).toBeNull();
  });

  it('refuses a well-formed cookie whose id no session row carries', async () => {
    const stranger = await webClient(context).get('/auth/me', {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${mintToken('ses').raw}` },
    });
    expect(stranger.status).toBe(401);
    expect(stranger.body).toMatchObject({ code: 'unauthenticated' });
  });
});
