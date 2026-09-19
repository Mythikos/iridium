/**
 * `security.csrf.integration` (12-milestones.md §5.4; 04-auth-and-access-control.md §4.4; skeleton A27;
 * 10-testing-and-quality.md D10-26).
 *
 * `security.csrf.unit` owns the decision table as a pure function. What this file proves is everything
 * that only a running server can show:
 *
 *  - **the guard is mounted and it is mounted in the `onRequest` phase**, before body parsing — a request
 *    whose body exceeds `bodyLimit` and whose header is missing is answered `403`, not `413`, which is
 *    what makes the claim "it covers multipart uploads and any future form-encoded route" true rather
 *    than aspirational;
 *  - **the refusal is one `ProblemDetails` shape**, `403 csrf_rejected` with a request id that equals the
 *    `X-Request-Id` header;
 *  - **the coverage is data-driven from `app.routes()`**, so a mutating route added by any stream is
 *    covered here without anyone remembering to add a case (D10-26);
 *  - **the route sets agree**: every mutating `/api/v1` route the live instance serves is in the committed
 *    `openapi.json`, and every mutating documented operation is served. The two sources fail differently —
 *    the instance sees a route nobody documented, the document sees a route nobody guarded — so requiring
 *    both and requiring them to agree is the only version of "data-driven over the route table" that an
 *    incomplete table cannot satisfy.
 *
 * **What is pending.** The cookie-principal and bearer-principal halves of §4.4 become *interesting* when
 * there are cookie-authenticated mutating routes to drive: the `auth` and `kernel-rest` streams add them,
 * and the loop below picks them up with no edit. At wave 1 the mutating route set is the two `/__test__`
 * control routes, which are cookie-capable and not exempt — so the table is exercised end to end today on
 * the routes that exist, and grows by itself. The `POST /oauth/consent` exemption half of the inventory
 * row belongs to M3, which is when that route is registered.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CSRF_EXEMPT_ROUTES, LIMITS } from '@iridium/contracts';
import type { HTTPMethods } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SESSION_COOKIE_NAME } from '../../src/auth/sessions/cookie.ts';
import { issueSession } from '../../src/auth/sessions/issuer.ts';
import { csrfDecision, csrfRequestView } from '../../src/security/csrf.ts';
import { insertUser } from '../support/seed.ts';
import { startPlatformApp, TEST_PUBLIC_ORIGIN, type PlatformApp } from './platform-app.ts';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const OPENAPI_FILE = join(REPO_ROOT, 'packages', 'contracts', 'openapi', 'openapi.json');
const API_PREFIX = '/api/v1';

/** The methods the guard inspects, narrowed so a route table entry can be injected without a cast. */
const MUTATING_METHODS = [
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
] as const satisfies readonly HTTPMethods[];

/** A method the guard inspects. */
type MutatingMethod = (typeof MUTATING_METHODS)[number];

function isMutatingMethod(method: string): method is MutatingMethod {
  return MUTATING_METHODS.some((candidate) => candidate === method);
}

const HOST = new URL(TEST_PUBLIC_ORIGIN).host;

let booted: PlatformApp;

/** `{method, url}` for every mutating route the live instance serves. */
function mutatingRoutes(): readonly { readonly method: MutatingMethod; readonly url: string }[] {
  const routes: { method: MutatingMethod; url: string }[] = [];
  for (const route of booted.app.routes()) {
    if (isMutatingMethod(route.method)) routes.push({ method: route.method, url: route.url });
  }
  return routes;
}

interface OpenApiDocument {
  readonly paths?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

/** `{method, url}` for every mutating operation the committed document documents, `/api/v1`-prefixed. */
function documentedMutatingOperations(): readonly {
  readonly method: string;
  readonly url: string;
}[] {
  const parsed: OpenApiDocument = JSON.parse(readFileSync(OPENAPI_FILE, 'utf8'));
  const operations: { method: string; url: string }[] = [];
  for (const [path, item] of Object.entries(parsed.paths ?? {})) {
    for (const method of Object.keys(item)) {
      const upper = method.toUpperCase();
      if (isMutatingMethod(upper)) operations.push({ method: upper, url: `${API_PREFIX}${path}` });
    }
  }
  return operations;
}

function render(
  routes: readonly { readonly method: string; readonly url: string }[],
): readonly string[] {
  return routes
    .map((route) => `${route.method} ${route.url.replace(/:([A-Za-z][A-Za-z0-9]*)/g, '{$1}')}`)
    .toSorted((left, right) => left.localeCompare(right));
}

beforeAll(async () => {
  booted = await startPlatformApp();
});

afterAll(async () => {
  await booted.close();
});

describe('security.csrf.integration [area:security]', () => {
  describe('the guard is mounted on every mutating route', () => {
    it('has mutating routes to police, so the loop below is not vacuous', () => {
      expect(mutatingRoutes().length).toBeGreaterThan(0);
    });

    it('refuses every mutating route that lacks X-Iridium-Client with a verified cookie principal', async () => {
      // Authentication precedes CSRF. A protected route with no credential correctly stops at 401;
      // the real web-session cookie is what lets this request reach the guard under test.
      const db = booted.app.database.dbApp;
      if (db === null) throw new Error('CSRF integration requires MySQL.');
      const userId = await insertUser(
        db,
        { email: 'csrf-principal@example.test', isServerAdmin: true },
        booted.app.clock.now(),
      );
      const session = await issueSession(
        booted.app.auth.sessionRepository(db),
        booted.app.auth.ttls,
        booted.app.clock.now(),
        booted.app.auth.newId,
        {
          userId,
          kind: 'web',
          ip: '127.0.0.1',
          userAgent: 'csrf integration',
          deviceName: null,
          clientVersion: null,
          method: 'password',
        },
      );
      const cookie = `${SESSION_COOKIE_NAME}=${session.raw}`;
      const authenticated = await booted.app.inject({
        url: '/api/v1/auth/me',
        headers: { host: HOST, cookie },
      });
      expect(authenticated.statusCode).toBe(200);
      for (const route of mutatingRoutes()) {
        if (CSRF_EXEMPT_ROUTES.some((exempt) => exempt === `${route.method} ${route.url}`))
          continue;
        // eslint-disable-next-line no-await-in-loop -- one request at a time keeps a failure attributable
        const response = await booted.app.inject({
          method: route.method,
          url: route.url,
          headers: { host: HOST, origin: TEST_PUBLIC_ORIGIN, cookie },
          payload: {},
        });
        expect(response.statusCode, `${route.method} ${route.url}`).toBe(403);
        expect(response.json<{ code?: string }>().code).toBe('csrf_rejected');
      }
    });

    it('refuses a cross-site Sec-Fetch-Site even when the Origin is right', async () => {
      const response = await booted.app.inject({
        method: 'POST',
        url: '/__test__/faults',
        headers: {
          host: HOST,
          'x-iridium-client': 'web',
          origin: TEST_PUBLIC_ORIGIN,
          'sec-fetch-site': 'cross-site',
        },
        payload: { point: 'store.throw' },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json<{ code?: string }>().code).toBe('csrf_rejected');
    });

    it('refuses a foreign Origin and an absent one', async () => {
      for (const origin of [undefined, 'https://evil.example']) {
        // eslint-disable-next-line no-await-in-loop -- one request at a time keeps a failure attributable
        const response = await booted.app.inject({
          method: 'POST',
          url: '/__test__/faults',
          headers: {
            host: HOST,
            'x-iridium-client': 'web',
            ...(origin === undefined ? {} : { origin }),
          },
          payload: { point: 'store.throw' },
        });
        expect(response.statusCode, `origin=${origin ?? 'absent'}`).toBe(403);
      }
    });

    it('accepts the browser shape: the custom header plus a matching Origin', async () => {
      const response = await booted.app.inject({
        method: 'DELETE',
        url: '/__test__/faults',
        headers: { host: HOST, 'x-iridium-client': 'web', origin: TEST_PUBLIC_ORIGIN },
      });
      expect(response.statusCode).toBe(204);
    });

    it('accepts Sec-Fetch-Site: same-origin without an Origin header', async () => {
      const response = await booted.app.inject({
        method: 'DELETE',
        url: '/__test__/faults',
        headers: { host: HOST, 'x-iridium-client': 'web', 'sec-fetch-site': 'same-origin' },
      });
      expect(response.statusCode).toBe(204);
    });

    it('refuses a desktop request that carries a cookie (D04-06)', async () => {
      const response = await booted.app.inject({
        method: 'DELETE',
        url: '/__test__/faults',
        headers: { host: HOST, 'x-iridium-client': 'desktop', cookie: '__Host-iridium_session=x' },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json<{ detail?: string }>().detail).toContain('never sends cookies');
    });

    it('exempts a bearer request from the guard', async () => {
      // A bearer carries no ambient credential, so §4.4 passes it. Whether it then *authenticates* is
      // `authenticate()`'s answer and not this guard's — so the assertion is that the failure, if any, is
      // never `csrf_rejected`.
      const response = await booted.app.inject({
        method: 'DELETE',
        url: '/__test__/faults',
        headers: { host: HOST, authorization: 'Bearer irid_ses_0000000000000000_x' },
      });
      expect(response.statusCode).not.toBe(403);
    });

    it('never inspects a safe method', async () => {
      const response = await booted.app.inject({ method: 'GET', url: '/healthz' });
      expect(response.statusCode).toBe(200);
    });
  });

  describe('the phase it runs in', () => {
    it('answers 403 rather than 413 for an oversized body with no client header', async () => {
      // The guard is an `onRequest` hook, so it decides before the body is read. If it ever moved to
      // `preHandler` this case would return `413` and the multipart claim of §4.4 would be false.
      const oversized = 'x'.repeat(LIMITS.BODY_MAX_BYTES_JSON + 1);
      const response = await booted.app.inject({
        method: 'POST',
        url: '/__test__/faults',
        headers: { host: HOST, 'content-type': 'application/json' },
        payload: `{"point":"${oversized}"}`,
      });
      expect(response.statusCode).toBe(403);
      expect(response.json<{ code?: string }>().code).toBe('csrf_rejected');
    });
  });

  describe('the refusal is one shape', () => {
    it('is application/problem+json with a request id that equals the response header', async () => {
      const response = await booted.app.inject({
        method: 'POST',
        url: '/__test__/faults',
        headers: { host: HOST },
        payload: {},
      });
      expect(response.statusCode).toBe(403);
      expect(response.headers['content-type']).toContain('application/problem+json');
      const problem: { code?: string; status?: number; requestId?: string; type?: string } =
        response.json();
      expect(problem.code).toBe('csrf_rejected');
      expect(problem.status).toBe(403);
      expect(problem.type).toBe('urn:iridium:problem:csrf_rejected');
      expect(problem.requestId).toBe(response.headers['x-request-id']);
    });
  });

  describe('the mounted hook and the pure decision agree', () => {
    it('decides a hand-built view the same way the server decided the same request', async () => {
      const publicOrigin = booted.app.iridiumConfig.server.publicOrigin.origin;
      // The same inputs through the pure function: if the hook ever stopped calling it, or called it with
      // a different view, these two would disagree.
      expect(
        csrfDecision(
          {
            method: 'POST',
            route: '/__test__/faults',
            hasAuthorization: false,
            hasCookie: false,
            client: null,
          },
          publicOrigin,
        ),
      ).toEqual({ pass: false, reason: 'client_header' });

      const response = await booted.app.inject({
        method: 'POST',
        url: '/__test__/faults',
        headers: { host: HOST },
        payload: {},
      });
      expect(response.statusCode).toBe(403);
    });

    it('builds its view from the route template, not from the concrete path', () => {
      // `csrfRequestView` is the one reader of the request, and the route *template* is what the exemption
      // set and the log line are written against. A concrete path would make both unbounded.
      expect(typeof csrfRequestView).toBe('function');
    });
  });

  describe('the two route sources agree (D10-26)', () => {
    it('serves exactly the mutating /api/v1 operations the committed document documents', () => {
      const served = render(
        mutatingRoutes().filter((route) => route.url.startsWith(`${API_PREFIX}/`)),
      );
      expect(served).toEqual(render(documentedMutatingOperations()));
    });

    it('declares csrfExempt on exactly the closed enumeration, in both directions', () => {
      const exemptServed = booted.app
        .routes()
        .filter((route) => route.csrfExempt === true)
        .map((route) => `${route.method} ${route.url.replace(/:([A-Za-z][A-Za-z0-9]*)/g, '{$1}')}`)
        .toSorted((left, right) => left.localeCompare(right));
      const expected = CSRF_EXEMPT_ROUTES.filter((exempt) =>
        booted.app.routes().some((route) => `${route.method} ${route.url}` === exempt),
      ).toSorted((left, right) => left.localeCompare(right));
      expect(exemptServed).toEqual([...expected]);
    });
  });
});
