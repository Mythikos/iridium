/**
 * `rest.served-routes.unit` — the served route set is exactly the manifest (09-api-reference.md §2.18;
 * 12-milestones.md §5.2, the `rest` row).
 *
 * `API_ROUTES` is data with three consumers, and this is the one that holds the *server* to it: the
 * instance is built through the one boot path with no database, readied — which runs the route-policy
 * boot assertion — and its `app.routes()` compared with the manifest in both directions. A route
 * registered without a row is as much a failure as a row nobody registered: the first is an
 * undocumented endpoint, the second is a documented promise the server does not keep.
 *
 * It also pins the two things `@fastify/swagger-ui` makes easy to get wrong: every route it registers
 * beneath `/docs` carries a policy (otherwise `ready()` would have thrown), and none of them is an
 * operation of the API.
 */
import { GLOBAL_ERROR_CODES, API_ROUTES, routeKey } from '@iridium/contracts';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  buildWithoutDatabase,
  NO_DATABASE_HOST,
  NO_DATABASE_ORIGIN,
  type NoDatabaseApp,
} from '../../test/support/no-database-app.ts';
import { API_PREFIX, TEST_NAMESPACE_PREFIX, type RegisteredRoute } from '../authz/route-policy.ts';
import type { OwnerFence } from '../collab/owner-lease.ts';
import { DOCS_PREFIX } from './docs.ts';
import { EMPTY_RESPONSE } from './handler-context.ts';

/** Where the two `EMPTY_RESPONSE` probes are mounted; the namespace is refused outside NODE_ENV=test. */
const EMPTY_304_PATH = `${TEST_NAMESPACE_PREFIX}/empty-not-modified`;
const EMPTY_204_PATH = `${TEST_NAMESPACE_PREFIX}/empty-no-content`;

let harness: NoDatabaseApp;
let routes: readonly RegisteredRoute[];

/** Fastify synthesises a `HEAD` twin for every `GET`; the manifest names the `GET` alone. */
function servedKeys(): ReadonlySet<string> {
  return new Set(
    routes
      .filter((route) => route.method !== 'HEAD')
      .map((route) => `${route.method} ${route.url}`),
  );
}

beforeAll(async () => {
  harness = await buildWithoutDatabase();
  // Two probes for `EMPTY_RESPONSE`, registered on the one boot path before `ready()` — the helper
  // exists for exactly this — inside a scope that sets the same compilers every area's routes set,
  // so the declaration is exercised through the stack that serves it rather than beside it. They
  // live in the test namespace and declare its policy, which is what the boot assertion requires.
  await harness.app.register(async (scope) => {
    scope.setValidatorCompiler(validatorCompiler);
    scope.setSerializerCompiler(serializerCompiler);
    const probes = scope.withTypeProvider<ZodTypeProvider>();
    probes.get(
      EMPTY_304_PATH,
      { config: { auth: 'test-only' }, schema: { hide: true, response: { 304: EMPTY_RESPONSE } } },
      async (_request, reply) => reply.code(304).send(),
    );
    probes.delete(
      EMPTY_204_PATH,
      { config: { auth: 'test-only' }, schema: { hide: true, response: { 204: EMPTY_RESPONSE } } },
      async (_request, reply) => reply.code(204).send(),
    );
  });
  // `ready()` is the boot assertion (04-auth-and-access-control.md §6.2): it refuses to start a
  // server with a route that declares no `config.auth`, so reaching this line is itself a case.
  // These probes only exercise response serialization. Their no-database fixture supplies the
  // ownership admission dependency; the real takeover and refusal paths are integration-tested.
  vi.spyOn(harness.app.collab.ownerLease, 'captureFence').mockReturnValue({
    assertActive: vi.fn<OwnerFence['assertActive']>(),
    assertCurrent: vi.fn<OwnerFence['assertCurrent']>().mockResolvedValue(undefined),
  });
  await harness.app.ready();
  routes = harness.app.routes();
});

afterAll(async () => {
  await harness.close();
});

describe('rest.served-routes.unit [area:contracts]', () => {
  it('registers every `rest` row of the manifest', () => {
    const served = servedKeys();
    const missing = API_ROUTES.filter(
      (row) => row.plugin === 'rest' && !served.has(routeKey(row)),
    ).map(routeKey);
    expect(missing).toStrictEqual([]);
  });

  it('registers every `ops` row of the manifest', () => {
    const served = servedKeys();
    const missing = API_ROUTES.filter(
      (row) => row.plugin === 'ops' && !served.has(routeKey(row)),
    ).map(routeKey);
    expect(missing).toStrictEqual([]);
  });

  it('registers no `/api/v1` route the manifest does not name', () => {
    const documented = new Set(API_ROUTES.map(routeKey));
    const undocumented = [...servedKeys()].filter(
      (key) =>
        key.includes(` ${API_PREFIX}/`) && !documented.has(key) && !key.includes(` ${DOCS_PREFIX}`),
    );
    expect(undocumented).toStrictEqual([]);
  });

  it('serves each row under the policy its row declares', () => {
    const byKey = new Map(routes.map((route) => [`${route.method} ${route.url}`, route]));
    for (const row of API_ROUTES) {
      const served = byKey.get(routeKey(row));
      expect(served, `${routeKey(row)} is not registered`).toBeDefined();
      expect(
        served?.auth,
        `${routeKey(row)} serves a policy the manifest does not declare`,
      ).toStrictEqual(row.auth);
    }
  });

  it('gives every Swagger UI route a policy of its own', () => {
    const docs = routes.filter((route) => route.url.startsWith(DOCS_PREFIX));
    expect(docs.length).toBeGreaterThan(1);
    for (const route of docs) {
      expect(route.auth, `${route.method} ${route.url} carries no policy`).toBeDefined();
    }
  });

  it('sends no bytes for a status whose whole answer is the status', async () => {
    // `EMPTY_RESPONSE` is what `members.delete` (204) and `notes.getMarkdown` (304) declare, and the
    // 304 is the case that decides its shape. Fastify strips a 204's body whatever the handler sent,
    // so a `z.null()` schema answering `send(null)` looks correct there — and then puts the four
    // bytes `null` on the wire for the 304, where nothing strips it and RFC 9110 section 15.4.5 says
    // a 304 carries no content. `z.undefined()` with a bare `send()` is the one declaration that is
    // empty for both, and it is also the one `@fastify/swagger` renders with no `content` member.
    const notModified = await harness.app.inject({
      method: 'GET',
      url: EMPTY_304_PATH,
      headers: { host: NO_DATABASE_HOST },
    });
    // A mutating method passes the CSRF guard the way a browser client does: the custom header plus
    // an `Origin` equal to `PUBLIC_ORIGIN` (04 section 4.4). Without them the guard answers `403`
    // and the probe would measure the refusal instead of the empty body.
    const noContent = await harness.app.inject({
      method: 'DELETE',
      url: EMPTY_204_PATH,
      headers: {
        host: NO_DATABASE_HOST,
        'x-iridium-client': 'web',
        origin: NO_DATABASE_ORIGIN,
      },
    });
    expect({
      status: notModified.statusCode,
      bytes: notModified.rawPayload.length,
    }).toStrictEqual({ status: 304, bytes: 0 });
    expect({ status: noContent.statusCode, bytes: noContent.rawPayload.length }).toStrictEqual({
      status: 204,
      bytes: 0,
    });
  });

  it('repeats no global error code in a row', () => {
    const repeated = API_ROUTES.filter((row) =>
      row.errors.some((code) => GLOBAL_ERROR_CODES.includes(code)),
    ).map((row) => routeKey(row));
    expect(repeated).toStrictEqual([]);
  });

  it('declares the API version header on every `/api/v1` response', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: `${API_PREFIX}/meta`,
      headers: { host: '127.0.0.1:4000' },
    });
    expect(response.headers['x-iridium-api-version']).toBe('1');
  });
});
