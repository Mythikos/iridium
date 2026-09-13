/**
 * Roles, permissions, principals and the pure authorization core
 * (04-auth-and-access-control.md sections 5.1 to 5.4; skeleton A30, A31).
 *
 * Permissions are strings rather than bitmasks or role comparisons because they are also token
 * scopes and must be readable in a token-creation dialog and in an audit row. The vocabulary is
 * closed and exhaustive; adding one is a change here plus a row in `authz.matrix.unit`.
 *
 * `decide()` is the pure core of `authorize()` — steps 2, 4, 5 and 6 of its algorithm — exported
 * so a client can grey out controls with exactly the server's logic and so the matrix can be
 * property-tested without a database. Every early return is a deny; there is no fall-through to
 * allow.
 */

import { z } from 'zod';

import type { SessionId, TokenId, UserId, VaultId } from './ids.ts';
import type { EnumOf } from './schema.ts';

// ---------------------------------------------------------------------------------------------
// Roles and vault status
// ---------------------------------------------------------------------------------------------

/** Vault roles, ordered `viewer < editor < manager`. They are per vault (`vault_members.role`). */
export const ROLES = ['viewer', 'editor', 'manager'] as const;

/** A vault role. `users.is_server_admin` is a server-level flag, not a fourth role. */
export type Role = (typeof ROLES)[number];

/** A vault role. */
export const Role: EnumOf<typeof ROLES> = z.enum(ROLES);

/** The order of the roles, used only by `maxRole`. */
export const ROLE_RANK: Readonly<Record<Role, number>> = { viewer: 1, editor: 2, manager: 3 };

/** The greater of two roles, with `null` meaning "no membership". */
export function maxRole(left: Role | null, right: Role | null): Role | null {
  if (left === null) return right;
  if (right === null) return left;
  return ROLE_RANK[left] >= ROLE_RANK[right] ? left : right;
}

/** `vaults.status` (03-data-model.md section 5). */
export const VAULT_STATUSES = ['importing', 'active', 'archived', 'deleting'] as const;

/** `vaults.status`. */
export type VaultStatus = (typeof VAULT_STATUSES)[number];

/** `vaults.status`. */
export const VaultStatus: EnumOf<typeof VAULT_STATUSES> = z.enum(VAULT_STATUSES);

/** Statuses that make a vault invisible to every listing and every authorization decision. */
export const INVISIBLE_VAULT_STATUSES: readonly VaultStatus[] = ['importing', 'deleting'];

// ---------------------------------------------------------------------------------------------
// The permission vocabulary
// ---------------------------------------------------------------------------------------------

/** The closed permission vocabulary of 04-auth-and-access-control.md section 5.2. */
export const PERMISSIONS = [
  // read
  'vault:read',
  'note:read',
  'search:read',
  'history:read',
  'attachment:read',
  'export:read',
  // write
  'note:write',
  'node:create',
  'node:rename',
  'node:move',
  'node:trash',
  'node:restore',
  'attachment:write',
  'revision:name',
  // manage
  'vault:manage_members',
  'vault:settings',
  'vault:archive',
  'history:restore',
  'node:purge',
  'import:commit',
  // server
  'server:users',
  'server:vaults:create',
  'server:settings',
  'server:audit:all',
  'server:tokens:all',
  'server:sessions:all',
  'server:jobs',
  'server:releases',
] as const;

/** A member of the closed permission vocabulary. */
export type Permission = (typeof PERMISSIONS)[number];

/** A member of the closed permission vocabulary. */
export const Permission: EnumOf<typeof PERMISSIONS> = z.enum(PERMISSIONS);

/** The group a permission belongs to, as the vocabulary table names it. */
export type PermissionGroup = 'read' | 'write' | 'manage' | 'server';

/** The group a permission belongs to. */
export const PERMISSION_GROUP: Readonly<Record<Permission, PermissionGroup>> = {
  'vault:read': 'read',
  'note:read': 'read',
  'search:read': 'read',
  'history:read': 'read',
  'attachment:read': 'read',
  'export:read': 'read',
  'note:write': 'write',
  'node:create': 'write',
  'node:rename': 'write',
  'node:move': 'write',
  'node:trash': 'write',
  'node:restore': 'write',
  'attachment:write': 'write',
  'revision:name': 'write',
  'vault:manage_members': 'manage',
  'vault:settings': 'manage',
  'vault:archive': 'manage',
  'history:restore': 'manage',
  'node:purge': 'manage',
  'import:commit': 'manage',
  'server:users': 'server',
  'server:vaults:create': 'server',
  'server:settings': 'server',
  'server:audit:all': 'server',
  'server:tokens:all': 'server',
  'server:sessions:all': 'server',
  'server:jobs': 'server',
  'server:releases': 'server',
};

/**
 * Whether a permission is decided against a vault or against the server. This is what makes a
 * missing vault id impossible to ignore: `authorize()` raises a usage error when a `'vault'`
 * permission arrives without a vault id, and when a `'server'` permission arrives with one.
 */
export const PERMISSION_SCOPE: Readonly<Record<Permission, 'vault' | 'server'>> = {
  'vault:read': 'vault',
  'note:read': 'vault',
  'search:read': 'vault',
  'history:read': 'vault',
  'attachment:read': 'vault',
  'export:read': 'vault',
  'note:write': 'vault',
  'node:create': 'vault',
  'node:rename': 'vault',
  'node:move': 'vault',
  'node:trash': 'vault',
  'node:restore': 'vault',
  'attachment:write': 'vault',
  'revision:name': 'vault',
  'vault:manage_members': 'vault',
  'vault:settings': 'vault',
  'vault:archive': 'vault',
  'history:restore': 'vault',
  'node:purge': 'vault',
  'import:commit': 'vault',
  'server:users': 'server',
  'server:vaults:create': 'server',
  'server:settings': 'server',
  'server:audit:all': 'server',
  'server:tokens:all': 'server',
  'server:sessions:all': 'server',
  'server:jobs': 'server',
  'server:releases': 'server',
};

/**
 * The six read permissions. They are the whole of what an integration token or an OAuth consent
 * can carry in MVP, and the only permissions an archived vault still allows.
 */
export const READ_BUNDLE: readonly [
  'vault:read',
  'note:read',
  'search:read',
  'history:read',
  'attachment:read',
  'export:read',
] = ['vault:read', 'note:read', 'search:read', 'history:read', 'attachment:read', 'export:read'];

/** Whether a permission is a read, which is what an archived vault still allows. */
export function isReadPermission(permission: Permission): boolean {
  return READ_BUNDLE.some((read) => read === permission);
}

// ---------------------------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------------------------

/**
 * The four role states the matrix is keyed by. `serverAdmin` is the effective state of a *user*
 * principal with `users.is_server_admin`; a token principal never reaches it (section 9.2).
 */
export type MatrixRole = Role | 'serverAdmin';

/** The four role states the matrix is keyed by. */
export const MATRIX_ROLES: readonly MatrixRole[] = ['viewer', 'editor', 'manager', 'serverAdmin'];

const READ_ONLY: Readonly<Record<Permission, boolean>> = {
  'vault:read': true,
  'note:read': true,
  'search:read': true,
  'history:read': true,
  'attachment:read': true,
  'export:read': true,
  'note:write': false,
  'node:create': false,
  'node:rename': false,
  'node:move': false,
  'node:trash': false,
  'node:restore': false,
  'attachment:write': false,
  'revision:name': false,
  'vault:manage_members': false,
  'vault:settings': false,
  'vault:archive': false,
  'history:restore': false,
  'node:purge': false,
  'import:commit': false,
  'server:users': false,
  'server:vaults:create': false,
  'server:settings': false,
  'server:audit:all': false,
  'server:tokens:all': false,
  'server:sessions:all': false,
  'server:jobs': false,
  'server:releases': false,
};

/**
 * The role by permission matrix of 04-auth-and-access-control.md section 5.3. It is the only
 * place in the system where a role maps to permissions; the server's `authz/permissions.ts`
 * re-exports this table rather than restating it.
 *
 * Deny by default: an unmatched permission denies, and a permission with no row does not compile
 * (`Record<Permission, boolean>`).
 */
export const PERMISSION_MATRIX: Readonly<
  Record<MatrixRole, Readonly<Record<Permission, boolean>>>
> = {
  viewer: READ_ONLY,
  editor: {
    ...READ_ONLY,
    'note:write': true,
    'node:create': true,
    'node:rename': true,
    'node:move': true,
    'node:trash': true,
    'node:restore': true,
    'attachment:write': true,
    'revision:name': true,
  },
  manager: {
    ...READ_ONLY,
    'note:write': true,
    'node:create': true,
    'node:rename': true,
    'node:move': true,
    'node:trash': true,
    'node:restore': true,
    'attachment:write': true,
    'revision:name': true,
    'vault:manage_members': true,
    'vault:settings': true,
    'vault:archive': true,
    'history:restore': true,
    'node:purge': true,
    'import:commit': true,
  },
  serverAdmin: {
    'vault:read': true,
    'note:read': true,
    'search:read': true,
    'history:read': true,
    'attachment:read': true,
    'export:read': true,
    'note:write': true,
    'node:create': true,
    'node:rename': true,
    'node:move': true,
    'node:trash': true,
    'node:restore': true,
    'attachment:write': true,
    'revision:name': true,
    'vault:manage_members': true,
    'vault:settings': true,
    'vault:archive': true,
    'history:restore': true,
    'node:purge': true,
    'import:commit': true,
    'server:users': true,
    'server:vaults:create': true,
    'server:settings': true,
    'server:audit:all': true,
    'server:tokens:all': true,
    'server:sessions:all': true,
    'server:jobs': true,
    'server:releases': true,
  },
};

/** Whether the matrix grants `permission` to `role`. An unknown pairing denies. */
export function matrixAllows(role: MatrixRole, permission: Permission): boolean {
  return PERMISSION_MATRIX[role][permission];
}

/** Every permission a role holds, in vocabulary order. */
export function permissionsOf(role: MatrixRole): readonly Permission[] {
  return PERMISSIONS.filter((permission) => PERMISSION_MATRIX[role][permission]);
}

// ---------------------------------------------------------------------------------------------
// Principals
// ---------------------------------------------------------------------------------------------

/** The tuple `beforeHandleMessage` compares per frame. A tuple, never a sum. */
export interface AuthzEpoch {
  /** `users.authz_version` at authentication time. */
  readonly userAuthzVersion: number;
  /** `vault_members.version` at authentication time. */
  readonly memberVersion: number;
}

/** Which surface a principal is acting on. `'mcp'` applies the MCP kill switches. */
export type AuthzSurface = 'rest' | 'collab' | 'mcp' | 'internal';

/** The vaults a token may reach, before intersection with the owner's live memberships. */
export type TokenVaultScope = { readonly all: true } | { readonly vaultIds: readonly VaultId[] };

/** A human, authenticated by a session cookie, a desktop bearer session or a collab ticket. */
export interface UserPrincipal {
  readonly kind: 'user';
  readonly userId: UserId;
  readonly sessionId: SessionId;
  readonly sessionKind: 'web' | 'desktop';
  readonly isServerAdmin: boolean;
  /** `users.authz_version` at authentication time. */
  readonly authzVersion: number;
  /** Drives the step-up window. */
  readonly lastAuthenticatedAt: Date;
}

/** A personal access token or an OAuth access token. Never a server administrator (section 9.2). */
export interface TokenPrincipal {
  readonly kind: 'token';
  /** Which credential produced it; nothing in `authorize()` reads this. */
  readonly tokenKind: 'pat' | 'oauth';
  /** `access_tokens.id`. */
  readonly tokenId: TokenId;
  /** `access_tokens.token_id`, the id16 inside the credential. */
  readonly publicTokenId: string;
  readonly userId: UserId;
  /** `oauth_clients.client_id` (a CIMD URL or a registered id); `null` for a PAT. */
  readonly clientId: string | null;
  /** `oauth_consents.id`; `null` for a PAT. */
  readonly consentId: string | null;
  /** The RFC 8707 audience the token was issued for; `null` for a PAT. */
  readonly resource: string | null;
  /** The permission strings stored on the row, with reserved scopes already dropped. */
  readonly scopes: readonly Permission[];
  readonly vaultScope: TokenVaultScope;
  /** Structurally impossible to be true. */
  readonly isServerAdmin: false;
  readonly adminOwned: boolean;
  readonly surface: 'mcp' | 'rest';
  readonly rateLimitPerHour: number;
  readonly expiresAt: Date;
}

/** The scheduler, the migrations, the CLI and server-originated collaborative writes. */
export interface SystemPrincipal {
  readonly kind: 'system';
  /** Lands in `audit_events.context.job`. */
  readonly job: string;
  readonly onBehalfOf?: UserId;
}

/**
 * The only input describing "who" anywhere in the server. No handler, tool or hook ever looks at
 * a request, a cookie, a header or a connection to decide something. The union is closed: adding
 * a kind is a deliberate contract change (01-vision-scope-and-principles.md section 4.4).
 */
export type Principal = UserPrincipal | TokenPrincipal | SystemPrincipal;

/** The three principal kinds. */
export type PrincipalKind = Principal['kind'];

/** The three principal kinds. */
export const PRINCIPAL_KINDS: readonly PrincipalKind[] = ['user', 'token', 'system'];

// ---------------------------------------------------------------------------------------------
// The pure decision
// ---------------------------------------------------------------------------------------------

/**
 * What `authorize()` answers. A deny is never thrown: only usage errors and database failures
 * throw, and neither is converted into a deny.
 */
export type Decision =
  | 'allow'
  | { readonly deny: 'not_found' }
  | { readonly deny: 'forbidden' }
  | { readonly deny: 'step_up_required' };

const DENY_NOT_FOUND: Decision = { deny: 'not_found' };
const DENY_FORBIDDEN: Decision = { deny: 'forbidden' };
const DENY_STEP_UP: Decision = { deny: 'step_up_required' };

/** The inputs `decide()` is a total function of. */
export interface DecideInput {
  readonly principalKind: PrincipalKind;
  /** Always `false` for a token principal. */
  readonly isServerAdmin: boolean;
  /** The `vault_members` row's role, or `null` when there is none. */
  readonly explicitRole: Role | null;
  /** The vault row's status, or `null` when no vault row was found. */
  readonly vaultStatus: VaultStatus | null;
  readonly permission: Permission;
  /** A token principal's scopes; ignored for the other kinds. */
  readonly scopes: readonly Permission[];
  /** Whether the vault is inside a token's allowlist (or `all_vaults`). */
  readonly vaultAllowed: boolean;
  /**
   * `settings.mcp_enabled && vault.mcp_enabled`, already combined. On a surface other than
   * `'mcp'` the caller passes `true`: `authorize()` computes the AND, and consults it only for
   * token principals on the MCP surface.
   */
  readonly mcpEnabled: boolean;
  /**
   * `false` only when the route requires step-up and the user principal's
   * `lastAuthenticatedAt` is outside the window. Step-up is evaluated last, so a caller who is
   * not a member or lacks the permission is refused before the prompt could reveal anything.
   */
  readonly stepUpOk: boolean;
}

/**
 * The pure core of `authorize()`. Server-scoped permissions are decided against the server-admin
 * flag; vault-scoped permissions against the vault's status, the caller's effective role and —
 * for tokens — the intersection of scopes, allowlist and the owner's *explicit* role, because
 * administrator-implied access never flows to a token.
 */
export function decide(input: DecideInput): Decision {
  if (input.principalKind === 'system') return 'allow';

  if (PERMISSION_SCOPE[input.permission] === 'server') {
    if (input.principalKind !== 'user') return DENY_FORBIDDEN;
    // One condition, not two statements: the matrix lookup is the authority even here, and a
    // permission the table ever stops granting a server administrator must deny rather than fall
    // through the flag.
    if (!input.isServerAdmin || !matrixAllows('serverAdmin', input.permission)) {
      return DENY_FORBIDDEN;
    }
    return input.stepUpOk ? 'allow' : DENY_STEP_UP;
  }

  if (input.vaultStatus === null) return DENY_NOT_FOUND;
  if (INVISIBLE_VAULT_STATUSES.includes(input.vaultStatus)) return DENY_NOT_FOUND;

  const isUser = input.principalKind === 'user';
  // A server administrator is a manager on every vault — computed here rather than as a bypass
  // branch, so an administrator's action goes through the same matrix and the same audit path.
  const effectiveRole: Role | null =
    isUser && input.isServerAdmin ? maxRole(input.explicitRole, 'manager') : input.explicitRole;

  if (effectiveRole === null) return DENY_NOT_FOUND;
  if (input.vaultStatus === 'archived' && !isReadPermission(input.permission)) {
    return DENY_FORBIDDEN;
  }
  if (!matrixAllows(effectiveRole, input.permission)) return DENY_FORBIDDEN;

  if (input.principalKind === 'token') {
    // The token's rights are the intersection of its scopes, its vault allowlist and the owner's
    // *explicit* role. The explicit-role half needs no check of its own: `effectiveRole` above is
    // the explicit role for every non-user principal, so a token whose owner holds no membership
    // was already refused `not_found` — administrator-implied access cannot flow to a token.
    if (!input.scopes.includes(input.permission)) return DENY_FORBIDDEN;
    if (!input.vaultAllowed) return DENY_NOT_FOUND;
    if (!input.mcpEnabled) return DENY_NOT_FOUND;
  }

  if (isUser && !input.stepUpOk) return DENY_STEP_UP;
  return 'allow';
}
