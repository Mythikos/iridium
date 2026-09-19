/**
 * `auth.me.integration` (09-api-reference.md sections 1.2, 1.7, 2.1 and 2.3;
 * 04-auth-and-access-control.md sections 3.3, 6.3, 7.4 and 11.4; D04-16; D04-20): the caller's own
 * representation and the routes that read or change it — `GET /auth/me` describes a session
 * principal with its session, and a token principal with `isServerAdmin: false` and its `token`
 * member whoever owns it, always `no-store` and never with a validator; an expired token is
 * `401 token_expired`, a revoked one the generic `401`, and repeated presentations of one refused
 * token write one bounded `token.denied` row; `PATCH /me` requires `If-Match`, answers `428` and
 * `409` with the current representation, and moves the version and the `ETag` on success;
 * set-password link redemption is throttled on the link id; and the ticket route refuses the 301st
 * request in a minute from one session, and the 1 001st from one address, with `429`.
 */
import { LIMITS, mintToken, READ_BUNDLE } from '@iridium/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { idBytes } from '../../src/auth/ids.ts';
import {
  desktopClient,
  nextIp,
  startAuthServer,
  webClient,
  webHeaders,
  type AuthTestServer,
} from '../support/auth-app.ts';
import { withOtherSecret } from '../support/credentials.ts';
import {
  auditRows,
  insertToken,
  insertUser,
  insertVault,
  seedUser,
  signInDesktop,
  signInWeb,
} from '../support/seed.ts';

const HOUR_MS = 3_600_000;

let context: AuthTestServer;

beforeAll(async () => {
  context = await startAuthServer();
});

afterAll(async () => {
  await context.stop();
});

/** The `iridium_token_auth_failures_total` series, by reason label. */
async function tokenAuthFailures(): Promise<Record<string, number>> {
  const metric = (await context.app.metrics.snapshot()).find(
    (entry) => entry.name === 'iridium_token_auth_failures_total',
  );
  const counts: Record<string, number> = {};
  for (const sample of metric?.values ?? []) counts[String(sample.labels['reason'])] = sample.value;
  return counts;
}

interface MeBody {
  readonly user: { id: string; version: number; displayName: string };
  readonly isServerAdmin: boolean;
  readonly principalKind: 'user' | 'token';
  readonly sessionKind?: string;
  readonly sessionId?: string;
  readonly lastAuthenticatedAt?: string;
  readonly token?: {
    id: string;
    name: string;
    scopes: string[];
    allVaults: boolean;
    vaultIds: string[];
    expiresAt: string;
  };
}

describe('auth.me.integration [area:auth]', () => {
  it('describes a session principal with its session, no-store and without a validator', async () => {
    const user = await seedUser(context, { email: 'me-user@example.test' });
    const { token, sessionId } = await signInDesktop(context, user);
    const client = desktopClient(context, token);
    const me = await client.get<MeBody>('/auth/me');
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({
      user: { id: user.id, version: 1, hasCredentials: true },
      isServerAdmin: false,
      principalKind: 'user',
      sessionKind: 'desktop',
      sessionId,
    });
    expect(me.body.token).toBeUndefined();
    expect(me.body.lastAuthenticatedAt).toBe(context.clock.date().toISOString());
    expect(me.response.headers.get('cache-control')).toContain('no-store');
    // `GET /auth/me` is not a validated resource (09 section 1.7): no ETag, nothing to revalidate.
    expect(me.response.headers.get('etag')).toBeNull();
    expect((await client.get('/auth/me', { headers: { 'if-none-match': '"1"' } })).status).toBe(
      200,
    );
  });

  it('describes a token principal with isServerAdmin false and its token member, whoever owns it', async () => {
    const admin = await seedUser(context, { email: 'me-admin@example.test', isServerAdmin: true });
    const vault = await insertVault(
      context.db,
      { name: 'me-vault', createdBy: admin.id },
      context.clock.now(),
    );
    const expiresAt = new Date(context.clock.now() + HOUR_MS);
    const listed = await insertToken(
      context.db,
      { ownerId: admin.id, vaultIds: [vault], expiresAt, adminOwned: true },
      context.clock.now(),
    );
    const me = await desktopClient(context, listed.raw).get<MeBody>('/auth/me');
    expect(me.status).toBe(200);
    expect(me.body).toStrictEqual({
      user: expect.objectContaining({ id: admin.id, isServerAdmin: true }),
      isServerAdmin: false,
      principalKind: 'token',
      token: {
        id: listed.id,
        name: 'seeded',
        scopes: [...READ_BUNDLE],
        allVaults: false,
        vaultIds: [vault],
        expiresAt: expiresAt.toISOString(),
      },
    });
    const everywhere = await insertToken(
      context.db,
      { ownerId: admin.id, allVaults: true, expiresAt },
      context.clock.now(),
    );
    const all = await desktopClient(context, everywhere.raw).get<MeBody>('/auth/me');
    expect(all.body.token).toMatchObject({ allVaults: true, vaultIds: [] });
  });

  it('answers token_expired for an expired token and the generic 401 for a revoked one, auditing once', async () => {
    const user = await seedUser(context, { email: 'me-denied@example.test' });
    const failuresBefore = await tokenAuthFailures();
    const expired = await insertToken(
      context.db,
      { ownerId: user.id, allVaults: true, expiresAt: new Date(context.clock.now() - 1) },
      context.clock.now(),
    );
    const refused = await desktopClient(context, expired.raw).get('/auth/me');
    expect(refused.status).toBe(401);
    expect(refused.body).toMatchObject({ code: 'token_expired', detail: 'the token has expired' });
    const revoked = await insertToken(
      context.db,
      {
        ownerId: user.id,
        allVaults: true,
        expiresAt: new Date(context.clock.now() + HOUR_MS),
        revokedAt: new Date(context.clock.now() - 1),
      },
      context.clock.now(),
    );
    for (let attempt = 0; attempt < 3; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop -- a revoked token left in an agent's config retries
      const response = await desktopClient(context, revoked.raw).get('/auth/me');
      expect(response.status).toBe(401);
      expect(response.body).toMatchObject({ code: 'unauthenticated' });
    }
    // Bounded per token id (10 min): one row for the expired token, one for the revoked one.
    const denied = await auditRows(context.db, 'token.denied');
    expect(denied).toHaveLength(2);
    expect(denied.map((row) => row.credential_type)).toStrictEqual(['pat', 'pat']);
    expect(denied.map((row) => row.metadata)).toStrictEqual([
      { reason: 'expired', surface: 'rest' },
      { reason: 'revoked', surface: 'rest' },
    ]);
    // An unknown token id names no row and writes nothing; the wrong secret against the revoked
    // token's id stays inside that id's window; the wrong secret against a live token names its row
    // and is the third bounded event.
    const unknown = await desktopClient(context, mintToken('pat').raw).get('/auth/me');
    expect(unknown.status).toBe(401);
    expect(unknown.body).toMatchObject({ code: 'unauthenticated' });
    expect(await auditRows(context.db, 'token.denied')).toHaveLength(2);
    expect(
      (await desktopClient(context, withOtherSecret(revoked.raw)).get('/auth/me')).status,
    ).toBe(401);
    expect(await auditRows(context.db, 'token.denied')).toHaveLength(2);
    const live = await insertToken(
      context.db,
      { ownerId: user.id, allVaults: true, expiresAt: new Date(context.clock.now() + HOUR_MS) },
      context.clock.now(),
    );
    const wrongSecret = await desktopClient(context, withOtherSecret(live.raw)).get('/auth/me');
    expect(wrongSecret.status).toBe(401);
    const three = await auditRows(context.db, 'token.denied');
    expect(three).toHaveLength(3);
    expect(three[2]?.metadata).toStrictEqual({ reason: 'secret_mismatch', surface: 'rest' });
    // The right secret still works: the denials never touched the row.
    expect((await desktopClient(context, live.raw).get('/auth/me')).status).toBe(200);
    // `iridium_token_auth_failures_total{reason}` counted every refusal under 11's labels, the
    // unknown id and the two wrong secrets as one `unknown`; a shape failure is `bad_format`.
    expect((await desktopClient(context, 'irid_pat_not-a-token').get('/auth/me')).status).toBe(401);
    const failuresAfter = await tokenAuthFailures();
    const delta = Object.fromEntries(
      Object.entries(failuresAfter).map(([reason, count]) => [
        reason,
        count - (failuresBefore[reason] ?? 0),
      ]),
    );
    expect(delta).toStrictEqual({
      bad_format: 1,
      unknown: 3,
      revoked: 3,
      expired: 1,
      wrong_kind_for_route: 0,
      audience_mismatch: 0,
      consent_revoked: 0,
      client_disabled: 0,
      user_disabled: 0,
    });
  });

  it('changes the display name under If-Match, answering 428 and 409 with the current representation', async () => {
    const user = await seedUser(context, { email: 'me-patch@example.test' });
    const jar = await signInWeb(context, user);
    const client = webClient(context, jar);
    const headers = webHeaders(context.origin);

    const missing = await client.patch<{ code: string; current: { version: number } }>('/me', {
      json: { displayName: 'Ada' },
      headers,
    });
    expect(missing.status).toBe(428);
    expect(missing.body).toMatchObject({
      code: 'precondition_required',
      current: { id: user.id, version: 1 },
    });
    const weak = await client.patch('/me', {
      json: { displayName: 'Ada' },
      headers: { ...headers, 'if-match': 'W/"1"' },
    });
    expect(weak.status).toBe(428);

    const stale = await client.patch('/me', {
      json: { displayName: 'Ada' },
      headers: { ...headers, 'if-match': '"7"' },
    });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: 'stale_version', current: { version: 1 } });

    const changed = await client.patch<{ displayName: string; version: number }>('/me', {
      json: { displayName: 'Ada' },
      headers: { ...headers, 'if-match': '"1"' },
    });
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({ id: user.id, displayName: 'Ada', version: 2 });
    expect(changed.response.headers.get('etag')).toBe('"2"');
    const me = await client.get<MeBody>('/auth/me');
    expect(me.body.user).toMatchObject({ displayName: 'Ada', version: 2 });
    // The moved version shows in the representation; `/auth/me` itself carries no validator.
    expect(me.response.headers.get('etag')).toBeNull();
  });

  it('throttles set-password link redemption on the link id', async () => {
    const userId = await insertUser(
      context.db,
      { email: 'me-link-throttle@example.test' },
      context.clock.now(),
    );
    const issued = await context.app.auth.setpw.issue(context.db, {
      userId,
      purpose: 'initial',
      issuedBy: userId,
    });
    const link = issued.link.slice(issued.link.indexOf('#') + 1);
    const client = desktopClient(context);
    for (let attempt = 0; attempt < LIMITS.LOGIN_FAILURES_PER_ACCOUNT_SOURCE; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop -- each wrong secret is one failure on the link id
      const response = await client.post('/auth/set-password', {
        json: { token: withOtherSecret(link), password: 'a perfectly fine passphrase' },
      });
      expect(response.status).toBe(410);
    }
    const blocked = await client.post('/auth/set-password', {
      json: { token: link, password: 'a perfectly fine passphrase' },
    });
    expect(blocked.status).toBe(429);
    expect(blocked.body).toMatchObject({ code: 'rate_limited' });
    // The link itself was never consumed by the guesses: another address redeems it.
    const consumed = await desktopClient(context).post('/auth/set-password', {
      json: { token: link, password: 'a perfectly fine passphrase' },
    });
    expect(consumed.status).toBe(204);
    const credential = await context.db
      .selectFrom('user_credentials')
      .select('pepper_version')
      .where('user_id', '=', idBytes(userId))
      .executeTakeFirst();
    expect(credential).toBeDefined();
  });

  it('refuses the 301st ticket request in a minute from one session with 429', async () => {
    const user = await seedUser(context, { email: 'me-ticket-budget@example.test' });
    const { token } = await signInDesktop(context, user);
    const client = desktopClient(context, token);
    for (let request = 0; request < LIMITS.TICKETS_PER_MINUTE_PER_SESSION; request += 1) {
      // eslint-disable-next-line no-await-in-loop -- the budget is spent one request at a time
      const response = await client.post('/auth/collab-tickets', { json: { count: 1 } });
      expect(response.status).toBe(201);
    }
    const refused = await client.post('/auth/collab-tickets', { json: { count: 1 } });
    expect(refused.status).toBe(429);
    expect(refused.body).toMatchObject({ code: 'rate_limited' });
    expect(refused.response.headers.get('retry-after')).not.toBeNull();
    // Another session of the same user has its own budget.
    const second = await signInDesktop(context, user, 'other-device');
    expect(
      (
        await desktopClient(context, second.token).post('/auth/collab-tickets', {
          json: { count: 1 },
        })
      ).status,
    ).toBe(201);
  });

  it('refuses the 1 001st ticket request in a minute from one address, across sessions, with 429', async () => {
    const user = await seedUser(context, { email: 'me-ticket-ip@example.test' });
    const ip = nextIp();
    const perSession = LIMITS.TICKETS_PER_MINUTE_PER_IP / 4;
    // Four sessions, each inside its own per-session budget, spend the address's budget together.
    for (let device = 0; device < 4; device += 1) {
      // eslint-disable-next-line no-await-in-loop -- one session at a time from the one address
      const { token } = await signInDesktop(context, user, `ip-device-${String(device)}`);
      const client = desktopClient(context, token, ip);
      for (let request = 0; request < perSession; request += 1) {
        // eslint-disable-next-line no-await-in-loop -- the budget is spent one request at a time
        const response = await client.post('/auth/collab-tickets', { json: { count: 1 } });
        expect(response.status).toBe(201);
      }
    }
    const { token } = await signInDesktop(context, user, 'ip-device-last');
    const refused = await desktopClient(context, token, ip).post('/auth/collab-tickets', {
      json: { count: 1 },
    });
    expect(refused.status).toBe(429);
    expect(refused.body).toMatchObject({ code: 'rate_limited' });
    expect(Number(refused.response.headers.get('retry-after'))).toBeGreaterThan(0);
    // The same session from another address is inside its own budget.
    expect(
      (await desktopClient(context, token).post('/auth/collab-tickets', { json: { count: 1 } }))
        .status,
    ).toBe(201);
    // The window ends on the server's clock, and the address is admitted again.
    context.clock.jump(context.clock.now() + 60_000);
    expect(
      (
        await desktopClient(context, token, ip).post('/auth/collab-tickets', {
          json: { count: 1 },
        })
      ).status,
    ).toBe(201);
  });
});
