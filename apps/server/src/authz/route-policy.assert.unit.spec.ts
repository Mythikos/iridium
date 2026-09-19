/**
 * `authz.route-policy.assert.unit` (04-auth-and-access-control.md sections 5.6 and 6.1; D04-10;
 * D04-12; D04-32; A26): the boot assertion's rules that the served M1 route set and the boot
 * guard's refusals do not reach — the test namespace without the `test-only` policy, a CSRF
 * exemption on a safe method, a step-up route that admits a token, `allowArchived` accepted on
 * exactly its closed set and refused elsewhere, and a bearer-only mount that admits exactly token
 * principals — each proven on the pure assertion, refusing and accepting.
 */
import { describe, expect, it } from 'vitest';

import {
  API_PREFIX,
  assertRoutePolicies,
  RoutePolicyError,
  TEST_NAMESPACE_PREFIX,
  type RegisteredRoute,
  type RouteAuth,
} from './route-policy.ts';

/** The violations the assertion collected, or none. */
function violationsOf(routes: readonly RegisteredRoute[]): readonly string[] {
  try {
    assertRoutePolicies(routes);
  } catch (error) {
    if (error instanceof RoutePolicyError) return error.violations;
    throw error;
  }
  return [];
}

describe('authz.route-policy.assert.unit [area:authz]', () => {
  it.each<{ route: RegisteredRoute; refusal: string }>([
    {
      route: { method: 'GET', url: '/forgotten', auth: undefined },
      refusal: 'declares no config.auth',
    },
    {
      route: { method: 'GET', url: '/elsewhere', auth: 'test-only' },
      refusal: 'outside the /__test__ namespace',
    },
    {
      route: { method: 'POST', url: '/oauth/token', auth: { public: true } },
      refusal: 'does not declare csrfExempt',
    },
    {
      route: {
        method: 'POST',
        url: '/api/v1/admin/users',
        auth: { serverAdmin: true, permission: 'server:users' },
      },
      refusal: 'without stepUp: true',
    },
    {
      route: { method: 'GET', url: '/api/v1/unlisted-admin', auth: { serverAdmin: true } },
      refusal: 'not a member of ADMIN_FLAG_ONLY_ROUTES',
    },
    {
      route: {
        method: 'GET',
        url: '/api/v1/admin/vault',
        auth: { serverAdmin: true, permission: 'note:read' },
      },
      refusal: 'vault-scoped permission',
    },
    {
      route: {
        method: 'GET',
        url: '/api/v1/vaults/:vaultId',
        auth: { permission: 'server:users', vaultFrom: 'params.vaultId' },
      },
      refusal: 'server-scoped permission',
    },
    {
      route: {
        method: 'POST',
        url: '/api/v1/vaults/:vaultId/notes',
        auth: { permission: 'note:read', vaultFrom: 'params.vaultId', principalKinds: ['token'] },
      },
      refusal: 'token principal on a mutating method',
    },
    {
      route: {
        method: 'GET',
        url: '/api/v1/vaults/:vaultId/write',
        auth: { permission: 'note:write', vaultFrom: 'params.vaultId', principalKinds: ['token'] },
      },
      refusal: 'non-read permission',
    },
    {
      route: {
        method: 'GET',
        url: '/api/v1/vaults/:vaultId/notes',
        auth: { permission: 'note:read', vaultFrom: 'params.vaultId', allowArchived: true },
      },
      refusal: 'allowArchived on a read permission',
    },
    {
      route: {
        method: 'GET',
        url: '/mcp',
        auth: { permission: 'note:read', vaultFrom: 'params.vaultId', mcpAudience: 'pat' },
      },
      refusal: 'mcpAudience without bearerOnly',
    },
  ])('rejects unsafe policy $refusal', ({ route, refusal }) => {
    expect(violationsOf([route])).toContainEqual(expect.stringContaining(refusal));
  });

  it('accepts exactly the declared CSRF-exempt unsafe endpoint and names every boot refusal', () => {
    expect(
      violationsOf([
        { method: 'POST', url: '/oauth/token', auth: { public: true }, csrfExempt: true },
      ]),
    ).toEqual([]);
    const missing: RegisteredRoute = { method: 'GET', url: '/forgotten', auth: undefined };
    const violations = violationsOf([missing]);
    expect(violations).toEqual([expect.stringContaining('GET /forgotten declares no config.auth')]);
    const one = new RoutePolicyError(violations);
    expect(one.name).toBe('RoutePolicyError');
    expect(one.exitCode).toBe(1);
    expect(one.message).toBe(
      'route policy assertion failed (1 violation):\n  ✖ ' + violations.join('\n  ✖ '),
    );
    const repeated = [...violations, 'POST /elsewhere requires step-up'];
    expect(new RoutePolicyError(repeated).message).toBe(
      'route policy assertion failed (2 violations):\n  ✖ ' + repeated.join('\n  ✖ '),
    );
  });

  it('rejects duplicate registrations even when both independently have a valid policy', () => {
    const route: RegisteredRoute = { method: 'GET', url: '/healthz', auth: { public: true } };
    expect(violationsOf([route, route])).toEqual([expect.stringContaining('registered twice')]);
  });

  it('refuses a route inside the test namespace that does not declare the test-only policy', () => {
    const route: RegisteredRoute = {
      method: 'GET',
      url: `${TEST_NAMESPACE_PREFIX}/probe`,
      auth: { public: true },
    };
    expect(violationsOf([route])).toStrictEqual([
      expect.stringContaining(`is inside the ${TEST_NAMESPACE_PREFIX} namespace`),
    ]);
  });

  it('refuses a CSRF exemption on a safe method, where the guard never runs (D04-32)', () => {
    const route: RegisteredRoute = {
      method: 'GET',
      url: `${API_PREFIX}/exempt`,
      auth: { session: true },
      csrfExempt: true,
    };
    expect(violationsOf([route])).toStrictEqual([
      expect.stringContaining('is not a member of CSRF_EXEMPT_ROUTES'),
      expect.stringContaining('declares csrfExempt on a safe method'),
    ]);
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
    'refuses a token-capable %s session policy at boot',
    (method) => {
      expect(
        violationsOf([
          {
            method,
            url: `${API_PREFIX}/session-write`,
            auth: { session: true, principalKinds: ['user', 'token'] },
          },
        ]),
      ).toEqual([expect.stringContaining('accepts a token principal on a mutating method')]);
    },
  );

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
    'refuses a public %s administrator route at boot',
    (method) => {
      expect(
        violationsOf([
          {
            method,
            url: `${API_PREFIX}/admin/things`,
            auth: { public: true },
          },
        ]),
      ).toEqual([expect.stringContaining('without stepUp: true')]);
    },
  );

  it('refuses a step-up route that admits a token principal, which can never satisfy it (D04-10)', () => {
    const route: RegisteredRoute = {
      method: 'GET',
      url: `${API_PREFIX}/stepped`,
      auth: { session: true, stepUp: true, principalKinds: ['user', 'token'] },
    };
    expect(violationsOf([route])).toStrictEqual([
      expect.stringContaining('accepts a token principal on a stepUp route'),
    ]);
  });

  it('accepts allowArchived on a write permission of the closed set, and refuses it elsewhere (D04-12)', () => {
    const unarchive: RegisteredRoute = {
      method: 'POST',
      url: `${API_PREFIX}/vaults/:vaultId/unarchive`,
      auth: { permission: 'vault:archive', vaultFrom: 'params.vaultId', allowArchived: true },
    };
    expect(violationsOf([unarchive])).toStrictEqual([]);
    const elsewhere: RegisteredRoute = { ...unarchive, url: `${API_PREFIX}/vaults/:vaultId/notes` };
    expect(violationsOf([elsewhere])).toStrictEqual([
      expect.stringContaining('is not a member of ALLOW_ARCHIVED_ROUTES'),
    ]);
  });

  it('accepts a bearer-only read that admits exactly token principals, and refuses one that admits users', () => {
    const mountAuth = {
      permission: 'note:read',
      vaultFrom: 'params.vaultId',
      bearerOnly: true,
      principalKinds: ['token'],
      mcpAudience: 'pat',
    } as const satisfies RouteAuth;
    const mount: RegisteredRoute = {
      method: 'GET',
      url: `${API_PREFIX}/vaults/:vaultId/notes/:noteId`,
      auth: mountAuth,
    };
    expect(violationsOf([mount])).toStrictEqual([]);
    const users: RegisteredRoute = {
      ...mount,
      auth: { ...mountAuth, principalKinds: ['user'] },
    };
    expect(violationsOf([users])).toStrictEqual([
      expect.stringContaining("declares bearerOnly without principalKinds: ['token']"),
    ]);
  });
});
