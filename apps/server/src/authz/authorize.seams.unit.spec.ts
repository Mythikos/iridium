/**
 * `authz.seams.unit` (04-auth-and-access-control.md sections 5.4, 5.5 and 13; A23; D04-08;
 * D04-31): `authorize()` takes its rows by parameter — a pre-loaded vault and membership perform no
 * lookup, a missing one performs exactly one — holds no module-level state, and reads nothing but
 * its arguments and the injected clock; the token branch is the intersection of scopes, allowlist
 * and the owner's explicit role with no admin-implied elevation and no branch on `tokenKind`.
 */
import {
  SessionId,
  TokenId,
  UserId,
  VaultId,
  type TokenPrincipal,
  type UserPrincipal,
} from '@iridium/contracts';
import { describe, expect, it } from 'vitest';

import { createAuthorizer, type MembershipLookup } from './authorize.ts';

const VAULT = VaultId.parse('019948c4-0000-7000-8000-0000000000a0');
const OTHER = VaultId.parse('019948c4-0000-7000-8000-0000000000b0');
const OWNER = UserId.parse('019948c4-0000-7000-8000-000000000001');

const admin: UserPrincipal = {
  kind: 'user',
  userId: OWNER,
  sessionId: SessionId.parse('019948c4-0000-7000-8000-0000000000aa'),
  sessionKind: 'web',
  isServerAdmin: true,
  authzVersion: 1,
  lastAuthenticatedAt: new Date(0),
};

function token(kind: 'pat' | 'oauth', overrides: Partial<TokenPrincipal> = {}): TokenPrincipal {
  return {
    kind: 'token',
    tokenKind: kind,
    tokenId: TokenId.parse('019948c4-0000-7000-8000-00000000f001'),
    publicTokenId: 'ABCDEFGHIJKLMNOP',
    userId: OWNER,
    clientId: kind === 'oauth' ? 'client' : null,
    consentId: kind === 'oauth' ? 'consent' : null,
    resource: kind === 'oauth' ? 'https://iridium.example/mcp/connect' : null,
    scopes: ['vault:read', 'note:read'],
    vaultScope: { vaultIds: [VAULT] },
    isServerAdmin: false,
    adminOwned: true,
    surface: 'mcp',
    rateLimitPerHour: 3000,
    expiresAt: new Date(1),
    ...overrides,
  };
}

function counting(role: 'viewer' | 'editor' | 'manager' | null, mcpEnabled = true) {
  const state = { lookups: 0 };
  const lookup: MembershipLookup = async (vaultId) => {
    state.lookups += 1;
    return {
      vault: { id: vaultId, status: 'active', mcp_enabled: mcpEnabled },
      member: role === null ? null : { role, version: 3 },
    };
  };
  return {
    state,
    authorizer: createAuthorizer({
      lookup,
      now: () => 0,
      stepUpWindowMs: 600_000,
      mcpServerEnabled: () => true,
    }),
  };
}

describe('authz.seams.unit [area:authz]', () => {
  it('performs exactly one lookup for a vault-scoped decision and none for a pre-loaded scope', async () => {
    const { state, authorizer } = counting('editor');
    await authorizer.authorize(admin, 'note:read', { vaultId: VAULT });
    expect(state.lookups).toBe(1);
    await authorizer.authorize(admin, 'note:read', {
      vault: { id: VAULT, status: 'active', mcp_enabled: true },
      member: { role: 'viewer', version: 1 },
    });
    expect(state.lookups).toBe(1);
    // A pre-loaded vault without a membership still needs the membership half, and a pre-loaded
    // membership without the vault row still needs the vault half — one lookup either way.
    await authorizer.authorize(admin, 'note:read', {
      vault: { id: VAULT, status: 'active', mcp_enabled: true },
    });
    expect(state.lookups).toBe(2);
    await expect(
      authorizer.authorize(admin, 'note:read', { vaultId: VAULT, member: null }),
    ).resolves.toBe('allow');
    expect(state.lookups).toBe(3);
    await authorizer.authorize(admin, 'server:users');
    expect(state.lookups).toBe(3);
  });

  it('returns the rows it decided with, so a caller can hang them off the request', async () => {
    const { authorizer } = counting('manager');
    const detailed = await authorizer.authorizeDetailed(admin, 'vault:settings', {
      vaultId: VAULT,
    });
    expect(detailed).toStrictEqual({
      decision: 'allow',
      vault: { id: VAULT, status: 'active', mcp_enabled: true },
      member: { role: 'manager', version: 3 },
      archivedRefusal: false,
    });
    const server = await authorizer.authorizeDetailed(admin, 'server:users');
    expect(server).toStrictEqual({
      decision: 'allow',
      vault: null,
      member: null,
      archivedRefusal: false,
    });
  });

  it('allows a system principal by construction with no lookup', async () => {
    const { state, authorizer } = counting(null);
    await expect(
      authorizer.authorize({ kind: 'system', job: 'cli:test' }, 'node:purge', { vaultId: VAULT }),
    ).resolves.toBe('allow');
    await expect(
      authorizer.authorize({ kind: 'system', job: 'cli:test' }, 'server:jobs'),
    ).resolves.toBe('allow');
    expect(state.lookups).toBe(0);
  });

  it('never lets an administrator-owned token inherit admin-implied access', async () => {
    const { authorizer } = counting(null);
    await expect(authorizer.authorize(admin, 'note:read', { vaultId: VAULT })).resolves.toBe(
      'allow',
    );
    await expect(
      authorizer.authorize(token('pat'), 'note:read', { vaultId: VAULT }),
    ).resolves.toStrictEqual({ deny: 'not_found' });
  });

  it('intersects scopes, the allowlist and the explicit role, and applies the MCP switches', async () => {
    const { authorizer } = counting('editor');
    await expect(
      authorizer.authorize(token('pat'), 'note:read', { vaultId: VAULT, surface: 'mcp' }),
    ).resolves.toBe('allow');
    await expect(
      authorizer.authorize(token('pat'), 'note:write', { vaultId: VAULT, surface: 'mcp' }),
    ).resolves.toStrictEqual({ deny: 'forbidden' });
    await expect(
      authorizer.authorize(token('pat'), 'note:read', { vaultId: OTHER, surface: 'mcp' }),
    ).resolves.toStrictEqual({ deny: 'not_found' });
    await expect(
      authorizer.authorize(token('pat', { vaultScope: { all: true } }), 'note:read', {
        vaultId: OTHER,
        surface: 'mcp',
      }),
    ).resolves.toBe('allow');
    const vaultOff = counting('editor', false).authorizer;
    await expect(
      vaultOff.authorize(token('pat'), 'note:read', { vaultId: VAULT, surface: 'mcp' }),
    ).resolves.toStrictEqual({ deny: 'not_found' });
    await expect(
      vaultOff.authorize(token('pat'), 'note:read', { vaultId: VAULT, surface: 'rest' }),
    ).resolves.toBe('allow');
    const serverOff = createAuthorizer({
      lookup: async (vaultId) => ({
        vault: { id: vaultId, status: 'active', mcp_enabled: true },
        member: { role: 'editor', version: 1 },
      }),
      now: () => 0,
      stepUpWindowMs: 600_000,
      mcpServerEnabled: () => false,
    });
    await expect(
      serverOff.authorize(token('pat'), 'note:read', { vaultId: VAULT, surface: 'mcp' }),
    ).resolves.toStrictEqual({ deny: 'not_found' });
  });

  it('decides an OAuth token and a PAT identically from identical inputs', async () => {
    const { authorizer } = counting('viewer');
    for (const permission of ['note:read', 'note:write', 'vault:read', 'server:users'] as const) {
      const scope =
        permission === 'server:users' ? {} : { vaultId: VAULT, surface: 'mcp' as const };
      // eslint-disable-next-line no-await-in-loop -- the pairs are compared one permission at a time
      const [pat, oauth] = await Promise.all([
        authorizer.authorize(token('pat'), permission, scope),
        authorizer.authorize(token('oauth'), permission, scope),
      ]);
      expect(oauth).toStrictEqual(pat);
    }
  });

  it('answers not_found for a vault that does not exist or is invisible', async () => {
    const missing = createAuthorizer({
      lookup: async () => ({ vault: null, member: null }),
      now: () => 0,
      stepUpWindowMs: 600_000,
      mcpServerEnabled: () => true,
    });
    await expect(missing.authorize(admin, 'note:read', { vaultId: VAULT })).resolves.toStrictEqual({
      deny: 'not_found',
    });
    const importing = createAuthorizer({
      lookup: async (vaultId) => ({
        vault: { id: vaultId, status: 'importing', mcp_enabled: true },
        member: { role: 'manager', version: 1 },
      }),
      now: () => 0,
      stepUpWindowMs: 600_000,
      mcpServerEnabled: () => true,
    });
    await expect(
      importing.authorize(admin, 'note:read', { vaultId: VAULT }),
    ).resolves.toStrictEqual({ deny: 'not_found' });
  });
});
