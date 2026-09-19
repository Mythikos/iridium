/**
 * `authz.route-policy.boot.guard` (12-milestones.md section 4.6; 10-testing-and-quality.md, "Guard
 * tests"; 04-auth-and-access-control.md section 6.2; invariant 2 of 02-system-architecture.md).
 *
 * What this proves at M0: the boot assertion **runs** and **passes** on the skeleton's route set
 * (`/healthz`, `/readyz`, `/metrics` — `GET /meta` first appears in M1's route set, so M0 cannot
 * assert it), and it accepts the `test-only` policy value reserved for the `/__test__` namespace M1
 * registers.
 *
 * It is a guard rather than an integration test because it needs no database and no socket:
 * `buildApp({ mode: 'in-process', database: 'none' })` registers every route and opens no
 * connection, so this file runs in `ci.yml › static`, which has no Docker. `database: 'none'` is the
 * same seam `pnpm gen` uses to export the OpenAPI document.
 *
 * The assertions the plan schedules for later milestones — the closed CSRF exemption enumeration, the
 * audience-per-MCP-mount rule, `ALLOW_ARCHIVED_ROUTES` membership and the four deliberate
 * `/.well-known/` 404s — are listed in `PENDING_ASSERTIONS`, and the last case below asserts that
 * list is non-empty and mentions each, so a milestone cannot quietly ship without them.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.ts';
import {
  API_PREFIX,
  assertRoutePolicies,
  PENDING_ASSERTIONS,
  RoutePolicyError,
  TEST_NAMESPACE_PREFIX,
  type RegisteredRoute,
} from '../../src/authz/route-policy.ts';
import { loadConfig, type IridiumConfig, type RawEnv } from '../../src/config/env.ts';

const scratch = mkdtempSync(join(tmpdir(), 'iridium-route-policy-'));

function guardEnv(): RawEnv {
  return {
    NODE_ENV: 'test',
    PUBLIC_ORIGIN: 'http://127.0.0.1:4000',
    DATABASE_URL: 'mysql://iridium_app:pw@127.0.0.1:3306/iridium',
    // A temp directory keeps the `attachment_store` readiness probe inside this test's own scratch
    // space; a guard must never write to a deployment path.
    ATTACHMENTS_DIR: join(scratch, 'attachments'),
    LOG_LEVEL: 'fatal',
  };
}

let config: IridiumConfig;

async function buildGuardApp(): Promise<FastifyInstance> {
  return buildApp({ mode: 'in-process', database: 'none', config });
}

/** A route table with one extra entry, for the negative cases. */
function tableWith(extra: RegisteredRoute): readonly RegisteredRoute[] {
  return [{ method: 'GET', url: '/healthz', auth: { public: true } }, extra];
}

beforeAll(() => {
  config = loadConfig(guardEnv());
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe('authz.route-policy.boot.guard [area:authz]', () => {
  describe('the assertion runs and passes on the registered route set', () => {
    let app: FastifyInstance;

    beforeAll(async () => {
      app = await buildGuardApp();
      // `ready()` is what runs the assertion. A violation would reject here, which is the whole
      // mechanism: the server refuses to start rather than serving an unpolicied route.
      await app.ready();
    });

    afterAll(async () => {
      await app.close();
    });

    it('registers only the documented surfaces, and any other route is the test-only namespace', () => {
      // Outside `/api/v1` the boot registers exactly what 09-api-reference.md §2.17 and §2.18's
      // second table name: the three operational routes and the `/collab` upgrade. Everything else a
      // milestone adds lives under the API prefix, and — under `NODE_ENV=test` — the `/__test__`
      // control namespace, whose every route must declare `test-only`.
      const routes = app.routes();
      const outsideTheApi = [...new Set(routes.map((route) => route.url))]
        .filter(
          (url) => !url.startsWith(TEST_NAMESPACE_PREFIX) && !url.startsWith(`${API_PREFIX}/`),
        )
        .toSorted((a, b) => a.localeCompare(b));
      expect(outsideTheApi).toEqual(['/collab', '/healthz', '/metrics', '/readyz']);
      const testRoutePolicies = routes
        .filter((route) => route.url.startsWith(TEST_NAMESPACE_PREFIX))
        .map((route) => route.auth);
      expect(testRoutePolicies.every((auth) => auth === 'test-only')).toBe(true);
    });

    it('gives every registered route a config.auth, HEAD twins included', () => {
      const routes = app.routes();
      expect(routes.length).toBeGreaterThan(0);
      for (const route of routes) {
        expect(route.auth, `${route.method} ${route.url} declares no config.auth`).toBeDefined();
      }
      // Fastify synthesises a HEAD route per GET, and it inherits the same `config` object. The
      // assertion walks method+path pairs, so that inheritance is load-bearing rather than incidental.
      expect(routes.filter((route) => route.method === 'HEAD').length).toBeGreaterThan(0);
    });

    it('passes the pure assertion over the real table', () => {
      expect(() => {
        assertRoutePolicies(app.routes());
      }).not.toThrow();
    });
  });

  describe('the accepted policy vocabulary', () => {
    it('accepts the test-only policy on a /__test__ route', () => {
      expect(() => {
        assertRoutePolicies(
          tableWith({ method: 'POST', url: `${TEST_NAMESPACE_PREFIX}/faults`, auth: 'test-only' }),
        );
      }).not.toThrow();
    });

    it('refuses test-only outside the /__test__ namespace', () => {
      expect(() => {
        assertRoutePolicies(tableWith({ method: 'POST', url: '/api/v1/notes', auth: 'test-only' }));
      }).toThrow(RoutePolicyError);
    });

    it('accepts public, self, session, serverAdmin and vault-scoped policies', () => {
      expect(() => {
        assertRoutePolicies([
          { method: 'GET', url: '/healthz', auth: { public: true } },
          { method: 'GET', url: '/api/v1/me', auth: { self: true } },
          { method: 'POST', url: '/api/v1/me/password', auth: { self: true, stepUp: true } },
          { method: 'DELETE', url: '/api/v1/auth/sessions/current', auth: { session: true } },
          {
            method: 'GET',
            url: '/api/v1/admin/users',
            auth: { serverAdmin: true, permission: 'server:users' },
          },
          {
            method: 'GET',
            url: '/api/v1/vaults/:vaultId/nodes',
            auth: { permission: 'vault:read', vaultFrom: 'params.vaultId' },
          },
        ]);
      }).not.toThrow();
    });

    it('accepts the two flag-only administrator documentation routes', () => {
      expect(() => {
        assertRoutePolicies([
          { method: 'GET', url: '/healthz', auth: { public: true } },
          { method: 'GET', url: '/openapi.json', auth: { serverAdmin: true } },
          { method: 'GET', url: '/docs', auth: { serverAdmin: true } },
        ]);
      }).not.toThrow();
    });
  });

  describe('the violations that refuse to boot', () => {
    it('refuses a route with no config.auth, naming it', () => {
      let thrown: unknown;
      try {
        assertRoutePolicies(
          tableWith({ method: 'GET', url: '/api/v1/unpolicied', auth: undefined }),
        );
      } catch (error) {
        thrown = error;
      }
      if (!(thrown instanceof RoutePolicyError)) {
        throw new Error(`expected the boot assertion to refuse; it threw: ${String(thrown)}`);
      }
      expect(thrown.violations).toHaveLength(1);
      expect(thrown.violations[0]).toContain('GET /api/v1/unpolicied');
      expect(thrown.message).toContain('declares no config.auth');
    });

    it('refuses the same method and path registered twice', () => {
      expect(() => {
        assertRoutePolicies([
          { method: 'GET', url: '/healthz', auth: { public: true } },
          { method: 'GET', url: '/healthz', auth: { public: true } },
        ]);
      }).toThrow(/registered twice/);
    });

    it('refuses serverAdmin with a vault-scoped permission', () => {
      expect(() => {
        assertRoutePolicies(
          tableWith({
            method: 'GET',
            url: '/api/v1/admin/thing',
            auth: { serverAdmin: true, permission: 'note:read' },
          }),
        );
      }).toThrow(/server:\* permission/);
    });

    it('refuses a server-scoped permission that resolves a vault', () => {
      expect(() => {
        assertRoutePolicies(
          tableWith({
            method: 'GET',
            url: '/api/v1/thing',
            auth: { permission: 'server:users', vaultFrom: 'params.vaultId' },
          }),
        );
      }).toThrow(/resolves no vault/);
    });

    it('refuses a token principal on a mutating method, and on a non-read permission', () => {
      expect(() => {
        assertRoutePolicies(
          tableWith({
            method: 'POST',
            url: '/api/v1/vaults/:vaultId/nodes',
            auth: {
              permission: 'note:read',
              vaultFrom: 'params.vaultId',
              principalKinds: ['user', 'token'],
            },
          }),
        );
      }).toThrow(/read-only/);

      expect(() => {
        assertRoutePolicies(
          tableWith({
            method: 'GET',
            url: '/api/v1/vaults/:vaultId/thing',
            auth: {
              permission: 'note:write',
              vaultFrom: 'params.vaultId',
              principalKinds: ['user', 'token'],
            },
          }),
        );
      }).toThrow(/READ_BUNDLE/);
    });

    it('refuses mcpAudience without bearerOnly', () => {
      expect(() => {
        assertRoutePolicies(
          tableWith({
            method: 'POST',
            url: '/mcp',
            auth: { permission: 'note:read', vaultFrom: 'params.vaultId', mcpAudience: 'pat' },
          }),
        );
      }).toThrow(/bearerOnly/);
    });

    it('refuses a bearerOnly mount that does not admit exactly token principals', () => {
      expect(() => {
        assertRoutePolicies(
          tableWith({
            method: 'GET',
            url: '/api/v1/vaults/:vaultId/nodes',
            auth: {
              permission: 'note:read',
              vaultFrom: 'params.vaultId',
              bearerOnly: true,
              mcpAudience: 'pat',
            },
          }),
        );
      }).toThrow(/principalKinds/);
    });

    it('refuses a serverAdmin flag-only route that is not a documentation route', () => {
      expect(() => {
        assertRoutePolicies(
          tableWith({ method: 'GET', url: '/api/v1/admin/secret', auth: { serverAdmin: true } }),
        );
      }).toThrow(/ADMIN_FLAG_ONLY_ROUTES/);
    });

    it('refuses a mutating /admin/* route without step-up', () => {
      expect(() => {
        assertRoutePolicies(
          tableWith({
            method: 'DELETE',
            url: '/admin/tokens/:tokenId',
            auth: { serverAdmin: true, permission: 'server:tokens:all' },
          }),
        );
      }).toThrow(/stepUp/);
    });

    it('refuses allowArchived on a read permission, where the flag would be a no-op', () => {
      expect(() => {
        assertRoutePolicies(
          tableWith({
            method: 'GET',
            url: '/api/v1/vaults/:vaultId/export',
            auth: { permission: 'export:read', vaultFrom: 'params.vaultId', allowArchived: true },
          }),
        );
      }).toThrow(/no-op/);
    });

    it('collects every violation in one failure rather than stopping at the first', () => {
      let thrown: unknown;
      try {
        assertRoutePolicies([
          { method: 'GET', url: '/a', auth: undefined },
          { method: 'GET', url: '/b', auth: undefined },
        ]);
      } catch (error) {
        thrown = error;
      }
      if (!(thrown instanceof RoutePolicyError)) {
        throw new Error(`expected the boot assertion to refuse; it threw: ${String(thrown)}`);
      }
      expect(thrown.violations).toHaveLength(2);
    });
  });

  describe('a real boot refuses to start on a violation', () => {
    it('rejects app.ready() when a route is registered without config.auth', async () => {
      const app = await buildGuardApp();
      app.get('/deliberately-unpolicied', async () => ({ ok: true }));
      await expect(app.ready()).rejects.toThrow(RoutePolicyError);
      await app.close();
    });
  });

  describe('the assertions later milestones add', () => {
    it('records each pending assertion with the milestone that registers its routes', () => {
      expect(PENDING_ASSERTIONS.length).toBeGreaterThan(0);
      const recorded = PENDING_ASSERTIONS.join('\n');
      // The CSRF-exemption enumeration and `allowArchived` membership are asserted now (the
      // negative cases below cover them), so they have left the pending list. What remains is M3's:
      // the MCP-audience-per-mount match, the `/oauth/*` routes, and the deliberate `.well-known` 404s.
      expect(recorded).toContain('mcpAudience');
      expect(recorded).toContain('/oauth');
      expect(recorded).toContain('.well-known');
      for (const entry of PENDING_ASSERTIONS) {
        expect(entry, 'every pending assertion names its milestone').toMatch(/^M\d:/);
      }
    });
  });
});
