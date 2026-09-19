/**
 * `auth.sessions-desktop.integration` (04-auth-and-access-control.md sections 4.1, 4.2, 4.5 and
 * 4.7; D04-01; D04-06; 09-api-reference.md sections 2.1 and 2.3): the desktop session over the real
 * routes and a real database — the bearer and its two lifetimes are answered in the body and no
 * cookie is set; the thirty-day idle window slides on use and lapses without it; the ninety-day cap
 * ends a session however often it is touched; the bearer is refused as a cookie; a login from the
 * same device replaces that device's session and the per-kind cap replaces the oldest; and the
 * caller lists and revokes their own sessions, with a foreign id answered `404`.
 */
import { LIMITS } from '@iridium/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { idBytes } from '../../src/auth/ids.ts';
import { SESSION_COOKIE_NAME } from '../../src/auth/sessions/cookie.ts';
import { LAST_SEEN_WRITE_INTERVAL_MS } from '../../src/auth/sessions/verify.ts';
import {
  desktopClient,
  startAuthServer,
  webClient,
  webHeaders,
  type AuthTestServer,
} from '../support/auth-app.ts';
import { auditRows, seedUser, signInDesktop, signInWeb, type SeededUser } from '../support/seed.ts';

const DAY_MS = 86_400_000;
/** The desktop lifetimes of section 4.1 as the harness configures them (the `EnvSchema` defaults). */
const DESKTOP_IDLE_MS = 30 * DAY_MS;
const DESKTOP_ABSOLUTE_MS = 90 * DAY_MS;

let context: AuthTestServer;

beforeAll(async () => {
  context = await startAuthServer();
});

afterAll(async () => {
  await context.stop();
});

interface SessionColumns {
  readonly id: Buffer;
  readonly kind: string;
  readonly client_name: string | null;
  readonly client_version: string | null;
  readonly device_name: string | null;
  readonly created_at: Date;
  readonly last_seen_at: Date;
  readonly idle_expires_at: Date;
  readonly absolute_expires_at: Date;
  readonly revoked_at: Date | null;
  readonly revoked_reason: string | null;
}

const COLUMNS = [
  'id',
  'kind',
  'client_name',
  'client_version',
  'device_name',
  'created_at',
  'last_seen_at',
  'idle_expires_at',
  'absolute_expires_at',
  'revoked_at',
  'revoked_reason',
] as const;

async function sessionsOf(user: SeededUser): Promise<readonly SessionColumns[]> {
  return context.db
    .selectFrom('sessions')
    .select(COLUMNS)
    .where('user_id', '=', idBytes(user.id))
    .orderBy('created_at', 'asc')
    .execute();
}

async function sessionById(sessionId: string): Promise<SessionColumns> {
  return context.db
    .selectFrom('sessions')
    .select(COLUMNS)
    .where('id', '=', idBytes(sessionId))
    .executeTakeFirstOrThrow();
}

async function me(bearer: string): Promise<number> {
  return (await desktopClient(context, bearer).get('/auth/me')).status;
}

describe('auth.sessions-desktop.integration [area:auth]', () => {
  it('answers the bearer with its idle and absolute expiries, sets no cookie, and records the device', async () => {
    const user = await seedUser(context, { email: 'desktop-issue@example.test' });
    const response = await desktopClient(context).post<{
      token: string;
      expiresAt: string;
      idleExpiresAt: string;
      session: {
        id: string;
        kind: string;
        deviceName: string;
        clientName: string;
        current: boolean;
      };
    }>('/auth/sessions', {
      json: { email: user.email, password: user.password, client: 'desktop', deviceName: 'studio' },
    });
    expect(response.status).toBe(201);
    expect(response.response.headers.get('set-cookie')).toBeNull();
    expect(response.response.headers.get('cache-control')).toContain('no-store');
    expect(response.body.token.startsWith('irid_ses_')).toBe(true);
    const now = context.clock.now();
    expect(new Date(response.body.idleExpiresAt).getTime()).toBe(now + DESKTOP_IDLE_MS);
    expect(new Date(response.body.expiresAt).getTime()).toBe(now + DESKTOP_ABSOLUTE_MS);
    expect(response.body.session).toMatchObject({
      kind: 'desktop',
      deviceName: 'studio',
      clientName: 'desktop',
      current: true,
    });

    const row = await sessionById(response.body.session.id);
    expect(row.device_name).toBe('studio');
    // `X-Iridium-Client-Version` is recorded on the row (A54); the harness reports `0.0.0`.
    expect(row.client_version).toBe('0.0.0');
    expect(await me(response.body.token)).toBe(200);
  });

  it('slides the thirty-day idle window on use and lets it lapse without use', async () => {
    const user = await seedUser(context, { email: 'desktop-idle@example.test' });
    const { token, sessionId } = await signInDesktop(context, user);

    context.clock.jump(context.clock.now() + 20 * DAY_MS);
    expect(await me(token)).toBe(200);
    expect((await sessionById(sessionId)).idle_expires_at.getTime()).toBe(
      context.clock.now() + DESKTOP_IDLE_MS,
    );

    context.clock.jump(context.clock.now() + 20 * DAY_MS);
    expect(await me(token)).toBe(200);

    context.clock.jump(context.clock.now() + DESKTOP_IDLE_MS);
    expect(await me(token)).toBe(401);
    expect((await sessionById(sessionId)).revoked_reason).toBe('expired');
  });

  it('ends the session at the ninety-day cap however often it is touched', async () => {
    const user = await seedUser(context, { email: 'desktop-absolute@example.test' });
    const { token, sessionId } = await signInDesktop(context, user);
    const absoluteAt = (await sessionById(sessionId)).absolute_expires_at.getTime();

    for (let touches = 0; touches < 4; touches += 1) {
      context.clock.jump(context.clock.now() + 20 * DAY_MS);
      // eslint-disable-next-line no-await-in-loop -- the touches are sequential by definition
      expect(await me(token)).toBe(200);
      // eslint-disable-next-line no-await-in-loop -- the row is read after each touch
      const row = await sessionById(sessionId);
      expect(row.idle_expires_at.getTime()).toBeLessThanOrEqual(absoluteAt);
    }
    context.clock.jump(absoluteAt);
    expect(await me(token)).toBe(401);
    expect((await sessionById(sessionId)).revoked_reason).toBe('expired');
  });

  it('writes last_seen_at at most once per interval, and the idle expiry only with it', async () => {
    const user = await seedUser(context, { email: 'desktop-lastseen@example.test' });
    const { token, sessionId } = await signInDesktop(context, user);
    const issued = await sessionById(sessionId);

    context.clock.jump(context.clock.now() + LAST_SEEN_WRITE_INTERVAL_MS - 1);
    expect(await me(token)).toBe(200);
    const inside = await sessionById(sessionId);
    expect(inside.last_seen_at.getTime()).toBe(issued.last_seen_at.getTime());
    expect(inside.idle_expires_at.getTime()).toBe(issued.idle_expires_at.getTime());

    context.clock.jump(context.clock.now() + 1);
    expect(await me(token)).toBe(200);
    const past = await sessionById(sessionId);
    expect(past.last_seen_at.getTime()).toBe(context.clock.now());
    expect(past.idle_expires_at.getTime()).toBe(context.clock.now() + DESKTOP_IDLE_MS);
  });

  it('refuses the bearer as a cookie (D04-06)', async () => {
    const user = await seedUser(context, { email: 'desktop-binding@example.test' });
    const { token } = await signInDesktop(context, user);
    const asCookie = await webClient(context).get('/auth/me', {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
    });
    expect(asCookie.status).toBe(401);
    expect(await me(token)).toBe(200);
  });

  it('replaces the previous session of the same device, and leaves other devices alone', async () => {
    const user = await seedUser(context, { email: 'desktop-device@example.test' });
    const laptop = await signInDesktop(context, user, 'laptop');
    const phone = await signInDesktop(context, user, 'phone');
    const laptopAgain = await signInDesktop(context, user, 'laptop');
    expect(await me(laptop.token)).toBe(401);
    expect((await sessionById(laptop.sessionId)).revoked_reason).toBe('replaced');
    expect(await me(phone.token)).toBe(200);
    expect(await me(laptopAgain.token)).toBe(200);
  });

  it('replaces the oldest desktop session once the per-kind cap is exceeded, web sessions untouched', async () => {
    const user = await seedUser(context, { email: 'desktop-cap@example.test' });
    const web = await signInWeb(context, user);
    const tokens: string[] = [];
    for (let index = 0; index < LIMITS.SESSIONS_PER_USER_PER_KIND; index += 1) {
      context.clock.jump(context.clock.now() + 1000);
      // eslint-disable-next-line no-await-in-loop -- twenty sequential logins by design
      tokens.push((await signInDesktop(context, user, `device-${String(index)}`)).token);
    }
    const [oldest] = tokens;
    if (oldest === undefined) throw new Error('no session');
    context.clock.jump(context.clock.now() + 1000);
    const newest = await signInDesktop(context, user, 'device-newest');
    expect(await me(newest.token)).toBe(200);
    expect(await me(oldest)).toBe(401);
    const rows = await sessionsOf(user);
    const desktopRows = rows.filter((row) => row.kind === 'desktop');
    expect(desktopRows[0]?.revoked_reason).toBe('replaced');
    expect(desktopRows.filter((row) => row.revoked_at === null)).toHaveLength(
      LIMITS.SESSIONS_PER_USER_PER_KIND,
    );
    // The web session is a separate cap and survives.
    expect((await webClient(context, web).get('/auth/me')).status).toBe(200);
  });

  it('lists the live sessions with the current one first', async () => {
    const user = await seedUser(context, { email: 'desktop-list@example.test' });
    await signInWeb(context, user);
    const { token } = await signInDesktop(context, user, 'laptop');
    const list = await desktopClient(context, token).get<{
      items: { kind: string; current: boolean; deviceName: string | null }[];
    }>('/me/sessions');
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(2);
    expect(list.body.items[0]).toMatchObject({
      kind: 'desktop',
      current: true,
      deviceName: 'laptop',
    });
    expect(list.body.items.filter((item) => item.current)).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain(token);
  });

  it('revokes another of the caller own sessions by id, stops listing it, and audits it', async () => {
    const user = await seedUser(context, { email: 'desktop-revoke@example.test' });
    const web = await signInWeb(context, user);
    const { token, sessionId } = await signInDesktop(context, user);
    const revoked = await webClient(context, web).del(`/me/sessions/${sessionId}`, {
      headers: webHeaders(context.origin),
    });
    expect(revoked.status).toBe(204);
    // Not the current session: no cookie change and no Clear-Site-Data.
    expect(revoked.response.headers.get('set-cookie')).toBeNull();
    expect(revoked.response.headers.get('clear-site-data')).toBeNull();
    const after = await webClient(context, web).get<{ items: { id: string }[] }>('/me/sessions');
    expect(after.body.items.some((item) => item.id === sessionId)).toBe(false);
    expect(await me(token)).toBe(401);
    expect((await sessionById(sessionId)).revoked_reason).toBe('logout');
    const events = await auditRows(context.db, 'session.revoked');
    expect(events).toHaveLength(1);
    expect(events[0]?.metadata).toMatchObject({ sessionId, reason: 'logout' });
    // Revoking it again is 404: the row is no longer one of the caller's live sessions.
    expect(
      (
        await webClient(context, web).del(`/me/sessions/${sessionId}`, {
          headers: webHeaders(context.origin),
        })
      ).status,
    ).toBe(404);
  });

  it('answers 404 for a session that belongs to another user, and for an unknown id', async () => {
    const owner = await seedUser(context, { email: 'desktop-owner@example.test' });
    const stranger = await seedUser(context, { email: 'desktop-stranger@example.test' });
    const ownerToken = (await signInDesktop(context, owner)).token;
    const strangerSession = await signInDesktop(context, stranger);
    const foreign = await desktopClient(context, ownerToken).del(
      `/me/sessions/${strangerSession.sessionId}`,
    );
    expect(foreign.status).toBe(404);
    expect(await me(strangerSession.token)).toBe(200);
    const unknown = await desktopClient(context, ownerToken).del(
      '/me/sessions/019948c4-0000-7000-8000-0000000000ff',
    );
    expect(unknown.status).toBe(404);
  });
});
