/**
 * `authorize()` — the single authorization function (04-auth-and-access-control.md sections 5.4
 * to 5.6; A23; A30; D04-08; D04-09; D04-31).
 *
 * `async` because it may perform exactly one query — the vault-and-membership lookup of section
 * 5.5, one statement — and never more. It performs **no caching**, and it never throws for an
 * authorization outcome: only for usage errors (a vault-scoped permission without a vault id, a
 * server-scoped one with one — `AuthzUsageError`, a 500) and for database failures, which surface
 * as `503` and are never converted into a deny.
 *
 * The decision itself is `decide()` from `@iridium/contracts`, the pure core of steps 2, 4, 5 and
 * 6; this module resolves its inputs (the vault row, the explicit membership, the token allowlist,
 * the MCP switches, the step-up window) and nothing else. There is no branch on `tokenKind`
 * anywhere here (D04-31).
 *
 * `authorizeDetailed()` is the same decision with the rows it read attached, so the route policy
 * can hang `request.vault` off the one lookup and map an archived-vault refusal to
 * `409 vault_archived` without a second query.
 */
import {
  decide,
  isReadPermission,
  PERMISSION_SCOPE,
  type Decision,
  type Permission,
  type Principal,
  type Role,
  type VaultId,
  type VaultStatus,
} from '@iridium/contracts';
import type { Kysely } from 'kysely';

import { idBytes } from '../auth/ids.ts';
import { stepUpSatisfied } from '../auth/sessions/stepup.ts';
import type { Database } from '../db/index.ts';

/** The vault columns a decision reads; a pre-loaded row must carry all three (section 5.4). */
export interface VaultForAuthz {
  readonly id: VaultId;
  readonly status: VaultStatus;
  readonly mcp_enabled: boolean;
}

/** The membership columns a decision reads. */
export interface MemberForAuthz {
  readonly role: Role;
  readonly version: number;
}

/** What a caller may pass beside the permission (section 5.4). */
export interface AuthzScope {
  readonly vaultId?: VaultId;
  /** Pre-loaded row when the caller already holds it inside a transaction. */
  readonly vault?: VaultForAuthz;
  /** Pre-loaded membership when the caller already holds it; `null` means "no row". */
  readonly member?: MemberForAuthz | null;
  /** Set by the route policy for routes declared `stepUp: true`. */
  readonly requireStepUp?: boolean;
  /**
   * Set by the route policy for the members of `ALLOW_ARCHIVED_ROUTES` (04 section 5.6; D04-12):
   * lifts the archived-vault write freeze, and nothing else.
   */
  readonly allowArchived?: boolean;
  /** `'mcp'` applies the MCP kill switches. */
  readonly surface?: 'rest' | 'collab' | 'mcp' | 'internal';
}

/** The decision plus the rows it was made from. */
export interface DetailedDecision {
  readonly decision: Decision;
  /** The vault row, when a vault-scoped permission resolved one. */
  readonly vault: VaultForAuthz | null;
  /** The explicit membership, when a vault was resolved. */
  readonly member: MemberForAuthz | null;
  /**
   * True when the deny is the archived-vault write freeze — the route policy answers
   * `409 vault_archived` for it rather than `403 forbidden` (09-api-reference.md section 1.3).
   */
  readonly archivedRefusal: boolean;
}

/** A programming error, never a deny: a 500 logged with the permission that was misused. */
export class AuthzUsageError extends Error {
  readonly permission: Permission;

  constructor(permission: Permission, problem: string) {
    super(
      `authorize('${permission}') was called incorrectly: ${problem}. The route-policy boot ` +
        'assertion proves every route supplies what its permission needs, so this can only come ' +
        'from hand-written service code (04-auth-and-access-control.md section 5.2).',
    );
    this.name = 'AuthzUsageError';
    this.permission = permission;
  }
}

/** The one statement of section 5.5, query 2: the vault row and the caller's membership together. */
export interface MembershipLookup {
  (
    vaultId: VaultId,
    userId: string,
  ): Promise<{
    readonly vault: VaultForAuthz | null;
    readonly member: MemberForAuthz | null;
  }>;
}

/** The Kysely form of `MembershipLookup` over `dbApp`. */
export function createMembershipLookup(db: () => Kysely<Database> | null): MembershipLookup {
  return async (vaultId, userId) => {
    const executor = db();
    if (executor === null) throw new AuthzStoreUnavailableError();
    const row = await executor
      .selectFrom('vaults as v')
      .leftJoin('vault_members as vm', (join) =>
        join.onRef('vm.vault_id', '=', 'v.id').on('vm.user_id', '=', idBytes(userId)),
      )
      .select(['v.status', 'v.mcp_enabled', 'vm.role', 'vm.version'])
      .where('v.id', '=', idBytes(vaultId))
      .executeTakeFirst();
    if (row === undefined) return { vault: null, member: null };
    return {
      vault: { id: vaultId, status: row.status, mcp_enabled: row.mcp_enabled },
      member:
        row.role === null || row.version === null ? null : { role: row.role, version: row.version },
    };
  };
}

/** Thrown when the database is not connected; the request answers `503`, never a deny. */
export class AuthzStoreUnavailableError extends Error {
  constructor() {
    super(
      'authorize() needs dbApp, which is not connected; a database failure is a 503 and is never ' +
        'converted into a deny (04-auth-and-access-control.md section 5.4)',
    );
    this.name = 'AuthzStoreUnavailableError';
  }
}

/** What the authorizer is built with. */
export interface AuthorizerOptions {
  readonly lookup: MembershipLookup;
  readonly now: () => number;
  /** `session_policy.stepUpMinutes` in milliseconds (the `STEP_UP_WINDOW_MIN` floor at M1). */
  readonly stepUpWindowMs: number;
  /**
   * `SettingsStore.effective().mcp_enabled` — an in-memory read (D04-29). At M1 the
   * `MCP_ENABLED` configuration value is the store.
   */
  readonly mcpServerEnabled: () => boolean;
}

/** The function the plan names, plus the detailed form the route policy uses. */
export interface Authorizer {
  readonly authorize: (
    principal: Principal,
    permission: Permission,
    scope?: AuthzScope,
  ) => Promise<Decision>;
  readonly authorizeDetailed: (
    principal: Principal,
    permission: Permission,
    scope?: AuthzScope,
  ) => Promise<DetailedDecision>;
}

/** Whether a token's allowlist admits a vault (`all_vaults` defers to the explicit membership). */
function vaultAllowedFor(principal: Principal, vaultId: VaultId): boolean {
  if (principal.kind !== 'token') return true;
  return 'all' in principal.vaultScope || principal.vaultScope.vaultIds.includes(vaultId);
}

/** Builds the authorizer. One per process, owned by the authz plugin. */
export function createAuthorizer(options: AuthorizerOptions): Authorizer {
  const stepUpOk = (principal: Principal, scope: AuthzScope): boolean =>
    scope.requireStepUp !== true ||
    principal.kind !== 'user' ||
    stepUpSatisfied(principal.lastAuthenticatedAt, options.now(), options.stepUpWindowMs);

  const authorizeDetailed = async (
    principal: Principal,
    permission: Permission,
    scope: AuthzScope = {},
  ): Promise<DetailedDecision> => {
    const noVault: DetailedDecision = {
      decision: 'allow',
      vault: null,
      member: null,
      archivedRefusal: false,
    };

    // 1. system principals are allowed by construction
    if (principal.kind === 'system') return noVault;

    // 2. server-scoped permissions resolve no vault
    if (PERMISSION_SCOPE[permission] === 'server') {
      if (scope.vaultId !== undefined || scope.vault !== undefined) {
        throw new AuthzUsageError(permission, 'a server-scoped permission arrived with a vault');
      }
      return {
        ...noVault,
        decision: decide({
          principalKind: principal.kind,
          isServerAdmin: principal.isServerAdmin,
          explicitRole: null,
          vaultStatus: null,
          permission,
          scopes: principal.kind === 'token' ? principal.scopes : [],
          vaultAllowed: true,
          mcpEnabled: true,
          stepUpOk: stepUpOk(principal, scope),
          allowArchived: false,
        }),
      };
    }

    // 3–4. the vault row and the membership: one lookup, or the rows the caller pre-loaded
    const vaultId = scope.vault?.id ?? scope.vaultId;
    if (vaultId === undefined) {
      throw new AuthzUsageError(permission, 'a vault-scoped permission arrived without a vault id');
    }
    let vault: VaultForAuthz | null;
    let member: MemberForAuthz | null;
    if (scope.vault !== undefined && scope.member !== undefined) {
      vault = scope.vault;
      member = scope.member;
    } else {
      const loaded = await options.lookup(vaultId, principal.userId);
      vault = scope.vault ?? loaded.vault;
      member = scope.member === undefined ? loaded.member : scope.member;
    }
    if (scope.surface === 'mcp' && vault !== null && typeof vault.mcp_enabled !== 'boolean') {
      throw new AuthzUsageError(
        permission,
        "a pre-loaded vault row on surface 'mcp' lacks mcp_enabled",
      );
    }

    // 5–7. the pure decision
    const mcpEnabled =
      scope.surface !== 'mcp' || (options.mcpServerEnabled() && vault?.mcp_enabled === true);
    const decision = decide({
      principalKind: principal.kind,
      isServerAdmin: principal.isServerAdmin,
      explicitRole: member?.role ?? null,
      vaultStatus: vault?.status ?? null,
      permission,
      scopes: principal.kind === 'token' ? principal.scopes : [],
      vaultAllowed: vaultAllowedFor(principal, vaultId),
      mcpEnabled,
      stepUpOk: stepUpOk(principal, scope),
      allowArchived: scope.allowArchived === true,
    });
    // The freeze is the refusal only where it applied: a route that lifts it was refused by the
    // matrix, which is a plain `403`.
    const archivedRefusal =
      decision !== 'allow' &&
      decision.deny === 'forbidden' &&
      vault?.status === 'archived' &&
      scope.allowArchived !== true &&
      !isReadPermission(permission);
    return { decision, vault, member, archivedRefusal };
  };

  return {
    authorizeDetailed,
    authorize: async (principal, permission, scope) =>
      (await authorizeDetailed(principal, permission, scope)).decision,
  };
}
