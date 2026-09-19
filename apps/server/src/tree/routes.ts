/**
 * `applyNodeRoutes(app)` — `POST /vaults/:vaultId/nodes`, the one structural write of M1
 * (09-api-reference.md §2.7).
 *
 * The handler does three things and delegates the rest: it narrows the principal, calls the service
 * that owns the structural transaction, and — **after COMMIT** — broadcasts `tree-changed` on the
 * vault channel so every open client learns its tree moved (03-data-model.md §6.4 step 8).
 *
 * The broadcast is best-effort by construction: the write has committed, and a collaboration server
 * that is not mounted (or a vault with no open connection) must not turn a successful `201` into a
 * `500`. Clients reconcile on their next read through `treeVersion` either way.
 */
import { CreateNodeBody, Node, VaultIdParams, type RouteSpec } from '@iridium/contracts';
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
  requireUserPrincipal,
  routeSpec as manifestRow,
} from '../rest/handler-context.ts';
import { requestOwnerFence } from '../rest/ownership.ts';
import { ProblemError } from '../security/problem.ts';
import { createNode, type NoteInitializer } from './service.ts';

/** What the composer passes: the audit writer and the note kernel (boot steps 6 and 8). */
export interface NodeRouteDeps {
  readonly audit: AuditRecorder;
  /** `app.notes` — resolved per request, because the collab plugin decorates it at step 8. */
  readonly notes: () => NoteInitializer;
  /** `app.collab.gateway.broadcastVault` with a `tree-changed` frame, after COMMIT. */
  readonly broadcastTreeChanged: (vaultId: string, treeVersion: number, node: Node) => void;
}

/** The operation ids this module registers. */
export const NODE_OPERATION_IDS = ['nodes.create'] as const;

/** An operation id of this module. */
type NodeOperationId = (typeof NODE_OPERATION_IDS)[number];

/**
 * The manifest row for one of this module's operations: the shared lookup, narrowed to the ids
 * above, so a registration cannot name a row this module does not claim.
 */
function routeSpec(operationId: NodeOperationId): RouteSpec {
  return manifestRow(operationId);
}

const HTTP_CREATED = 201;

/** Applies the node routes to an instance already mounted under `/api/v1`. */
export function applyNodeRoutes(app: FastifyInstance, deps: NodeRouteDeps): void {
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const api = app.withTypeProvider<ZodTypeProvider>();

  const create = routeSpec('nodes.create');
  api.post(
    create.path,
    {
      config: { auth: create.auth },
      schema: {
        operationId: create.operationId,
        tags: [create.tag],
        summary: create.summary,
        params: VaultIdParams,
        body: CreateNodeBody,
        response: { [HTTP_CREATED]: Node },
      },
    },
    async (request, reply) => {
      const principal = requireUserPrincipal(request.principal);
      const resolved = request.vault;
      if (resolved === null) throw new ProblemError('not_found');
      const db = appDb(app);
      const actor = await requireUserRow(db, principal.userId);

      const { node, treeVersion } = await createNode(
        {
          db,
          clock: app.clock,
          audit: deps.audit,
          notes: deps.notes(),
          ownerFence: requestOwnerFence(request),
        },
        {
          vaultId: resolved.id,
          kind: request.body.kind,
          parentId: request.body.parentId,
          name: request.body.name,
          ...(request.body.markdown === undefined ? {} : { markdown: request.body.markdown }),
          actor: {
            userId: principal.userId,
            sessionId: principal.sessionId,
            displayName: actor.display_name,
          },
          context: auditContext(request),
        },
      );

      deps.broadcastTreeChanged(resolved.id, treeVersion, node);
      return reply
        .code(HTTP_CREATED)
        .header('location', `${API_PREFIX}/nodes/${node.id}`)
        .send(node);
    },
  );
}
