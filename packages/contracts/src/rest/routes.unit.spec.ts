import { describe, expect, it } from 'vitest';

import {
  ADMIN_FLAG_ONLY_ROUTES,
  isReadPermission,
  PERMISSION_SCOPE,
  requiresStepUp,
  routePermission,
  routePrincipalKinds,
} from '../authz.ts';
import { ERROR_CODES, type ErrorCode } from '../errors.ts';
import { ClientHeaders, IfMatchHeaders } from './common.ts';
import {
  GLOBAL_ERROR_CODES,
  M1_ROUTES,
  routeByOperationId,
  routeCoveragePairs,
  routeKey,
  type RouteSpec,
} from './routes.ts';

const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);

/** The route set 12-milestones.md section 5.2 names, spelled as `<METHOD> <mount><path>`. */
const EXPECTED_KEYS: readonly string[] = [
  'POST /api/v1/auth/sessions',
  'DELETE /api/v1/auth/sessions/current',
  'POST /api/v1/auth/reauthenticate',
  'POST /api/v1/auth/set-password',
  'POST /api/v1/auth/collab-tickets',
  'GET /api/v1/auth/me',
  'GET /api/v1/meta',
  'GET /api/v1/openapi.json',
  'GET /api/v1/docs',
  'GET /api/v1/me/sessions',
  'DELETE /api/v1/me/sessions/:sessionId',
  'PATCH /api/v1/me',
  'POST /api/v1/me/password',
  'GET /api/v1/vaults',
  'POST /api/v1/vaults',
  'GET /api/v1/vaults/:vaultId',
  'GET /api/v1/vaults/:vaultId/members',
  'PUT /api/v1/vaults/:vaultId/members/:userId',
  'DELETE /api/v1/vaults/:vaultId/members/:userId',
  'POST /api/v1/vaults/:vaultId/nodes',
  'GET /api/v1/notes/:noteId',
  'GET /api/v1/notes/:noteId/markdown',
  'GET /api/v1/notes/:noteId/participants',
  'GET /api/v1/admin/users',
  'POST /api/v1/admin/users',
  'POST /api/v1/admin/users/:userId/disable',
  'POST /api/v1/admin/users/:userId/enable',
  'POST /api/v1/admin/users/:userId/reset-password',
  'GET /healthz',
  'GET /readyz',
  'GET /metrics',
];

/**
 * The three `201`s that name a row a client can fetch afterwards. The others deliberately carry no
 * `Location`: a `PUT` creates its row *at the request URI*. Session, ticket and admin password-reset
 * operations mint credentials, which no route addresses.
 */
const ADDRESSABLE_CREATES: ReadonlySet<string> = new Set([
  'vaults.create',
  'nodes.create',
  'admin.users.create',
]);

function hasPathParameter(route: RouteSpec): boolean {
  return route.path.split('/').some((segment) => segment.startsWith(':'));
}

function isMutating(route: RouteSpec): boolean {
  return !SAFE_METHODS.has(route.method);
}

function isPublic(route: RouteSpec): boolean {
  return route.auth !== 'test-only' && 'public' in route.auth;
}

function resolvesAVault(route: RouteSpec): boolean {
  return route.auth !== 'test-only' && 'vaultFrom' in route.auth;
}

/** The offending operation ids, so a failure names the routes rather than a boolean. */
function offenders(predicate: (route: RouteSpec) => boolean): readonly string[] {
  return M1_ROUTES.filter(predicate).map((route) => route.operationId);
}

function missingError(route: RouteSpec, code: ErrorCode): boolean {
  return !route.errors.includes(code);
}

describe('rest.routes.unit [area:contracts]', () => {
  describe('the route set', () => {
    it('is exactly the set the milestone names', () => {
      expect(M1_ROUTES.map(routeKey).toSorted()).toStrictEqual(EXPECTED_KEYS.toSorted());
    });

    it('registers each operation id and each method-and-path once', () => {
      const ids = M1_ROUTES.map((route) => route.operationId);
      expect(new Set(ids).size).toBe(ids.length);
      const keys = M1_ROUTES.map(routeKey);
      expect(new Set(keys).size).toBe(keys.length);
    });

    it('finds a row by its operation id and nothing by a foreign one', () => {
      expect(routeByOperationId('nodes.create')?.method).toBe('POST');
      expect(routeByOperationId('nodes.update')).toBeUndefined();
    });

    it('offers one coverage pair per documented response', () => {
      const pairs = routeCoveragePairs();
      const responses = M1_ROUTES.reduce((total, route) => total + route.responses.length, 0);
      expect(pairs).toHaveLength(responses);
      expect(pairs).toContainEqual(['ops.readyz', 503]);
      expect(pairs).toContainEqual(['notes.getMarkdown', 304]);
    });

    it('keeps the ops surface outside the versioned prefix and in its own plugin', () => {
      expect(offenders((route) => route.plugin === 'ops' && route.mount !== '')).toStrictEqual([]);
      expect(offenders((route) => route.plugin === 'ops' && route.tag !== 'ops')).toStrictEqual([]);
      expect(
        offenders((route) => route.plugin === 'rest' && route.mount !== '/api/v1'),
      ).toStrictEqual([]);
    });
  });

  describe('the policy each row declares', () => {
    it('names a vault-scoped permission wherever it resolves a vault', () => {
      expect(
        offenders((route) => {
          const permission = routePermission(route.auth);
          if (permission === null) return false;
          const expected = resolvesAVault(route) ? 'vault' : 'server';
          return PERMISSION_SCOPE[permission] !== expected;
        }),
      ).toStrictEqual([]);
    });

    it('omits the permission only on the two documentation operations', () => {
      const flagOnly = M1_ROUTES.filter(
        (route) =>
          route.auth !== 'test-only' &&
          'serverAdmin' in route.auth &&
          route.auth.permission === undefined,
      );
      expect(flagOnly.map((route) => `${route.method} ${route.path}`).toSorted()).toStrictEqual(
        ADMIN_FLAG_ONLY_ROUTES.toSorted(),
      );
    });

    it('admits a token principal only on a safe method carrying a read permission', () => {
      const tokenRoutes = M1_ROUTES.filter((route) =>
        routePrincipalKinds(route.auth).includes('token'),
      );
      expect(tokenRoutes.map((route) => route.operationId)).toStrictEqual([
        'auth.me',
        'vaults.list',
        'vaults.get',
        'notes.get',
        'notes.getMarkdown',
      ]);
      expect(tokenRoutes.filter(isMutating).map((route) => route.operationId)).toStrictEqual([]);
      expect(
        tokenRoutes
          .filter((route) => {
            const permission = routePermission(route.auth);
            return permission !== null && !isReadPermission(permission);
          })
          .map((route) => route.operationId),
      ).toStrictEqual([]);
      expect(
        tokenRoutes.filter((route) => requiresStepUp(route.auth)).map((route) => route.operationId),
      ).toStrictEqual([]);
    });

    it('step-up gates every mutating /admin route', () => {
      const adminMutations = M1_ROUTES.filter(
        (route) => route.path.startsWith('/admin/') && isMutating(route),
      );
      expect(adminMutations).not.toHaveLength(0);
      expect(
        adminMutations
          .filter((route) => !requiresStepUp(route.auth))
          .map((route) => route.operationId),
      ).toStrictEqual([]);
      expect(
        adminMutations
          .filter((route) => missingError(route, 'step_up_required'))
          .map((route) => route.operationId),
      ).toStrictEqual([]);
    });

    it('declares the client header on every mutating route that a cookie can reach', () => {
      const mutations = M1_ROUTES.filter(isMutating);
      expect(
        mutations
          .filter(
            (route) =>
              route.request.headers !== ClientHeaders && route.request.headers !== IfMatchHeaders,
          )
          .map((route) => route.operationId),
      ).toStrictEqual([]);
      expect(
        mutations.filter((route) => missingError(route, 'csrf_rejected')).map((r) => r.operationId),
      ).toStrictEqual([]);
    });
  });

  describe('the request and response shapes', () => {
    it('declares a params schema for exactly the paths that carry a parameter', () => {
      expect(
        offenders((route) => hasPathParameter(route) && route.request.params === undefined),
      ).toStrictEqual([]);
      expect(
        offenders((route) => !hasPathParameter(route) && route.request.params !== undefined),
      ).toStrictEqual([]);
    });

    it('gives an If-Match route the header schema that requires the validator', () => {
      const required = M1_ROUTES.filter((route) => route.ifMatch === 'required');
      expect(required.map((route) => route.operationId)).toStrictEqual([
        'me.update',
        'members.delete',
      ]);
      expect(
        required
          .filter((route) => route.request.headers !== IfMatchHeaders)
          .map((route) => route.operationId),
      ).toStrictEqual([]);
      expect(
        required
          .filter(
            (route) =>
              missingError(route, 'precondition_required') || missingError(route, 'stale_version'),
          )
          .map((route) => route.operationId),
      ).toStrictEqual([]);
      const conditional = M1_ROUTES.filter((route) => route.ifMatch === 'conditional');
      expect(conditional.map((route) => route.operationId)).toStrictEqual(['members.put']);
      expect(
        conditional
          .filter((route) => missingError(route, 'stale_version'))
          .map((r) => r.operationId),
      ).toStrictEqual([]);
    });

    it('answers 204 with no body, and names the non-JSON bodies the surface really has', () => {
      const responses = M1_ROUTES.flatMap((route) =>
        route.responses.map((response) => ({ operationId: route.operationId, response })),
      );
      expect(
        responses
          .filter(({ response }) => response.status === 204 && response.body.kind !== 'empty')
          .map(({ operationId }) => operationId),
      ).toStrictEqual([]);
      const nonJson = responses
        .filter(({ response }) => response.body.kind !== 'json' && response.body.kind !== 'empty')
        .map(({ operationId, response }) => `${operationId}: ${response.body.kind}`);
      expect(nonJson.toSorted()).toStrictEqual([
        'meta.docs: text',
        'meta.openapi: opaque-json',
        'notes.getMarkdown: markdown',
        'ops.metrics: text',
      ]);
    });

    it('carries a Location header on every 201 that creates an addressable row', () => {
      const created = M1_ROUTES.flatMap((route) =>
        route.responses
          .filter((response) => response.status === 201)
          .map((response) => ({ route, location: response.location })),
      );
      expect(created).not.toHaveLength(0);
      expect(
        created
          .filter(
            ({ route, location }) =>
              ADDRESSABLE_CREATES.has(route.operationId) !==
              (location !== undefined && location.startsWith('/api/v1/')),
          )
          .map(({ route }) => route.operationId),
      ).toStrictEqual([]);
      expect(
        created
          .filter(
            ({ route, location }) =>
              location === undefined &&
              route.method !== 'PUT' &&
              !route.path.startsWith('/auth/') &&
              route.operationId !== 'admin.users.resetPassword',
          )
          .map(({ route }) => route.operationId),
      ).toStrictEqual([]);
    });
  });

  describe('the documented error codes', () => {
    it('names only members of the closed vocabulary, without repetition', () => {
      expect(
        offenders((route) => new Set(route.errors).size !== route.errors.length),
      ).toStrictEqual([]);
      const unknown = M1_ROUTES.flatMap((route) =>
        route.errors.filter((code) => !ERROR_CODES.includes(code)),
      );
      expect(unknown).toStrictEqual([]);
      expect(GLOBAL_ERROR_CODES.filter((code) => !ERROR_CODES.includes(code))).toStrictEqual([]);
    });

    it('never repeats a code every route already answers', () => {
      const repeated = M1_ROUTES.flatMap((route) =>
        route.errors
          .filter((code) => GLOBAL_ERROR_CODES.includes(code))
          .map((code) => `${route.operationId}: ${code}`),
      );
      expect(repeated).toStrictEqual([]);
    });

    it('claims unauthenticated only where a principal is required', () => {
      expect(
        offenders((route) => isPublic(route) && route.errors.includes('unauthenticated')),
      ).toStrictEqual([]);
    });

    it('documents the rate-limited answer wherever a bucket is named', () => {
      expect(
        offenders(
          (route) =>
            route.rateLimit !== undefined &&
            route.rateLimit !== 'pat' &&
            missingError(route, 'rate_limited'),
        ),
      ).toStrictEqual([]);
      expect(offenders((route) => route.rateLimit === 'login')).toStrictEqual([
        'auth.createSession',
        'auth.reauthenticate',
        'auth.setPassword',
      ]);
    });
  });
});
