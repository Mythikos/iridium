/**
 * The route policy and its boot assertion (04-auth-and-access-control.md section 6.2; skeleton A30;
 * invariant 2 of 02-system-architecture.md), and boot step 5 — the `authz` plugin.
 *
 * Every Fastify route declares `config.auth`. The assertion runs at `onReady`, after every plugin
 * has registered its routes, walks them, and **throws, refusing to start the server**, on any
 * violation. Deny by default has to be impossible to forget, and a rule that only a reviewer
 * enforces is a rule that is eventually forgotten — so this is a boot failure, not a lint.
 *
 * For every route with a non-`public` policy the plugin also registers the `preHandler` of
 * section 6.2: it reads `request.principal`, refuses a principal kind the route does not list,
 * resolves the vault from `vaultFrom`, calls `authorize()`, attaches `request.vault` and maps a
 * deny to `ProblemDetails` through one function so the body, the code and the SIEM line are
 * identical everywhere.
 *
 * The assertion is incremental: it asserts what exists. The MCP audience rule and the four
 * deliberate `/.well-known/` `404` routes arrive with M3 and are listed in `PENDING_ASSERTIONS` so
 * the gap is a recorded decision rather than an omission a reader has to notice.
 */
import {
  ADMIN_FLAG_ONLY_ROUTES,
  ALLOW_ARCHIVED_ROUTES,
  CSRF_EXEMPT_ROUTES,
  isReadPermission,
  maxRole,
  PERMISSION_SCOPE,
  requiresStepUp,
  routePrincipalKinds,
  toCanonicalId,
  VaultId,
  type Decision,
  type Principal,
  type Role,
  type RouteAuth,
  type TokenPrincipal,
  type UserPrincipal,
  type VaultFrom,
  type VaultStatus,
} from '@iridium/contracts';
import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  RouteOptions,
} from 'fastify';
import type { Kysely } from 'kysely';

import { idBytes, userIdFromBytes, vaultIdFromBytes } from '../auth/ids.ts';
import { stepUpSatisfied } from '../auth/sessions/stepup.ts';
import type { Database } from '../db/index.ts';
import type { NodeKind } from '../db/schema.ts';
import { ProblemError } from '../security/problem.ts';
import { createAccessibleVaultIds, type AccessibleVaultIds } from './accessible-vaults.ts';
import {
  AuthzStoreUnavailableError,
  AuthzUsageError,
  createAuthorizer,
  createMembershipLookup,
  type Authorizer,
  type MemberForAuthz,
  type VaultForAuthz,
} from './authorize.ts';
import { InProcessAuthzBus, type AuthzBus } from './bus.ts';
import { EpochTable } from './epochs.ts';
import { EpochReconciler } from './reconciler.ts';
import { SessionCommandFence } from './session-command-fence.ts';
import {
  createSessionCommandServices,
  type SessionCommandServices,
} from './session-revocations.ts';

export type { RouteAuth } from '@iridium/contracts';

/** The vault a route resolved, attached to the request after `authorize()` allowed. */
export interface ResolvedVault {
  readonly id: VaultId;
  readonly status: VaultStatus;
  /** The caller's explicit role; `null` for a server admin without a membership row. */
  readonly role: Role | null;
}

/** The node a `node:`/`note:` route resolved, reused by the handler so it is never looked up twice. */
export interface ResolvedNode {
  readonly vaultId: VaultId;
  readonly kind: NodeKind;
  readonly deletedAt: Date | null;
}

/** What boot step 5 decorates the instance with. */
export interface AuthzServices {
  readonly authorize: Authorizer['authorize'];
  readonly authorizeDetailed: Authorizer['authorizeDetailed'];
  readonly bus: AuthzBus;
  readonly epochs: EpochTable;
  readonly reconciler: EpochReconciler;
  readonly sessionFence: SessionCommandFence;
  readonly sessionCommands: SessionCommandServices;
  readonly accessibleVaultIds: AccessibleVaultIds;
}

const MS_PER_MINUTE = 60_000;

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Every route declares this; a route without it refuses to boot the server (A30). */
    auth?: RouteAuth;
    /**
     * Declared by exactly the members of `CSRF_EXEMPT_ROUTES` (D04-32); the CSRF guard skips a
     * route that carries it and the boot assertion holds the set closed.
     */
    csrfExempt?: true;
  }
  interface FastifyInstance {
    /** Every route registered on this instance, collected by the `onRoute` hook. */
    routes(): readonly RegisteredRoute[];
    /** Boot step 5: `authorize()`, the bus, the epoch table, the reconciler, the ACL helper. */
    authz: AuthzServices;
  }
  interface FastifyRequest {
    /** The vault the route policy resolved and `authorize()` allowed; `null` otherwise. */
    vault: ResolvedVault | null;
    /** The role `authorize()` decided with: the explicit role, or `manager` for a server admin. */
    vaultRole: Role | null;
    /** The node a `node:`/`note:` route resolved, for the handler. */
    resolvedNode: ResolvedNode | null;
  }
}

/** One registered route, reduced to what the assertion reads. */
export interface RegisteredRoute {
  readonly method: string;
  readonly url: string;
  readonly auth: RouteAuth | undefined;
  readonly csrfExempt?: boolean;
}

/** The `/__test__` prefix the `test-only` policy is reserved for. */
export const TEST_NAMESPACE_PREFIX = '/__test__';

/** The prefix the `/api/v1` route tree is registered under (09-api-reference.md section 1.2). */
export const API_PREFIX = '/api/v1';

/**
 * Assertions this table will gain, each with the milestone that registers the routes it reads. A
 * gap that is written down is a decision; a gap that is not is a hole.
 *
 * `authz.route-policy.boot.guard` is the reader: it asserts the list is non-empty, that every entry
 * names the milestone it waits on, and that each gap is recorded — which is what keeps this from
 * decaying into a comment nobody checks. The serving path never consults it.
 *
 * @internal
 */
export const PENDING_ASSERTIONS: readonly string[] = Object.freeze([
  'M3: one credential kind per MCP mount — `mcpAudience` must match the registered Protected Resource Metadata document',
  'M3: every `/oauth/*` route declares `public` or `self` and is unreachable by a token principal',
  'M3: the four deliberate `/.well-known/` 404 routes are registered',
]);

/** Thrown by the boot assertion. `main.ts` maps this to a non-zero exit with the list printed. */
export class RoutePolicyError extends Error {
  readonly violations: readonly string[];
  readonly exitCode = 1;

  constructor(violations: readonly string[]) {
    super(
      `route policy assertion failed (${String(violations.length)} violation${violations.length === 1 ? '' : 's'}):\n` +
        violations.map((violation) => `  ✖ ${violation}`).join('\n'),
    );
    this.name = 'RoutePolicyError';
    this.violations = violations;
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** The path relative to the API root, which is how the closed route sets spell their members. */
export function apiRelativePath(url: string): string {
  return url.startsWith(`${API_PREFIX}/`) ? url.slice(API_PREFIX.length) : url;
}

function describe(route: RegisteredRoute): string {
  return `${route.method} ${route.url}`;
}

/**
 * The `METHOD /path` spelling the closed route sets use. Fastify synthesises a `HEAD` twin for every
 * `GET` with the same `config`, and the sets name the `GET` alone, so the twin is judged as its `GET`.
 */
function routeSetKey(route: RegisteredRoute): string {
  const method = route.method === 'HEAD' ? 'GET' : route.method;
  return `${method} ${apiRelativePath(route.url)}`;
}

function checkOne(route: RegisteredRoute, violations: string[]): void {
  const { auth } = route;
  const key = routeSetKey(route);
  if (auth === undefined) {
    violations.push(
      `${describe(route)} declares no config.auth. Every route declares one; deny by default must be impossible to forget (A30).`,
    );
    return;
  }

  if (route.url.startsWith(TEST_NAMESPACE_PREFIX) && auth !== 'test-only') {
    violations.push(
      `${describe(route)} is inside the ${TEST_NAMESPACE_PREFIX} namespace but does not declare config.auth = 'test-only'.`,
    );
  }
  if (auth === 'test-only') {
    if (!route.url.startsWith(TEST_NAMESPACE_PREFIX)) {
      violations.push(
        `${describe(route)} declares config.auth = 'test-only' outside the ${TEST_NAMESPACE_PREFIX} namespace, which is the only place that policy is reserved for.`,
      );
    }
    return;
  }

  // D04-32: the CSRF exemption set is exactly the closed enumeration, in both directions.
  const exemptByConstant = CSRF_EXEMPT_ROUTES.some((member) => member === key);
  if (route.csrfExempt === true && !exemptByConstant) {
    violations.push(
      `${describe(route)} declares csrfExempt but is not a member of CSRF_EXEMPT_ROUTES; the exemption set is closed (D04-32).`,
    );
  }
  if (exemptByConstant && route.csrfExempt !== true) {
    violations.push(
      `${describe(route)} is a member of CSRF_EXEMPT_ROUTES but does not declare csrfExempt; the served set must equal the constant exactly (D04-32).`,
    );
  }
  if (route.csrfExempt === true && SAFE_METHODS.has(route.method)) {
    violations.push(
      `${describe(route)} declares csrfExempt on a safe method, where the guard never runs.`,
    );
  }

  // A26: every mutating /admin/* route is step-up gated, whatever policy shape it uses.
  const stepUp = requiresStepUp(auth);
  if (
    apiRelativePath(route.url).startsWith('/admin/') &&
    !SAFE_METHODS.has(route.method) &&
    !stepUp
  ) {
    violations.push(`${describe(route)} is a mutating /admin/* route without stepUp: true (A26).`);
  }

  // D04-10: a token can never satisfy step-up, so a stepUp route may not admit one.
  if (stepUp && routePrincipalKinds(auth).includes('token')) {
    violations.push(
      `${describe(route)} accepts a token principal on a stepUp route; a token can never satisfy step-up (D04-10).`,
    );
  }

  // The read-only token invariant applies to every policy shape, including cross-vault session
  // reads. Check it before those shapes return without a permission/vault resolution.
  if (routePrincipalKinds(auth).includes('token') && !SAFE_METHODS.has(route.method)) {
    violations.push(
      `${describe(route)} accepts a token principal on a mutating method; MVP integration tokens are read-only (A31, F4).`,
    );
  }

  if ('public' in auth || 'self' in auth || 'session' in auth) return;

  if ('serverAdmin' in auth) {
    if (auth.permission === undefined) {
      if (!ADMIN_FLAG_ONLY_ROUTES.some((member) => member === key)) {
        violations.push(
          `${describe(route)} declares serverAdmin: true without a permission but is not a member of ADMIN_FLAG_ONLY_ROUTES; a forgotten permission must not become a silent pass.`,
        );
      }
    } else if (PERMISSION_SCOPE[auth.permission] !== 'server') {
      violations.push(
        `${describe(route)} declares serverAdmin: true with the vault-scoped permission '${auth.permission}'; serverAdmin routes carry a server:* permission (04 section 5.2).`,
      );
    }
    return;
  }

  if (PERMISSION_SCOPE[auth.permission] === 'server') {
    violations.push(
      `${describe(route)} declares the server-scoped permission '${auth.permission}' with vaultFrom; a server:* permission resolves no vault (04 section 5.2).`,
    );
  }

  if (auth.principalKinds?.includes('token') === true) {
    if (!isReadPermission(auth.permission)) {
      violations.push(
        `${describe(route)} accepts a token principal with the non-read permission '${auth.permission}'; the token surface is exactly READ_BUNDLE (A31, F4).`,
      );
    }
  }

  if (auth.allowArchived === true) {
    if (isReadPermission(auth.permission)) {
      violations.push(
        `${describe(route)} sets allowArchived on a read permission, where the flag is a no-op; a dead flag invites the belief that archiving was lifted (04 section 5.6).`,
      );
    }
    if (!ALLOW_ARCHIVED_ROUTES.some((member) => member === key)) {
      violations.push(
        `${describe(route)} sets allowArchived but is not a member of ALLOW_ARCHIVED_ROUTES; archiving must actually freeze a vault (D04-12).`,
      );
    }
  }

  if (auth.mcpAudience !== undefined && auth.bearerOnly !== true) {
    violations.push(
      `${describe(route)} declares mcpAudience without bearerOnly; both MCP mounts are bearerOnly so a session cookie can never resolve to a principal there (04 section 6.1).`,
    );
  }
  if (
    auth.bearerOnly === true &&
    !(auth.principalKinds?.length === 1 && auth.principalKinds[0] === 'token')
  ) {
    violations.push(
      `${describe(route)} declares bearerOnly without principalKinds: ['token']; a bearer-only mount admits token principals and nothing else (02, boot step 5).`,
    );
  }
}

/** Runs the assertion over a route table. Pure, so the guard test can drive it directly. */
export function assertRoutePolicies(routes: readonly RegisteredRoute[]): void {
  const violations: string[] = [];
  const seen = new Map<string, RegisteredRoute>();

  for (const route of routes) {
    const key = `${route.method} ${route.url}`;
    if (seen.has(key)) {
      violations.push(`${key} is registered twice; a duplicate registration can shadow a policy.`);
    } else {
      seen.set(key, route);
    }
    checkOne(route, violations);
  }

  if (violations.length > 0) throw new RoutePolicyError(violations);
}

// ---- the preHandler --------------------------------------------------------------------------

/** What the policy needs beyond the instance decorations. */
interface PolicyDeps {
  readonly db: () => Kysely<Database> | null;
  readonly stepUpWindowMs: number;
  readonly now: () => number;
}

/** A principal step 2 admits: a user or a token. The system principal never arrives over HTTP. */
type CallerPrincipal = UserPrincipal | TokenPrincipal;

/**
 * What the policy reads from a request. `policyView` builds it from a live request;
 * `authz.route-policy.apply.unit` builds it by hand, so every refusal is provable without a server —
 * including the ones the wired process can never reach because the auth hook, the boot assertion
 * and the connected pool answer first.
 */
export interface PolicyView {
  readonly method: string;
  readonly principal: Principal | null;
  readonly params: unknown;
  readonly body: unknown;
  /** The route pattern, never the concrete path: the SIEM line must not carry ids. */
  readonly routeUrl: string | undefined;
  readonly log: Pick<FastifyBaseLogger, 'warn'>;
  readonly authorizeDetailed: Authorizer['authorizeDetailed'];
}

/** What an allowed vault-scoped request attaches; the handler reads it through `request.vault`. */
export interface PolicyAttachment {
  readonly vault: ResolvedVault;
  readonly vaultRole: Role | null;
  readonly resolvedNode: ResolvedNode | null;
}

/** A plain object with string keys — what `request.params` and a JSON body are once validated. */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The canonical id a member of `params` or the body carries, or `null` when it carries none. */
function memberId(container: unknown, name: string): string | null {
  const value = isRecord(container) ? container[name] : undefined;
  return typeof value === 'string' ? toCanonicalId(value) : null;
}

/** The `not_found` every failed resolution answers: identical for a missing and a foreign row. */
function notFound(): ProblemError {
  return new ProblemError('not_found');
}

/**
 * The id a `vaultFrom` names. A route whose path or body does not carry it, or carries something
 * that is not an id, names a row that cannot exist — the same answer as an unknown row.
 */
function requiredId(container: unknown, name: string): string {
  const id = memberId(container, name);
  if (id === null) throw notFound();
  return id;
}

/**
 * The caller's standing in a vault, read in the same statement that resolved the row naming it, so
 * `authorize()` decides from these rows without a lookup of its own.
 */
interface Access {
  readonly vault: VaultForAuthz;
  readonly member: MemberForAuthz | null;
}

/** What a resolver answers: the vault, the node row a `node:`/`note:` route read, and access. */
interface Resolution {
  readonly vaultId: VaultId;
  readonly node: ResolvedNode | null;
  /** `null` for a vault named by the request itself, which `authorize()` looks up in one read. */
  readonly access: Access | null;
}

/** One resolver per `VaultFrom` member (section 6.2 step 3). */
type VaultResolver = (
  view: PolicyView,
  db: Kysely<Database>,
  principal: CallerPrincipal,
) => Promise<Resolution>;

/** The vault and membership columns every id resolver selects beside its own row. */
interface AccessColumns {
  readonly status: VaultStatus | null;
  readonly mcp_enabled: boolean | null;
  readonly role: Role | null;
  readonly member_version: number | null;
}

/** The access a joined row carries, or `null` when the row names no vault that exists. */
function accessFrom(vaultId: VaultId, row: AccessColumns): Access | null {
  if (row.status === null || row.mcp_enabled === null) return null;
  return {
    vault: { id: vaultId, status: row.status, mcp_enabled: row.mcp_enabled },
    member:
      row.role === null || row.member_version === null
        ? null
        : { role: row.role, version: row.member_version },
  };
}

/**
 * A foreign id and an unknown id must cost the same (04-auth-and-access-control.md section 5.4,
 * T4). Resolving the row and then authorizing it made a foreign id two statements and an unknown
 * id one, and `authz.vault-isolation.integration` measured that as more than twice the latency on
 * a loaded runner. Each id resolver therefore joins its row to the vault and to the caller's
 * membership in one statement, which leaves `authorize()` nothing to read.
 */
async function resolveNode(
  view: PolicyView,
  db: Kysely<Database>,
  principal: CallerPrincipal,
  parameter: 'nodeId' | 'noteId',
  notesOnly: boolean,
): Promise<Resolution> {
  const id = requiredId(view.params, parameter);
  const row = await db
    .selectFrom('nodes as r')
    .leftJoin('vaults as v', 'v.id', 'r.vault_id')
    .leftJoin('vault_members as vm', (join) =>
      join.onRef('vm.vault_id', '=', 'r.vault_id').on('vm.user_id', '=', idBytes(principal.userId)),
    )
    .select([
      'r.vault_id',
      'r.kind',
      'r.deleted_at',
      'v.status',
      'v.mcp_enabled',
      'vm.role',
      'vm.version as member_version',
    ])
    .where('r.id', '=', idBytes(id))
    .executeTakeFirst();
  if (row === undefined || (notesOnly && row.kind !== 'note')) throw notFound();
  const vaultId = vaultIdFromBytes(row.vault_id);
  return {
    vaultId,
    node: { vaultId, kind: row.kind, deletedAt: row.deleted_at },
    access: accessFrom(vaultId, row),
  };
}

/**
 * The closed table of resolvers, keyed by `VaultFrom`: a new member of the type is a compile error
 * here, so there is no default branch to reach at run time.
 */
const VAULT_RESOLVERS: Readonly<Record<VaultFrom, VaultResolver>> = {
  'params.vaultId': async (view) => ({
    vaultId: VaultId.parse(requiredId(view.params, 'vaultId')),
    node: null,
    access: null,
  }),
  'body.vaultId': async (view) => ({
    vaultId: VaultId.parse(requiredId(view.body, 'vaultId')),
    node: null,
    access: null,
  }),
  'node:params.nodeId': (view, db, principal) => resolveNode(view, db, principal, 'nodeId', false),
  'note:params.noteId': (view, db, principal) => resolveNode(view, db, principal, 'noteId', true),
  'attachment:params.attachmentId': async (view, db, principal) => {
    const id = requiredId(view.params, 'attachmentId');
    const row = await db
      .selectFrom('attachments as r')
      .leftJoin('vaults as v', 'v.id', 'r.vault_id')
      .leftJoin('vault_members as vm', (join) =>
        join
          .onRef('vm.vault_id', '=', 'r.vault_id')
          .on('vm.user_id', '=', idBytes(principal.userId)),
      )
      .select([
        'r.vault_id',
        'v.status',
        'v.mcp_enabled',
        'vm.role',
        'vm.version as member_version',
      ])
      .where('r.id', '=', idBytes(id))
      .executeTakeFirst();
    if (row === undefined) throw notFound();
    const vaultId = vaultIdFromBytes(row.vault_id);
    // The attachment routes are nested under the vault: a mismatch is a foreign row (section 6.2).
    const routeVault = memberId(view.params, 'vaultId');
    if (routeVault !== null && routeVault !== vaultId) throw notFound();
    return { vaultId, node: null, access: accessFrom(vaultId, row) };
  },
  'job:params.jobId': async (view, db, principal) => {
    const id = requiredId(view.params, 'jobId');
    const row = await db
      .selectFrom('jobs as r')
      .leftJoin('vaults as v', 'v.id', 'r.vault_id')
      .leftJoin('vault_members as vm', (join) =>
        join
          .onRef('vm.vault_id', '=', 'r.vault_id')
          .on('vm.user_id', '=', idBytes(principal.userId)),
      )
      .select([
        'r.vault_id',
        'r.requested_by',
        'v.status',
        'v.mcp_enabled',
        'vm.role',
        'vm.version as member_version',
      ])
      .where('r.id', '=', idBytes(id))
      .executeTakeFirst();
    if (row === undefined || row.vault_id === null) throw notFound();
    // Section 6.8: the requester, or a server admin, may watch a job; anyone else sees nothing.
    const requester = row.requested_by === null ? null : userIdFromBytes(row.requested_by);
    const isAdmin = principal.kind === 'user' && principal.isServerAdmin;
    if (!isAdmin && requester !== principal.userId) throw notFound();
    const vaultId = vaultIdFromBytes(row.vault_id);
    return { vaultId, node: null, access: accessFrom(vaultId, row) };
  },
};

/** A refusal `authorize()` answered. */
type DenyReason = Exclude<Decision, 'allow'>['deny'];

/** The problem each refusal becomes; the archived-vault write freeze is `409 vault_archived`. */
const DENY_PROBLEMS: Readonly<Record<DenyReason, (archivedRefusal: boolean) => ProblemError>> = {
  not_found: () => new ProblemError('not_found'),
  forbidden: (archivedRefusal) =>
    archivedRefusal ? new ProblemError('vault_archived') : new ProblemError('forbidden'),
  step_up_required: () =>
    new ProblemError('step_up_required', { detail: 'Re-authenticate to continue' }),
};

/** The SIEM line of section 6.2 step 6. */
function denied(view: PolicyView, reason: string): void {
  view.log.warn({ event: 'authz.denied', reason, route: view.routeUrl }, 'denied');
}

/** Maps a deny to the one problem the route answers, logging the SIEM line. */
function denyToProblem(view: PolicyView, deny: DenyReason, archivedRefusal: boolean): ProblemError {
  denied(view, deny === 'step_up_required' ? 'step_up' : deny);
  return DENY_PROBLEMS[deny](archivedRefusal);
}

/** The policies the preHandler is registered for: everything but `public` and `test-only`. */
type GuardedRouteAuth = Exclude<RouteAuth, 'test-only' | { readonly public: true }>;

/**
 * Section 6.2 over a view. Throws the `ProblemError` a refusal answers, or the store error while
 * the pool is not connected (a `503`, never a deny); resolves to what the handler may read for an
 * allowed vault-scoped request and to `null` for the policies that address no vault.
 *
 * @internal
 */
export async function applyRoutePolicy(
  view: PolicyView,
  auth: GuardedRouteAuth,
  deps: PolicyDeps,
): Promise<PolicyAttachment | null> {
  const { principal } = view;
  if (principal === null) throw new ProblemError('unauthenticated');

  // Step 2: a principal kind the route does not list (D04-10 for a token on a user-only route).
  const kinds = routePrincipalKinds(auth);
  if (principal.kind === 'system' || !kinds.includes(principal.kind)) {
    denied(view, 'token_scope');
    throw new ProblemError(principal.kind === 'token' ? 'token_scope_insufficient' : 'forbidden');
  }

  // Retain the token boundary even if a caller applies a policy the boot assertion never saw.
  if (principal.kind === 'token' && !SAFE_METHODS.has(view.method)) {
    denied(view, 'token_scope');
    throw new ProblemError('token_scope_insufficient');
  }
  const requireStepUp = requiresStepUp(auth);
  if (requireStepUp && principal.kind !== 'user') {
    throw denyToProblem(view, 'step_up_required', false);
  }
  // Session/self and flag-only policies enforce the user's window here. Permission policies
  // enforce it in authorizeDetailed, after its resource and permission checks.

  const userWindowCurrent =
    principal.kind === 'user' &&
    stepUpSatisfied(principal.lastAuthenticatedAt, deps.now(), deps.stepUpWindowMs);
  const stepUpOk = !requireStepUp || userWindowCurrent;

  // `session` and `self` address no vault: authentication, the kind and the window decide.
  if ('session' in auth || 'self' in auth) {
    if (!stepUpOk) throw denyToProblem(view, 'step_up_required', false);
    return null;
  }

  if ('serverAdmin' in auth) {
    if (auth.permission === undefined) {
      // The two documentation operations: the flag alone, then the window (ADMIN_FLAG_ONLY_ROUTES).
      if (principal.kind !== 'user' || !principal.isServerAdmin) {
        throw denyToProblem(view, 'forbidden', false);
      }
      if (!stepUpOk) throw denyToProblem(view, 'step_up_required', false);
      return null;
    }
    const detailed = await view.authorizeDetailed(principal, auth.permission, {
      requireStepUp,
      surface: 'rest',
    });
    if (detailed.decision !== 'allow') {
      throw denyToProblem(view, detailed.decision.deny, detailed.archivedRefusal);
    }
    return null;
  }

  // Steps 3–5: resolve the vault, authorize, attach the rows the handler reuses.
  const db = deps.db();
  if (db === null) throw new AuthzStoreUnavailableError();
  const resolved = await VAULT_RESOLVERS[auth.vaultFrom](view, db, principal);
  const detailed = await view.authorizeDetailed(principal, auth.permission, {
    vaultId: resolved.vaultId,
    ...(resolved.access === null
      ? {}
      : { vault: resolved.access.vault, member: resolved.access.member }),
    requireStepUp,
    allowArchived: auth.allowArchived === true,
    surface: 'rest',
  });
  if (detailed.decision !== 'allow') {
    throw denyToProblem(view, detailed.decision.deny, detailed.archivedRefusal);
  }
  if (detailed.vault === null) {
    // `authorizeDetailed` answers `not_found` for a vault it could not load, so an allow always
    // carries the row; a decision that does not is a defect, never an active vault.
    throw new AuthzUsageError(
      auth.permission,
      'the decision allowed a vault-scoped permission without the vault row it was made from',
    );
  }
  const explicit = detailed.member?.role ?? null;
  return {
    vault: { id: resolved.vaultId, status: detailed.vault.status, role: explicit },
    vaultRole:
      principal.kind === 'user' && principal.isServerAdmin
        ? maxRole(explicit, 'manager')
        : explicit,
    resolvedNode: resolved.node,
  };
}

/** The view of a live request. */
function policyView(request: FastifyRequest): PolicyView {
  return {
    method: request.method,
    principal: request.principal,
    params: request.params,
    body: request.body,
    routeUrl: request.routeOptions.url,
    log: request.log,
    authorizeDetailed: request.server.authz.authorizeDetailed,
  };
}

/** Builds the `preHandler` for one route with a non-public policy. */
function createPolicyPreHandler(auth: GuardedRouteAuth, deps: PolicyDeps) {
  return async function routePolicy(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    void reply;
    const attachment = await applyRoutePolicy(policyView(request), auth, deps);
    if (attachment === null) return;
    request.vault = attachment.vault;
    request.vaultRole = attachment.vaultRole;
    request.resolvedNode = attachment.resolvedNode;
  };
}

// ---- boot step 5 -----------------------------------------------------------------------------

/**
 * Boot step 5, the `authz` plugin: `authorize()`, the `AuthzBus`, the epoch table and its
 * reconciler, `accessibleVaultIds()`, the per-route `preHandler`, `app.routes()` and the boot
 * assertion at `onReady`. Everything it needs — the clock, the configuration and the database —
 * is already on the instance from steps 1 and 2.
 *
 * Applied — not `register`ed — so the `onRoute` hook is on the root instance and sees every route
 * any later plugin adds, including routes inside encapsulated children.
 */
export function applyRoutePolicyPlugin(app: FastifyInstance): void {
  const collected: RegisteredRoute[] = [];
  const db = (): Kysely<Database> | null => app.database.dbApp;
  const now = (): number => app.clock.now();
  const stepUpWindowMs = app.iridiumConfig.auth.stepUpWindowMinutes * MS_PER_MINUTE;
  const mcpServerEnabled = (): boolean => app.iridiumConfig.mcp.enabled;

  const authorizer = createAuthorizer({
    lookup: createMembershipLookup(db),
    now,
    stepUpWindowMs,
    mcpServerEnabled,
  });
  const epochs = new EpochTable();
  // Section 8.3: a throwing subscriber is isolated, logged at `error` and counted, so a silently
  // failing revocation subscriber is visible on a dashboard as well as in the log.
  const bus = new InProcessAuthzBus({
    onHandlerError: (eventType, error) => {
      app.log.error({ err: error, eventType }, 'an AuthzBus subscriber threw');
      app.metrics.authzBusHandlerErrorsTotal.inc();
    },
  });
  const reconciler = new EpochReconciler(epochs);
  reconciler.attach(bus);
  const sessionFence = new SessionCommandFence();
  const sessionCommands = createSessionCommandServices(app, sessionFence);

  app.decorate('authz', {
    authorize: authorizer.authorize,
    authorizeDetailed: authorizer.authorizeDetailed,
    bus,
    epochs,
    reconciler,
    sessionFence,
    sessionCommands,
    accessibleVaultIds: createAccessibleVaultIds({ db, mcpServerEnabled }),
  } satisfies AuthzServices);
  app.problems.register('authz', (error) =>
    error instanceof AuthzStoreUnavailableError
      ? new ProblemError('unavailable', { detail: 'The database is not connected.' })
      : null,
  );
  app.decorateRequest('vault', null);
  app.decorateRequest('vaultRole', null);
  app.decorateRequest('resolvedNode', null);

  const policyDeps: PolicyDeps = { db, now, stepUpWindowMs };

  app.addHook('onRoute', (routeOptions: RouteOptions) => {
    const methods = Array.isArray(routeOptions.method)
      ? routeOptions.method
      : [routeOptions.method];
    const auth = routeOptions.config?.auth;
    for (const method of methods) {
      collected.push({
        method,
        url: routeOptions.url,
        auth,
        ...(routeOptions.config?.csrfExempt === true ? { csrfExempt: true } : {}),
      });
    }
    if (auth === undefined || auth === 'test-only' || 'public' in auth) return;
    const existing = routeOptions.preHandler;
    const handler = createPolicyPreHandler(auth, policyDeps);
    routeOptions.preHandler =
      existing === undefined
        ? [handler]
        : [handler, ...(Array.isArray(existing) ? existing : [existing])];
  });

  app.decorate('routes', () => collected as readonly RegisteredRoute[]);

  app.addHook('onReady', async () => {
    assertRoutePolicies(collected);
  });
}
