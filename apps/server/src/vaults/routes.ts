/**
 * `applyVaultRoutes(app)` — the three vault routes of M1 (09-api-reference.md §2.5).
 *
 * Each registration is one row of `M1_ROUTES`: the path, the policy and the schemas come from the
 * row through `routeSpec()`, so a route cannot be served with a policy or a body the OpenAPI
 * document does not describe, and `rest.route-index.contract` holds the served set equal to the
 * documented one.
 *
 * `GET /vaults` does **not** post-filter. The accessible set is built by `accessibleVaultIds()` and
 * goes into the statement as `vaults.id IN (?)` (04-auth-and-access-control.md §5.7, D04-11): a
 * result filtered after the fact has already been counted and ordered against rows the caller cannot
 * see. The other two routes are addressed by id, so the route policy's `vaultFrom` has already
 * decided them and the handler reads `request.vault`.
 */
import {
  CreateVaultBody,
  ListVaultsQuery,
  strongEtag,
  UserId,
  Vault,
  VaultIdParams,
  VaultSummaryList,
  type RouteSpec,
} from '@iridium/contracts';
import type { FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';

import type { AuditRecorder } from '../auth/audit.ts';
import { requireUserRow } from '../auth/users.ts';
import { API_PREFIX } from '../authz/route-policy.ts';
import {
  appDb,
  auditContext,
  requirePrincipal,
  requireUserPrincipal,
  routeSpec as manifestRow,
} from '../rest/handler-context.ts';
import { requestOwnerFence } from '../rest/ownership.ts';
import { ProblemError } from '../security/problem.ts';
import { createVault, listVaults, readVault } from './service.ts';

/** What the composer passes: the instance's audit writer (boot step 6). */
export interface VaultRouteDeps {
  readonly audit: AuditRecorder;
}

/** The operation ids this module registers, in registration order. */
export const VAULT_OPERATION_IDS = ['vaults.list', 'vaults.create', 'vaults.get'] as const;

/** An operation id of this module. */
type VaultOperationId = (typeof VAULT_OPERATION_IDS)[number];

/**
 * The manifest row for one of this module's operations: the shared lookup, narrowed to the ids
 * above, so a registration cannot name a row this module does not claim.
 */
function routeSpec(operationId: VaultOperationId): RouteSpec {
  return manifestRow(operationId);
}

const HTTP_OK = 200;
const HTTP_CREATED = 201;

/** Applies the vault routes to an instance already mounted under `/api/v1`. */
export function applyVaultRoutes(app: FastifyInstance, deps: VaultRouteDeps): void {
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const api = app.withTypeProvider<ZodTypeProvider>();

  // ---- GET /vaults -------------------------------------------------------------------------------
  const list = routeSpec('vaults.list');
  api.get(
    list.path,
    {
      config: { auth: list.auth },
      schema: {
        operationId: list.operationId,
        tags: [list.tag],
        summary: list.summary,
        querystring: ListVaultsQuery,
        response: { [HTTP_OK]: VaultSummaryList },
      },
    },
    async (request, reply) => {
      const principal = requirePrincipal(request.principal);
      const vaultIds = await app.authz.accessibleVaultIds(principal, {
        permission: 'vault:read',
        surface: 'rest',
      });
      const items = await listVaults(appDb(app), {
        vaultIds,
        userId: principal.userId,
        isServerAdmin: principal.kind === 'user' && principal.isServerAdmin,
        includeArchived: request.query.includeArchived,
      });
      return reply.code(HTTP_OK).send({ items });
    },
  );

  // ---- POST /vaults ------------------------------------------------------------------------------
  const create = routeSpec('vaults.create');
  api.post(
    create.path,
    {
      config: { auth: create.auth },
      schema: {
        operationId: create.operationId,
        tags: [create.tag],
        summary: create.summary,
        body: CreateVaultBody,
        response: { [HTTP_CREATED]: Vault },
      },
    },
    async (request, reply) => {
      const principal = requireUserPrincipal(request.principal);
      const db = appDb(app);
      const creator = await requireUserRow(db, principal.userId);
      const { vault, events } = await createVault(
        { db, audit: deps.audit, ownerFence: requestOwnerFence(request) },
        {
          name: request.body.name,
          ...(request.body.description === undefined
            ? {}
            : { description: request.body.description }),
          ...(request.body.settings === undefined ? {} : { settings: request.body.settings }),
          // Branded through the id schema, which is also the assertion that each validated string
          // is a canonical user id (ARCH-13).
          ...(request.body.members === undefined
            ? {}
            : {
                members: request.body.members.map((grant) => ({
                  userId: UserId.parse(grant.userId),
                  role: grant.role,
                })),
              }),
          actor: {
            userId: principal.userId,
            sessionId: principal.sessionId,
            displayName: creator.display_name,
          },
          context: auditContext(request),
          now: new Date(app.clock.now()),
        },
      );
      // Step 8 of 03-data-model.md §6.4: every side effect runs out here, after COMMIT.
      for (const event of events) app.authz.bus.publish(event);
      return reply
        .code(HTTP_CREATED)
        .header('location', `${API_PREFIX}/vaults/${vault.id}`)
        .header('etag', strongEtag(vault.version))
        .send(vault);
    },
  );

  // ---- GET /vaults/:vaultId ----------------------------------------------------------------------
  const get = routeSpec('vaults.get');
  api.get(
    get.path,
    {
      config: { auth: get.auth },
      schema: {
        operationId: get.operationId,
        tags: [get.tag],
        summary: get.summary,
        params: VaultIdParams,
        response: { [HTTP_OK]: Vault },
      },
    },
    async (request, reply) => {
      const principal = requirePrincipal(request.principal);
      // The route policy resolved and authorised the vault before this handler ran, so an absent
      // attachment is a policy defect rather than an unknown vault.
      const resolved = request.vault;
      if (resolved === null) throw new ProblemError('not_found');
      const vault = await readVault(appDb(app), resolved.id, {
        role: resolved.role,
        isServerAdmin: principal.kind === 'user' && principal.isServerAdmin,
      });
      if (vault === null) throw new ProblemError('not_found');
      reply.header('etag', strongEtag(vault.version));
      return reply.code(HTTP_OK).send(vault);
    },
  );
}
