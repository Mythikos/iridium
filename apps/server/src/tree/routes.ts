/** REST ownership of tree reads, structural writes and their post-COMMIT deltas. */
import {
  CreateNodeBody,
  InboundLinksPage,
  ListChildrenQuery,
  ListInboundLinksQuery,
  ListNodesQuery,
  ListTrashQuery,
  Node,
  NodeId,
  NodeIdParams,
  NodePage,
  NodePatchResult,
  PatchNodeBody,
  PurgeNodeQuery,
  RenameImpactQuery,
  RenameImpactResult,
  NoteIdParams,
  RestoreNodeBody,
  RestoreNodeResult,
  strongEtag,
  TrashNodeBody,
  TrashNodeResult,
  TrashPage,
  TreePage,
  VaultIdParams,
  type Permission,
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
import { idBytes, vaultIdFromBytes } from '../auth/ids.ts';
import { requireUserRow } from '../auth/users.ts';
import { API_PREFIX } from '../authz/route-policy.ts';
import type { ContentReadCore } from '../content/read/index.ts';
import {
  appDb,
  auditContext,
  EMPTY_RESPONSE,
  requirePrincipal,
  requireUserPrincipal,
  routeSpec as manifestRow,
} from '../rest/handler-context.ts';
import { requestOwnerFence } from '../rest/ownership.ts';
import { ProblemError } from '../security/problem.ts';
import { patchNode, treeChanges, type NodeMutationInput, type TreeChange } from './mutations.ts';
import { requiredVersion } from './preconditions.ts';
import { createNode, type NoteInitializer, type TreeServiceDeps } from './service.ts';
import { purgeNode, restoreNode, trashNode, type TreeLifecycleDeps } from './trash.ts';

/** Composition supplies owned I/O seams; a route never reaches into the collaboration kernel. */
export interface NodeRouteDeps {
  readonly searchIndex: () => TreeServiceDeps['searchIndex'];
  readonly audit: AuditRecorder;
  readonly notes: () => NoteInitializer;
  readonly core: () => ContentReadCore;
  readonly lifecycle: Pick<
    TreeLifecycleDeps,
    | 'markClosing'
    | 'clearClosing'
    | 'checkpointTrash'
    | 'afterTrashCommit'
    | 'afterTrash'
    | 'beginPurge'
    | 'beforePurge'
    | 'afterPurge'
  >;
  readonly broadcastTreeChanged: (
    vaultId: string,
    treeVersion: number,
    changes: readonly TreeChange[],
  ) => void;
}

/** Exactly the routes this area mounts. */
export const NODE_OPERATION_IDS = [
  'nodes.create',
  'tree.listChildren',
  'nodes.list',
  'nodes.get',
  'nodes.update',
  'nodes.trash',
  'nodes.restore',
  'nodes.purge',
  'nodes.inboundLinks',
  'trash.list',
  'notes.renameImpact',
] as const;

function routeSpec(operationId: (typeof NODE_OPERATION_IDS)[number]): RouteSpec {
  return manifestRow(operationId);
}

function vaultIdOf(request: FastifyRequest): VaultId {
  if (request.vault === null) throw new ProblemError('not_found');
  return request.vault.id;
}

async function authorizeExtra(
  app: FastifyInstance,
  request: FastifyRequest,
  permission: Permission,
): Promise<void> {
  const decision = await app.authz.authorize(requirePrincipal(request.principal), permission, {
    vaultId: vaultIdOf(request),
    surface: 'rest',
  });
  if (decision !== 'allow') throw new ProblemError(decision.deny);
}

/** Only a caller who can read both vaults may learn that a proposed parent is cross-vault. */
async function authorizeParent(
  app: FastifyInstance,
  request: FastifyRequest,
  parentId: string,
): Promise<void> {
  const parent = await appDb(app)
    .selectFrom('nodes')
    .select('vault_id')
    .where('id', '=', idBytes(parentId))
    .executeTakeFirst();
  if (parent === undefined) return;
  const parentVault = vaultIdFromBytes(parent.vault_id);
  if (parentVault === vaultIdOf(request)) return;
  const decision = await app.authz.authorize(requirePrincipal(request.principal), 'vault:read', {
    vaultId: parentVault,
    surface: 'rest',
  });
  if (decision !== 'allow') throw new ProblemError('not_found');
}

/** Applies the complete headless tree surface under `/api/v1`. */
export function applyNodeRoutes(app: FastifyInstance, deps: NodeRouteDeps): void {
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const api = app.withTypeProvider<ZodTypeProvider>();
  const services = (request: FastifyRequest): TreeServiceDeps => ({
    searchIndex: deps.searchIndex(),
    db: appDb(app),
    clock: app.clock,
    audit: deps.audit,
    notes: deps.notes(),
    ownerFence: requestOwnerFence(request),
  });
  const mutationInput = async (
    request: FastifyRequest,
    nodeId: string,
  ): Promise<NodeMutationInput> => {
    const principal = requireUserPrincipal(request.principal);
    const actor = await requireUserRow(appDb(app), principal.userId);
    return {
      vaultId: vaultIdOf(request),
      nodeId: NodeId.parse(nodeId),
      version: requiredVersion(request.headers['if-match']),
      actor: {
        userId: principal.userId,
        sessionId: principal.sessionId,
        displayName: actor.display_name,
      },
      context: auditContext(request),
    };
  };

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
        response: { 201: Node },
      },
    },
    async (request, reply) => {
      const principal = requireUserPrincipal(request.principal);
      await authorizeParent(app, request, request.body.parentId);
      const actor = await requireUserRow(appDb(app), principal.userId);
      const { node, treeVersion } = await createNode(services(request), {
        vaultId: vaultIdOf(request),
        ...request.body,
        actor: {
          userId: principal.userId,
          sessionId: principal.sessionId,
          displayName: actor.display_name,
        },
        context: auditContext(request),
      });
      deps.broadcastTreeChanged(vaultIdOf(request), treeVersion, treeChanges([node], 'created'));
      return reply
        .code(201)
        .header('location', `${API_PREFIX}/nodes/${node.id}`)
        .header('etag', strongEtag(node.version))
        .send(node);
    },
  );

  const children = routeSpec('tree.listChildren');
  api.get(
    children.path,
    {
      config: { auth: children.auth },
      schema: {
        operationId: children.operationId,
        tags: [children.tag],
        summary: children.summary,
        params: VaultIdParams,
        querystring: ListChildrenQuery,
        response: { 200: TreePage },
      },
    },
    async (request) =>
      deps
        .core()
        .listChildren(requirePrincipal(request.principal), vaultIdOf(request), request.query),
  );

  const list = routeSpec('nodes.list');
  api.get(
    list.path,
    {
      config: { auth: list.auth },
      schema: {
        operationId: list.operationId,
        tags: [list.tag],
        summary: list.summary,
        params: VaultIdParams,
        querystring: ListNodesQuery,
        response: { 200: NodePage },
      },
    },
    async (request) => {
      if (request.query.includeTrashed) await authorizeExtra(app, request, 'history:read');
      return deps
        .core()
        .listNodes(requirePrincipal(request.principal), vaultIdOf(request), request.query);
    },
  );

  const get = routeSpec('nodes.get');
  api.get(
    get.path,
    {
      config: { auth: get.auth },
      schema: {
        operationId: get.operationId,
        tags: [get.tag],
        summary: get.summary,
        params: NodeIdParams,
        response: { 200: Node },
      },
    },
    async (request, reply) => {
      const node = await deps
        .core()
        .getNode(requirePrincipal(request.principal), request.params.nodeId);
      if (node === null) throw new ProblemError('not_found');
      return reply.header('etag', strongEtag(node.version)).send(node);
    },
  );

  const patch = routeSpec('nodes.update');
  api.patch(
    patch.path,
    {
      config: { auth: patch.auth },
      schema: {
        operationId: patch.operationId,
        tags: [patch.tag],
        summary: patch.summary,
        params: NodeIdParams,
        body: PatchNodeBody,
        response: { 200: NodePatchResult },
      },
    },
    async (request, reply) => {
      if (request.body.parentId !== undefined) {
        await authorizeExtra(app, request, 'node:move');
        await authorizeParent(app, request, request.body.parentId);
      }
      const outcome = await patchNode(
        services(request),
        await mutationInput(request, request.params.nodeId),
        request.body,
      );
      if (!outcome.result.dryRun)
        deps.broadcastTreeChanged(vaultIdOf(request), outcome.treeVersion, outcome.changes);
      return reply.header('etag', strongEtag(outcome.result.node.version)).send(outcome.result);
    },
  );

  const trash = routeSpec('nodes.trash');
  api.post(
    trash.path,
    {
      config: { auth: trash.auth },
      schema: {
        operationId: trash.operationId,
        tags: [trash.tag],
        summary: trash.summary,
        params: NodeIdParams,
        body: TrashNodeBody,
        response: { 200: TrashNodeResult },
      },
    },
    async (request) => {
      const result = await trashNode(
        { ...services(request), ...deps.lifecycle },
        await mutationInput(request, request.params.nodeId),
        request.body.recursive,
      );
      deps.broadcastTreeChanged(
        vaultIdOf(request),
        result.treeVersion,
        treeChanges(result.nodes, 'trashed'),
      );
      return result;
    },
  );

  const restore = routeSpec('nodes.restore');
  api.post(
    restore.path,
    {
      config: { auth: restore.auth },
      schema: {
        operationId: restore.operationId,
        tags: [restore.tag],
        summary: restore.summary,
        params: NodeIdParams,
        body: RestoreNodeBody,
        response: { 200: RestoreNodeResult },
      },
    },
    async (request) => {
      if (request.body.newParentId !== undefined)
        await authorizeParent(app, request, request.body.newParentId);
      const result = await restoreNode(
        services(request),
        await mutationInput(request, request.params.nodeId),
        request.body,
      );
      if (!result.dryRun)
        deps.broadcastTreeChanged(
          vaultIdOf(request),
          result.treeVersion,
          treeChanges(result.nodes, 'restored'),
        );
      return result;
    },
  );

  const purge = routeSpec('nodes.purge');
  api.delete(
    purge.path,
    {
      config: { auth: purge.auth },
      schema: {
        operationId: purge.operationId,
        tags: [purge.tag],
        summary: purge.summary,
        params: NodeIdParams,
        querystring: PurgeNodeQuery,
        response: { 204: EMPTY_RESPONSE },
      },
    },
    async (request, reply) => {
      const result = await purgeNode(
        { ...services(request), ...deps.lifecycle },
        await mutationInput(request, request.params.nodeId),
      );
      deps.broadcastTreeChanged(
        vaultIdOf(request),
        result.treeVersion,
        treeChanges(result.nodes, 'purged'),
      );
      return reply.code(204).send();
    },
  );

  const inbound = routeSpec('nodes.inboundLinks');
  api.get(
    inbound.path,
    {
      config: { auth: inbound.auth },
      schema: {
        operationId: inbound.operationId,
        tags: [inbound.tag],
        summary: inbound.summary,
        params: NodeIdParams,
        querystring: ListInboundLinksQuery,
        response: { 200: InboundLinksPage },
      },
    },
    async (request) =>
      deps
        .core()
        .listInboundLinks(
          requirePrincipal(request.principal),
          request.params.nodeId,
          request.query,
        ),
  );

  const trashed = routeSpec('trash.list');
  api.get(
    trashed.path,
    {
      config: { auth: trashed.auth },
      schema: {
        operationId: trashed.operationId,
        tags: [trashed.tag],
        summary: trashed.summary,
        params: VaultIdParams,
        querystring: ListTrashQuery,
        response: { 200: TrashPage },
      },
    },
    async (request) => {
      await authorizeExtra(app, request, 'history:read');
      return deps
        .core()
        .listTrash(requirePrincipal(request.principal), vaultIdOf(request), request.query);
    },
  );

  const impact = routeSpec('notes.renameImpact');
  api.get(
    impact.path,
    {
      config: { auth: impact.auth },
      schema: {
        operationId: impact.operationId,
        tags: [impact.tag],
        summary: impact.summary,
        params: NoteIdParams,
        querystring: RenameImpactQuery,
        response: { 200: RenameImpactResult },
      },
    },
    async (request) =>
      deps
        .core()
        .renameImpact(requirePrincipal(request.principal), request.params.noteId, request.query),
  );
}
