/**
 * `auth.routes.unit` (09-api-reference.md section 1.5; 02-system-architecture.md ARCH-02; D04-10;
 * D06-15): the guards the route handlers narrow the request with — an anonymous or system
 * principal is `unauthenticated`, a token on a user-only handler is `token_scope_insufficient` — and
 * the two answers a route gives while the database is not connected, through the one boot path
 * with `database: 'none'`: `503 unavailable` from the route, and the same code from the auth
 * plugin's problem mapper for every store error the area throws, never a `401`.
 */
import {
  SessionId,
  TokenId,
  UserId,
  type Principal,
  type TokenPrincipal,
} from '@iridium/contracts';
import type { FastifyInstance } from 'fastify';
import { onTestFinished, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { buildWithoutDatabase, NO_DATABASE_HOST } from '../../test/support/no-database-app.ts';
import { API_PREFIX } from '../authz/route-policy.ts';
import {
  requireConnected,
  requirePrincipal,
  requireUserPrincipal,
} from '../rest/handler-context.ts';
import { ProblemError } from '../security/problem.ts';
import { PepperVersionMissingError } from './credentials/hasher.ts';
import { PepperStoreUnavailableError } from './credentials/pepper-version.ts';
import { SessionStoreUnavailableError } from './plugin.ts';
import { AUTH_OPERATION_IDS, routeSpec, ticketRateLimitKey } from './routes.ts';
import { PrincipalTokenMissingError, TokenStoreUnavailableError } from './tokens/verify.ts';
import { PrincipalUserMissingError } from './users.ts';

const USER = UserId.parse('019948c4-0000-7000-8000-000000000001');
const HTTP_UNAVAILABLE = 503;
const HTTP_NO_CONTENT = 204;

/** The part of the generated document this spec reads: the path items, each a map of operations. */
const OPEN_API_DOCUMENT = z.object({
  paths: z.record(z.string(), z.record(z.string(), z.unknown())),
});

/** One operation, as `@fastify/swagger` renders a registration's `schema`. */
const OPEN_API_OPERATION = z.object({
  operationId: z.string(),
  tags: z.array(z.string()),
  summary: z.string(),
  responses: z.record(z.string(), z.unknown()),
});

/**
 * A Fastify path as the document spells it: `:param` becomes `{param}`, and the `/api/v1` mount
 * is the document's server URL rather than part of the path.
 */
function openApiPath(path: string): string {
  return path.replaceAll(/:([A-Za-z]+)/g, '{$1}');
}

const USER_PRINCIPAL: Principal = {
  kind: 'user',
  userId: USER,
  sessionId: SessionId.parse('019948c4-0000-7000-8000-0000000000aa'),
  sessionKind: 'web',
  isServerAdmin: false,
  authzVersion: 1,
  lastAuthenticatedAt: new Date(0),
};
const TOKEN_PRINCIPAL: TokenPrincipal = {
  kind: 'token',
  tokenKind: 'pat',
  tokenId: TokenId.parse('019948c4-0000-7000-8000-00000000f001'),
  publicTokenId: 'ABCDEFGHIJKLMNOP',
  userId: USER,
  clientId: null,
  consentId: null,
  resource: null,
  scopes: ['vault:read'],
  vaultScope: { all: true },
  isServerAdmin: false,
  adminOwned: false,
  surface: 'rest',
  rateLimitPerHour: 3000,
  expiresAt: new Date(1),
};
const SYSTEM_PRINCIPAL: Principal = { kind: 'system', job: 'cli:test' };

function codeOf(work: () => unknown): string {
  try {
    work();
  } catch (error) {
    if (error instanceof ProblemError) return error.code;
    throw error;
  }
  throw new Error('expected a ProblemError');
}

async function fixture(): Promise<FastifyInstance> {
  // Boot inside each owning test so mutation coverage attributes route registration to the
  // assertions that prove it, rather than to an unrelated test or a suite-level beforeAll.
  const booted = await buildWithoutDatabase();
  onTestFinished(() => booted.close());
  await booted.app.ready();
  return booted.app;
}

describe('auth.routes.unit [area:auth]', () => {
  describe('the principal guards', () => {
    it('narrows a user or token principal and refuses anonymous and system callers', () => {
      expect(requirePrincipal(USER_PRINCIPAL)).toBe(USER_PRINCIPAL);
      expect(requirePrincipal(TOKEN_PRINCIPAL)).toBe(TOKEN_PRINCIPAL);
      expect(codeOf(() => requirePrincipal(null))).toBe('unauthenticated');
      expect(codeOf(() => requirePrincipal(SYSTEM_PRINCIPAL))).toBe('unauthenticated');
    });

    it('narrows to a user principal, refusing a token with the route policy code (D04-10)', () => {
      expect(requireUserPrincipal(USER_PRINCIPAL)).toBe(USER_PRINCIPAL);
      expect(codeOf(() => requireUserPrincipal(TOKEN_PRINCIPAL))).toBe('token_scope_insufficient');
      expect(codeOf(() => requireUserPrincipal(null))).toBe('unauthenticated');
    });

    it('answers unavailable, never a query, while the pool is not connected', () => {
      expect(codeOf(() => requireConnected(null))).toBe('unavailable');
    });

    it('keys the per-session ticket budget by the principal, and by the address without one', () => {
      expect(ticketRateLimitKey({ principalKey: 'ses:abc', ip: '203.0.113.9' })).toBe('ses:abc');
      expect(ticketRateLimitKey({ principalKey: null, ip: '203.0.113.9' })).toBe('203.0.113.9');
    });
  });

  describe('the routes on the one boot path without a database', () => {
    it('answers 503 unavailable to a login while the database is not connected', async () => {
      const app = await fixture();
      const response = await app.inject({
        method: 'POST',
        url: `${API_PREFIX}/auth/sessions`,
        headers: { host: NO_DATABASE_HOST, 'x-iridium-client': 'desktop' },
        payload: {
          email: 'ada@example.test',
          password: 'correct horse battery',
          client: 'desktop',
        },
      });
      expect(response.statusCode).toBe(HTTP_UNAVAILABLE);
      expect(response.json()).toMatchObject({ code: 'unavailable' });
    });

    it('maps every store error of the area to unavailable, and a vanished user row to unauthenticated', async () => {
      const app = await fixture();
      for (const error of [
        new TokenStoreUnavailableError(),
        new SessionStoreUnavailableError(),
        new PepperStoreUnavailableError(),
        new PepperVersionMissingError(9),
      ]) {
        expect(app.problems.map(error)?.code).toBe('unavailable');
      }
      expect(app.problems.map(new PrincipalUserMissingError(USER))?.code).toBe('unauthenticated');
      expect(app.problems.map(new PrincipalTokenMissingError(TOKEN_PRINCIPAL.tokenId))?.code).toBe(
        'unauthenticated',
      );
      expect(app.problems.map(new Error('not ours'))).toBeNull();
      expect(app.problems.failures).toStrictEqual([]);
    });

    it('serves the ten manifest operations under the API prefix, each under its row', async () => {
      const app = await fixture();
      const registered = app
        .routes()
        .filter((route) => route.method !== 'HEAD')
        .map((route) => `${route.method} ${route.url}`);
      for (const operationId of AUTH_OPERATION_IDS) {
        const spec = routeSpec(operationId);
        expect(registered).toContain(`${spec.method} ${API_PREFIX}${spec.path}`);
      }
    });

    it('documents every auth route under the operation id, tag and summary of its manifest row', async () => {
      const app = await fixture();
      const document = OPEN_API_DOCUMENT.parse(app.swagger());
      for (const operationId of AUTH_OPERATION_IDS) {
        const spec = routeSpec(operationId);
        const operation = OPEN_API_OPERATION.parse(
          document.paths[openApiPath(spec.path)]?.[spec.method.toLowerCase()],
        );
        expect(operation).toMatchObject({
          operationId: spec.operationId,
          tags: [spec.tag],
          summary: spec.summary,
        });
      }
    });

    it('documents a 204 as carrying nothing, so the document invents no 200 for it', async () => {
      const app = await fixture();
      const document = OPEN_API_DOCUMENT.parse(app.swagger());
      const noContent = AUTH_OPERATION_IDS.map((operationId) => routeSpec(operationId)).filter(
        (spec) => spec.responses.some((response) => response.status === HTTP_NO_CONTENT),
      );
      expect(noContent.map((spec) => spec.operationId)).toStrictEqual([
        'auth.deleteCurrentSession',
        'auth.setPassword',
        'me.sessions.revoke',
        'me.changePassword',
      ]);
      for (const spec of noContent) {
        const operation = OPEN_API_OPERATION.parse(
          document.paths[openApiPath(spec.path)]?.[spec.method.toLowerCase()],
        );
        // The success statuses are the row's, and `204` is the only one. The other statuses the
        // document carries are the refusals `ops/openapi.ts` emits from the row's own `errors` list
        // (09-api-reference.md §6), which is why the success set is compared rather than every key.
        const success = Object.keys(operation.responses).filter((status) => status.startsWith('2'));
        expect(success).toStrictEqual([String(HTTP_NO_CONTENT)]);
        expect(operation.responses[String(HTTP_NO_CONTENT)]).not.toHaveProperty('content');
      }
    });
  });
});
