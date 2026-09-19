/**
 * `applyAdminUserRoutes(app)` — the `/admin/users` routes of M1 (09-api-reference.md §2.15.1).
 *
 * Every `/admin/*` route is `serverAdmin` and every mutation additionally requires the step-up
 * window; both come from the `M1_ROUTES` row verbatim, and the boot assertion refuses a mutating
 * `/admin/*` route that does not declare `stepUp` (A26), so the rule cannot be forgotten on a route
 * added later.
 *
 * The `AuthzBus` events a disable justifies are published **after** COMMIT, here in the handler:
 * publishing inside the transaction would close a user's connections for a change that then rolled
 * back (04-auth-and-access-control.md §8.3, D04-14).
 */
import {
  AdminUserCreated,
  AdminUserPage,
  AdminUserPasswordReset,
  CreateAdminUserBody,
  DisableUserBody,
  ListAdminUsersQuery,
  strongEtag,
  User,
  UserId,
  UserIdParams,
  VaultId,
  type RouteSpec,
} from '@iridium/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';

import type { AuditRecorder } from '../auth/audit.ts';
import { requireUserRow } from '../auth/users.ts';
import { authzMutations, type AuthzMutationRunner } from '../authz/mutations.ts';
import { API_PREFIX } from '../authz/route-policy.ts';
import type { CursorCodec } from '../mcp/cursor.ts';
import {
  appDb,
  auditContext,
  requireUserPrincipal,
  routeSpec as manifestRow,
} from '../rest/handler-context.ts';
import { requestOwnerFence } from '../rest/ownership.ts';
import { listAdminUsers } from './listing.ts';
import {
  createUser,
  disableUser,
  enableUser,
  resetUserPassword,
  type AdminActor,
  type UserServiceDeps,
} from './service.ts';

/** What the composer passes. */
export interface AdminUserRouteDeps {
  readonly audit: AuditRecorder;
  /** The shared keyset cursor codec; `GET /admin/users` is its first consumer (09 §1.6). */
  readonly cursors: () => Promise<CursorCodec>;
}

/** The operation ids this module registers, in registration order. */
export const ADMIN_USER_OPERATION_IDS = [
  'admin.users.list',
  'admin.users.create',
  'admin.users.disable',
  'admin.users.enable',
  'admin.users.resetPassword',
] as const;

/** An operation id of this module. */
type AdminUserOperationId = (typeof ADMIN_USER_OPERATION_IDS)[number];

/**
 * The manifest row for one of this module's operations: the shared lookup, narrowed to the ids
 * above, so a registration cannot name a row this module does not claim.
 */
function routeSpec(operationId: AdminUserOperationId): RouteSpec {
  return manifestRow(operationId);
}

const HTTP_OK = 200;
const HTTP_CREATED = 201;

/**
 * The rate-limit and cursor key of the calling principal. A `/admin/*` route only ever sees a user
 * principal, so the hook has always set it; the address is the honest fallback for a principal that
 * somehow carries none rather than a cursor bound to the empty string.
 */
function principalKey(request: FastifyRequest): string {
  return request.principalKey ?? request.ip;
}

/** Applies the administrative user routes to an instance already mounted under `/api/v1`. */
export function applyAdminUserRoutes(app: FastifyInstance, deps: AdminUserRouteDeps): void {
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const api = app.withTypeProvider<ZodTypeProvider>();

  const mutations = authzMutations(app);
  const services = (
    request: FastifyRequest,
  ): UserServiceDeps & { readonly mutations: AuthzMutationRunner } => ({
    db: appDb(app),
    mutations: mutations.forOwner(requestOwnerFence(request)),
    ownerFence: requestOwnerFence(request),
    audit: deps.audit,
    setpw: app.auth.setpw,
    sessionRepository: (trx) => app.auth.sessionRepository(trx),
  });

  const actorOf = async (request: FastifyRequest): Promise<AdminActor> => {
    const principal = requireUserPrincipal(request.principal);
    const row = await requireUserRow(appDb(app), principal.userId);
    return {
      kind: 'session',
      userId: principal.userId,
      sessionId: principal.sessionId,
      displayName: row.display_name,
    };
  };

  // ---- GET /admin/users --------------------------------------------------------------------------
  const list = routeSpec('admin.users.list');
  api.get(
    list.path,
    {
      config: { auth: list.auth },
      schema: {
        operationId: list.operationId,
        tags: [list.tag],
        summary: list.summary,
        querystring: ListAdminUsersQuery,
        response: { [HTTP_OK]: AdminUserPage },
      },
    },
    async (request, reply) => {
      const codec = await deps.cursors();
      const page = await listAdminUsers(appDb(app), codec, {
        q: request.query.q ?? null,
        status: request.query.status ?? null,
        isServerAdmin: request.query.isServerAdmin ?? null,
        cursor: request.query.cursor ?? null,
        limit: request.query.limit,
        principalKey: principalKey(request),
      });
      return reply.code(HTTP_OK).send(page);
    },
  );

  // ---- POST /admin/users -------------------------------------------------------------------------
  const create = routeSpec('admin.users.create');
  api.post(
    create.path,
    {
      config: { auth: create.auth },
      schema: {
        operationId: create.operationId,
        tags: [create.tag],
        summary: create.summary,
        body: CreateAdminUserBody,
        response: { [HTTP_CREATED]: AdminUserCreated },
      },
    },
    async (request, reply) => {
      const created = await createUser(services(request), {
        email: request.body.email,
        displayName: request.body.displayName,
        isServerAdmin: request.body.isServerAdmin,
        // Branded through the id schema, which is also the assertion that the validated string is a
        // canonical vault id (ARCH-13).
        ...(request.body.memberships === undefined
          ? {}
          : {
              memberships: request.body.memberships.map((grant) => ({
                vaultId: VaultId.parse(grant.vaultId),
                role: grant.role,
              })),
            }),
        actor: await actorOf(request),
        context: auditContext(request),
        now: new Date(app.clock.now()),
      });
      for (const event of created.events) app.authz.bus.publish(event);
      return reply
        .code(HTTP_CREATED)
        .header('location', `${API_PREFIX}/admin/users/${created.user.id}`)
        .send({
          user: created.user,
          setPasswordLink: created.setPasswordLink,
          expiresAt: created.expiresAt.toISOString(),
        });
    },
  );

  // ---- POST /admin/users/:userId/disable ---------------------------------------------------------
  const disable = routeSpec('admin.users.disable');
  api.post(
    disable.path,
    {
      config: { auth: disable.auth },
      schema: {
        operationId: disable.operationId,
        tags: [disable.tag],
        summary: disable.summary,
        params: UserIdParams,
        body: DisableUserBody,
        response: { [HTTP_OK]: User },
      },
    },
    async (request, reply) => {
      const changed = await disableUser(services(request), {
        userId: UserId.parse(request.params.userId),
        ...(request.body.reason === undefined ? {} : { reason: request.body.reason }),
        actor: await actorOf(request),
        context: auditContext(request),
        now: new Date(app.clock.now()),
      });
      reply.header('etag', strongEtag(changed.user.version));
      return reply.code(HTTP_OK).send(changed.user);
    },
  );

  // ---- POST /admin/users/:userId/enable ----------------------------------------------------------
  const enable = routeSpec('admin.users.enable');
  api.post(
    enable.path,
    {
      config: { auth: enable.auth },
      schema: {
        operationId: enable.operationId,
        tags: [enable.tag],
        summary: enable.summary,
        params: UserIdParams,
        response: { [HTTP_OK]: User },
      },
    },
    async (request, reply) => {
      const changed = await enableUser(services(request), {
        userId: UserId.parse(request.params.userId),
        actor: await actorOf(request),
        context: auditContext(request),
        now: new Date(app.clock.now()),
      });
      reply.header('etag', strongEtag(changed.user.version));
      return reply.code(HTTP_OK).send(changed.user);
    },
  );
  const reset = routeSpec('admin.users.resetPassword');
  api.post(
    reset.path,
    {
      config: { auth: reset.auth },
      schema: {
        operationId: reset.operationId,
        tags: [reset.tag],
        summary: reset.summary,
        params: UserIdParams,
        response: { [HTTP_CREATED]: AdminUserPasswordReset },
      },
    },
    async (request, reply) => {
      const changed = await resetUserPassword(
        { ...services(request), throttle: app.auth.throttle },
        {
          userId: UserId.parse(request.params.userId),
          actor: await actorOf(request),
          context: auditContext(request),
          now: new Date(app.clock.now()),
        },
      );
      return reply.code(HTTP_CREATED).send({
        setPasswordLink: changed.setPasswordLink,
        expiresAt: changed.expiresAt.toISOString(),
      });
    },
  );
}
