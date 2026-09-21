/**
 * `applyMemberRoutes(app)` — the three membership routes of M1 (09-api-reference.md §2.6).
 *
 * Everyone who can read a vault can see who else can, and a manager can change who can: the two
 * policies come from the `API_ROUTES` rows verbatim, so the read is `vault:read` and the two writes
 * are `vault:manage_members`.
 *
 * `If-Match` is parsed here and enforced in the service, because the header's *shape* is a wire rule
 * (`"<version>"`, never a weak validator, a list or `*` — §1.2) while whether one is required is a
 * fact about the row (`PUT` needs one only when the membership already exists). `parseStrongEtag`
 * answers `null` for every shape §1.2 refuses, and a `null` is `428 precondition_required` rather
 * than a silently ignored header.
 */
import {
  Member,
  MemberList,
  parseStrongEtag,
  PutMemberBody,
  strongEtag,
  UserId,
  VaultIdParams,
  VaultMemberParams,
  type RouteSpec,
  type VaultId,
} from '@iridium/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';

import type { AuditRecorder } from '../auth/audit.ts';
import { requireUserRow } from '../auth/users.ts';
import { authzMutations } from '../authz/mutations.ts';
import {
  appDb,
  auditContext,
  EMPTY_RESPONSE,
  requireUserPrincipal,
  routeSpec as manifestRow,
} from '../rest/handler-context.ts';
import { requestOwnerFence } from '../rest/ownership.ts';
import { ProblemError } from '../security/problem.ts';
import { listMembers, putMember, removeMember, type MemberActor } from './service.ts';

/** What the composer passes: the instance's audit writer (boot step 6). */
export interface MemberRouteDeps {
  readonly audit: AuditRecorder;
}

/** The operation ids this module registers, in registration order. */
export const MEMBER_OPERATION_IDS = ['members.list', 'members.put', 'members.delete'] as const;

/** An operation id of this module. */
type MemberOperationId = (typeof MEMBER_OPERATION_IDS)[number];

/**
 * The manifest row for one of this module's operations: the shared lookup, narrowed to the ids
 * above, so a registration cannot name a row this module does not claim.
 */
function routeSpec(operationId: MemberOperationId): RouteSpec {
  return manifestRow(operationId);
}

const HTTP_OK = 200;
const HTTP_CREATED = 201;
const HTTP_NO_CONTENT = 204;

/**
 * The version an `If-Match` header names, or `undefined` when the header is absent.
 *
 * A present-but-unusable validator is **not** `undefined`: §1.2 refuses a weak validator, `*`, a
 * list and a malformed value with `428 precondition_required`, and treating any of them as "no
 * header" would let a client that thinks it is being careful write unconditionally.
 */
function ifMatchVersion(request: FastifyRequest): number | undefined {
  const header = request.headers['if-match'];
  if (header === undefined) return undefined;
  const value = Array.isArray(header) ? header[0] : header;
  const parsed = value === undefined ? null : parseStrongEtag(value);
  if (parsed === null) {
    throw new ProblemError('precondition_required', {
      detail: 'If-Match must carry a strong validator of the form "<version>" (09 §1.2).',
    });
  }
  return parsed;
}

/** The vault the route policy resolved; an absent attachment is a policy defect, not a 404. */
function resolvedVaultId(request: FastifyRequest): VaultId {
  const resolved = request.vault;
  if (resolved === null) throw new ProblemError('not_found');
  return resolved.id;
}

/** Applies the membership routes to an instance already mounted under `/api/v1`. */
export function applyMemberRoutes(app: FastifyInstance, deps: MemberRouteDeps): void {
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const api = app.withTypeProvider<ZodTypeProvider>();
  const mutations = authzMutations(app);

  const actorOf = async (request: FastifyRequest): Promise<MemberActor> => {
    const principal = requireUserPrincipal(request.principal);
    const row = await requireUserRow(appDb(app), principal.userId);
    return {
      userId: principal.userId,
      sessionId: principal.sessionId,
      displayName: row.display_name,
      isServerAdmin: principal.isServerAdmin,
    };
  };

  // ---- GET /vaults/:vaultId/members --------------------------------------------------------------
  const list = routeSpec('members.list');
  api.get(
    list.path,
    {
      config: { auth: list.auth },
      schema: {
        operationId: list.operationId,
        tags: [list.tag],
        summary: list.summary,
        params: VaultIdParams,
        response: { [HTTP_OK]: MemberList },
      },
    },
    async (request, reply) => {
      const items = await listMembers(appDb(app), resolvedVaultId(request));
      return reply.code(HTTP_OK).send({ items });
    },
  );

  // ---- PUT /vaults/:vaultId/members/:userId ------------------------------------------------------
  const put = routeSpec('members.put');
  api.put(
    put.path,
    {
      config: { auth: put.auth },
      schema: {
        operationId: put.operationId,
        tags: [put.tag],
        summary: put.summary,
        params: VaultMemberParams,
        body: PutMemberBody,
        response: { [HTTP_OK]: Member, [HTTP_CREATED]: Member },
      },
    },
    async (request, reply) => {
      const result = await putMember(
        { mutations: mutations.forOwner(requestOwnerFence(request)), audit: deps.audit },
        {
          vaultId: resolvedVaultId(request),
          userId: UserId.parse(request.params.userId),
          ifMatch: ifMatchVersion(request),
          actor: await actorOf(request),
          context: auditContext(request),
          now: new Date(app.clock.now()),
        },
        request.body.role,
      );
      return reply
        .code(result.created ? HTTP_CREATED : HTTP_OK)
        .header('etag', strongEtag(result.member.version))
        .send(result.member);
    },
  );

  // ---- DELETE /vaults/:vaultId/members/:userId ---------------------------------------------------
  const remove = routeSpec('members.delete');
  api.delete(
    remove.path,
    {
      config: { auth: remove.auth },
      schema: {
        operationId: remove.operationId,
        tags: [remove.tag],
        summary: remove.summary,
        params: VaultMemberParams,
        // A `204` answers nothing, and `EMPTY_RESPONSE` is what says so in the document.
        response: { [HTTP_NO_CONTENT]: EMPTY_RESPONSE },
      },
    },
    async (request, reply) => {
      await removeMember(
        { mutations: mutations.forOwner(requestOwnerFence(request)), audit: deps.audit },
        {
          vaultId: resolvedVaultId(request),
          userId: UserId.parse(request.params.userId),
          ifMatch: ifMatchVersion(request),
          actor: await actorOf(request),
          context: auditContext(request),
          now: new Date(app.clock.now()),
        },
      );
      return reply.code(HTTP_NO_CONTENT).send();
    },
  );
}
