/**
 * The password flows (04-auth-and-access-control.md sections 3.3, 3.5, 3.7, 3.8, 4.6 and 11.2).
 *
 * One login path for both clients — steps 4 to 10 of section 3.7 — plus re-authentication, the
 * self password change and the consumption of a set-password link. Each flow returns a
 * discriminated outcome; the route turns it into a response and sets the cookie. The admission
 * barrier publishes its events after COMMIT before the successful outcome returns (section 8.3).
 *
 * Every audit row of these flows is written inside the transaction that made the change; the one
 * failure event, `user.login.failed`, has no change and is written detached and bounded (D04-16).
 */
import { SERVER_CHAIN_ID, type SessionId, type UserId } from '@iridium/contracts';
import type { FastifyBaseLogger } from 'fastify';
import { sql, type Kysely, type Transaction } from 'kysely';

import type { AuthzEvent } from '../authz/bus.ts';
import type { AuthzMutationRunner } from '../authz/mutations.ts';
import type { OwnerFence } from '../collab/owner-lease.ts';
import type { Database } from '../db/index.ts';
import type { SessionKind } from '../db/schema.ts';
import {
  emailKeyAuditHash,
  type AuditEventContext,
  type AuditRecorder,
  type DetachedAuditSink,
  type FailureAuditGate,
} from './audit.ts';
import type { PasswordHasher } from './credentials/hasher.ts';
import { needsRehash } from './credentials/phc.ts';
import {
  normalizePassword,
  type PasswordPolicy,
  type PasswordRuleId,
} from './credentials/policy.ts';
import type { LoginThrottle } from './credentials/throttle.ts';
import { idBytes, userIdFromBytes } from './ids.ts';
import { issueSession, type IssuedSession } from './sessions/issuer.ts';
import { KyselySessionRepository } from './sessions/repository.ts';
import { revokeUserSessions } from './sessions/revoke.ts';
import { stepUpExpiresAt } from './sessions/stepup.ts';
import type { SessionTtls } from './sessions/ttl.ts';
import type { SetPasswordLinks } from './setpw/service.ts';
import { loadUserByEmail, requireUserRow, type UserWithCredential } from './users.ts';

/** What every flow needs. Assembled by the routes from `app.auth` and the composer's writer. */
export interface PasswordFlowDeps {
  readonly db: Kysely<Database>;
  readonly mutations: AuthzMutationRunner;
  readonly ownerFence: OwnerFence;
  readonly hasher: PasswordHasher;
  readonly policy: PasswordPolicy;
  readonly throttle: LoginThrottle;
  readonly ttls: SessionTtls;
  readonly setpw: SetPasswordLinks;
  readonly audit: AuditRecorder;
  readonly sink: DetachedAuditSink;
  readonly loginFailureGate: FailureAuditGate;
  readonly now: () => number;
  readonly newId: () => string;
  readonly log: FastifyBaseLogger;
  /** `iridium_login_failures_total{reason}` (`ops/metrics.ts` owns the reason vocabulary). */
  readonly countLoginFailure: (reason: LoginFailureMetricReason) => void;
  /** The promoted pepper, read now: the salt of the audited email hash (D04-17). */
  readonly currentPepper: () => Promise<Uint8Array>;
}

/** The request half of `POST /auth/sessions` the route hands the flow. */
export interface LoginInput {
  readonly email: string;
  readonly password: string;
  readonly client: SessionKind;
  readonly deviceName: string | null;
  readonly ip: string;
  /** The `User-Agent` header as received; absent on a client that sends none. */
  readonly userAgent: string | undefined;
  readonly clientVersion: string | null;
  readonly context: AuditEventContext;
}

/** What a login answers. `invalid` is one answer for every wrong credential (section 3.7). */
export type LoginOutcome =
  | { readonly kind: 'throttled'; readonly retryAfterMs: number }
  | { readonly kind: 'invalid' }
  | {
      readonly kind: 'ok';
      readonly user: UserWithCredential;
      readonly session: IssuedSession;
      /** Events already delivered after COMMIT (`session.revoked` for each replaced session). */
      readonly events: readonly AuthzEvent[];
    };

/** An active user whose credential row exists: the only row a real verification runs against. */
export type UserWithLiveCredential = UserWithCredential & {
  readonly password_hash: string;
  readonly pepper_version: number;
};

/**
 * Which argon2 work a presented password gets (section 3.7 step 6). A pure function of the row, so
 * `auth.login-timing.unit` can assert that an unknown email, a disabled user and a user without a
 * credential all take the dummy path — one real `verify()`, result discarded — and only a live
 * credential takes the real one.
 */
export type VerificationPlan =
  | { readonly kind: 'credential'; readonly user: UserWithLiveCredential }
  | { readonly kind: 'dummy' };

/** The plan for a row (or its absence). */
export function verificationPlan(user: UserWithCredential | null): VerificationPlan {
  if (
    user === null ||
    user.status !== 'active' ||
    user.password_hash === null ||
    user.pepper_version === null
  ) {
    return { kind: 'dummy' };
  }
  return {
    kind: 'credential',
    user: { ...user, password_hash: user.password_hash, pepper_version: user.pepper_version },
  };
}

/** The one logger method `runVerification` needs: the malformed-credential line of section 3.5. */
export type MalformedCredentialLog = Pick<FastifyBaseLogger, 'error'>;

/**
 * Runs the plan: exactly one `verify()` either way, and the dummy's result is always `false`. A
 * stored string the binding cannot parse is a mismatch to the caller and an `error`-level line
 * carrying the user id only (section 3.5).
 */
export async function runVerification(
  hasher: PasswordHasher,
  plan: VerificationPlan,
  normalizedPassword: string,
  log: MalformedCredentialLog,
): Promise<boolean> {
  if (plan.kind === 'dummy') {
    await hasher.verifyDummy(normalizedPassword);
    return false;
  }
  const outcome = await hasher.verify(
    plan.user.password_hash,
    normalizedPassword,
    plan.user.pepper_version,
  );
  if (outcome === 'malformed') {
    log.error(
      { event: 'auth.credential.malformed', userId: userIdFromBytes(plan.user.id) },
      'stored password hash is not a parseable PHC string',
    );
  }
  return outcome === 'match';
}

/** Why a login failed, as `user.login.failed` records it (section 11.2). */
type LoginFailureReason = 'invalid_credentials' | 'user_disabled' | 'no_credential' | 'blocked';

/** The `iridium_login_failures_total{reason}` vocabulary of `ops/metrics.ts`. */
export type LoginFailureMetricReason = 'unknown_user' | 'bad_password' | 'disabled' | 'throttled';

/** The metric label for an audit reason. */
function metricReasonOf(user: UserWithCredential | null): LoginFailureMetricReason {
  if (user === null) return 'unknown_user';
  if (user.status !== 'active') return 'disabled';
  return 'bad_password';
}

async function auditLoginFailure(
  deps: PasswordFlowDeps,
  input: LoginInput,
  user: UserWithCredential | null,
  reason: LoginFailureReason,
  attemptsInWindow: number,
  blockedForMs: number | null,
): Promise<void> {
  const key = `${input.email.toLowerCase()}|${input.ip}`;
  if (!deps.loginFailureGate.shouldWrite(key, blockedForMs !== null)) return;
  const emailKeyHash = emailKeyAuditHash(input.email.toLowerCase(), await deps.currentPepper());
  await deps.sink.record({
    action: 'user.login.failed',
    chainId: SERVER_CHAIN_ID,
    actorType: 'user',
    actorId: user === null ? null : userIdFromBytes(user.id),
    actorDisplay: user === null ? null : user.email,
    credentialType: 'none',
    credentialId: null,
    outcome: 'failure',
    reason,
    context: input.context,
    metadata: {
      reason,
      emailKeyHash,
      attemptsInWindow,
      ...(blockedForMs === null
        ? {}
        : { blockedUntil: new Date(deps.now() + blockedForMs).toISOString() }),
    },
  });
}

/**
 * Password verification is expensive and happens without locks. Before committing its authority,
 * lock the parent account and recheck the exact verified credential. Reset, disable, link consume,
 * and other password operations take that same lock before their credential/session writes.
 */
async function lockVerifiedCredential(
  trx: Transaction<Database>,
  verified: UserWithCredential,
  actorSession?: SessionId,
): Promise<boolean> {
  const user = await trx
    .selectFrom('users')
    .select('status')
    .where('id', '=', verified.id)
    .forUpdate()
    .executeTakeFirst();
  if (user?.status !== 'active') return false;
  const credential = await trx
    .selectFrom('user_credentials')
    .select(['password_hash', 'pepper_version'])
    .where('user_id', '=', verified.id)
    .forUpdate()
    .executeTakeFirst();
  if (
    credential === undefined ||
    credential.password_hash !== verified.password_hash ||
    credential.pepper_version !== verified.pepper_version
  )
    return false;
  if (actorSession === undefined) return true;
  const session = await trx
    .selectFrom('sessions')
    .select('revoked_at')
    .where('id', '=', idBytes(actorSession))
    .where('user_id', '=', verified.id)
    .forUpdate()
    .executeTakeFirst();
  return session !== undefined && session.revoked_at === null;
}
/** Steps 4–10 of section 3.7. */
export async function login(deps: PasswordFlowDeps, input: LoginInput): Promise<LoginOutcome> {
  const emailKey = input.email.toLowerCase();

  // 4. the two throttle budgets, before any password work
  const verdict = await deps.throttle.check(emailKey, input.ip);
  if (!verdict.allowed) {
    deps.countLoginFailure('throttled');
    deps.log.warn({ event: 'auth.login.throttled', scope: verdict.scope }, 'login throttled');
    return { kind: 'throttled', retryAfterMs: verdict.retryAfterMs };
  }

  // 5–6. the row, and one argon2 verification whether or not it exists
  const user = await loadUserByEmail(deps.db, input.email);
  const normalized = normalizePassword(input.password);
  const plan = verificationPlan(user);
  const ok = await runVerification(deps.hasher, plan, normalized, deps.log);

  // 7. failure: consume the budgets, block when limiter A is exhausted, audit (bounded), count
  if (!ok || plan.kind === 'dummy') {
    const record = await deps.throttle.recordFailure(emailKey, input.ip);
    const reason: LoginFailureReason =
      user === null
        ? 'invalid_credentials'
        : user.status !== 'active'
          ? 'user_disabled'
          : user.password_hash === null
            ? 'no_credential'
            : record.blockedForMs === null
              ? 'invalid_credentials'
              : 'blocked';
    deps.countLoginFailure(metricReasonOf(user));
    deps.log.warn(
      { event: 'auth.login.failed', reason, blocked: record.blockedForMs !== null, ip: input.ip },
      'login failed',
    );
    await auditLoginFailure(
      deps,
      input,
      user,
      reason,
      record.attemptsInWindow,
      record.blockedForMs,
    );
    return { kind: 'invalid' };
  }
  const live = plan.user;

  // The promoted pepper version is read before anything is written: a promoted version the keyring
  // lacks (section 3.6) refuses the login as `503` with no session row, rather than committing a
  // session and then failing the re-hash.
  const rehashPolicy = await deps.hasher.rehashPolicy();

  // 8. success clears limiter A and the block counter
  await deps.throttle.recordSuccess(emailKey, input.ip);

  // 9. the session, `last_login_at` and the audit row, in one transaction
  const nowMs = deps.now();
  const userId = userIdFromBytes(live.id);
  const events: AuthzEvent[] = [];
  const session = await deps.mutations.run(
    { userId, isolation: 'repeatable read' },
    async (trx) => {
      if (!(await lockVerifiedCredential(trx, live))) return null;
      const issued = await issueSession(
        new KyselySessionRepository(trx),
        deps.ttls,
        nowMs,
        deps.newId,
        {
          userId,
          kind: input.client,
          ip: input.ip,
          userAgent: input.userAgent,
          deviceName: input.deviceName,
          clientVersion: input.clientVersion,
          method: 'password',
        },
      );
      await trx
        .updateTable('users')
        .set({ last_login_at: new Date(nowMs) })
        .where('id', '=', idBytes(userId))
        .execute();
      await deps.audit.record(trx, {
        action: 'user.login.succeeded',
        chainId: SERVER_CHAIN_ID,
        actorType: 'user',
        actorId: userId,
        actorDisplay: live.email,
        credentialType: 'session',
        credentialId: issued.sessionId,
        outcome: 'success',
        context: input.context,
        metadata: {
          kind: input.client,
          method: 'password',
          ...(input.deviceName === null ? {} : { deviceName: input.deviceName }),
          ...(input.clientVersion === null ? {} : { clientVersion: input.clientVersion }),
        },
      });
      events.push(
        ...issued.replaced.map((sessionId): AuthzEvent => ({
          type: 'session.revoked',
          userId,
          sessionId,
          reason: 'replaced',
        })),
      );
      return issued;
    },
    () => events,
  );

  if (session === null) return { kind: 'invalid' };

  // the transparent re-hash, after the session is issued, logged and never audited (section 3.5)
  if (needsRehash(live.password_hash, live.pepper_version, rehashPolicy)) {
    await rehashCredential(deps, live, normalized);
  }

  deps.log.info({ event: 'auth.login.succeeded', kind: input.client, userId }, 'login');

  return { kind: 'ok', user: live, session, events };
}

/**
 * The re-hash of section 3.5. The `WHERE` on the old hash makes concurrent logins idempotent: the
 * second one matches no row and changes nothing.
 */
async function rehashCredential(
  deps: PasswordFlowDeps,
  user: UserWithLiveCredential,
  normalized: string,
): Promise<void> {
  const hashed = await deps.hasher.hash(normalized);
  const result = await deps.db
    .updateTable('user_credentials')
    .set({ password_hash: hashed.phc, pepper_version: hashed.pepperVersion })
    .where('user_id', '=', user.id)
    .where('password_hash', '=', user.password_hash)
    .executeTakeFirst();
  deps.log.info(
    {
      event: 'auth.credential.rehashed',
      userId: userIdFromBytes(user.id),
      pepperVersion: hashed.pepperVersion,
      applied: result.numUpdatedRows === 1n,
    },
    'credential re-hashed',
  );
}

/** What `POST /auth/reauthenticate` and `POST /me/password` share: the caller's session. */
export interface SessionActor {
  readonly userId: UserId;
  readonly sessionId: SessionId;
  readonly ip: string;
  readonly context: AuditEventContext;
}

/** What re-authentication answers. */
export type ReauthenticateOutcome =
  | { readonly kind: 'throttled'; readonly retryAfterMs: number }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'ok'; readonly lastAuthenticatedAt: Date; readonly stepUpExpiresAt: Date };

/**
 * Verifies the caller's password against limiter A (a stolen session must not become an offline
 * password oracle, D04-07). Answers the user row on success so the callers can continue.
 */
async function verifyCurrentPassword(
  deps: PasswordFlowDeps,
  actor: SessionActor,
  password: string,
  failureEvent: 'auth.reauth.failed',
): Promise<
  | { readonly kind: 'throttled'; readonly retryAfterMs: number }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'ok'; readonly user: UserWithCredential; readonly normalized: string }
> {
  const user = await requireUserRow(deps.db, actor.userId);
  const verdict = await deps.throttle.check(user.email_key, actor.ip);
  if (!verdict.allowed) {
    deps.countLoginFailure('throttled');
    return { kind: 'throttled', retryAfterMs: verdict.retryAfterMs };
  }
  const normalized = normalizePassword(password);
  const ok = await runVerification(deps.hasher, verificationPlan(user), normalized, deps.log);
  if (!ok) {
    await deps.throttle.recordFailure(user.email_key, actor.ip);
    deps.countLoginFailure('bad_password');
    deps.log.warn({ event: failureEvent, userId: actor.userId }, 'wrong password');
    return { kind: 'invalid' };
  }
  return { kind: 'ok', user, normalized };
}

/** `POST /auth/reauthenticate` (section 4.6). */
export async function reauthenticate(
  deps: PasswordFlowDeps,
  actor: SessionActor,
  password: string,
): Promise<ReauthenticateOutcome> {
  const verified = await verifyCurrentPassword(deps, actor, password, 'auth.reauth.failed');
  if (verified.kind !== 'ok') return verified;
  const nowMs = deps.now();
  const at = new Date(nowMs);
  const accepted = await deps.db.transaction().execute(async (trx) => {
    await deps.ownerFence.assertCurrent(trx);
    if (!(await lockVerifiedCredential(trx, verified.user, actor.sessionId))) return false;
    await new KyselySessionRepository(trx).markAuthenticated(actor.sessionId, at);
    await deps.audit.record(trx, {
      action: 'user.reauth.succeeded',
      chainId: SERVER_CHAIN_ID,
      actorType: 'user',
      actorId: actor.userId,
      actorDisplay: verified.user.email,
      credentialType: 'session',
      credentialId: actor.sessionId,
      outcome: 'success',
      context: actor.context,
      metadata: {},
    });
    return true;
  });
  if (!accepted) return { kind: 'invalid' };
  deps.log.info({ event: 'auth.reauth.succeeded', userId: actor.userId }, 'reauthenticated');
  return {
    kind: 'ok',
    lastAuthenticatedAt: at,
    stepUpExpiresAt: stepUpExpiresAt(at, deps.ttls.stepUpWindowMs),
  };
}

/** What a password change answers. */
export type ChangePasswordOutcome =
  | { readonly kind: 'throttled'; readonly retryAfterMs: number }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'policy'; readonly violations: readonly PasswordRuleId[] }
  | { readonly kind: 'ok'; readonly events: readonly AuthzEvent[] };

/** `POST /me/password` (section 3.8): verify, policy, hash, revoke the other sessions, bump, audit. */
export async function changePassword(
  deps: PasswordFlowDeps,
  actor: SessionActor,
  currentPassword: string,
  newPassword: string,
): Promise<ChangePasswordOutcome> {
  const verified = await verifyCurrentPassword(deps, actor, currentPassword, 'auth.reauth.failed');
  if (verified.kind !== 'ok') return verified;
  const checked = deps.policy.check(newPassword, { email: verified.user.email });
  if (!checked.ok) return { kind: 'policy', violations: checked.violations };

  const hashed = await deps.hasher.hash(checked.normalized);
  const nowMs = deps.now();
  const now = new Date(nowMs);
  const events: AuthzEvent[] = [];
  const revoked = await deps.mutations.run(
    { userId: actor.userId, isolation: 'repeatable read' },
    async (trx) => {
      if (!(await lockVerifiedCredential(trx, verified.user, actor.sessionId))) return null;
      await trx
        .insertInto('user_credentials')
        .values({
          user_id: idBytes(actor.userId),
          password_hash: hashed.phc,
          pepper_version: hashed.pepperVersion,
          password_changed_at: now,
        })
        .onDuplicateKeyUpdate({
          password_hash: hashed.phc,
          pepper_version: hashed.pepperVersion,
          password_changed_at: now,
        })
        .execute();
      const others = await revokeUserSessions(
        new KyselySessionRepository(trx),
        actor.userId,
        'password_change',
        nowMs,
        actor.sessionId,
      );
      await trx
        .updateTable('users')
        .set({ authz_version: sql`authz_version + 1`, updated_at: now })
        .where('id', '=', idBytes(actor.userId))
        .execute();
      await deps.audit.record(trx, {
        action: 'user.password.changed',
        chainId: SERVER_CHAIN_ID,
        actorType: 'user',
        actorId: actor.userId,
        actorDisplay: verified.user.email,
        credentialType: 'session',
        credentialId: actor.sessionId,
        outcome: 'success',
        context: actor.context,
        metadata: { revokedSessionCount: others.length },
      });
      events.push(
        { type: 'user.password_changed', userId: actor.userId, keepSessionId: actor.sessionId },
        ...others.map((sessionId): AuthzEvent => ({
          type: 'session.revoked',
          userId: actor.userId,
          sessionId,
          reason: 'password_change',
        })),
      );
      return others;
    },
    () => events,
  );
  if (revoked === null) return { kind: 'invalid' };
  return { kind: 'ok', events };
}

/** What consuming a link answers. */
export type SetPasswordOutcome =
  | { readonly kind: 'throttled'; readonly retryAfterMs: number }
  | { readonly kind: 'invalid_link' }
  | { readonly kind: 'policy'; readonly violations: readonly PasswordRuleId[] }
  | { readonly kind: 'ok'; readonly userId: UserId; readonly events: readonly AuthzEvent[] };

/**
 * `POST /auth/set-password` (section 3.3; D04-20). Link redemption is throttled on the link id
 * (`spl:<token_id>|<ip>`, limiter A) so the id space is uninteresting to probe; the user's sessions
 * are revoked with the credential write (09 section 2.1) and PATs are untouched (A28).
 */
export async function setPassword(
  deps: PasswordFlowDeps,
  input: {
    readonly token: string;
    readonly password: string;
    readonly ip: string;
    readonly context: AuditEventContext;
  },
): Promise<SetPasswordOutcome> {
  const tokenId = input.token.slice('irid_spl_'.length, 'irid_spl_'.length + 16);
  const throttleKey = `spl:${tokenId}`;
  const verdict = await deps.throttle.check(throttleKey, input.ip);
  if (!verdict.allowed) return { kind: 'throttled', retryAfterMs: verdict.retryAfterMs };

  const recipient = await deps.setpw.recipient(deps.db, input.token);
  if (recipient === null) {
    await deps.throttle.recordFailure(throttleKey, input.ip);
    return { kind: 'invalid_link' };
  }
  const nowMs = deps.now();
  const events: AuthzEvent[] = [];
  const outcome = await deps.mutations.run(
    { userId: recipient, isolation: 'repeatable read' },
    async (trx) => {
      const consumed = await deps.setpw.consume(trx, {
        token: input.token,
        password: input.password,
      });
      if (!consumed.ok) return consumed;
      const revoked = await revokeUserSessions(
        new KyselySessionRepository(trx),
        consumed.userId,
        'password_change',
        nowMs,
      );
      await deps.audit.record(trx, {
        action: 'user.password.set',
        chainId: SERVER_CHAIN_ID,
        actorType: 'user',
        actorId: consumed.userId,
        credentialType: 'setpw',
        credentialId: consumed.tokenRowId,
        outcome: 'success',
        context: input.context,
        metadata: { purpose: consumed.purpose },
      });
      events.push(
        { type: 'user.password_changed', userId: consumed.userId },
        ...revoked.map((sessionId): AuthzEvent => ({
          type: 'session.revoked',
          userId: consumed.userId,
          sessionId,
          reason: 'password_change',
        })),
      );
      return consumed;
    },
    () => events,
  );

  if (!outcome.ok) {
    if (outcome.failure === 'invalid_link') {
      await deps.throttle.recordFailure(throttleKey, input.ip);
      return { kind: 'invalid_link' };
    }
    return { kind: 'policy', violations: outcome.violations };
  }
  deps.log.info(
    { event: 'auth.setpw.consumed', userId: outcome.userId, purpose: outcome.purpose },
    'set-password link consumed',
  );
  return {
    kind: 'ok',
    userId: outcome.userId,
    events,
  };
}
