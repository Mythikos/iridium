/**
 * `authz.route-policy.apply.unit` (04-auth-and-access-control.md section 6.2; D04-10; D04-12;
 * ARCH-02): the policy over a hand-built view. The integration suite proves the wired routes; this
 * proves the refusals a wired process can never reach because the auth hook, the boot assertion and
 * the connected pool answer first — an anonymous or system caller, a token on a step-up route, a
 * route whose parameters do not carry the id its policy names, the pool not connected, a decision
 * that allowed without the vault row — and the mapping of every deny and of the attached rows.
 */
import {
  mintToken,
  SessionId,
  TokenId,
  UserId,
  VaultId,
  type Principal,
  type RouteAuth,
  type TokenPrincipal,
  type UserPrincipal,
} from '@iridium/contracts';
import type { preHandlerAsyncHookHandler } from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { EMPTY_SCRIPT, fakeDatabase, type QueryScript } from '../../test/support/fake-driver.ts';
import { buildWithoutDatabase, NO_DATABASE_HOST } from '../../test/support/no-database-app.ts';
import { idBytes } from '../auth/ids.ts';
import { secretHash } from '../auth/secret-hash.ts';
import type { SessionWithUser } from '../auth/sessions/repository.ts';
import { ProblemError } from '../security/problem.ts';
import {
  AuthzStoreUnavailableError,
  AuthzUsageError,
  type AuthzScope,
  type DetailedDecision,
} from './authorize.ts';
import { API_PREFIX, applyRoutePolicy, type PolicyView } from './route-policy.ts';

const NOW_MS = Date.parse('2026-09-13T12:00:00.000Z');
const HOUR_MS = 3_600_000;
const STEP_UP_WINDOW_MS = 600_000;
const VAULT = VaultId.parse('019948c4-0000-7000-8000-0000000000a0');

const USER: UserPrincipal = {
  kind: 'user',
  userId: UserId.parse('019948c4-0000-7000-8000-000000000001'),
  sessionId: SessionId.parse('019948c4-0000-7000-8000-0000000000aa'),
  sessionKind: 'web',
  isServerAdmin: false,
  authzVersion: 1,
  lastAuthenticatedAt: new Date(NOW_MS - HOUR_MS),
};
const FRESH_ADMIN: UserPrincipal = {
  ...USER,
  isServerAdmin: true,
  lastAuthenticatedAt: new Date(NOW_MS),
};
const TOKEN: TokenPrincipal = {
  kind: 'token',
  tokenKind: 'pat',
  tokenId: TokenId.parse('019948c4-0000-7000-8000-00000000f001'),
  publicTokenId: 'ABCDEFGHIJKLMNOP',
  userId: USER.userId,
  clientId: null,
  consentId: null,
  resource: null,
  scopes: ['vault:read'],
  vaultScope: { all: true },
  isServerAdmin: false,
  adminOwned: false,
  surface: 'rest',
  rateLimitPerHour: 3000,
  expiresAt: new Date(NOW_MS + HOUR_MS),
};
const SYSTEM: Principal = { kind: 'system', job: 'probe' };

const SESSION_AUTH: RouteAuth = { session: true };
const EITHER_STEP_UP: RouteAuth = {
  session: true,
  stepUp: true,
  principalKinds: ['user', 'token'],
};
const DOCS: RouteAuth = { serverAdmin: true };
const DOCS_STEP_UP: RouteAuth = { serverAdmin: true, stepUp: true };
const ADMIN_USERS: RouteAuth = { serverAdmin: true, permission: 'server:users' };
const VAULT_READ: RouteAuth = { permission: 'note:read', vaultFrom: 'params.vaultId' };
const BODY_IMPORT: RouteAuth = { permission: 'import:commit', vaultFrom: 'body.vaultId' };

/** The vault and membership columns an id resolver reads beside its own row. */
const ACCESS_COLUMNS = { status: 'active', mcp_enabled: true, role: 'viewer', member_version: 1 };

/** The scope a resolved id hands `authorize()`: its rows pre-loaded, so it reads nothing itself. */
const RESOLVED_SCOPE = {
  vaultId: VAULT,
  vault: { id: VAULT, status: 'active', mcp_enabled: true },
  member: { role: 'viewer', version: 1 },
  requireStepUp: false,
  allowArchived: false,
  surface: 'rest',
};

const ALLOW_VAULT: DetailedDecision = {
  decision: 'allow',
  vault: { id: VAULT, status: 'archived', mcp_enabled: true },
  member: { role: 'viewer', version: 1 },
  archivedRefusal: false,
};

interface ViewOptions {
  readonly method?: string;
  readonly principal?: Principal | null;
  readonly params?: unknown;
  readonly body?: unknown;
  readonly decision?: DetailedDecision;
}

/** A view whose authorizer answers one scripted decision, recording the SIEM lines and the scopes. */
function view(options: ViewOptions = {}): {
  readonly view: PolicyView;
  readonly warnings: unknown[];
  readonly scopes: (AuthzScope | undefined)[];
} {
  const warnings: unknown[] = [];
  const scopes: (AuthzScope | undefined)[] = [];
  return {
    warnings,
    scopes,
    view: {
      method: options.method ?? 'GET',
      principal: options.principal === undefined ? USER : options.principal,
      params: 'params' in options ? options.params : { vaultId: VAULT },
      body: 'body' in options ? options.body : { vaultId: VAULT },
      routeUrl: '/api/v1/__probe__/:vaultId',
      log: {
        warn: (line: unknown) => {
          warnings.push(line);
        },
      },
      authorizeDetailed: async (_principal, _permission, scope) => {
        scopes.push(scope);
        return options.decision ?? ALLOW_VAULT;
      },
    },
  };
}

function deps(connected: boolean = true, script: QueryScript = EMPTY_SCRIPT) {
  const fake = fakeDatabase({ script });
  return {
    fake,
    deps: {
      db: () => (connected ? fake.db : null),
      stepUpWindowMs: STEP_UP_WINDOW_MS,
      now: () => NOW_MS,
    },
  };
}

/** The problem code a policy application refused with. */
async function refusal(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    if (error instanceof ProblemError) return error.code;
    throw error;
  }
  throw new Error('expected a ProblemError');
}

describe('authz.route-policy.apply.unit [area:authz]', () => {
  it('answers unauthenticated for an anonymous view, whatever the policy', async () => {
    const built = view({ principal: null });
    expect(await refusal(applyRoutePolicy(built.view, SESSION_AUTH, deps().deps))).toBe(
      'unauthenticated',
    );
    expect(await refusal(applyRoutePolicy(built.view, VAULT_READ, deps().deps))).toBe(
      'unauthenticated',
    );
    expect(built.warnings).toStrictEqual([]);
  });

  it('refuses the system principal as forbidden and a token on a user-only route by scope, logging the SIEM line', async () => {
    const system = view({ principal: SYSTEM });
    expect(await refusal(applyRoutePolicy(system.view, SESSION_AUTH, deps().deps))).toBe(
      'forbidden',
    );
    expect(system.warnings).toStrictEqual([
      { event: 'authz.denied', reason: 'token_scope', route: '/api/v1/__probe__/:vaultId' },
    ]);
    const token = view({ principal: TOKEN });
    expect(await refusal(applyRoutePolicy(token.view, VAULT_READ, deps().deps))).toBe(
      'token_scope_insufficient',
    );
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
    'refuses a token on a %s session policy before any handler or authorizer can run',
    async (method) => {
      const token = view({ principal: TOKEN, method });
      expect(
        await refusal(
          applyRoutePolicy(
            token.view,
            {
              session: true,
              principalKinds: ['user', 'token'],
            },
            deps().deps,
          ),
        ),
      ).toBe('token_scope_insufficient');
      expect(token.scopes).toEqual([]);
    },
  );

  it('refuses token step-up on a vault policy before the authorizer can accidentally grant it', async () => {
    const token = view({ principal: TOKEN });
    expect(
      await refusal(
        applyRoutePolicy(
          token.view,
          {
            ...VAULT_READ,
            stepUp: true,
            principalKinds: ['user', 'token'],
          },
          deps().deps,
        ),
      ),
    ).toBe('step_up_required');
    expect(token.scopes).toEqual([]);
  });

  it('never lets a token satisfy step-up, even on a policy that admits tokens (D04-10)', async () => {
    const token = view({ principal: TOKEN });
    expect(await refusal(applyRoutePolicy(token.view, EITHER_STEP_UP, deps().deps))).toBe(
      'step_up_required',
    );
    expect(token.warnings).toStrictEqual([
      { event: 'authz.denied', reason: 'step_up', route: '/api/v1/__probe__/:vaultId' },
    ]);
    const stale = view();
    expect(await refusal(applyRoutePolicy(stale.view, EITHER_STEP_UP, deps().deps))).toBe(
      'step_up_required',
    );
    const fresh = view({ principal: { ...USER, lastAuthenticatedAt: new Date(NOW_MS) } });
    await expect(applyRoutePolicy(fresh.view, EITHER_STEP_UP, deps().deps)).resolves.toBeNull();
  });

  it('gates the flag-only administrator routes on the flag, then the window, and a permission on the decision', async () => {
    expect(await refusal(applyRoutePolicy(view().view, DOCS, deps().deps))).toBe('forbidden');
    // An administrator route lists user principals only, so a token is refused by scope at step 2.
    expect(
      await refusal(applyRoutePolicy(view({ principal: TOKEN }).view, DOCS, deps().deps)),
    ).toBe('token_scope_insufficient');
    const staleAdmin = view({ principal: { ...USER, isServerAdmin: true } });
    await expect(applyRoutePolicy(staleAdmin.view, DOCS, deps().deps)).resolves.toBeNull();
    expect(await refusal(applyRoutePolicy(staleAdmin.view, DOCS_STEP_UP, deps().deps))).toBe(
      'step_up_required',
    );
    const admin = view({ principal: FRESH_ADMIN });
    await expect(applyRoutePolicy(admin.view, DOCS_STEP_UP, deps().deps)).resolves.toBeNull();
    const allowed = view({
      principal: FRESH_ADMIN,
      decision: { decision: 'allow', vault: null, member: null, archivedRefusal: false },
    });
    await expect(applyRoutePolicy(allowed.view, ADMIN_USERS, deps().deps)).resolves.toBeNull();
    expect(allowed.scopes).toEqual([{ requireStepUp: false, surface: 'rest' }]);
    await expect(
      applyRoutePolicy(allowed.view, { ...ADMIN_USERS, stepUp: true }, deps().deps),
    ).resolves.toBeNull();
    expect(allowed.scopes.at(-1)).toEqual({ requireStepUp: true, surface: 'rest' });
    const denied = view({
      decision: {
        decision: { deny: 'forbidden' },
        vault: null,
        member: null,
        archivedRefusal: false,
      },
    });
    expect(await refusal(applyRoutePolicy(denied.view, ADMIN_USERS, deps().deps))).toBe(
      'forbidden',
    );
  });

  it('answers not_found when the route carries no id its policy names, before any query', async () => {
    const built = deps();
    for (const params of [
      {},
      { vaultId: 'not-an-id' },
      'nope',
      null,
      undefined,
      Object.assign([], { vaultId: VAULT }),
      Object.assign(() => undefined, { vaultId: VAULT }),
    ]) {
      // eslint-disable-next-line no-await-in-loop -- four shapes, checked in order
      const code = await refusal(applyRoutePolicy(view({ params }).view, VAULT_READ, built.deps));
      expect(code).toBe('not_found');
    }
    expect(await refusal(applyRoutePolicy(view({ body: [] }).view, BODY_IMPORT, built.deps))).toBe(
      'not_found',
    );
    expect(built.fake.executed).toStrictEqual([]);
  });

  it('throws the store error, never a deny, while the pool is not connected', async () => {
    await expect(
      applyRoutePolicy(view().view, VAULT_READ, deps(false).deps),
    ).rejects.toBeInstanceOf(AuthzStoreUnavailableError);
    // The policies that address no vault need no pool.
    await expect(applyRoutePolicy(view().view, SESSION_AUTH, deps(false).deps)).resolves.toBeNull();
  });

  it('maps every deny of a vault-scoped decision, the archived write freeze to vault_archived', async () => {
    const cases = [
      [{ deny: 'not_found' }, false, 'not_found'],
      [{ deny: 'forbidden' }, false, 'forbidden'],
      [{ deny: 'forbidden' }, true, 'vault_archived'],
      [{ deny: 'step_up_required' }, false, 'step_up_required'],
    ] as const;
    for (const [decision, archivedRefusal, code] of cases) {
      const built = view({ decision: { decision, vault: null, member: null, archivedRefusal } });
      // eslint-disable-next-line no-await-in-loop -- the mapping is checked in order
      expect(await refusal(applyRoutePolicy(built.view, VAULT_READ, deps().deps))).toBe(code);
      expect(built.warnings).toEqual([
        {
          event: 'authz.denied',
          reason: decision.deny === 'step_up_required' ? 'step_up' : decision.deny,
          route: '/api/v1/__probe__/:vaultId',
        },
      ]);
    }
  });

  it('attaches the vault, the explicit role and the administrator manager floor on an allow', async () => {
    await expect(applyRoutePolicy(view().view, VAULT_READ, deps().deps)).resolves.toStrictEqual({
      vault: { id: VAULT, status: 'archived', role: 'viewer' },
      vaultRole: 'viewer',
      resolvedNode: null,
    });
    const admin = view({
      principal: FRESH_ADMIN,
      decision: { ...ALLOW_VAULT, member: null },
    });
    await expect(applyRoutePolicy(admin.view, VAULT_READ, deps().deps)).resolves.toStrictEqual({
      vault: { id: VAULT, status: 'archived', role: null },
      vaultRole: 'manager',
      resolvedNode: null,
    });
    const token = view({ principal: { ...TOKEN, adminOwned: true } });
    await expect(
      applyRoutePolicy(
        token.view,
        { ...VAULT_READ, principalKinds: ['user', 'token'] },
        deps().deps,
      ),
    ).resolves.toMatchObject({ vaultRole: 'viewer' });
    const fromBody = view({ params: {}, body: { vaultId: VAULT.toUpperCase() } });
    await expect(applyRoutePolicy(fromBody.view, BODY_IMPORT, deps().deps)).resolves.toMatchObject({
      vault: { id: VAULT },
    });
  });

  it('passes allowArchived to the decision for exactly the routes that declare it (D04-12)', async () => {
    const plain = view();
    await applyRoutePolicy(plain.view, VAULT_READ, deps().deps);
    expect(plain.scopes).toStrictEqual([
      { vaultId: VAULT, requireStepUp: false, allowArchived: false, surface: 'rest' },
    ]);
    const lifted = view();
    await applyRoutePolicy(
      lifted.view,
      { permission: 'vault:archive', vaultFrom: 'params.vaultId', allowArchived: true },
      deps().deps,
    );
    expect(lifted.scopes).toStrictEqual([
      { vaultId: VAULT, requireStepUp: false, allowArchived: true, surface: 'rest' },
    ]);
  });

  it.each([
    ['node:params.nodeId', 'category', true],
    ['node:params.nodeId', 'note', true],
    ['note:params.noteId', 'category', false],
    ['note:params.noteId', 'note', true],
  ] as const)(
    'resolves %s with kind %s without confusing notes and categories',
    async (vaultFrom, kind, allowed) => {
      const id = '019948c4-0000-7000-8000-000000000003';
      const deletedAt = new Date(NOW_MS);
      const built = view({ params: { nodeId: id, noteId: id } });
      const sql = deps(true, () => ({
        rows: [{ vault_id: idBytes(VAULT), kind, deleted_at: deletedAt, ...ACCESS_COLUMNS }],
      }));
      const work = applyRoutePolicy(built.view, { permission: 'note:read', vaultFrom }, sql.deps);
      const outcome = await work.catch((error: unknown) => {
        if (error instanceof ProblemError) return error;
        throw error;
      });
      expect(outcome).toMatchObject(
        allowed
          ? { vault: { id: VAULT }, resolvedNode: { vaultId: VAULT, kind, deletedAt } }
          : { code: 'not_found' },
      );
      expect(built.scopes).toEqual(allowed ? [RESOLVED_SCOPE] : []);
      expect(sql.fake.executed).toEqual([
        {
          sql: 'select `r`.`vault_id`, `r`.`kind`, `r`.`deleted_at`, `v`.`status`, `v`.`mcp_enabled`, `vm`.`role`, `vm`.`version` as `member_version` from `nodes` as `r` left join `vaults` as `v` on `v`.`id` = `r`.`vault_id` left join `vault_members` as `vm` on `vm`.`vault_id` = `r`.`vault_id` and `vm`.`user_id` = ? where `r`.`id` = ?',
          parameters: [idBytes(USER.userId), idBytes(id)],
        },
      ]);
    },
  );

  it.each(['node:params.nodeId', 'note:params.noteId'] as const)(
    'refuses an absent %s row before authorization, in the one statement a foreign row costs',
    async (vaultFrom) => {
      const built = view({ params: { nodeId: VAULT, noteId: VAULT } });
      const sql = deps();
      expect(
        await refusal(
          applyRoutePolicy(built.view, { permission: 'note:read', vaultFrom }, sql.deps),
        ),
      ).toBe('not_found');
      expect(built.scopes).toEqual([]);
      // A foreign id reads this same statement and is refused by `authorize()` from its rows, so
      // neither answer costs a second query the other does not (04 section 5.4, T4).
      expect(sql.fake.executed).toEqual([
        {
          sql: 'select `r`.`vault_id`, `r`.`kind`, `r`.`deleted_at`, `v`.`status`, `v`.`mcp_enabled`, `vm`.`role`, `vm`.`version` as `member_version` from `nodes` as `r` left join `vaults` as `v` on `v`.`id` = `r`.`vault_id` left join `vault_members` as `vm` on `vm`.`vault_id` = `r`.`vault_id` and `vm`.`user_id` = ? where `r`.`id` = ?',
          parameters: [idBytes(USER.userId), idBytes(VAULT)],
        },
      ]);
    },
  );

  it.each(['same vault', 'foreign vault', 'unnested', 'missing attachment'] as const)(
    'resolves an attachment in %s without authorizing a foreign parent',
    async (shape) => {
      const attachmentId = '019948c4-0000-7000-8000-000000000003';
      const foreign = '019948c4-0000-7000-8000-0000000000a1';
      const built = view({
        params: {
          attachmentId,
          ...(shape === 'unnested' ? {} : { vaultId: shape === 'foreign vault' ? foreign : VAULT }),
        },
      });
      const sql = deps(true, () => ({
        rows:
          shape === 'missing attachment' ? [] : [{ vault_id: idBytes(VAULT), ...ACCESS_COLUMNS }],
      }));
      const work = applyRoutePolicy(
        built.view,
        { permission: 'note:read', vaultFrom: 'attachment:params.attachmentId' },
        sql.deps,
      );
      const allowed = shape === 'same vault' || shape === 'unnested';
      const outcome = await work.catch((error: unknown) => {
        if (error instanceof ProblemError) return error;
        throw error;
      });
      expect(outcome).toMatchObject(
        allowed ? { vault: { id: VAULT }, resolvedNode: null } : { code: 'not_found' },
      );
      expect(built.scopes).toEqual(allowed ? [RESOLVED_SCOPE] : []);
      expect(sql.fake.executed).toEqual([
        {
          sql: 'select `r`.`vault_id`, `v`.`status`, `v`.`mcp_enabled`, `vm`.`role`, `vm`.`version` as `member_version` from `attachments` as `r` left join `vaults` as `v` on `v`.`id` = `r`.`vault_id` left join `vault_members` as `vm` on `vm`.`vault_id` = `r`.`vault_id` and `vm`.`user_id` = ? where `r`.`id` = ?',
          parameters: [idBytes(USER.userId), idBytes(attachmentId)],
        },
      ]);
    },
  );

  it.each([
    ['requesting user', USER, USER.userId, true],
    ['another user', USER, '019948c4-0000-7000-8000-000000000002', false],
    ['server admin', FRESH_ADMIN, '019948c4-0000-7000-8000-000000000002', true],
    ['requesting token owner', TOKEN, USER.userId, true],
    [
      'admin-owned token',
      { ...TOKEN, adminOwned: true },
      '019948c4-0000-7000-8000-000000000002',
      false,
    ],
    ['orphaned job', USER, null, false],
    ['admin viewing orphaned job', FRESH_ADMIN, null, true],
  ] as const)(
    'job ownership for %s is resolved before its vault permission',
    async (_label, principal, requester, allowed) => {
      const jobId = '019948c4-0000-7000-8000-000000000004';
      const built = view({ principal, params: { jobId } });
      const sql = deps(true, () => ({
        rows: [
          {
            vault_id: idBytes(VAULT),
            requested_by: requester === null ? null : idBytes(requester),
            ...ACCESS_COLUMNS,
          },
        ],
      }));
      const work = applyRoutePolicy(
        built.view,
        {
          permission: 'note:read',
          vaultFrom: 'job:params.jobId',
          principalKinds: ['user', 'token'],
        },
        sql.deps,
      );
      const outcome = await work.catch((error: unknown) => {
        if (error instanceof ProblemError) return error;
        throw error;
      });
      expect(outcome).toMatchObject(
        allowed ? { vault: { id: VAULT }, resolvedNode: null } : { code: 'not_found' },
      );
      expect(built.scopes).toEqual(allowed ? [RESOLVED_SCOPE] : []);
      expect(sql.fake.executed).toEqual([
        {
          sql: 'select `r`.`vault_id`, `r`.`requested_by`, `v`.`status`, `v`.`mcp_enabled`, `vm`.`role`, `vm`.`version` as `member_version` from `jobs` as `r` left join `vaults` as `v` on `v`.`id` = `r`.`vault_id` left join `vault_members` as `vm` on `vm`.`vault_id` = `r`.`vault_id` and `vm`.`user_id` = ? where `r`.`id` = ?',
          parameters: [idBytes(principal.userId), idBytes(jobId)],
        },
      ]);
    },
  );

  it.each([
    { label: 'missing', rows: [] },
    { label: 'without a vault', rows: [{ vault_id: null, requested_by: idBytes(USER.userId) }] },
  ])('refuses a $label job even to the administrator', async ({ rows }) => {
    const built = view({ principal: FRESH_ADMIN, params: { jobId: VAULT } });
    expect(
      await refusal(
        applyRoutePolicy(
          built.view,
          { permission: 'note:read', vaultFrom: 'job:params.jobId' },
          deps(true, () => ({ rows })).deps,
        ),
      ),
    ).toBe('not_found');
    expect(built.scopes).toEqual([]);
  });

  it('runs the real policy hook before all route preHandler shapes and attaches the resolved resource', async () => {
    const booted = await buildWithoutDatabase();
    const app = booted.app;
    const token = mintToken('ses');
    const now = app.clock.now();
    const state = {
      role: 'viewer' as 'viewer' | null,
      lastAuthenticatedAt: new Date(now - 5 * 60_000),
    };
    const session: SessionWithUser = {
      id: idBytes(USER.sessionId),
      token_id: token.tokenId,
      secret_hash: secretHash(token.secret),
      user_id: idBytes(USER.userId),
      kind: 'desktop',
      created_at: new Date(now),
      last_seen_at: new Date(now),
      idle_expires_at: new Date(now + HOUR_MS),
      absolute_expires_at: new Date(now + HOUR_MS),
      last_authenticated_at: state.lastAuthenticatedAt,
      ip: null,
      user_agent: null,
      client_name: 'unit',
      device_name: null,
      client_version: null,
      revoked_at: null,
      revoked_reason: null,
      status: 'active',
      is_server_admin: false,
      authz_version: 1,
    };
    const fake = fakeDatabase({
      script: (query) => {
        if (query.sql.includes('from `sessions`'))
          return { rows: [{ ...session, last_authenticated_at: state.lastAuthenticatedAt }] };
        if (query.sql.includes('from `nodes`'))
          return {
            rows: [
              {
                vault_id: idBytes(VAULT),
                kind: 'note',
                deleted_at: null,
                status: 'active',
                mcp_enabled: true,
                role: state.role,
                member_version: state.role === null ? null : 1,
              },
            ],
          };
        if (query.sql.includes('from `vaults` as `v`'))
          return {
            rows: [
              {
                status: 'active',
                mcp_enabled: true,
                role: state.role,
                version: state.role === null ? null : 1,
              },
            ],
          };
        throw new Error('unexpected policy-hook SQL: ' + query.sql);
      },
    });
    const calls: string[] = [];
    const attachment = {
      vault: { id: VAULT, status: 'active', role: 'viewer' },
      vaultRole: 'viewer',
      resolvedNode: { vaultId: VAULT, kind: 'note', deletedAt: null },
    };
    try {
      for (const shape of ['none', 'single', 'array'] as const) {
        const existing: preHandlerAsyncHookHandler = async (request) => {
          expect({
            vault: request.vault,
            vaultRole: request.vaultRole,
            resolvedNode: request.resolvedNode,
          }).toEqual(attachment);
          calls.push(shape);
        };
        app.get(
          API_PREFIX + '/__probe__/' + shape + '/:noteId',
          {
            config: { auth: { permission: 'note:read', vaultFrom: 'note:params.noteId' } },
            ...(shape === 'none' ? {} : { preHandler: shape === 'single' ? existing : [existing] }),
          },
          async (request, reply) =>
            reply.send({
              vault: request.vault,
              vaultRole: request.vaultRole,
              resolvedNode: request.resolvedNode,
            }),
        );
      }
      app.get(
        API_PREFIX + '/__probe__/stepped',
        { config: { auth: { session: true, stepUp: true } } },
        async () => ({ ok: true }),
      );
      app.get(
        API_PREFIX + '/__probe__/public',
        { config: { auth: { public: true } } },
        async (request, reply) =>
          reply.send({
            vault: request.vault,
            vaultRole: request.vaultRole,
            resolvedNode: request.resolvedNode,
          }),
      );
      await app.ready();
      vi.spyOn(app.database, 'dbApp', 'get').mockReturnValue(fake.db);
      const headers = { host: NO_DATABASE_HOST, authorization: 'Bearer ' + token.raw };
      for (const shape of ['none', 'single', 'array'] as const) {
        // eslint-disable-next-line no-await-in-loop -- observe each registered hook shape independently
        const allowed = await app.inject({
          method: 'GET',
          url: API_PREFIX + '/__probe__/' + shape + '/' + VAULT,
          headers,
        });
        expect(allowed.statusCode).toBe(200);
        expect(allowed.json()).toEqual(attachment);
      }
      expect(calls).toEqual(['single', 'array']);
      state.role = null;
      for (const shape of ['none', 'single', 'array'] as const) {
        // eslint-disable-next-line no-await-in-loop -- every hook shape must refuse before its handler
        const denied = await app.inject({
          method: 'GET',
          url: API_PREFIX + '/__probe__/' + shape + '/' + VAULT,
          headers,
        });
        expect(denied.statusCode).toBe(404);
        expect(denied.json()).toMatchObject({ code: 'not_found' });
      }
      expect(calls).toEqual(['single', 'array']);
      const stepped = await app.inject({
        method: 'GET',
        url: API_PREFIX + '/__probe__/stepped',
        headers,
      });
      expect(stepped.statusCode).toBe(200);
      state.lastAuthenticatedAt = new Date(now - 11 * 60_000);
      const stale = await app.inject({
        method: 'GET',
        url: API_PREFIX + '/__probe__/stepped',
        headers,
      });
      expect(stale.statusCode).toBe(403);
      expect(stale.json()).toMatchObject({
        code: 'step_up_required',
        detail: 'Re-authenticate to continue',
      });
      const publicResponse = await app.inject({
        method: 'GET',
        url: API_PREFIX + '/__probe__/public',
        headers: { host: NO_DATABASE_HOST },
      });
      expect(publicResponse.statusCode).toBe(200);
      expect(publicResponse.json()).toEqual({ vault: null, vaultRole: null, resolvedNode: null });
      expect(
        app
          .routes()
          .filter((route) => route.url.includes('/__probe__/single/'))
          .map((route) => route.method)
          .toSorted(),
      ).toEqual(['GET', 'HEAD']);
      expect(app.problems.map(new AuthzStoreUnavailableError())).toMatchObject({
        code: 'unavailable',
        status: 503,
        extensions: { detail: 'The database is not connected.' },
      });
      app.authz.epochs.user(USER.userId, 1);
      app.authz.bus.publish({ type: 'user.disabled', userId: USER.userId });
      expect(app.authz.epochs.userEpoch(USER.userId)).toBeNaN();
    } finally {
      vi.restoreAllMocks();
      await booted.close();
      await fake.db.destroy();
    }
  });

  it('treats an allow without the vault row as a usage error, never as an active vault', async () => {
    const built = view({
      decision: { decision: 'allow', vault: null, member: null, archivedRefusal: false },
    });
    await expect(applyRoutePolicy(built.view, VAULT_READ, deps().deps)).rejects.toBeInstanceOf(
      AuthzUsageError,
    );
  });
});
