/** The HTTP handlers retain real security/auth services and scripted persistence I/O. */
import {
  CollabTicketsCreated,
  DesktopSessionCreated,
  LIMITS,
  mintToken,
  ProblemDetails,
  Reauthenticated,
  SERVER_CHAIN_ID,
  SessionId,
  SessionList,
  strongEtag,
  VaultId,
  WebSessionCreated,
} from '@iridium/contracts';
import { describe, expect, it, vi } from 'vitest';

import {
  FLOW_NEW_PASSWORD,
  FLOW_PASSWORD,
  FLOW_SESSION,
  FLOW_USER,
  type AuthFlowFixtureOptions,
} from '../../test/support/auth-flow-fixture.ts';
import { authRouteFixture as buildAuthRouteFixture } from '../../test/support/auth-route-fixture.ts';
import { idBytes } from './ids.ts';
import { LOGOUT_CLEAR_SITE_DATA, SESSION_COOKIE_NAME } from './sessions/cookie.ts';

function authRouteFixture(options: AuthFlowFixtureOptions = {}) {
  return buildAuthRouteFixture(options, (app, flow) => {
    vi.spyOn(app.database, 'dbApp', 'get').mockReturnValue(flow.fake.db);
    vi.spyOn(app.collab.ownerLease, 'captureFence').mockImplementation(() =>
      flow.fake.owner.captureFence(),
    );
    vi.spyOn(app.audit, 'record').mockImplementation(async (trx, event) => {
      await flow.deps.audit.record(trx, event);
      return {
        id: flow.audits.length,
        chainId: event.chainId ?? SERVER_CHAIN_ID,
        occurredAt: flow.clock.date(),
        keyVersion: 1,
        prevHash: Buffer.alloc(32),
        hash: Buffer.alloc(32),
      };
    });
  });
}

const LOGIN_BODY = { email: 'Person@Example.Test', password: FLOW_PASSWORD, client: 'desktop' };

describe('auth.routes.behavior.unit [area:auth]', () => {
  it('creates a desktop bearer and metadata through the actual login route', async () => {
    const fixture = await authRouteFixture();
    const response = await fixture.app.inject({
      method: 'POST',
      url: '/api/v1/auth/sessions',
      headers: {
        ...fixture.desktop,
        'user-agent': 'route-unit',
        'x-iridium-client-version': '1.2.3',
      },
      payload: { ...LOGIN_BODY, deviceName: 'workstation' },
    });
    expect(response.statusCode).toBe(201);
    const body = DesktopSessionCreated.parse(response.json());
    expect(body.user.id).toBe(FLOW_USER);
    expect(body.session).toMatchObject({
      kind: 'desktop',
      current: true,
      deviceName: 'workstation',
    });
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(fixture.state.tables.sessions).toEqual([
      expect.objectContaining({ user_agent: 'route-unit', client_version: '1.2.3' }),
    ]);
    expect(fixture.audits).toEqual([
      expect.objectContaining({ action: 'user.login.succeeded', actorId: FLOW_USER }),
    ]);
    const verified = await fixture.app.auth.sessions.verifySession(body.token, 'bearer');
    expect(verified).toMatchObject({ userId: FLOW_USER, sessionId: body.session.id });
    expect(body.expiresAt).toBe(
      new Date(fixture.clock.now() + fixture.app.auth.ttls.desktopAbsoluteMs).toISOString(),
    );
  });

  it('creates a web session only in a secure host cookie and refuses its bearer replay', async () => {
    const fixture = await authRouteFixture();
    const response = await fixture.app.inject({
      method: 'POST',
      url: '/api/v1/auth/sessions',
      headers: fixture.web,
      payload: { ...LOGIN_BODY, client: 'web' },
    });
    expect(response.statusCode).toBe(201);
    const body = WebSessionCreated.parse(response.json());
    expect(body.session).toMatchObject({ kind: 'web', current: true });
    const cookie = response.cookies.find((entry) => entry.name === SESSION_COOKIE_NAME);
    expect(cookie).toMatchObject({ httpOnly: true, secure: true, path: '/', sameSite: 'Lax' });
    expect(cookie?.value).toMatch(/^irid_ses_/);
    expect(response.body).not.toContain('irid_ses_');
    expect(await fixture.app.auth.sessions.verifySession(cookie?.value ?? '', 'bearer')).toBeNull();
    expect(
      await fixture.app.auth.sessions.verifySession(cookie?.value ?? '', 'cookie'),
    ).toMatchObject({
      userId: FLOW_USER,
    });
  });

  it('rejects a disagreeing client channel before password or SQL work', async () => {
    const fixture = await authRouteFixture();
    const response = await fixture.app.inject({
      method: 'POST',
      url: '/api/v1/auth/sessions',
      headers: fixture.desktop,
      payload: { ...LOGIN_BODY, client: 'web' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'csrf_rejected' });
    expect(fixture.trace).toEqual([]);
    expect(fixture.state.tables.sessions).toEqual([]);
  });

  it('returns the authenticated session and stored user from the actual authentication hook', async () => {
    const fixture = await authRouteFixture();
    const auth = await fixture.authenticate();
    const response = await fixture.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: auth.headers,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      principalKind: 'user',
      sessionId: auth.issued.sessionId,
      sessionKind: 'desktop',
      isServerAdmin: false,
      lastAuthenticatedAt: fixture.clock.date().toISOString(),
      user: { id: FLOW_USER, displayName: 'Person' },
    });
  });

  it('maps invalid credentials to 401 and the next genuinely blocked attempt to 429 with a rounded Retry-After', async () => {
    const fixture = await authRouteFixture({ maxFailures: 1 });
    const attempt = () =>
      fixture.app.inject({
        method: 'POST',
        url: '/api/v1/auth/sessions',
        headers: fixture.desktop,
        payload: { ...LOGIN_BODY, password: 'wrong password' },
      });
    const failed = await attempt();
    expect(failed.statusCode).toBe(401);
    expect(failed.json()).toMatchObject({ code: 'invalid_credentials' });
    const blocked = await attempt();
    expect(blocked.statusCode).toBe(429);
    const problem = ProblemDetails.parse(blocked.json());
    expect(problem).toMatchObject({
      code: 'rate_limited',
      detail: 'Too many attempts; try again later.',
    });
    expect(blocked.headers['retry-after']).toBe(
      String(Math.max(1, Math.ceil((problem.retryAfterMs ?? 0) / 1000))),
    );
    expect(fixture.state.tables.sessions).toEqual([]);
  });

  it.each(['web', 'desktop'] as const)(
    'logs out %s, clears only browser storage, and publishes after the audited commit',
    async (kind) => {
      const fixture = await authRouteFixture();
      const auth = await fixture.authenticate(kind);
      fixture.resetObservations();
      const response = await fixture.app.inject({
        method: 'DELETE',
        url: '/api/v1/auth/sessions/current',
        headers: auth.headers,
      });
      expect(response.statusCode).toBe(204);
      expect(response.body).toBe('');
      expect(fixture.audits).toEqual([
        expect.objectContaining({
          action: 'user.logout',
          credentialId: FLOW_SESSION,
          metadata: { sessionId: FLOW_SESSION },
        }),
      ]);
      expect(fixture.events).toEqual([
        { type: 'session.revoked', userId: FLOW_USER, sessionId: FLOW_SESSION, reason: 'logout' },
      ]);
      expect(fixture.trace.indexOf('audit:user.logout')).toBeLessThan(
        fixture.trace.indexOf('tx:commit'),
      );
      expect(fixture.trace.indexOf('tx:commit')).toBeLessThan(
        fixture.trace.indexOf('published:session.revoked'),
      );
      expect(response.headers['clear-site-data']).toBe(
        kind === 'web' ? LOGOUT_CLEAR_SITE_DATA : undefined,
      );
      expect(response.cookies).toMatchObject(
        kind === 'web'
          ? [{ name: SESSION_COOKIE_NAME, value: '', maxAge: 0, secure: true, httpOnly: true }]
          : [],
      );
      expect(Boolean(response.headers['set-cookie'])).toBe(kind === 'web');
      expect(
        await fixture.app.auth.sessions.verifySession(
          auth.issued.raw,
          kind === 'web' ? 'cookie' : 'bearer',
        ),
      ).toBeNull();
    },
  );

  it('keeps current logout idempotent when another transaction revokes the row after authentication', async () => {
    const fixture = await authRouteFixture();
    const auth = await fixture.authenticate();
    fixture.state.retireSessionsAtLock = true;
    fixture.resetObservations();
    const response = await fixture.app.inject({
      method: 'DELETE',
      url: '/api/v1/auth/sessions/current',
      headers: auth.headers,
    });
    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
    expect(fixture.audits).toEqual([]);
    expect(fixture.events).toEqual([]);
  });

  it('answers step-up timestamps from the actual reauthentication commit', async () => {
    const fixture = await authRouteFixture();
    const auth = await fixture.authenticate();
    fixture.clock.jump(fixture.clock.now() + 2500);
    const response = await fixture.app.inject({
      method: 'POST',
      url: '/api/v1/auth/reauthenticate',
      headers: auth.headers,
      payload: { password: FLOW_PASSWORD },
    });
    expect(response.statusCode).toBe(200);
    expect(Reauthenticated.parse(response.json())).toEqual({
      lastAuthenticatedAt: fixture.clock.date().toISOString(),
      stepUpExpiresAt: new Date(
        fixture.clock.now() + fixture.app.auth.ttls.stepUpWindowMs,
      ).toISOString(),
    });
    expect(fixture.state.tables.sessions[0]?.['last_authenticated_at']).toEqual(
      fixture.clock.date(),
    );
    expect(fixture.audits).toContainEqual(
      expect.objectContaining({ action: 'user.reauth.succeeded', credentialId: FLOW_SESSION }),
    );
  });

  it.each(['/auth/reauthenticate', '/me/password'])(
    'maps invalid and throttled credential checks on %s without changing a session',
    async (path) => {
      const fixture = await authRouteFixture({ maxFailures: 1 });
      const auth = await fixture.authenticate();
      const payload =
        path === '/auth/reauthenticate'
          ? { password: 'incorrect' }
          : { currentPassword: 'incorrect', newPassword: FLOW_NEW_PASSWORD };
      const attempt = () =>
        fixture.app.inject({
          method: 'POST',
          url: '/api/v1' + path,
          headers: auth.headers,
          payload,
        });
      expect((await attempt()).statusCode).toBe(401);
      const blocked = await attempt();
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json()).toMatchObject({ code: 'rate_limited' });
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
      expect(fixture.state.tables.sessions[0]?.['revoked_at']).toBeNull();
      expect(fixture.events).toEqual([]);
    },
  );

  it.each(['/auth/set-password', '/me/password'])(
    'maps the account-context password policy on %s without changing credentials',
    async (path) => {
      const fixture = await authRouteFixture();
      const auth = await fixture.authenticate();
      const link = await fixture.seedLink();
      const before = fixture.state.tables.user_credentials[0]?.['password_hash'];
      const response = await fixture.app.inject({
        method: 'POST',
        url: '/api/v1' + path,
        headers: path === '/me/password' ? auth.headers : fixture.desktop,
        payload:
          path === '/me/password'
            ? { currentPassword: FLOW_PASSWORD, newPassword: 'person sunrise password' }
            : { token: link.token, password: 'person sunrise password' },
      });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({
        code: 'validation_failed',
        detail: 'The password does not meet the policy.',
        errors: [
          { path: 'body.password', message: 'password: context_word', code: 'context_word' },
        ],
      });
      expect(fixture.state.tables.user_credentials[0]?.['password_hash']).toBe(before);
      expect(fixture.state.tables.password_setup_tokens[0]?.['consumed_at']).toBeNull();
      expect(fixture.events).toEqual([]);
    },
  );

  it('maps an unknown well-formed set-password link to 410, then its exhausted budget to 429', async () => {
    const fixture = await authRouteFixture({ maxFailures: 1 });
    const token = mintToken('spl').raw;
    const attempt = () =>
      fixture.app.inject({
        method: 'POST',
        url: '/api/v1/auth/set-password',
        headers: fixture.desktop,
        payload: { token, password: FLOW_NEW_PASSWORD },
      });
    const invalid = await attempt();
    expect(invalid.statusCode).toBe(410);
    expect(invalid.json()).toMatchObject({ code: 'invalid_link' });
    const blocked = await attempt();
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toMatchObject({ code: 'rate_limited' });
    expect(fixture.audits).toEqual([]);
  });

  it.each(['/auth/set-password', '/me/password'])(
    'returns an empty 204 only after %s commits its credential and session changes',
    async (path) => {
      const fixture = await authRouteFixture();
      const auth = await fixture.authenticate();
      const other = await fixture.seedSession(
        'desktop',
        SessionId.parse('019948c4-0000-7000-8000-000000000103'),
      );
      const link = await fixture.seedLink();
      const response = await fixture.app.inject({
        method: 'POST',
        url: '/api/v1' + path,
        headers: path === '/me/password' ? auth.headers : fixture.desktop,
        payload:
          path === '/me/password'
            ? { currentPassword: FLOW_PASSWORD, newPassword: FLOW_NEW_PASSWORD }
            : { token: link.token, password: FLOW_NEW_PASSWORD },
      });
      expect(response.statusCode).toBe(204);
      expect(response.body).toBe('');
      expect(await fixture.app.auth.sessions.verifySession(other.raw, 'bearer')).toBeNull();
      const current = await fixture.app.auth.sessions.verifySession(auth.issued.raw, 'bearer');
      expect(current?.sessionId ?? null).toBe(path === '/me/password' ? FLOW_SESSION : null);
      const login = await fixture.app.inject({
        method: 'POST',
        url: '/api/v1/auth/sessions',
        headers: fixture.desktop,
        payload: { ...LOGIN_BODY, password: FLOW_NEW_PASSWORD },
      });
      expect(login.statusCode).toBe(201);
    },
  );

  it('issues the requested single-use ticket batch bound to the authenticated session', async () => {
    const fixture = await authRouteFixture();
    const auth = await fixture.authenticate();
    const response = await fixture.app.inject({
      method: 'POST',
      url: '/api/v1/auth/collab-tickets',
      headers: auth.headers,
      payload: { count: 3 },
    });
    expect(response.statusCode).toBe(201);
    const body = CollabTicketsCreated.parse(response.json());
    expect(body.expiresIn).toBe(LIMITS.TICKET_TTL_S);
    expect(body.tickets).toHaveLength(3);
    expect(new Set(body.tickets).size).toBe(3);
    for (const ticket of body.tickets) {
      expect(fixture.app.auth.tickets.consume(ticket)).toEqual({
        sessionId: FLOW_SESSION,
        userId: FLOW_USER,
      });
      expect(fixture.app.auth.tickets.consume(ticket)).toBeNull();
    }
  });

  it('refuses an exhausted IP ticket budget with the positive sub-second Retry-After floor', async () => {
    const fixture = await authRouteFixture();
    const auth = await fixture.authenticate();
    for (let hit = 0; hit < LIMITS.TICKETS_PER_MINUTE_PER_IP; hit += 1)
      fixture.app.auth.ticketIpBudget.hit('127.0.0.1');
    fixture.clock.jump(fixture.clock.now() + 59_999);
    const response = await fixture.app.inject({
      method: 'POST',
      url: '/api/v1/auth/collab-tickets',
      headers: auth.headers,
      payload: { count: 1 },
    });
    expect(response.statusCode).toBe(429);
    expect(response.headers['retry-after']).toBe('1');
    expect(response.json()).toMatchObject({ code: 'rate_limited', retryAfterMs: 1 });
  });

  it.each([true, false])(
    'renders a real PAT with allVaults=%s and never grants its admin owner authority',
    async (allVaults) => {
      const fixture = await authRouteFixture();
      Object.assign(fixture.state.tables.users[0] ?? {}, { is_server_admin: true });
      const pat = fixture.seedToken(allVaults);
      const vault = VaultId.parse('019948c4-0000-7000-8000-000000000201');
      fixture.state.tables.access_token_vaults.push({
        token_id: fixture.state.tables.access_tokens[0]?.['id'],
        vault_id: idBytes(vault),
      });
      const headers = { ...fixture.desktop, authorization: 'Bearer ' + pat.raw };
      const response = await fixture.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        principalKind: 'token',
        isServerAdmin: false,
        user: { isServerAdmin: true },
        token: {
          name: 'Automation',
          scopes: ['vault:read', 'note:read'],
          allVaults,
          vaultIds: allVaults ? [] : [vault],
          expiresAt: new Date(fixture.clock.now() + 86_400_000).toISOString(),
        },
      });
      expect(response.body).not.toContain(pat.raw);
      const forbidden = await fixture.app.inject({
        method: 'GET',
        url: '/api/v1/me/sessions',
        headers,
      });
      expect(forbidden.statusCode).toBe(403);
      expect(forbidden.json()).toMatchObject({ code: 'token_scope_insufficient' });
    },
  );

  it('lists only owned live sessions, sorting the current one before a newer peer', async () => {
    const fixture = await authRouteFixture();
    const other = await fixture.seedSession(
      'desktop',
      SessionId.parse('019948c4-0000-7000-8000-000000000103'),
    );
    const auth = await fixture.authenticate();
    const response = await fixture.app.inject({
      method: 'GET',
      url: '/api/v1/me/sessions',
      headers: auth.headers,
    });
    expect(response.statusCode).toBe(200);
    expect(
      SessionList.parse(response.json()).items.map(({ id: sessionId, current }) => ({
        id: sessionId,
        current,
      })),
    ).toEqual([
      { id: FLOW_SESSION, current: true },
      { id: other.sessionId, current: false },
    ]);
  });

  it('revokes a peer session with target evidence, but treats foreign, unknown and already-revoked IDs as the same 404', async () => {
    const fixture = await authRouteFixture();
    const auth = await fixture.authenticate('web');
    const other = await fixture.seedSession(
      'desktop',
      SessionId.parse('019948c4-0000-7000-8000-000000000103'),
    );
    fixture.resetObservations();
    const revoke = (sessionId: string) =>
      fixture.app.inject({
        method: 'DELETE',
        url: '/api/v1/me/sessions/' + sessionId,
        headers: auth.headers,
      });
    const response = await revoke(other.sessionId);
    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(fixture.audits).toEqual([
      expect.objectContaining({
        action: 'session.revoked',
        credentialId: FLOW_SESSION,
        metadata: { sessionId: other.sessionId, targetUserId: FLOW_USER, reason: 'logout' },
      }),
    ]);
    expect(fixture.events).toEqual([
      { type: 'session.revoked', userId: FLOW_USER, sessionId: other.sessionId, reason: 'logout' },
    ]);
    const repeated = await revoke(other.sessionId);
    expect(repeated.statusCode).toBe(404);
    expect(repeated.json()).toMatchObject({ code: 'not_found' });
    const unknown = await revoke('019948c4-0000-7000-8000-000000000104');
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ code: 'not_found' });
    Object.assign(fixture.state.tables.sessions[1] ?? {}, {
      user_id: idBytes('019948c4-0000-7000-8000-000000000105'),
      revoked_at: null,
    });
    const foreign = await revoke(other.sessionId);
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json()).toMatchObject({ code: 'not_found' });
    expect(fixture.audits).toHaveLength(1);
  });

  it.each(['web', 'desktop'] as const)(
    'revokes the selected current %s session using logout semantics',
    async (kind) => {
      const fixture = await authRouteFixture();
      const auth = await fixture.authenticate(kind);
      const response = await fixture.app.inject({
        method: 'DELETE',
        url: '/api/v1/me/sessions/' + FLOW_SESSION,
        headers: auth.headers,
      });
      expect(response.statusCode).toBe(204);
      expect(fixture.audits).toContainEqual(
        expect.objectContaining({ action: 'user.logout', metadata: { sessionId: FLOW_SESSION } }),
      );
      expect(response.headers['clear-site-data']).toBe(
        kind === 'web' ? LOGOUT_CLEAR_SITE_DATA : undefined,
      );
    },
  );

  it.each([undefined, 'W/"1"', 'garbage'])(
    'requires a strong profile version before writing (If-Match=%s)',
    async (ifMatch) => {
      const fixture = await authRouteFixture();
      const auth = await fixture.authenticate();
      const response = await fixture.app.inject({
        method: 'PATCH',
        url: '/api/v1/me',
        headers: { ...auth.headers, ...(ifMatch === undefined ? {} : { 'if-match': ifMatch }) },
        payload: { displayName: 'Changed' },
      });
      expect(response.statusCode).toBe(428);
      expect(response.json()).toMatchObject({
        code: 'precondition_required',
        current: { id: FLOW_USER, displayName: 'Person', version: 1 },
      });
      expect(fixture.state.tables.users[0]?.['display_name']).toBe('Person');
      expect(fixture.trace.some((entry) => entry.startsWith('update'))).toBe(false);
    },
  );

  it('returns the current profile on a stale version, then changes only the owned matching row and returns its strong ETag', async () => {
    const fixture = await authRouteFixture();
    const auth = await fixture.authenticate();
    const patch = (version: number) =>
      fixture.app.inject({
        method: 'PATCH',
        url: '/api/v1/me',
        headers: { ...auth.headers, 'if-match': strongEtag(version) },
        payload: { displayName: 'Changed' },
      });
    const stale = await patch(9);
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({
      code: 'stale_version',
      current: { displayName: 'Person', version: 1 },
    });
    const good = await patch(1);
    expect(good.statusCode).toBe(200);
    expect(good.headers.etag).toBe(strongEtag(2));
    expect(good.json()).toMatchObject({
      id: FLOW_USER,
      displayName: 'Changed',
      version: 2,
      updatedAt: fixture.clock.date().toISOString(),
    });
    expect(fixture.state.tables.users[0]?.['display_name']).toBe('Changed');
    expect(fixture.state.tables.users[0]?.['email']).toBe('person@example.test');
  });
});
