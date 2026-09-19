/**
 * `authz.usage.unit` (04-auth-and-access-control.md section 5.2; D04-08): a vault-scoped
 * permission without a vault id, and a server-scoped one with a vault, are programming errors —
 * `AuthzUsageError`, never a deny — and a pre-loaded vault row on the MCP surface must carry
 * `mcp_enabled`; a database that is not connected is a thrown `503`, never a deny.
 */
import { SessionId, UserId, VaultId, type UserPrincipal } from '@iridium/contracts';
import { describe, expect, it } from 'vitest';

import {
  AuthzStoreUnavailableError,
  AuthzUsageError,
  createAuthorizer,
  createMembershipLookup,
  type MembershipLookup,
  type VaultForAuthz,
} from './authorize.ts';

const USER: UserPrincipal = {
  kind: 'user',
  userId: UserId.parse('019948c4-0000-7000-8000-000000000001'),
  sessionId: SessionId.parse('019948c4-0000-7000-8000-0000000000aa'),
  sessionKind: 'web',
  isServerAdmin: false,
  authzVersion: 1,
  lastAuthenticatedAt: new Date(0),
};
const VAULT = VaultId.parse('019948c4-0000-7000-8000-0000000000a0');

const lookup: MembershipLookup = async (vaultId) => ({
  vault: { id: vaultId, status: 'active', mcp_enabled: true },
  member: { role: 'editor', version: 1 },
});

const authorizer = createAuthorizer({
  lookup,
  now: () => 0,
  stepUpWindowMs: 600_000,
  mcpServerEnabled: () => true,
});

describe('authz.usage.unit [area:authz]', () => {
  it('throws a usage error for a vault-scoped permission without a vault id', async () => {
    await expect(authorizer.authorize(USER, 'note:read')).rejects.toBeInstanceOf(AuthzUsageError);
    await expect(authorizer.authorize(USER, 'note:read', {})).rejects.toThrow(/without a vault id/);
  });

  it('throws a usage error for a server-scoped permission with a vault', async () => {
    await expect(authorizer.authorize(USER, 'server:users', { vaultId: VAULT })).rejects.toThrow(
      /arrived with a vault/,
    );
    await expect(
      authorizer.authorize(USER, 'server:users', {
        vault: { id: VAULT, status: 'active', mcp_enabled: true },
      }),
    ).rejects.toBeInstanceOf(AuthzUsageError);
  });

  it('carries the misused permission and the remedy on the error', async () => {
    const thrown = await authorizer.authorize(USER, 'vault:read').then(
      () => null,
      (error: unknown) => error,
    );
    expect(thrown).toBeInstanceOf(AuthzUsageError);
    expect(thrown).toMatchObject({
      permission: 'vault:read',
      message: expect.stringContaining('boot assertion'),
    });
  });

  it('refuses a pre-loaded vault row without mcp_enabled on the mcp surface', async () => {
    // A row a JavaScript caller built without the column: the guard is a runtime check.
    // eslint-disable-next-line typescript/no-unsafe-type-assertion -- deliberately malformed input for the guard
    const row = { id: VAULT, status: 'active' } as VaultForAuthz;
    await expect(
      authorizer.authorize(USER, 'note:read', { vault: row, member: null, surface: 'mcp' }),
    ).rejects.toThrow(/lacks mcp_enabled/);
  });

  it('throws, never denies, when the membership lookup has no database', async () => {
    const disconnected = createAuthorizer({
      lookup: createMembershipLookup(() => null),
      now: () => 0,
      stepUpWindowMs: 600_000,
      mcpServerEnabled: () => true,
    });
    await expect(
      disconnected.authorize(USER, 'note:read', { vaultId: VAULT }),
    ).rejects.toBeInstanceOf(AuthzStoreUnavailableError);
  });

  it('never throws for an authorization outcome', async () => {
    await expect(authorizer.authorize(USER, 'server:users')).resolves.toStrictEqual({
      deny: 'forbidden',
    });
    await expect(authorizer.authorize(USER, 'note:read', { vaultId: VAULT })).resolves.toBe(
      'allow',
    );
  });
});
