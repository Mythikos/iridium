/**
 * `applyAuthRoutes(app, deps)` — the M1 auth routes (09-api-reference.md sections 2.1 and 2.3;
 * 04-auth-and-access-control.md sections 3.7, 3.8, 4.3, 4.6, 4.7 and 7.2).
 *
 * The `rest` plugin composes this under the `/api/v1` prefix and passes the instance's audit
 * writer. Every route is one row of `M1_ROUTES` (`@iridium/contracts`): the path, the policy and
 * the schemas are read from the row through `routeSpec()`, so a route cannot be registered with a
 * policy or a body the document does not describe, and `auth.routes.manifest.unit` asserts that
 * every registration below is its row. Every route audits inside the transaction that made the
 * change, publishes its `AuthzBus` events after COMMIT, and maps every refusal to the problem codes
 * of 09 section 1.5 by throwing a `ProblemError`.
 *
 * The login-tier rate limit (10/min per IP, 09 section 1.8) is `LOGIN_RATE_LIMIT` of
 * `security/rate-limits.ts`, spread into the three credential-presenting routes; the ticket route
 * carries its two budgets (300/min per session, 1 000/min per IP) as the same plugin's per-route
 * override plus a second bucket in `preHandler`.
 */
import {
  ChangePasswordBody,
  CollabTicketsCreated,
  CreateCollabTicketsBody,
  CreateSessionBody,
  LIMITS,
  Me,
  parseStrongEtag,
  Reauthenticated,
  ReauthenticateBody,
  SERVER_CHAIN_ID,
  SessionCreated,
  SessionIdParams,
  SessionList,
  SetPasswordBody,
  strongEtag,
  UpdateMeBody,
  User,
  type Me as MeDto,
  type RouteSpec,
  SessionId,
  type UserPrincipal,
} from '@iridium/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';

import { authzMutations } from '../authz/mutations.ts';
import type { Database } from '../db/index.ts';
import {
  auditContext,
  requireConnected,
  requirePrincipal,
  requireUserPrincipal,
  routeSpec as manifestRow,
} from '../rest/handler-context.ts';
import { requestOwnerFence } from '../rest/ownership.ts';
import { ProblemError } from '../security/problem.ts';
import { LOGIN_RATE_LIMIT, RATE_LIMIT_WINDOW, rateLimitProblem } from '../security/rate-limits.ts';
import type { AuditRecorder } from './audit.ts';
import { idBytes } from './ids.ts';
import {
  changePassword,
  login,
  reauthenticate,
  setPassword,
  type PasswordFlowDeps,
} from './login.ts';
import {
  clearedSessionCookieOptions,
  LOGOUT_CLEAR_SITE_DATA,
  SESSION_COOKIE_NAME,
  sessionCookieOptions,
} from './sessions/cookie.ts';
import { toSessionDto } from './sessions/dto.ts';
import { revokeOwnSession } from './sessions/revoke.ts';
import { requireTokenRow } from './tokens/verify.ts';
import { requireUserRow, toUserDto } from './users.ts';

/** What the composer passes: the instance's audit writer (boot step 6). */
export interface AuthRouteDeps {
  readonly audit: AuditRecorder;
}

/** The operation ids this module registers, in registration order. */
export const AUTH_OPERATION_IDS = [
  'auth.createSession',
  'auth.deleteCurrentSession',
  'auth.reauthenticate',
  'auth.setPassword',
  'auth.createCollabTickets',
  'auth.me',
  'me.sessions.list',
  'me.sessions.revoke',
  'me.update',
  'me.changePassword',
] as const;

/** An operation id of this module. */
export type AuthOperationId = (typeof AUTH_OPERATION_IDS)[number];

const HTTP_OK = 200;
const HTTP_CREATED = 201;
const HTTP_NO_CONTENT = 204;
const MS_PER_SECOND = 1000;

/** The manifest row for one of this module's operations: the shared lookup, narrowed to its ids. */
export function routeSpec(operationId: AuthOperationId): RouteSpec {
  return manifestRow(operationId);
}

/**
 * The response declaration of a `204`: documented, and documented as carrying nothing, so the
 * document says what the route sends and `@fastify/swagger` invents no `200` for it. A `null`
 * schema is the one shape the document renders without a `content` member; the route sends no
 * payload, so the serializer never runs.
 */
const NO_CONTENT_RESPONSE = { [HTTP_NO_CONTENT]: z.null().describe('No content') } as const;

/**
 * The OpenAPI identity of a registration, from its row: the operation id the document and the
 * `toMatchOpenApi` matcher locate it by, its tag and its one-line summary (09 section 1.2).
 */
function documentedBy(spec: RouteSpec): {
  readonly operationId: string;
  readonly tags: readonly string[];
  readonly summary: string;
} {
  return { operationId: spec.operationId, tags: [spec.tag], summary: spec.summary };
}

/**
 * The per-session ticket budget's key (09 section 1.8): the principal the auth hook set. The route
 * admits user principals only, so the key is always present over HTTP; the address is what the
 * type demands for a principal without one.
 *
 * @internal
 */
export function ticketRateLimitKey(request: Pick<FastifyRequest, 'principalKey' | 'ip'>): string {
  return request.principalKey ?? request.ip;
}

function throttled(retryAfterMs: number): ProblemError {
  return new ProblemError('rate_limited', {
    detail: 'Too many attempts; try again later.',
    retryAfterMs,
    headers: { 'retry-after': String(Math.max(1, Math.ceil(retryAfterMs / MS_PER_SECOND))) },
  });
}

function policyFailure(violations: readonly string[]): ProblemError {
  return new ProblemError('validation_failed', {
    detail: 'The password does not meet the policy.',
    errors: violations.map((code) => ({
      path: 'body.password',
      message: `password: ${code}`,
      code,
    })),
  });
}

/** Clears the web cookie and the browser-stored UI state on logout (section 4.3). */
function clearWebSession(reply: FastifyReply): void {
  reply.setCookie(SESSION_COOKIE_NAME, '', clearedSessionCookieOptions());
  reply.header('clear-site-data', LOGOUT_CLEAR_SITE_DATA);
}

/** Applies the M1 auth routes to `app` (an instance under the `/api/v1` prefix). */
export function applyAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): void {
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.auth.sink.bind(deps.audit);
  const api = app.withTypeProvider<ZodTypeProvider>();
  const { auth } = app;
  const mutations = authzMutations(app);

  const requireDb = (): Kysely<Database> => requireConnected(app.database.dbApp);

  const flowDeps = (request: FastifyRequest): PasswordFlowDeps => ({
    db: requireDb(),
    mutations: mutations.forOwner(requestOwnerFence(request)),
    ownerFence: requestOwnerFence(request),
    hasher: auth.hasher,
    policy: auth.policy,
    throttle: auth.throttle,
    ttls: auth.ttls,
    setpw: auth.setpw,
    audit: deps.audit,
    sink: auth.sink,
    loginFailureGate: auth.loginFailureGate,
    now: () => app.clock.now(),
    newId: auth.newId,
    log: request.log,
    countLoginFailure: (reason) => {
      app.metrics.loginFailuresTotal.inc({ reason });
    },
    currentPepper: () => auth.pepperVersion.currentPepper(),
  });

  /**
   * Revokes one of the caller's own sessions as `logout`, audits it and publishes the event.
   * Answers `false`, having written nothing, when no live session of the caller carries the id.
   */
  const revokeOwn = async (
    request: FastifyRequest,
    principal: UserPrincipal,
    sessionId: SessionId,
    action: 'user.logout' | 'session.revoked',
  ): Promise<boolean> => {
    const nowMs = app.clock.now();
    const revoked = await mutations.forOwner(requestOwnerFence(request)).run(
      { userId: principal.userId, isolation: 'repeatable read' },
      async (trx) => {
        // Match password and administrative session writes: parent user before session rows.
        await trx
          .selectFrom('users')
          .select('id')
          .where('id', '=', idBytes(principal.userId))
          .forUpdate()
          .executeTakeFirstOrThrow();
        const done = await revokeOwnSession(
          auth.sessionRepository(trx),
          sessionId,
          principal.userId,
          'logout',
          nowMs,
        );
        if (!done) return false;
        await deps.audit.record(trx, {
          action,
          chainId: SERVER_CHAIN_ID,
          actorType: 'user',
          actorId: principal.userId,
          credentialType: 'session',
          credentialId: principal.sessionId,
          outcome: 'success',
          context: auditContext(request),
          metadata:
            action === 'user.logout'
              ? { sessionId }
              : { sessionId, targetUserId: principal.userId, reason: 'logout' },
        });
        return true;
      },
      (done) =>
        done
          ? [
              {
                type: 'session.revoked',
                userId: principal.userId,
                sessionId,
                reason: 'logout',
              },
            ]
          : [],
    );
    if (revoked) {
      request.log.info(
        { event: 'auth.session.revoked', sessionId, reason: 'logout' },
        'session revoked',
      );
    }
    return revoked;
  };

  // ---- POST /auth/sessions -----------------------------------------------------------------------
  const createSession = routeSpec('auth.createSession');
  api.post(
    createSession.path,
    {
      config: { auth: createSession.auth, ...LOGIN_RATE_LIMIT.config },
      schema: {
        ...documentedBy(createSession),
        body: CreateSessionBody,
        response: { [HTTP_CREATED]: SessionCreated },
      },
    },
    async (request, reply) => {
      const { body } = request;
      // Step 3 of section 3.7: the header and the body must agree on the channel (D04-22).
      if (request.iridiumClient !== body.client) {
        request.log.warn(
          { event: 'authz.csrf_rejected', reason: 'client_mismatch', ip: request.ip },
          'login refused',
        );
        throw new ProblemError('csrf_rejected', {
          detail: 'X-Iridium-Client must equal the body client.',
        });
      }
      const outcome = await login(flowDeps(request), {
        email: body.email,
        password: body.password,
        client: body.client,
        deviceName: body.deviceName ?? null,
        ip: request.ip,
        userAgent: request.headers['user-agent'],
        clientVersion: request.iridiumClientVersion,
        context: auditContext(request),
      });
      if (outcome.kind === 'throttled') throw throttled(outcome.retryAfterMs);
      if (outcome.kind === 'invalid') throw new ProblemError('invalid_credentials');

      const user = toUserDto(outcome.user);
      const session = toSessionDto(outcome.session.row, outcome.session.sessionId);
      if (body.client === 'web') {
        reply.setCookie(
          SESSION_COOKIE_NAME,
          outcome.session.raw,
          sessionCookieOptions(outcome.session.row.absolute_expires_at, app.clock.now()),
        );
        return reply.code(HTTP_CREATED).send({ user, session });
      }
      return reply.code(HTTP_CREATED).send({
        token: outcome.session.raw,
        expiresAt: outcome.session.row.absolute_expires_at.toISOString(),
        idleExpiresAt: outcome.session.row.idle_expires_at.toISOString(),
        user,
        session,
      });
    },
  );

  // ---- DELETE /auth/sessions/current ------------------------------------------------------------
  const deleteCurrent = routeSpec('auth.deleteCurrentSession');
  api.delete(
    deleteCurrent.path,
    {
      config: { auth: deleteCurrent.auth },
      schema: { ...documentedBy(deleteCurrent), response: NO_CONTENT_RESPONSE },
    },
    async (request, reply) => {
      const principal = requireUserPrincipal(request.principal);
      // Idempotent: a session revoked between authentication and here still answers 204.
      await revokeOwn(request, principal, principal.sessionId, 'user.logout');
      request.log.info({ event: 'auth.logout', userId: principal.userId }, 'logout');
      if (principal.sessionKind === 'web') clearWebSession(reply);
      return reply.code(HTTP_NO_CONTENT).send(null);
    },
  );

  // ---- POST /auth/reauthenticate ----------------------------------------------------------------
  const reauth = routeSpec('auth.reauthenticate');
  api.post(
    reauth.path,
    {
      config: { auth: reauth.auth, ...LOGIN_RATE_LIMIT.config },
      schema: {
        ...documentedBy(reauth),
        body: ReauthenticateBody,
        response: { [HTTP_OK]: Reauthenticated },
      },
    },
    async (request, reply) => {
      const principal = requireUserPrincipal(request.principal);
      const outcome = await reauthenticate(
        flowDeps(request),
        {
          userId: principal.userId,
          sessionId: principal.sessionId,
          ip: request.ip,
          context: auditContext(request),
        },
        request.body.password,
      );
      if (outcome.kind === 'throttled') throw throttled(outcome.retryAfterMs);
      if (outcome.kind === 'invalid') throw new ProblemError('invalid_credentials');
      return reply.code(HTTP_OK).send({
        lastAuthenticatedAt: outcome.lastAuthenticatedAt.toISOString(),
        stepUpExpiresAt: outcome.stepUpExpiresAt.toISOString(),
      });
    },
  );

  // ---- POST /auth/set-password ------------------------------------------------------------------
  const setPw = routeSpec('auth.setPassword');
  api.post(
    setPw.path,
    {
      config: { auth: setPw.auth, ...LOGIN_RATE_LIMIT.config },
      schema: { ...documentedBy(setPw), body: SetPasswordBody, response: NO_CONTENT_RESPONSE },
    },
    async (request, reply) => {
      const outcome = await setPassword(flowDeps(request), {
        token: request.body.token,
        password: request.body.password,
        ip: request.ip,
        context: auditContext(request),
      });
      if (outcome.kind === 'throttled') throw throttled(outcome.retryAfterMs);
      if (outcome.kind === 'invalid_link') throw new ProblemError('invalid_link');
      if (outcome.kind === 'policy') throw policyFailure(outcome.violations);
      return reply.code(HTTP_NO_CONTENT).send(null);
    },
  );

  // ---- POST /auth/collab-tickets ----------------------------------------------------------------
  // Two budgets on one route (section 7.4): the per-session one is `@fastify/rate-limit`'s route
  // override, keyed by the principal the auth hook has already set; the per-IP one is the auth
  // plugin's own `WindowedBudget`, because that plugin runs at most one limiter per request.
  const tickets = routeSpec('auth.createCollabTickets');
  api.post(
    tickets.path,
    {
      config: {
        auth: tickets.auth,
        rateLimit: {
          max: LIMITS.TICKETS_PER_MINUTE_PER_SESSION,
          timeWindow: RATE_LIMIT_WINDOW,
          keyGenerator: ticketRateLimitKey,
          errorResponseBuilder: rateLimitProblem,
        },
      },
      preHandler: async (request) => {
        const verdict = auth.ticketIpBudget.hit(request.ip);
        if (!verdict.allowed) throw throttled(verdict.retryAfterMs);
      },
      schema: {
        ...documentedBy(tickets),
        body: CreateCollabTicketsBody,
        response: { [HTTP_CREATED]: CollabTicketsCreated },
      },
    },
    async (request, reply) => {
      const principal = requireUserPrincipal(request.principal);
      const issued = auth.tickets.issue(
        { sessionId: principal.sessionId, userId: principal.userId },
        request.body.count,
      );
      return reply
        .code(HTTP_CREATED)
        .send({ tickets: [...issued], expiresIn: LIMITS.TICKET_TTL_S });
    },
  );

  // ---- GET /auth/me -----------------------------------------------------------------------------
  const me = routeSpec('auth.me');
  api.get(
    me.path,
    { config: { auth: me.auth }, schema: { ...documentedBy(me), response: { [HTTP_OK]: Me } } },
    async (request, reply) => {
      const principal = requirePrincipal(request.principal);
      const db = requireDb();
      const user = await requireUserRow(db, principal.userId);
      if (principal.kind === 'user') {
        const body: MeDto = {
          user: toUserDto(user),
          isServerAdmin: principal.isServerAdmin,
          principalKind: 'user',
          sessionKind: principal.sessionKind,
          sessionId: principal.sessionId,
          lastAuthenticatedAt: principal.lastAuthenticatedAt.toISOString(),
        };
        return reply.code(HTTP_OK).send(body);
      }
      const tokenRow = await requireTokenRow(db, principal.tokenId);
      const body: MeDto = {
        user: toUserDto(user),
        isServerAdmin: false,
        principalKind: 'token',
        token: {
          id: principal.tokenId,
          name: tokenRow.name,
          scopes: [...principal.scopes],
          allVaults: 'all' in principal.vaultScope,
          vaultIds: 'all' in principal.vaultScope ? [] : [...principal.vaultScope.vaultIds],
          expiresAt: principal.expiresAt.toISOString(),
        },
      };
      return reply.code(HTTP_OK).send(body);
    },
  );

  // ---- GET /me/sessions -------------------------------------------------------------------------
  const listSessions = routeSpec('me.sessions.list');
  api.get(
    listSessions.path,
    {
      config: { auth: listSessions.auth },
      schema: { ...documentedBy(listSessions), response: { [HTTP_OK]: SessionList } },
    },
    async (request, reply) => {
      const principal = requireUserPrincipal(request.principal);
      const rows = await auth.sessionRepository(requireDb()).listLiveForUser(principal.userId);
      const items = rows
        .map((row) => toSessionDto(row, principal.sessionId))
        .toSorted((left, right) => Number(right.current) - Number(left.current));
      return reply.code(HTTP_OK).send({ items });
    },
  );

  // ---- DELETE /me/sessions/:sessionId -----------------------------------------------------------
  const revokeOne = routeSpec('me.sessions.revoke');
  api.delete(
    revokeOne.path,
    {
      config: { auth: revokeOne.auth },
      schema: {
        ...documentedBy(revokeOne),
        params: SessionIdParams,
        response: NO_CONTENT_RESPONSE,
      },
    },
    async (request, reply) => {
      const principal = requireUserPrincipal(request.principal);
      // Branded through the schema the params were validated with, so no cast claims the shape.
      const target = SessionId.parse(request.params.sessionId);
      const current = target === principal.sessionId;
      const done = await revokeOwn(
        request,
        principal,
        target,
        current ? 'user.logout' : 'session.revoked',
      );
      // A foreign, unknown or already revoked id is one `not_found` (09 section 1.3, `self`): the
      // revocation is scoped to the caller's live rows, so there is nothing to read first.
      if (!done) throw new ProblemError('not_found');
      if (current && principal.sessionKind === 'web') clearWebSession(reply);
      return reply.code(HTTP_NO_CONTENT).send(null);
    },
  );

  // ---- PATCH /me --------------------------------------------------------------------------------
  const updateMe = routeSpec('me.update');
  api.patch(
    updateMe.path,
    {
      config: { auth: updateMe.auth },
      schema: { ...documentedBy(updateMe), body: UpdateMeBody, response: { [HTTP_OK]: User } },
    },
    async (request, reply) => {
      const principal = requireUserPrincipal(request.principal);
      const db = requireDb();
      const current = await requireUserRow(db, principal.userId);
      const ifMatch = request.headers['if-match'];
      const expected = ifMatch === undefined ? null : parseStrongEtag(ifMatch);
      if (expected === null) {
        throw new ProblemError('precondition_required', { current: toUserDto(current) });
      }
      const now = new Date(app.clock.now());
      const result = await db.transaction().execute(async (trx) => {
        await requestOwnerFence(request).assertCurrent(trx);
        return trx
          .updateTable('users')
          .set({
            display_name: request.body.displayName,
            version: sql`version + 1`,
            updated_at: now,
          })
          .where('id', '=', idBytes(principal.userId))
          .where('version', '=', expected)
          .executeTakeFirst();
      });
      const updated = await requireUserRow(db, principal.userId);
      if (result.numUpdatedRows !== 1n) {
        throw new ProblemError('stale_version', { current: toUserDto(updated) });
      }
      reply.header('etag', strongEtag(updated.version));
      return toUserDto(updated);
    },
  );

  // ---- POST /me/password ------------------------------------------------------------------------
  const changePw = routeSpec('me.changePassword');
  api.post(
    changePw.path,
    {
      config: { auth: changePw.auth },
      schema: {
        ...documentedBy(changePw),
        body: ChangePasswordBody,
        response: NO_CONTENT_RESPONSE,
      },
    },
    async (request, reply) => {
      const principal = requireUserPrincipal(request.principal);
      const outcome = await changePassword(
        flowDeps(request),
        {
          userId: principal.userId,
          sessionId: principal.sessionId,
          ip: request.ip,
          context: auditContext(request),
        },
        request.body.currentPassword,
        request.body.newPassword,
      );
      if (outcome.kind === 'throttled') throw throttled(outcome.retryAfterMs);
      if (outcome.kind === 'invalid') throw new ProblemError('invalid_credentials');
      if (outcome.kind === 'policy') throw policyFailure(outcome.violations);
      return reply.code(HTTP_NO_CONTENT).send(null);
    },
  );
}
