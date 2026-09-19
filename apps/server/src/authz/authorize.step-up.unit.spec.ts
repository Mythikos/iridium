/**
 * `authz.step-up.order.unit` (04-auth-and-access-control.md sections 4.6 and 5.4; D04-09): step-up
 * is evaluated last — a caller who is not a member, or lacks the permission, gets `not_found` or
 * `forbidden` before `step_up_required`, so the prompt never reveals that an action would otherwise
 * be allowed; a token principal never reaches the step-up branch; the window is measured from
 * `lastAuthenticatedAt` against the injected clock.
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

const WINDOW_MS = 600_000;
const NOW = 1_000_000_000;
const VAULT = VaultId.parse('019948c4-0000-7000-8000-0000000000a0');

function user(
  lastAuthenticatedAgoMs: number,
  overrides: Partial<UserPrincipal> = {},
): UserPrincipal {
  return {
    kind: 'user',
    userId: UserId.parse('019948c4-0000-7000-8000-000000000001'),
    sessionId: SessionId.parse('019948c4-0000-7000-8000-0000000000aa'),
    sessionKind: 'web',
    isServerAdmin: false,
    authzVersion: 1,
    lastAuthenticatedAt: new Date(NOW - lastAuthenticatedAgoMs),
    ...overrides,
  };
}

const TOKEN: TokenPrincipal = {
  kind: 'token',
  tokenKind: 'pat',
  tokenId: TokenId.parse('019948c4-0000-7000-8000-00000000f001'),
  publicTokenId: 'ABCDEFGHIJKLMNOP',
  userId: user(0).userId,
  clientId: null,
  consentId: null,
  resource: null,
  scopes: ['vault:read', 'note:read'],
  vaultScope: { all: true },
  isServerAdmin: false,
  adminOwned: false,
  surface: 'rest',
  rateLimitPerHour: 3000,
  expiresAt: new Date(NOW + 1),
};

function authorizerWith(lookup: MembershipLookup) {
  return createAuthorizer({
    lookup,
    now: () => NOW,
    stepUpWindowMs: WINDOW_MS,
    mcpServerEnabled: () => true,
  });
}

const memberLookup =
  (
    role: 'viewer' | 'editor' | 'manager' | null,
    status: 'active' | 'archived' = 'active',
  ): MembershipLookup =>
  async (vaultId) => ({
    vault: { id: vaultId, status, mcp_enabled: true },
    member: role === null ? null : { role, version: 1 },
  });

describe('authz.step-up.order.unit [area:authz]', () => {
  it('answers not_found for a non-member before any step-up consideration', async () => {
    const stale = user(WINDOW_MS + 1);
    await expect(
      authorizerWith(memberLookup(null)).authorize(stale, 'vault:archive', {
        vaultId: VAULT,
        requireStepUp: true,
      }),
    ).resolves.toStrictEqual({ deny: 'not_found' });
  });

  it('answers forbidden for a member lacking the permission before step-up', async () => {
    const stale = user(WINDOW_MS + 1);
    await expect(
      authorizerWith(memberLookup('viewer')).authorize(stale, 'vault:archive', {
        vaultId: VAULT,
        requireStepUp: true,
      }),
    ).resolves.toStrictEqual({ deny: 'forbidden' });
  });

  it('answers step_up_required only once existence and permission both passed', async () => {
    const stale = user(WINDOW_MS + 1);
    await expect(
      authorizerWith(memberLookup('manager')).authorize(stale, 'vault:archive', {
        vaultId: VAULT,
        requireStepUp: true,
      }),
    ).resolves.toStrictEqual({ deny: 'step_up_required' });
    const fresh = user(WINDOW_MS);
    await expect(
      authorizerWith(memberLookup('manager')).authorize(fresh, 'vault:archive', {
        vaultId: VAULT,
        requireStepUp: true,
      }),
    ).resolves.toBe('allow');
  });

  it('applies the same order to server-scoped permissions', async () => {
    const staleNonAdmin = user(WINDOW_MS + 1);
    await expect(
      authorizerWith(memberLookup(null)).authorize(staleNonAdmin, 'server:users', {
        requireStepUp: true,
      }),
    ).resolves.toStrictEqual({ deny: 'forbidden' });
    const staleAdmin = user(WINDOW_MS + 1, { isServerAdmin: true });
    await expect(
      authorizerWith(memberLookup(null)).authorize(staleAdmin, 'server:users', {
        requireStepUp: true,
      }),
    ).resolves.toStrictEqual({ deny: 'step_up_required' });
    await expect(
      authorizerWith(memberLookup(null)).authorize(
        user(0, { isServerAdmin: true }),
        'server:users',
        { requireStepUp: true },
      ),
    ).resolves.toBe('allow');
  });

  it('ignores step-up for a token principal: the route policy refuses it earlier with token_scope_insufficient', async () => {
    await expect(
      authorizerWith(memberLookup('editor')).authorize(TOKEN, 'note:read', {
        vaultId: VAULT,
        requireStepUp: true,
      }),
    ).resolves.toBe('allow');
  });

  it('does not require step-up when the scope does not ask for it', async () => {
    const stale = user(WINDOW_MS * 100);
    await expect(
      authorizerWith(memberLookup('manager')).authorize(stale, 'vault:archive', { vaultId: VAULT }),
    ).resolves.toBe('allow');
  });

  it('marks an archived-vault write refusal so the route answers vault_archived', async () => {
    const detailed = await authorizerWith(memberLookup('manager', 'archived')).authorizeDetailed(
      user(0),
      'note:write',
      { vaultId: VAULT },
    );
    expect(detailed.decision).toStrictEqual({ deny: 'forbidden' });
    expect(detailed.archivedRefusal).toBe(true);
    const read = await authorizerWith(memberLookup('viewer', 'archived')).authorizeDetailed(
      user(0),
      'note:read',
      { vaultId: VAULT },
    );
    expect(read.decision).toBe('allow');
    expect(read.archivedRefusal).toBe(false);
    const plain = await authorizerWith(memberLookup('viewer')).authorizeDetailed(
      user(0),
      'note:write',
      { vaultId: VAULT },
    );
    expect(plain.archivedRefusal).toBe(false);
  });
});
