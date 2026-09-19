/**
 * Boot step 4, the `auth` plugin (02-system-architecture.md, "Boot sequence and plugin order";
 * 04-auth-and-access-control.md sections 3 to 7).
 *
 * It decorates `request.principal`, registers `authenticate()` as an instance-level `onRequest`
 * hook, and wires the credential services onto `app.auth`: argon2id hashing, the password policy
 * with its bundled breached list, the `RateLimiterMySQL` login throttle, session verification,
 * the single token verifier, the in-process `TicketStore` and the set-password links. The routes
 * that use them are `applyAuthRoutes` (composed by the `rest` plugin, step 7), and `authorize()`
 * with the bus and the epoch table are step 5 (`authz/route-policy.ts`).
 *
 * Everything the plugin needs is already on the instance from steps 1 and 2: the configuration,
 * the clock and the database handle. Nothing here reads `process.env`.
 */
import { randomFillSync } from 'node:crypto';

import { LIMITS, newId, SERVER_CHAIN_ID } from '@iridium/contracts';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';

import { parseDatabaseUrl, type Database } from '../db/index.ts';
import { ProblemError } from '../security/problem.ts';
import {
  DetachedAuditSink,
  FailureAuditGate,
  LOGIN_FAILED_AUDIT_WINDOW_MS,
  TOKEN_DENIED_AUDIT_WINDOW_MS,
} from './audit.ts';
import { createAuthenticateHook } from './authenticate.ts';
import { loadBlocklist } from './credentials/blocklist.ts';
import { PasswordHasher, PepperVersionMissingError } from './credentials/hasher.ts';
import { PepperStoreUnavailableError, PepperVersionSource } from './credentials/pepper-version.ts';
import { PASSWORD_MAX_CODE_POINTS, PasswordPolicy } from './credentials/policy.ts';
import { createMysqlLoginThrottle, type LoginThrottle } from './credentials/throttle.ts';
import { KyselySessionRepository, type SessionRepository } from './sessions/repository.ts';
import { sessionTtlsFromConfig, type SessionTtls } from './sessions/ttl.ts';
import { SessionVerifier, type VerifierSessionRepository } from './sessions/verify.ts';
import { SetPasswordLinks } from './setpw/service.ts';
import { WindowedBudget } from './tickets/ip-budget.ts';
import { InMemoryTicketStore, type TicketStore } from './tickets/store.ts';
import {
  KyselyTokenRepository,
  PrincipalTokenMissingError,
  TOKEN_AUTH_FAILURE_LABELS,
  TokenStoreUnavailableError,
  TokenVerifier,
} from './tokens/verify.ts';
import { truncateUserAgent } from './user-agent.ts';
import { PrincipalUserMissingError } from './users.ts';

/**
 * `ARGON2_CONCURRENCY` (D04-03), the in-process semaphore behind `UV_THREADPOOL_SIZE=8`. The
 * environment key is not in `EnvSchema` yet (the configuration module owns the key table); until
 * it is, the plan's default is the value.
 */
export const ARGON2_CONCURRENCY_DEFAULT = 4;

/** The ticket sweep interval of section 7.2. */
export const TICKET_SWEEP_INTERVAL_MS = 10_000;

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
/** The window the per-IP ticket budget is counted over (09 section 1.8: "per minute"). */
const TICKET_IP_WINDOW_MS = SECONDS_PER_MINUTE * MS_PER_SECOND;

/** What boot step 4 decorates the instance with. */
export interface AuthServices {
  readonly hasher: PasswordHasher;
  readonly policy: PasswordPolicy;
  readonly throttle: LoginThrottle;
  /** `schema_meta.pepper_version`, read per call; the promoted pepper is `currentPepper()`. */
  readonly pepperVersion: PepperVersionSource;
  readonly ttls: SessionTtls;
  /** `verifySession` and `loadLiveSession` over the app pool. */
  readonly sessions: SessionVerifier;
  /** A repository over one executor, for a caller that holds a transaction. */
  sessionRepository(db: Kysely<Database>): SessionRepository;
  readonly tokens: TokenVerifier;
  readonly tickets: TicketStore;
  /** `TICKETS_PER_MINUTE_PER_IP`, the second key of the ticket route (section 7.4). */
  readonly ticketIpBudget: WindowedBudget;
  /** `COLLAB_TICKET_TTL_S`, published as `expiresIn`. */
  readonly ticketTtlSeconds: number;
  readonly setpw: SetPasswordLinks;
  /** The detached writer for failure events; bound by `applyAuthRoutes`. */
  readonly sink: DetachedAuditSink;
  readonly loginFailureGate: FailureAuditGate;
  readonly tokenDeniedGate: FailureAuditGate;
  readonly newId: () => string;
  /** Entries in the bundled breached list, for `iridium doctor`. */
  readonly blocklistSize: number;
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Boot step 4: credentials, sessions, the token verifier, tickets and set-password links. */
    auth: AuthServices;
  }
}

/**
 * The verifier's repository, resolving `dbApp` per call so a verifier built at boot works once the
 * database connects. It carries exactly the four members verification uses; a caller that holds a
 * transaction builds its own through `app.auth.sessionRepository(trx)`.
 */
function lazySessionRepository(db: () => Kysely<Database> | null): VerifierSessionRepository {
  const resolve = (): SessionRepository => {
    const executor = db();
    if (executor === null) throw new SessionStoreUnavailableError();
    return new KyselySessionRepository(executor);
  };
  return {
    findByTokenId: (tokenId) => resolve().findByTokenId(tokenId),
    findById: (sessionId) => resolve().findById(sessionId),
    touch: (sessionId, lastSeenAt, idleExpiresAt) =>
      resolve().touch(sessionId, lastSeenAt, idleExpiresAt),
    revoke: (sessionId, revokedAt, reason) => resolve().revoke(sessionId, revokedAt, reason),
  };
}

/** Thrown when a session read arrives before the database connected; a `503`, never a `401`. */
export class SessionStoreUnavailableError extends Error {
  constructor() {
    super(
      'session verification needs dbApp, which is not connected; the request answers 503 ' +
        'not_ready or unavailable rather than 401 (02-system-architecture.md ARCH-02)',
    );
    this.name = 'SessionStoreUnavailableError';
  }
}

/** Applies boot step 4. */
export function applyAuthPlugin(app: FastifyInstance): void {
  const config = app.iridiumConfig;
  const db = (): Kysely<Database> | null => app.database.dbApp;
  const now = (): number => app.clock.now();

  const pepperVersion = new PepperVersionSource(db, config.keys.pepper.versions);
  const hasher = new PasswordHasher({
    memoryKib: config.auth.argon2MemoryKib,
    timeCost: config.auth.argon2TimeCost,
    concurrency: ARGON2_CONCURRENCY_DEFAULT,
    peppers: config.keys.pepper.versions,
    currentPepperVersion: () => pepperVersion.current(),
    fillRandom: (bytes) => {
      randomFillSync(bytes);
    },
  });
  const blocklist = loadBlocklist();
  const policy = new PasswordPolicy({
    minLength: config.auth.passwordMinLength,
    maxLength: PASSWORD_MAX_CODE_POINTS,
    blocklist,
    checkBreachedList: true,
  });
  const throttle = createMysqlLoginThrottle({
    db,
    schema: parseDatabaseUrl(config.db.appUrl).database,
    policy: {
      maxFailures: config.auth.loginThrottleMaxFailures,
      blockBaseSeconds: config.auth.loginThrottleBlockMinutes * SECONDS_PER_MINUTE,
      blockMaxSeconds: LIMITS.LOGIN_BLOCK_MAX_SECONDS,
      sourcePerDay: config.auth.loginThrottleIpPerDay,
    },
  });
  const ttls = sessionTtlsFromConfig(config.auth);
  const sessions = new SessionVerifier(lazySessionRepository(db), ttls, now);
  const tokens = new TokenVerifier(
    () => {
      const executor = db();
      return executor === null ? null : new KyselyTokenRepository(executor);
    },
    now,
    config.mcp.rateLimitPerHour,
  );
  const tickets = new InMemoryTicketStore({
    clock: app.clock,
    ttlMs: config.collab.ticketTtlSeconds * MS_PER_SECOND,
    sweepIntervalMs: TICKET_SWEEP_INTERVAL_MS,
  });
  const ticketIpBudget = new WindowedBudget({
    clock: app.clock,
    max: LIMITS.TICKETS_PER_MINUTE_PER_IP,
    windowMs: TICKET_IP_WINDOW_MS,
  });
  const setpw = new SetPasswordLinks({
    publicOrigin: config.server.publicOrigin,
    hasher,
    policy,
    now,
    newId,
  });
  const sink = new DetachedAuditSink(db);
  const loginFailureGate = new FailureAuditGate(LOGIN_FAILED_AUDIT_WINDOW_MS, now);
  const tokenDeniedGate = new FailureAuditGate(TOKEN_DENIED_AUDIT_WINDOW_MS, now);

  const services: AuthServices = {
    hasher,
    policy,
    throttle,
    pepperVersion,
    ttls,
    sessions,
    sessionRepository: (executor) => new KyselySessionRepository(executor),
    tokens,
    tickets,
    ticketIpBudget,
    ticketTtlSeconds: config.collab.ticketTtlSeconds,
    setpw,
    sink,
    loginFailureGate,
    tokenDeniedGate,
    newId,
    blocklistSize: blocklist.size,
  };
  app.decorate('auth', services);
  app.decorateRequest('principal', null);

  // A verification that cannot read its row is a 503, never a 401 (D06-15): an outage must not tell
  // every client that its credential is invalid.
  app.problems.register('auth', (error) => {
    if (
      error instanceof TokenStoreUnavailableError ||
      error instanceof SessionStoreUnavailableError ||
      error instanceof PepperStoreUnavailableError
    ) {
      return new ProblemError('unavailable', { detail: 'The database is not connected.' });
    }
    if (error instanceof PepperVersionMissingError) {
      return new ProblemError('unavailable', { detail: error.message });
    }
    // A principal whose row is gone is refused as any unknown credential is (09 section 1.5).
    if (error instanceof PrincipalUserMissingError || error instanceof PrincipalTokenMissingError) {
      return new ProblemError('unauthenticated');
    }
    return null;
  });

  app.addHook(
    'onRequest',
    createAuthenticateHook({
      sessions,
      tokens,
      resources: {
        mcp: `${config.server.publicOrigin.origin}/mcp`,
        mcpConnect: config.oauth.resource,
      },
      countTokenFailure: (reason) => {
        app.metrics.tokenAuthFailuresTotal.inc({ reason: TOKEN_AUTH_FAILURE_LABELS[reason] });
      },
      onTokenDenied: async (request, denial) => {
        // A denial names a real row by construction (steps 4–9), so the only question is the
        // per-row bound of D04-16.
        if (!tokenDeniedGate.shouldWrite(denial.tokenRowId)) return;
        await sink.record({
          action: 'token.denied',
          chainId: SERVER_CHAIN_ID,
          actorType: 'token',
          actorId: denial.tokenRowId,
          onBehalfOfUserId: denial.ownerUserId,
          credentialType: denial.tokenKind,
          credentialId: denial.tokenRowId,
          outcome: 'failure',
          reason: denial.reason,
          context: {
            ip: request.ip,
            user_agent: truncateUserAgent(request.headers['user-agent']),
            request_id: request.requestId,
            client: request.iridiumClient,
          },
          metadata: { reason: denial.reason, surface: 'rest' },
        });
      },
    }),
  );

  // The dummy hash for timing equalisation exists before the first login (section 3.5). The
  // promoted pepper version is checked against the keyring as soon as a database is reachable
  // (D04-05): boot proceeds without one (ARCH-02), so a mismatch is an `error`-level line here, a
  // `503` on every password operation, and the `key_versions` readiness check — never a wrong hash.
  app.addHook('onReady', async () => {
    await hasher.prime();
    if (db() !== null) {
      try {
        await pepperVersion.current();
      } catch (error) {
        app.log.error(
          { err: error, event: 'readyz.degraded', check: 'key_versions' },
          'schema_meta.pepper_version is not usable with the configured AUTH_PASSWORD_PEPPER keyring; ' +
            'password operations answer 503 until it is',
        );
      }
    }
    // The ticket store is the third bus subscriber (section 8.3): after the reconciler (step 5)
    // and the gateway (step 9), which is why this waits for every plugin to have registered.
    app.authz.bus.subscribe((event) => {
      if (event.type === 'session.revoked') tickets.revokeSession(event.sessionId);
      else if (event.type === 'user.disabled') tickets.revokeUser(event.userId);
      else if (event.type === 'user.password_changed')
        tickets.revokeUser(event.userId, event.keepSessionId);
    });
  });

  app.addHook('onClose', async () => {
    tickets.close();
    ticketIpBudget.close();
  });
}
