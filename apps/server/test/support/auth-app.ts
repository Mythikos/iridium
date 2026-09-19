/**
 * The auth suites' server: the product's `buildApp` with the M1 auth routes composed under
 * `/api/v1` (12-milestones.md section 5.2, the `rest` row; 04-auth-and-access-control.md).
 *
 * The `rest` plugin that composes `applyAuthRoutes` for the running server is the wave-2
 * `kernel-rest` stream's; until it lands, this wrapper does the composition the same way that plugin
 * will — one encapsulated child under the API prefix, the instance's audit writer passed in — so
 * every suite here exercises the real routes, the real policy and the real chain. The wrapper is
 * `startServer`'s `buildApp` seam, so the harness, the schema, the port and the cookie jar are the
 * shared ones; nothing here is a second boot path. Once `buildApp` composes the auth routes itself,
 * the wrapper sees them in `app.routes()` and composes nothing, so the two never double-register.
 *
 * The clock is a `ManualClock`, which is what makes idle expiry, absolute expiry, the step-up window
 * and the ticket TTL drivable without sleeping. argon2 runs at the smallest parameters `EnvSchema`
 * accepts: these suites prove the flows, not the calibration, which `config.env.unit` and spike S13
 * hold to the production values.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { M1_ROUTES } from '@iridium/contracts';
import {
  startServer,
  workerSchemaName,
  type BuildApp,
  type RestClient,
  type RestRequestInit,
  type TestServer,
} from '@iridium/testkit';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { expect, inject } from 'vitest';

import { buildApp } from '../../src/app.ts';
import { applyAuthRoutes } from '../../src/auth/routes.ts';
import { API_PREFIX } from '../../src/authz/route-policy.ts';
import type { Database } from '../../src/db/index.ts';
import { ManualClock } from './manual-clock.ts';
import { registerRecordingOpenApiMatcher } from './openapi-coverage.ts';

// Every real response driven by these suites is checked against the public contract. Recording
// happens in the matcher only after the actual HTTP request, never from a manufactured fixture.
registerRecordingOpenApiMatcher();

/** What a suite gets: the harness server plus white-box access to the instance and its database. */
export interface AuthTestServer {
  readonly server: TestServer;
  readonly app: FastifyInstance;
  readonly clock: ManualClock;
  readonly db: Kysely<Database>;
  /** The public origin, which is also the `Origin` a web request sends past the CSRF guard. */
  readonly origin: string;
  /** Stops the server and removes the scratch directory. */
  stop(): Promise<void>;
}

/** The headers a cookie-authenticated browser request carries (04 section 4.4). */
export function webHeaders(origin: string): Readonly<Record<string, string>> {
  return { origin };
}

/** The path of the first auth route, which is how the wrapper knows the routes are composed. */
const FIRST_AUTH_ROUTE = `${API_PREFIX}/auth/sessions`;

/**
 * The cheapest argon2 parameters `EnvSchema` accepts (`ARGON2_MEMORY_KIB` floor 8 192, `ARGON2_TIME_COST`
 * floor 1), so a suite that signs in dozens of times is bounded by the database rather than by hashing.
 */
const FAST_ARGON2_ENV: Readonly<Record<string, string>> = Object.freeze({
  ARGON2_MEMORY_KIB: '8192',
  ARGON2_TIME_COST: '1',
});

/**
 * A fresh peer address, unique across a run.
 *
 * The global (60/min per IP) and login (10/min per IP) limiters key on `request.ip` and their
 * in-memory counters are **not** reset by the per-test table truncation, so a run that made many
 * unauthenticated requests from one address would eventually see spurious `429`s. The harness runs
 * behind a trusted proxy (`TRUST_PROXY=127.0.0.1`) and every client sends its own
 * `X-Forwarded-For`, so each test — and, within a test, each throttle probe that must share an
 * address — controls its own bucket. Authenticated requests key on the principal, not the address.
 */
let ipCounter = 0;
export function nextIp(): string {
  ipCounter += 1;
  return `203.0.${Math.floor(ipCounter / 254) % 254}.${(ipCounter % 254) + 1}`;
}

/** Wraps a client so every request carries `X-Forwarded-For: <ip>` (the address the limiter reads). */
function fromIp(client: RestClient, ip: string): RestClient {
  const withHeader = (init?: RestRequestInit): RestRequestInit => ({
    ...init,
    headers: { 'x-forwarded-for': ip, ...init?.headers },
  });
  return {
    origin: client.origin,
    basePath: client.basePath,
    jar: client.jar,
    client: client.client,
    bearer: client.bearer,
    request: (method, path, init) => client.request(method, path, withHeader(init)),
    api: (method, path, init) => client.api(method, path, withHeader(init)),
    get: (path, init) => client.get(path, withHeader(init)),
    post: (path, init) => client.post(path, withHeader(init)),
    put: (path, init) => client.put(path, withHeader(init)),
    patch: (path, init) => client.patch(path, withHeader(init)),
    del: (path, init) => client.del(path, withHeader(init)),
    as: (options) => fromIp(client.as(options), ip),
  };
}

/** A browser client for one profile: `X-Iridium-Client: web`, an optional jar, its own peer address. */
export function webClient(
  context: AuthTestServer,
  jar?: RestClient['jar'],
  ip: string = nextIp(),
): RestClient {
  return fromIp(
    context.server.rest(jar === undefined ? { client: 'web' } : { client: 'web', jar }),
    ip,
  );
}

/** A desktop-host client: `X-Iridium-Client: desktop`, no cookies, an optional bearer, its own peer address. */
export function desktopClient(
  context: AuthTestServer,
  bearer?: string,
  ip: string = nextIp(),
): RestClient {
  return fromIp(
    context.server.rest(
      bearer === undefined ? { client: 'desktop' } : { client: 'desktop', bearer },
    ),
    ip,
  );
}

export interface StartAuthServerOptions {
  /** Explicit degraded-boot probes inspect readiness themselves. */
  readonly waitForReady?: boolean;
  readonly clock?: ManualClock;
  readonly extraEnv?: Readonly<Record<string, string>>;
  /** Registered on the child under `/api/v1`, before the auth routes; for probe routes. */
  readonly extraRoutes?: (api: FastifyInstance) => void;
  /** Registered on the root instance, outside the API prefix; for probes of root-level policies. */
  readonly rootRoutes?: (app: FastifyInstance) => void;
}

/** Boots the server for one suite. The caller stops it in `afterAll`. */
export async function startAuthServer(
  options: StartAuthServerOptions = {},
): Promise<AuthTestServer> {
  const mysql = inject('iridiumMysql');
  // Start at wall time so the `clock_skew` readiness check (app clock vs MySQL NOW()) passes at boot;
  // suites advance this clock and read `context.clock.now()`, never a hard-coded instant.
  const clock = options.clock ?? new ManualClock(Date.now());
  const scratch = mkdtempSync(join(tmpdir(), 'iridium-auth-'));
  let captured: FastifyInstance | null = null;

  const build: BuildApp<FastifyInstance> = async (bootOptions): Promise<FastifyInstance> => {
    const app = await buildApp({ ...bootOptions, clock });
    options.rootRoutes?.(app);
    const composed = app.routes().some((route) => route.url === FIRST_AUTH_ROUTE);
    await app.register(
      async (api) => {
        options.extraRoutes?.(api);
        if (!composed) applyAuthRoutes(api, { audit: app.audit });
      },
      { prefix: API_PREFIX },
    );
    captured = app;
    return app;
  };

  const server = await startServer({
    mode: 'in-process',
    async onResponse(response, method): Promise<void> {
      const segments = new URL(response.url).pathname.split('/');
      const route = M1_ROUTES.find((candidate) => {
        if (candidate.method !== method) return false;
        const expected = `${candidate.mount}${candidate.path}`.split('/');
        return (
          expected.length === segments.length &&
          expected.every((segment, index) => segment.startsWith(':') || segment === segments[index])
        );
      });
      if (route !== undefined)
        await expect(response).toMatchOpenApi(route.operationId, response.status);
    },
    db: {
      host: mysql.host,
      port: mysql.port,
      schema: workerSchemaName(process.env['VITEST_WORKER_ID'] ?? '1'),
    },
    attachmentsDir: join(scratch, 'attachments'),
    buildApp: build,
    // Behind a trusted proxy so each client's `X-Forwarded-For` is the address the limiter reads.
    extraEnv: { TRUST_PROXY: '127.0.0.1', ...FAST_ARGON2_ENV, ...options.extraEnv },
  });
  try {
    if (options.waitForReady !== false) await server.waitReady({ timeoutMs: 30_000 });
  } catch (error) {
    try {
      await server.stop();
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
    throw error;
  }
  if (captured === null) throw new Error('buildApp did not run');
  const app: FastifyInstance = captured;
  const db = app.database.dbApp;
  if (db === null) throw new Error('the server booted without a database');

  return {
    server,
    app,
    clock,
    db,
    origin: server.origin,
    async stop(): Promise<void> {
      await server.stop();
      rmSync(scratch, { recursive: true, force: true });
    },
  };
}
