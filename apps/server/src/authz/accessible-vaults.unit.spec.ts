/**
 * `authz.accessible-vaults.unit` (04-auth-and-access-control.md section 5.7; D04-11): the role
 * filter of `accessibleVaultIds()` is derived from the matrix rather than restated, the helper
 * answers an empty list — before any query — while the database is not connected, for a server
 * permission, for a token lacking the scope or with an empty allowlist, and for a token on the MCP
 * surface while the server-wide switch is off; and the statement it does issue carries the ACL as
 * predicates: the membership join for a user, no join for a server administrator or the system,
 * the allowlist `IN` and the vault switch for a token on the MCP surface.
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

import { fakeDatabase } from '../../test/support/fake-driver.ts';
import { idBytes } from '../auth/ids.ts';
import { createAccessibleVaultIds, rolesGranting } from './accessible-vaults.ts';

const VAULT_A = VaultId.parse('019948c4-0000-7000-8000-0000000000a0');
const VAULT_B = VaultId.parse('019948c4-0000-7000-8000-0000000000b0');

const USER: UserPrincipal = {
  kind: 'user',
  userId: UserId.parse('019948c4-0000-7000-8000-000000000001'),
  sessionId: SessionId.parse('019948c4-0000-7000-8000-0000000000aa'),
  sessionKind: 'web',
  isServerAdmin: false,
  authzVersion: 1,
  lastAuthenticatedAt: new Date(0),
};
const ADMIN: UserPrincipal = { ...USER, isServerAdmin: true };
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
  surface: 'mcp',
  rateLimitPerHour: 3000,
  expiresAt: new Date(1),
};

/** A helper over a scripted database that lists `VAULT_A` and `VAULT_B` for any statement. */
function helper(mcpServerEnabled: boolean = true) {
  const fake = fakeDatabase({
    script: () => ({ rows: [{ id: idBytes(VAULT_A) }, { id: idBytes(VAULT_B) }] }),
  });
  return {
    fake,
    list: createAccessibleVaultIds({ db: () => fake.db, mcpServerEnabled: () => mcpServerEnabled }),
  };
}

describe('authz.accessible-vaults.unit [area:authz]', () => {
  it('derives the IN list of roles from the matrix', () => {
    expect(rolesGranting('vault:read')).toStrictEqual(['viewer', 'editor', 'manager']);
    expect(rolesGranting('note:write')).toStrictEqual(['editor', 'manager']);
    expect(rolesGranting('vault:archive')).toStrictEqual(['manager']);
    expect(rolesGranting('server:users')).toStrictEqual([]);
  });

  it('answers an empty list without a database', async () => {
    const list = createAccessibleVaultIds({ db: () => null, mcpServerEnabled: () => true });
    await expect(list(USER, { permission: 'vault:read', surface: 'rest' })).resolves.toStrictEqual(
      [],
    );
  });

  it('answers an empty list before any query when no row could satisfy the listing', async () => {
    const off = helper(false);
    await expect(
      off.list(TOKEN, { permission: 'vault:read', surface: 'mcp' }),
    ).resolves.toStrictEqual([]);
    const { fake, list } = helper();
    // No role grants a server permission on a vault.
    await expect(
      list(USER, { permission: 'server:users', surface: 'rest' }),
    ).resolves.toStrictEqual([]);
    // A token lacking the scope, or with an explicit but empty allowlist.
    await expect(
      list({ ...TOKEN, scopes: ['note:read'] }, { permission: 'vault:read', surface: 'rest' }),
    ).resolves.toStrictEqual([]);
    await expect(
      list(
        { ...TOKEN, vaultScope: { vaultIds: [] } },
        { permission: 'vault:read', surface: 'rest' },
      ),
    ).resolves.toStrictEqual([]);
    expect(off.fake.executed).toStrictEqual([]);
    expect(fake.executed).toStrictEqual([]);
  });

  it('puts the membership join and the role list into the statement for a user', async () => {
    const { fake, list } = helper();
    await expect(list(USER, { permission: 'note:write', surface: 'rest' })).resolves.toStrictEqual([
      VAULT_A,
      VAULT_B,
    ]);
    const [statement] = fake.executed;
    expect(statement?.sql).toContain('inner join `vault_members`');
    expect(statement?.sql).toContain('`v`.`status` in (?, ?)');
    expect(statement?.sql).toContain('`vm`.`role` in (?, ?)');
    expect(statement?.parameters).toStrictEqual([
      idBytes(USER.userId),
      'active',
      'archived',
      'editor',
      'manager',
    ]);
  });

  it('lists every visible vault for a server administrator, and every row for the system', async () => {
    const admin = helper();
    await admin.list(ADMIN, { permission: 'vault:read', surface: 'rest' });
    expect(admin.fake.executed[0]?.sql).not.toContain('vault_members');
    expect(admin.fake.executed[0]?.sql).toContain('`v`.`status` in (?, ?)');
    const system = helper();
    // A user on the MCP surface is the collaboration server's own read: no token switches apply.
    await system.list(
      { kind: 'system', job: 'probe' },
      { permission: 'server:users', surface: 'mcp' },
    );
    expect(system.fake.executed[0]?.sql).not.toContain('status');
    expect(system.fake.executed[0]?.parameters).toStrictEqual([]);
  });

  it('intersects a token with its allowlist and, on the MCP surface, with the vault switch', async () => {
    const rest = helper();
    await rest.list(
      { ...TOKEN, vaultScope: { vaultIds: [VAULT_A] } },
      { permission: 'vault:read', surface: 'rest' },
    );
    expect(rest.fake.executed[0]?.sql).toContain('`v`.`id` in (?)');
    expect(rest.fake.executed[0]?.sql).not.toContain('mcp_enabled');
    const mcp = helper();
    await mcp.list(TOKEN, { permission: 'vault:read', surface: 'mcp' });
    expect(mcp.fake.executed[0]?.sql).toContain('`v`.`mcp_enabled` = ?');
    expect(mcp.fake.executed[0]?.sql).not.toContain('`v`.`id` in');
    const user = helper();
    await user.list(USER, { permission: 'vault:read', surface: 'mcp' });
    expect(user.fake.executed[0]?.sql).not.toContain('mcp_enabled');
  });
});
