/**
 * The route policy and its boot assertion (04-auth-and-access-control.md section 6.2; skeleton A30;
 * invariant 2 of 02-system-architecture.md).
 *
 * Every Fastify route declares `config.auth`. The assertion runs at `onReady`, after every plugin
 * has registered its routes, walks them, and **throws, refusing to start the server**, on any
 * violation. Deny by default has to be impossible to forget, and a rule that only a reviewer
 * enforces is a rule that is eventually forgotten — so this is a boot failure, not a lint.
 *
 * The assertion is deliberately incremental: it asserts what exists. At M0 the route set is
 * `/healthz`, `/readyz`, `/metrics` and the static surfaces, so the rules below are the ones whose
 * inputs exist now. The MCP audience rule, the closed CSRF-exemption enumeration and the
 * `ALLOW_ARCHIVED_ROUTES` membership rule arrive with the milestones that register those routes
 * (M3, M3 and M2); each is listed in `PENDING_ASSERTIONS` so the gap is a recorded decision rather
 * than an omission a reader has to notice.
 *
 * `config.auth = 'test-only'` is accepted from M0 even though the `/__test__` namespace arrives in
 * M1 (12-milestones.md section 4.3), because the value is part of the policy vocabulary and a later
 * milestone should add routes, not widen this type.
 */
import {
  isReadPermission,
  PERMISSION_SCOPE,
  type Permission,
  type PrincipalKind,
} from '@iridium/contracts';
import type { FastifyInstance, RouteOptions } from 'fastify';

/**
 * The route policy vocabulary of 04-auth-and-access-control.md section 6.2.
 *
 * The plan places this type in `@iridium/contracts/authz.ts`. It is declared here until that package
 * exports it, because the server must not import a name that does not exist — a missing export
 * would be a module-resolution crash at boot rather than a clear failure. The shapes are identical,
 * so the move is a one-line import change and no call site changes.
 */
export type RouteAuth =
  | { readonly public: true }
  /** The `/__test__` namespace, which exists only when `NODE_ENV=test` (10, "Fault injection"). */
  | 'test-only'
  | { readonly self: true; readonly stepUp?: boolean }
  | {
      readonly serverAdmin: true;
      readonly permission: Permission;
      readonly stepUp?: boolean;
    }
  | {
      readonly permission: Permission;
      readonly vaultFrom:
        | 'params.vaultId'
        | 'node:params.nodeId'
        | 'note:params.noteId'
        | 'attachment:params.attachmentId'
        | 'job:params.jobId'
        | 'body.vaultId';
      readonly stepUp?: boolean;
      readonly allowArchived?: boolean;
      readonly principalKinds?: readonly PrincipalKind[];
      readonly bearerOnly?: true;
      readonly mcpAudience?: 'pat' | 'oauth';
    };

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Every route declares this; a route without it refuses to boot the server (A30). */
    auth?: RouteAuth;
  }
  interface FastifyInstance {
    /** Every route registered on this instance, collected by the `onRoute` hook. */
    routes(): readonly RegisteredRoute[];
  }
}

/** One registered route, reduced to what the assertion reads. */
export interface RegisteredRoute {
  readonly method: string;
  readonly url: string;
  readonly auth: RouteAuth | undefined;
}

/** The `/__test__` prefix the `test-only` policy is reserved for. */
export const TEST_NAMESPACE_PREFIX = '/__test__';

/**
 * Assertions this table will gain, each with the milestone that registers the routes it reads. A
 * gap that is written down is a decision; a gap that is not is a hole.
 *
 * `authz.route-policy.boot.guard` is the reader: it asserts the list is non-empty, that every entry
 * names the milestone it waits on, and that the four gaps above are each recorded — which is what
 * keeps this from decaying into a comment nobody checks. The serving path never consults it.
 *
 * @internal
 */
export const PENDING_ASSERTIONS: readonly string[] = Object.freeze([
  'M2: `allowArchived` only on routes in ALLOW_ARCHIVED_ROUTES (04 section 5.6)',
  'M3: one credential kind per MCP mount — `mcpAudience` must match the registered Protected Resource Metadata document',
  'M3: the CSRF-exemption set equals the closed enumeration CSRF_EXEMPT_ROUTES (D04-32)',
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

function describe(route: RegisteredRoute): string {
  return `${route.method} ${route.url}`;
}

function checkOne(route: RegisteredRoute, violations: string[]): void {
  const { auth } = route;
  if (auth === undefined) {
    violations.push(
      `${describe(route)} declares no config.auth. Every route declares one; deny by default must be impossible to forget (A30).`,
    );
    return;
  }

  if (auth === 'test-only') {
    if (!route.url.startsWith(TEST_NAMESPACE_PREFIX)) {
      violations.push(
        `${describe(route)} declares config.auth = 'test-only' outside the ${TEST_NAMESPACE_PREFIX} namespace, which is the only place that policy is reserved for.`,
      );
    }
    return;
  }

  // A26: every mutating /admin/* route is step-up gated, whatever policy shape it uses.
  const stepUp = 'public' in auth ? true : auth.stepUp === true;
  if (route.url.startsWith('/admin/') && !SAFE_METHODS.has(route.method) && !stepUp) {
    violations.push(`${describe(route)} is a mutating /admin/* route without stepUp: true (A26).`);
  }

  if ('public' in auth || 'self' in auth) return;

  if ('serverAdmin' in auth) {
    if (PERMISSION_SCOPE[auth.permission] !== 'server') {
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
    if (!SAFE_METHODS.has(route.method)) {
      violations.push(
        `${describe(route)} accepts a token principal on a mutating method; MVP integration tokens are read-only (A31, F4).`,
      );
    }
    if (!isReadPermission(auth.permission)) {
      violations.push(
        `${describe(route)} accepts a token principal with the non-read permission '${auth.permission}'; the token surface is exactly READ_BUNDLE (A31, F4).`,
      );
    }
  }

  if (auth.allowArchived === true && isReadPermission(auth.permission)) {
    violations.push(
      `${describe(route)} sets allowArchived on a read permission, where the flag is a no-op; a dead flag invites the belief that archiving was lifted (04 section 5.6).`,
    );
  }

  if (auth.mcpAudience !== undefined && auth.bearerOnly !== true) {
    violations.push(
      `${describe(route)} declares mcpAudience without bearerOnly; both MCP mounts are bearerOnly so a session cookie can never resolve to a principal there (04 section 6.1).`,
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

/**
 * Boot step 5, the `authz` plugin, as far as M0 reaches: the route table, `app.routes()`, and the
 * boot assertion at `onReady`. `authorize()`, the permission matrix binding, the `AuthzBus` and the
 * epoch table arrive with M1.
 *
 * Applied — not `register`ed — so the `onRoute` hook is on the root instance and sees every route
 * any later plugin adds, including routes inside encapsulated children.
 */
export function applyRoutePolicyPlugin(app: FastifyInstance): void {
  const collected: RegisteredRoute[] = [];

  app.addHook('onRoute', (routeOptions: RouteOptions) => {
    const methods = Array.isArray(routeOptions.method)
      ? routeOptions.method
      : [routeOptions.method];
    for (const method of methods) {
      collected.push({
        method,
        url: routeOptions.url,
        auth: routeOptions.config?.auth,
      });
    }
  });

  app.decorate('routes', () => collected as readonly RegisteredRoute[]);

  app.addHook('onReady', async () => {
    assertRoutePolicies(collected);
  });
}
