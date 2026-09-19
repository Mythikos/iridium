/** Auth handler units boot the product once, replacing only database and audit transports. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type SessionId } from '@iridium/contracts';
import type { FastifyInstance } from 'fastify';
import { onTestFinished } from 'vitest';

import { buildApp } from '../../src/app.ts';
import { SESSION_COOKIE_NAME } from '../../src/auth/sessions/cookie.ts';
import type { IssuedSession } from '../../src/auth/sessions/issuer.ts';
import { loadConfig } from '../../src/config/env.ts';
import {
  authFlowFixture,
  FLOW_PASSWORD,
  FLOW_PEPPER,
  type AuthFlowFixture,
  type AuthFlowFixtureOptions,
} from './auth-flow-fixture.ts';
import { NO_DATABASE_HOST, NO_DATABASE_ORIGIN } from './no-database-app.ts';

/** Product route fixture with real authentication and test-owned I/O (09 section 2.1). @internal */
export interface AuthRouteFixture extends AuthFlowFixture {
  readonly app: FastifyInstance;
  readonly desktop: Readonly<Record<string, string>>;
  readonly web: Readonly<Record<string, string>>;
  readonly authenticate: (
    kind?: 'web' | 'desktop',
    sessionId?: SessionId,
  ) => Promise<{
    readonly issued: IssuedSession;
    readonly headers: Readonly<Record<string, string | undefined>>;
  }>;
}

/**
 * Boots the one product route composition while substituting SQL/audit transports, so authentication
 * hooks and wire serialization remain under test (ARCH-02; 09 section 2.1). Cleanup belongs to the
 * calling test through its completion hook.
 * @internal
 */
export async function authRouteFixture(
  options: AuthFlowFixtureOptions,
  configureTransports: (app: FastifyInstance, flow: AuthFlowFixture) => void,
): Promise<AuthRouteFixture> {
  const flow = await authFlowFixture(options);
  const scratch = mkdtempSync(join(tmpdir(), 'iridium-auth-route-'));
  const app = await buildApp({
    mode: 'in-process',
    database: 'none',
    clock: flow.clock,
    config: loadConfig({
      NODE_ENV: 'test',
      PUBLIC_ORIGIN: NO_DATABASE_ORIGIN,
      DATABASE_URL: 'mysql://iridium_app:pw@127.0.0.1:3306/iridium',
      ATTACHMENTS_DIR: join(scratch, 'attachments'),
      LOG_LEVEL: 'fatal',
      AUTH_PASSWORD_PEPPER_V1: Buffer.from(FLOW_PEPPER).toString('base64'),
      ARGON2_MEMORY_KIB: '8192',
      ARGON2_TIME_COST: '1',
    }),
  });
  onTestFinished(async () => {
    await app.close();
    rmSync(scratch, { recursive: true, force: true });
  });
  await app.ready();
  // No alternate route composition or fabricated principal: the actual auth hook still verifies
  // the presented secret and reads the session row. Its I/O port uses a real Kysely compiler.
  configureTransports(app, flow);
  // Seed through the app's actual keyring parser and native hasher, not a differently configured
  // service. The fixture helper's separate unit hasher deliberately receives decoded test bytes.
  const credential = await app.auth.hasher.hash(FLOW_PASSWORD);
  Object.assign(flow.state.tables.user_credentials[0] ?? {}, {
    password_hash: credential.phc,
    pepper_version: credential.pepperVersion,
  });
  // This is the same LoginThrottle implementation with its supported in-memory storage port.
  Object.assign(app.auth, { throttle: flow.deps.throttle });
  app.authz.bus.subscribe((event) => {
    flow.trace.push('published:' + event.type);
    flow.events.push(event);
  });
  const desktop = { host: NO_DATABASE_HOST, 'x-iridium-client': 'desktop' };
  const web = { host: NO_DATABASE_HOST, 'x-iridium-client': 'web', origin: NO_DATABASE_ORIGIN };
  async function authenticate(kind: 'web' | 'desktop' = 'desktop', sessionId?: SessionId) {
    const issued = await flow.seedSession(kind, sessionId);
    return {
      issued,
      headers:
        kind === 'web'
          ? { ...web, cookie: SESSION_COOKIE_NAME + '=' + issued.raw }
          : { ...desktop, authorization: 'Bearer ' + issued.raw },
    };
  }
  flow.resetObservations();
  return { ...flow, app, desktop, web, authenticate };
}
