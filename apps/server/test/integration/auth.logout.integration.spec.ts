/**
 * `auth.logout.integration` (04-auth-and-access-control.md sections 3.8, 4.3 and 8.3;
 * 09-api-reference.md section 2.1): `DELETE /auth/sessions/current` revokes the row as `logout` and
 * keeps it for the audit trail, clears the `__Host-` cookie with `Max-Age=0` and the same attributes
 * it was set with, sends `Clear-Site-Data: "cookies","storage"` and `Cache-Control: no-store`, audits
 * `user.logout` once, and publishes `session.revoked` after COMMIT — which is what drops the
 * session's outstanding collaboration tickets and, once the collaboration server subscribes, closes
 * that session's `/collab` connections. A desktop logout does the same without a cookie.
 *
 * The connection-closing half of the inventory row is the `CollabGateway`'s (wave 2); what this
 * suite proves is the event that drives it and the ticket half the auth plugin already subscribes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { idBytes } from '../../src/auth/ids.ts';
import { SESSION_COOKIE_NAME } from '../../src/auth/sessions/cookie.ts';
import type { AuthzEvent } from '../../src/authz/bus.ts';
import {
  desktopClient,
  startAuthServer,
  webClient,
  webHeaders,
  type AuthTestServer,
} from '../support/auth-app.ts';
import { auditRows, seedUser, signInDesktop, signInWeb } from '../support/seed.ts';

let context: AuthTestServer;

beforeAll(async () => {
  context = await startAuthServer();
});

afterAll(async () => {
  await context.stop();
});

async function sessionRow(sessionId: string) {
  return context.db
    .selectFrom('sessions')
    .select(['revoked_at', 'revoked_reason'])
    .where('id', '=', idBytes(sessionId))
    .executeTakeFirstOrThrow();
}

describe('auth.logout.integration [area:auth]', () => {
  it('clears the cookie, marks Clear-Site-Data, keeps the row as revoked and refuses the cookie afterwards', async () => {
    const user = await seedUser(context, { email: 'logout-web@example.test' });
    const jar = await signInWeb(context, user);
    const listed = await webClient(context, jar).get<{ items: { id: string; current: boolean }[] }>(
      '/me/sessions',
    );
    const sessionId = listed.body.items.find((item) => item.current)?.id ?? '';
    expect(sessionId).not.toBe('');
    const cookieHeader = jar.header('/') ?? '';
    expect(cookieHeader.startsWith(`${SESSION_COOKIE_NAME}=irid_ses_`)).toBe(true);

    const out = await webClient(context, jar).del('/auth/sessions/current', {
      headers: webHeaders(context.origin),
    });
    expect(out.status).toBe(204);
    const setCookie = out.response.headers.get('set-cookie') ?? '';
    expect(setCookie.startsWith(`${SESSION_COOKIE_NAME}=`)).toBe(true);
    expect(setCookie).toMatch(/max-age=0/i);
    expect(setCookie).toMatch(/;\s*Secure/i);
    expect(setCookie).toMatch(/;\s*HttpOnly/i);
    expect(setCookie).toMatch(/;\s*SameSite=Lax/i);
    expect(setCookie).toMatch(/;\s*Path=\//);
    expect(out.response.headers.get('clear-site-data')).toBe('"cookies","storage"');
    expect(out.response.headers.get('cache-control')).toContain('no-store');

    // The row is kept, revoked as `logout`: the sessions table is not the audit record, but a
    // revoked row is what the admin view and the sweep read (04 section 4.2).
    const row = await sessionRow(sessionId);
    expect(row.revoked_reason).toBe('logout');
    expect(row.revoked_at).not.toBeNull();
    // The jar has dropped the cookie, and a client that kept the old value is refused.
    expect(jar.header('/')).toBeUndefined();
    const stale = await webClient(context).get('/auth/me', { headers: { cookie: cookieHeader } });
    expect(stale.status).toBe(401);
  });

  it('logs a desktop session out without a cookie, and the bearer is refused afterwards', async () => {
    const user = await seedUser(context, { email: 'logout-desktop@example.test' });
    const { token, sessionId } = await signInDesktop(context, user);
    const out = await desktopClient(context, token).del('/auth/sessions/current');
    expect(out.status).toBe(204);
    expect(out.response.headers.get('set-cookie')).toBeNull();
    expect(out.response.headers.get('clear-site-data')).toBeNull();
    expect((await desktopClient(context, token).get('/auth/me')).status).toBe(401);
    expect((await sessionRow(sessionId)).revoked_reason).toBe('logout');
    // Once revoked, the bearer no longer authenticates the route either.
    expect((await desktopClient(context, token).del('/auth/sessions/current')).status).toBe(401);
  });

  it('audits user.logout exactly once per logout, with the session id', async () => {
    const user = await seedUser(context, { email: 'logout-audit@example.test' });
    const { token, sessionId } = await signInDesktop(context, user);
    await desktopClient(context, token).del('/auth/sessions/current');
    const events = await auditRows(context.db, 'user.logout');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      outcome: 'success',
      credential_type: 'session',
      metadata: { sessionId },
    });
  });

  it('publishes session.revoked after COMMIT and drops the session outstanding tickets', async () => {
    const user = await seedUser(context, { email: 'logout-bus@example.test' });
    const { token, sessionId } = await signInDesktop(context, user);
    const tickets = await desktopClient(context, token).post<{ tickets: string[] }>(
      '/auth/collab-tickets',
      { json: { count: 2 } },
    );
    expect(tickets.status).toBe(201);

    const seen: AuthzEvent[] = [];
    const unsubscribe = context.app.authz.bus.subscribe((event) => {
      // The row is already committed by the time a subscriber runs (section 8.3).
      seen.push(event);
    });
    try {
      await desktopClient(context, token).del('/auth/sessions/current');
    } finally {
      unsubscribe();
    }
    expect(seen).toStrictEqual([
      { type: 'session.revoked', userId: user.id, sessionId, reason: 'logout' },
    ]);
    // The ticket store is a subscriber: a ticket minted before the logout is useless after it.
    for (const ticket of tickets.body.tickets) {
      expect(context.app.auth.tickets.consume(ticket)).toBeNull();
    }
  });
});
