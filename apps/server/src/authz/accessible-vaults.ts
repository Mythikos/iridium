/**
 * `accessibleVaultIds()` — authorization inside SQL (04-auth-and-access-control.md section 5.7;
 * D04-11).
 *
 * Search, cross-vault listings and the audit viewer must not post-filter results: a result that is
 * filtered after the fact has already been counted, paginated and possibly scored against
 * inaccessible data. This is the one helper every such query obtains its ACL from; the ids go into
 * the query as `vault_id IN (?)`, so the ACL is part of the SQL plan. The role filter is an `IN`
 * list of roles computed from the matrix in TypeScript, so the matrix stays the single source of
 * truth rather than being restated as `IN ('viewer','editor','manager')`.
 */
import {
  matrixAllows,
  ROLES,
  type Permission,
  type Principal,
  type VaultId,
} from '@iridium/contracts';
import type { Kysely } from 'kysely';

import { idBytes, vaultIdFromBytes } from '../auth/ids.ts';
import type { Database } from '../db/index.ts';
import type { VaultRole } from '../db/schema.ts';

/** Which surface the listing serves; `'mcp'` adds the two kill switches. */
export interface AccessibleVaultsOptions {
  readonly permission: Permission;
  readonly surface: 'rest' | 'mcp';
}

/** What the helper needs from the process. */
export interface AccessibleVaultsDeps {
  readonly db: () => Kysely<Database> | null;
  /** `SettingsStore.effective().mcp_enabled` (D04-29); the `MCP_ENABLED` value at M1. */
  readonly mcpServerEnabled: () => boolean;
}

/** The roles the matrix grants a permission to — the `IN (…)` list. */
export function rolesGranting(permission: Permission): readonly VaultRole[] {
  return ROLES.filter((role) => matrixAllows(role, permission));
}

/** The helper, bound to its dependencies. */
export type AccessibleVaultIds = (
  principal: Principal,
  options: AccessibleVaultsOptions,
) => Promise<readonly VaultId[]>;

/** Builds the helper. */
export function createAccessibleVaultIds(deps: AccessibleVaultsDeps): AccessibleVaultIds {
  return async (principal, options) => {
    const db = deps.db();
    if (db === null) return [];
    const mcp = options.surface === 'mcp';
    // The server-wide switch is not a SQL predicate: a `false` short-circuits before any query.
    if (mcp && principal.kind === 'token' && !deps.mcpServerEnabled()) return [];

    const roles = rolesGranting(options.permission);
    if (roles.length === 0 && principal.kind !== 'system') return [];

    let query = db
      .selectFrom('vaults as v')
      .select('v.id')
      .where('v.status', 'in', ['active', 'archived']);

    if (principal.kind === 'user' && principal.isServerAdmin) {
      // Every vault, plus nothing else: the admin is a manager everywhere for user principals.
    } else if (principal.kind === 'system') {
      query = db.selectFrom('vaults as v').select('v.id');
    } else {
      query = query
        .innerJoin('vault_members as vm', (join) =>
          join.onRef('vm.vault_id', '=', 'v.id').on('vm.user_id', '=', idBytes(principal.userId)),
        )
        .where('vm.role', 'in', roles);
      if (principal.kind === 'token') {
        if (!principal.scopes.includes(options.permission)) return [];
        if (!('all' in principal.vaultScope)) {
          if (principal.vaultScope.vaultIds.length === 0) return [];
          query = query.where(
            'v.id',
            'in',
            principal.vaultScope.vaultIds.map((vaultId) => idBytes(vaultId)),
          );
        }
        if (mcp) query = query.where('v.mcp_enabled', '=', true);
      }
    }

    const rows = await query.execute();
    return rows.map((row) => vaultIdFromBytes(row.id));
  };
}
