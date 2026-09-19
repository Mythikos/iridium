/**
 * `authz.plugin.unit` (04-auth-and-access-control.md sections 6.2 and 8.3; 02-system-architecture.md
 * invariants 1 and 2; D04-32): boot step 5's wiring on the one boot path without a database — a
 * subscriber that throws is logged at `error` and stops no other subscriber, the store error maps
 * to `503 unavailable`, a route registered with several methods and its own `preHandler` list gets
 * registered policies while an ownerless process refuses traffic, and a `csrfExempt` declaration outside the closed set is a
 * boot failure that names the route.
 */
import { VaultId } from '@iridium/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  buildWithoutDatabase,
  NO_DATABASE_HOST,
  type NoDatabaseApp,
} from '../../test/support/no-database-app.ts';
import { createLogger, newInstanceId } from '../ops/logging.ts';
import { AuthzStoreUnavailableError } from './authorize.ts';
import type { AuthzEvent } from './bus.ts';
import { API_PREFIX, RoutePolicyError } from './route-policy.ts';

const METHOD_FAILURES = {
  GET: { status: 401, code: 'unauthenticated' },
  POST: { status: 503, code: 'unavailable' },
} as const;
const MANY = `${API_PREFIX}/__probe__/many`;

describe('authz.plugin.unit [area:authz]', () => {
  const captured: string[] = [];
  let booted: NoDatabaseApp;
  let app: FastifyInstance;

  beforeAll(async () => {
    const logger = createLogger({
      level: 'error',
      format: 'json',
      instanceId: newInstanceId('01a09c3c-0000-7000-8000-000000000005'),
      destination: {
        write(line: string): void {
          captured.push(line.trimEnd());
        },
      },
    });
    booted = await buildWithoutDatabase({ logger });
    app = booted.app;
    app.route({
      method: ['GET', 'POST'],
      url: MANY,
      config: { auth: { session: true } },
      preHandler: [async () => undefined],
      handler: async (_request, reply) => reply.send({ ok: true }),
    });
    await app.ready();
  });

  afterAll(async () => {
    await booted.close();
  });

  it('logs and counts a subscriber that throws, and still delivers to the next one', async () => {
    const delivered: AuthzEvent[] = [];
    const unsubscribeThrowing = app.authz.bus.subscribe(() => {
      throw new Error('a subscriber defect');
    });
    const unsubscribeRecording = app.authz.bus.subscribe((event) => {
      delivered.push(event);
    });
    const event: AuthzEvent = {
      type: 'vault.archived',
      vaultId: VaultId.parse('019948c4-0000-7000-8000-0000000000a0'),
    };
    app.authz.bus.publish(event);
    app.authz.bus.publish(event);
    unsubscribeThrowing();
    unsubscribeRecording();
    expect(delivered).toStrictEqual([event, event]);
    const line = captured.find((entry) => entry.includes('an AuthzBus subscriber threw'));
    expect(line).toBeDefined();
    expect(line).toContain('"eventType":"vault.archived"');
    expect(line).toContain('a subscriber defect');
    // `iridium_authz_bus_handler_errors_total` (04 section 8.3): one per throw, none per delivery.
    const counter = (await app.metrics.snapshot()).find(
      (metric) => metric.name === 'iridium_authz_bus_handler_errors_total',
    );
    expect(counter?.values.map((sample) => sample.value)).toStrictEqual([2]);
  });

  it('maps the store error to 503 unavailable, never to a deny', () => {
    const problem = app.problems.map(new AuthzStoreUnavailableError());
    expect(problem?.code).toBe('unavailable');
    expect(problem?.status).toBe(503);
  });

  it('registers every multi-method policy and requires ownership before a mutating request', async () => {
    const registered = app
      .routes()
      .filter((route) => route.url === MANY)
      .map((route) => ({ method: route.method, auth: route.auth }))
      .toSorted((left, right) => left.method.localeCompare(right.method));
    expect(registered).toStrictEqual(
      ['GET', 'HEAD', 'POST'].map((method) => ({ method, auth: { session: true } })),
    );
    for (const method of ['GET', 'POST'] as const) {
      // eslint-disable-next-line no-await-in-loop -- one request per method, in order
      const response = await app.inject({
        method,
        url: MANY,
        headers: { host: NO_DATABASE_HOST, 'x-iridium-client': 'desktop' },
      });
      expect(response.statusCode).toBe(METHOD_FAILURES[method].status);
      expect(response.json()).toMatchObject({ code: METHOD_FAILURES[method].code });
    }
  });

  it('refuses to boot a route that declares csrfExempt outside the closed set (D04-32)', async () => {
    const refused = await buildWithoutDatabase();
    try {
      refused.app.post(
        `${API_PREFIX}/__probe__/exempt`,
        { config: { auth: { public: true }, csrfExempt: true } },
        async (_request, reply) => reply.send({ ok: true }),
      );
      const failure = await refused.app.ready().then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(RoutePolicyError);
      expect(failure).toMatchObject({
        violations: [expect.stringContaining('declares csrfExempt but is not a member')],
      });
    } finally {
      await refused.close();
    }
  });
});
