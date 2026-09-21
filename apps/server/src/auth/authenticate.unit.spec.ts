/**
 * `auth.authenticate.unit` (04-auth-and-access-control.md section 6.1; A26; D04-28; D09-11): the
 * four outcomes of `authenticate()` — cookie → web session, bearer `irid_ses_` → desktop session with
 * cookies ignored, bearer `irid_pat_` → token principal, otherwise anonymous — and the refusals
 * around them: a malformed bearer costs no lookup, a credential that is not an HTTP credential is
 * `401` and never consumed, a cookie never reaches a `bearerOnly` route, and a missing principal on
 * a non-public route is `401 unauthenticated`.
 *
 * The decision is driven as the pure function it is, over the in-memory session repository and an
 * in-memory token row (the unit project's allowance). The hook that applies it to a request is
 * driven through the one boot path, `buildApp({ mode: 'in-process', database: 'none' })`, which is
 * what proves the operational paths bypass it: `/metrics` carries `METRICS_TOKEN`, not an `irid_`
 * credential, and its bad-token answer is the ops plugin's bare `401`, never a problem document.
 */
import {
  mintToken,
  READ_BUNDLE,
  SessionId,
  TokenId,
  UserId,
  VaultId,
  type Principal,
  type RouteAuth,
} from '@iridium/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { InMemorySessionRepository } from '../../test/support/in-memory-session-repository.ts';
import {
  buildWithoutDatabase,
  NO_DATABASE_HOST,
  type NoDatabaseApp,
} from '../../test/support/no-database-app.ts';
import { API_PREFIX } from '../authz/route-policy.ts';
import { authenticate, type AuthenticateView, type AuthenticationOutcome } from './authenticate.ts';
import { idBytes } from './ids.ts';
import { principalKeyOf } from './principal-key.ts';
import { secretHash } from './secret-hash.ts';
import { SESSION_COOKIE_NAME } from './sessions/cookie.ts';
import { sessionTtlsFromConfig } from './sessions/ttl.ts';
import { SessionVerifier } from './sessions/verify.ts';
import { TokenVerifier, type TokenRepository, type TokenRowWithOwner } from './tokens/verify.ts';

const NOW_MS = Date.parse('2026-09-13T12:00:00.000Z');
const HOUR_MS = 3_600_000;
const USER = UserId.parse('019948c4-0000-7000-8000-000000000001');
const WEB_SESSION = SessionId.parse('019948c4-0000-7000-8000-0000000000aa');
const DESKTOP_SESSION = SessionId.parse('019948c4-0000-7000-8000-0000000000ab');
const TOKEN_ROW = '019948c4-0000-7000-8000-00000000f001';
const TOKEN_ID = TokenId.parse(TOKEN_ROW);
const VAULT = VaultId.parse('019948c4-0000-7000-8000-0000000000a0');
const MCP = 'https://iridium.example/mcp';
const MCP_CONNECT = 'https://iridium.example/mcp/connect';
const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const HTTP_UNAVAILABLE = 503;
/** At least 32 characters and obviously fake, so `/metrics` is protected rather than absent. */
const METRICS_TOKEN = 'authenticate-unit-metrics-token-not-a-secret';

/** The `Host` the Host guard accepts on every non-operational route (ARCH-03). */
const HOST = NO_DATABASE_HOST;

const PUBLIC: RouteAuth = { public: true };
const SESSION: RouteAuth = { session: true };
const EITHER: RouteAuth = { session: true, principalKinds: ['user', 'token'] };
const PAT_MOUNT: RouteAuth = {
  permission: 'note:read',
  vaultFrom: 'params.vaultId',
  bearerOnly: true,
  principalKinds: ['token'],
  mcpAudience: 'pat',
};
const OAUTH_MOUNT: RouteAuth = { ...PAT_MOUNT, mcpAudience: 'oauth' };
const ADMIN_DOC: RouteAuth = { serverAdmin: true };

const REFUSED: AuthenticationOutcome = { ok: false, code: 'unauthenticated', denial: null };

interface Harness {
  readonly webRaw: string;
  readonly desktopRaw: string;
  readonly patRaw: string;
  readonly oatRaw: string;
  readonly expiredPatRaw: string;
  readonly lookups: string[];
  run(view: AuthenticateView): Promise<AuthenticationOutcome>;
}

async function harness(): Promise<Harness> {
  const sessions = new InMemorySessionRepository();
  const web = mintToken('ses');
  const desktop = mintToken('ses');
  for (const [id, minted, kind] of [
    [WEB_SESSION, web, 'web'],
    [DESKTOP_SESSION, desktop, 'desktop'],
  ] as const) {
    // eslint-disable-next-line no-await-in-loop -- two rows, inserted in order
    await sessions.insert({
      id: idBytes(id),
      token_id: minted.tokenId,
      secret_hash: secretHash(minted.secret),
      user_id: idBytes(USER),
      kind,
      created_at: new Date(NOW_MS - HOUR_MS),
      last_seen_at: new Date(NOW_MS - HOUR_MS),
      idle_expires_at: new Date(NOW_MS + HOUR_MS),
      absolute_expires_at: new Date(NOW_MS + HOUR_MS),
      last_authenticated_at: new Date(NOW_MS - HOUR_MS),
    });
  }
  const pat = mintToken('pat');
  const oat = mintToken('oat');
  const expiredPat = mintToken('pat');
  const lookups: string[] = [];
  const rows = new Map<string, TokenRowWithOwner>();
  for (const [minted, kind, expiresAt] of [
    [pat, 'pat', NOW_MS + HOUR_MS],
    [oat, 'oauth', NOW_MS + HOUR_MS],
    [expiredPat, 'pat', NOW_MS - 1],
  ] as const) {
    rows.set(minted.tokenId, {
      id: idBytes(TOKEN_ROW),
      token_id: minted.tokenId,
      secret_hash: secretHash(minted.secret),
      user_id: idBytes(USER),
      kind,
      scopes: [...READ_BUNDLE],
      all_vaults: false,
      admin_owned: false,
      expires_at: new Date(expiresAt),
      rate_limit_per_hour: null,
      rotation_overlap_until: null,
      resource: kind === 'oauth' ? MCP_CONNECT : null,
      revoked_at: null,
      consent_id: kind === 'oauth' ? idBytes('019948c4-0000-7000-8000-00000000c001') : null,
      user_status: 'active',
      consent_revoked_at: null,
      client_public_id: kind === 'oauth' ? 'https://client.example/cimd.json' : null,
      client_status: kind === 'oauth' ? 'active' : null,
    });
  }
  const tokens: TokenRepository = {
    async findByTokenId(tokenId) {
      lookups.push(tokenId);
      return rows.get(tokenId) ?? null;
    },
    async allowlist() {
      return [VAULT];
    },
  };
  const deps = {
    sessions: new SessionVerifier(
      sessions,
      sessionTtlsFromConfig({
        sessionWebIdleHours: 24,
        sessionWebAbsoluteDays: 14,
        sessionDesktopIdleDays: 30,
        sessionDesktopAbsoluteDays: 90,
        stepUpWindowMinutes: 10,
      }),
      () => NOW_MS,
    ),
    tokens: new TokenVerifier(
      () => tokens,
      () => NOW_MS,
      3000,
    ),
    resources: { mcp: MCP, mcpConnect: MCP_CONNECT },
  };
  return {
    webRaw: web.raw,
    desktopRaw: desktop.raw,
    patRaw: pat.raw,
    oatRaw: oat.raw,
    expiredPatRaw: expiredPat.raw,
    lookups,
    run: (view) => authenticate(view, deps),
  };
}

/** The principal an `ok` outcome carries, so a case asserts one shape. */
function principalOf(outcome: AuthenticationOutcome): Principal | null {
  if (!outcome.ok) throw new Error(`refused: ${outcome.code}`);
  return outcome.principal;
}

describe('auth.authenticate.unit [area:auth]', () => {
  describe('the decision over a request view', () => {
    it('leaves an anonymous request on a public, test-only or unpolicied route with a null principal', async () => {
      const built = await harness();
      for (const auth of [PUBLIC, 'test-only', undefined] as const) {
        // eslint-disable-next-line no-await-in-loop -- three policies, one at a time
        await expect(built.run({ auth })).resolves.toStrictEqual({ ok: true, principal: null });
      }
    });

    it('refuses an anonymous request on every non-public policy with unauthenticated', async () => {
      const built = await harness();
      for (const auth of [SESSION, EITHER, PAT_MOUNT, ADMIN_DOC, { self: true }] as const) {
        // eslint-disable-next-line no-await-in-loop -- one policy shape per iteration
        await expect(built.run({ auth })).resolves.toStrictEqual(REFUSED);
      }
    });

    it('resolves the cookie to the web session', async () => {
      const built = await harness();
      const outcome = await built.run({ auth: SESSION, sessionCookie: built.webRaw });
      expect(principalOf(outcome)).toMatchObject({
        kind: 'user',
        userId: USER,
        sessionId: WEB_SESSION,
        sessionKind: 'web',
      });
    });

    it('resolves a bearer irid_ses_ as the desktop session and ignores any cookie beside it', async () => {
      const built = await harness();
      const outcome = await built.run({
        auth: SESSION,
        authorization: `Bearer ${built.desktopRaw}`,
        sessionCookie: built.webRaw,
      });
      expect(principalOf(outcome)).toMatchObject({
        sessionId: DESKTOP_SESSION,
        sessionKind: 'desktop',
      });
      // The web session's credential is refused as a bearer even though it is live (D04-06).
      await expect(
        built.run({ auth: SESSION, authorization: `Bearer ${built.webRaw}` }),
      ).resolves.toStrictEqual(REFUSED);
    });

    it('resolves a bearer irid_pat_ to a token principal on the mount the route declares', async () => {
      const built = await harness();
      const rest = await built.run({ auth: EITHER, authorization: `bearer ${built.patRaw}` });
      expect(principalOf(rest)).toMatchObject({
        kind: 'token',
        tokenKind: 'pat',
        tokenId: TOKEN_ROW,
        surface: 'rest',
      });
      const mcp = await built.run({ auth: PAT_MOUNT, authorization: `Bearer ${built.patRaw}` });
      expect(principalOf(mcp)).toMatchObject({ surface: 'mcp', resource: null });
      // The OAuth mount verifies the audience against `<PUBLIC_ORIGIN>/mcp/connect`.
      const connect = await built.run({
        auth: OAUTH_MOUNT,
        authorization: `Bearer ${built.oatRaw}`,
      });
      expect(principalOf(connect)).toMatchObject({ tokenKind: 'oauth', resource: MCP_CONNECT });
      // A flag-only administrator route is a REST surface for a bearer, not a mount.
      const doc = await built.run({ auth: ADMIN_DOC, authorization: `Bearer ${built.patRaw}` });
      expect(principalOf(doc)).toMatchObject({ surface: 'rest' });
    });

    it('refuses the wrong token kind for a mount, naming the row for the bounded audit', async () => {
      const built = await harness();
      await expect(
        built.run({ auth: EITHER, authorization: `Bearer ${built.oatRaw}` }),
      ).resolves.toMatchObject({
        ok: false,
        code: 'unauthenticated',
        detail: expect.stringContaining('/mcp/connect'),
        denial: { reason: 'wrong_kind_for_route', tokenRowId: TOKEN_ROW, tokenKind: 'oauth' },
      });
    });

    it('answers token_expired for an expired row and reports nothing for an unknown id', async () => {
      const built = await harness();
      await expect(
        built.run({ auth: EITHER, authorization: `Bearer ${built.expiredPatRaw}` }),
      ).resolves.toMatchObject({
        ok: false,
        code: 'token_expired',
        denial: { reason: 'expired', tokenRowId: TOKEN_ROW, tokenKind: 'pat', ownerUserId: USER },
      });
      const unknown = mintToken('pat').raw;
      await expect(
        built.run({ auth: EITHER, authorization: `Bearer ${unknown}` }),
      ).resolves.toMatchObject({ ok: false, code: 'unauthenticated', denial: null });
      expect(built.lookups).toHaveLength(2);
    });

    it('refuses a malformed bearer and a non-Bearer scheme with no lookup, even on a public route', async () => {
      const built = await harness();
      // A bearer that is not a credential is a token failure for the metric; a foreign scheme or a
      // header of the wrong shape names no token at all.
      const cases: readonly (readonly [string, AuthenticationOutcome])[] = [
        ['Bearer not-a-credential', { ...REFUSED, tokenReason: 'not_a_credential' }],
        ['Bearer irid_pat_not-a-token', { ...REFUSED, tokenReason: 'malformed' }],
        ['Basic abc', REFUSED],
        ['Bearer', REFUSED],
        [`Token ${built.patRaw}`, REFUSED],
        [`Bearer ${built.patRaw} extra`, REFUSED],
      ];
      for (const [authorization, expected] of cases) {
        // eslint-disable-next-line no-await-in-loop -- one refusal per shape, asserted in order
        await expect(built.run({ auth: PUBLIC, authorization })).resolves.toStrictEqual(expected);
      }
      expect(built.lookups).toHaveLength(0);
    });

    it('refuses a ticket, a set-password link, a code or a refresh token as a bearer without consuming it', async () => {
      const built = await harness();
      for (const kind of ['tkt', 'spl', 'oac', 'ort'] as const) {
        // eslint-disable-next-line no-await-in-loop -- one kind per iteration
        await expect(
          built.run({ auth: SESSION, authorization: `Bearer ${mintToken(kind).raw}` }),
        ).resolves.toStrictEqual({ ...REFUSED, tokenReason: 'unknown_kind' });
      }
      expect(built.lookups).toHaveLength(0);
    });

    it('never reads the cookie on a bearerOnly route', async () => {
      const built = await harness();
      await expect(
        built.run({ auth: PAT_MOUNT, sessionCookie: built.webRaw }),
      ).resolves.toStrictEqual(REFUSED);
    });

    it('treats a well-formed cookie the verifier refuses as anonymous, which a public route accepts', async () => {
      const built = await harness();
      const stranger = mintToken('ses').raw;
      await expect(built.run({ auth: SESSION, sessionCookie: stranger })).resolves.toStrictEqual(
        REFUSED,
      );
      await expect(built.run({ auth: PUBLIC, sessionCookie: stranger })).resolves.toStrictEqual({
        ok: true,
        principal: null,
      });
    });

    it('derives the rate-limit key per principal kind (09 section 1.8)', async () => {
      const built = await harness();
      const session = await built.run({ auth: SESSION, sessionCookie: built.webRaw });
      expect(session.ok && session.principal !== null && principalKeyOf(session.principal)).toBe(
        `ses:${WEB_SESSION}`,
      );
      const pat = await built.run({ auth: EITHER, authorization: `Bearer ${built.patRaw}` });
      expect(pat.ok && pat.principal !== null && principalKeyOf(pat.principal)).toBe(
        `pat:${TOKEN_ROW}`,
      );
      const oat = await built.run({
        auth: OAUTH_MOUNT,
        authorization: `Bearer ${built.oatRaw}`,
      });
      expect(oat.ok && oat.principal !== null && principalKeyOf(oat.principal)).toBe(
        `oat:${TOKEN_ROW}`,
      );
      expect(principalKeyOf({ kind: 'system', job: 'cli:test' })).toBeNull();
    });

    it('treats a vault-scoped route without mcpAudience as the REST surface for a bearer', async () => {
      const built = await harness();
      const starred: RouteAuth = {
        permission: 'note:read',
        vaultFrom: 'params.vaultId',
        principalKinds: ['user', 'token'],
      };
      const outcome = await built.run({ auth: starred, authorization: `Bearer ${built.patRaw}` });
      expect(principalOf(outcome)).toMatchObject({ kind: 'token', surface: 'rest' });
    });
  });

  describe('the hook on the one boot path', () => {
    let booted: NoDatabaseApp;
    let app: FastifyInstance;

    beforeAll(async () => {
      booted = await buildWithoutDatabase({ extraEnv: { METRICS_TOKEN } });
      app = booted.app;
      await app.register(
        async (api) => {
          api.get('/__probe__/public', { config: { auth: PUBLIC } }, async (request, reply) =>
            reply.send({ principal: request.principal, key: request.principalKey }),
          );
          api.get('/__probe__/session', { config: { auth: SESSION } }, async (_request, reply) =>
            reply.send({ ok: true }),
          );
        },
        { prefix: API_PREFIX },
      );
      await app.ready();
    });

    afterAll(async () => {
      await booted.close();
    });

    it('leaves the three operational paths to their own guards, so a METRICS_TOKEN bearer is never an irid_ credential', async () => {
      const garbage = { authorization: 'Bearer not-an-irid-credential' };
      const healthz = await app.inject({ method: 'GET', url: '/healthz', headers: garbage });
      expect(healthz.statusCode).toBe(HTTP_OK);
      const readyz = await app.inject({
        method: 'GET',
        url: '/readyz?verbose=1',
        headers: garbage,
      });
      expect(readyz.statusCode).not.toBe(HTTP_UNAUTHORIZED);
      // A bad metrics token is the ops plugin's bare 401 with no body (D09-11) — not a problem document.
      const refused = await app.inject({ method: 'GET', url: '/metrics', headers: garbage });
      expect(refused.statusCode).toBe(HTTP_UNAUTHORIZED);
      expect(refused.body).toBe('');
      const served = await app.inject({
        method: 'GET',
        url: '/metrics',
        headers: { authorization: `Bearer ${METRICS_TOKEN}` },
      });
      expect(served.statusCode).toBe(HTTP_OK);
      expect(served.body).toContain('iridium_build_info');
    });

    it('applies the decision to the request: anonymous on public, 401 on a session route', async () => {
      const anonymous = await app.inject({
        method: 'GET',
        url: `${API_PREFIX}/__probe__/public`,
        headers: { host: HOST },
      });
      expect(anonymous.statusCode).toBe(HTTP_OK);
      expect(anonymous.json()).toStrictEqual({ principal: null, key: null });
      const refused = await app.inject({
        method: 'GET',
        url: `${API_PREFIX}/__probe__/session`,
        headers: { host: HOST },
      });
      expect(refused.statusCode).toBe(HTTP_UNAUTHORIZED);
      expect(refused.json()).toMatchObject({ code: 'unauthenticated' });
      const malformed = await app.inject({
        method: 'GET',
        url: `${API_PREFIX}/__probe__/session`,
        headers: { host: HOST, authorization: 'Bearer nope' },
      });
      expect(malformed.statusCode).toBe(HTTP_UNAUTHORIZED);
      expect(malformed.json()).toMatchObject({ code: 'unauthenticated' });
      // No `WWW-Authenticate` on an `/api/v1` route: a browser must never show a native dialog.
      expect(malformed.headers['www-authenticate']).toBeUndefined();
    });

    it('answers 503, never 401, when a well-formed credential cannot be read because there is no database', async () => {
      // D06-15: an outage must not tell every client its credential is invalid.
      const cookie = await app.inject({
        method: 'GET',
        url: `${API_PREFIX}/__probe__/session`,
        headers: { host: HOST, cookie: `${SESSION_COOKIE_NAME}=${mintToken('ses').raw}` },
      });
      expect(cookie.statusCode).toBe(HTTP_UNAVAILABLE);
      expect(cookie.json()).toMatchObject({ code: 'unavailable' });
      const bearer = await app.inject({
        method: 'GET',
        url: `${API_PREFIX}/__probe__/session`,
        headers: { host: HOST, authorization: `Bearer ${mintToken('pat').raw}` },
      });
      expect(bearer.statusCode).toBe(HTTP_UNAVAILABLE);
      expect(bearer.json()).toMatchObject({ code: 'unavailable' });
    });

    it('drops a user tickets on user.disabled and a session tickets on session.revoked (section 8.3)', () => {
      const store = app.auth.tickets;
      store.issue({ sessionId: WEB_SESSION, userId: USER }, 2);
      store.issue({ sessionId: DESKTOP_SESSION, userId: USER }, 1);
      app.authz.bus.publish({
        type: 'session.revoked',
        userId: USER,
        sessionId: WEB_SESSION,
        reason: 'logout',
      });
      expect(store.size).toBe(1);
      app.authz.bus.publish({ type: 'user.disabled', userId: USER });
      expect(store.size).toBe(0);
      store.issue({ sessionId: WEB_SESSION, userId: USER }, 1);
      store.issue({ sessionId: DESKTOP_SESSION, userId: USER }, 1);
      app.authz.bus.publish({
        type: 'user.password_changed',
        userId: USER,
        keepSessionId: DESKTOP_SESSION,
      });
      expect(store.size).toBe(1);
      // The other events of section 8.3 are not the store's: a revoked token drops no ticket.
      app.authz.bus.publish({ type: 'token.revoked', userId: USER, tokenId: TOKEN_ID });
      expect(store.size).toBe(1);
    });
  });
});
