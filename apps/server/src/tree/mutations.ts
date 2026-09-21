/** Structural metadata writes share one vault lock, optimistic version and audit-last boundary. */
import {
  idFromBytes,
  LIMITS,
  NodeId,
  NoteId,
  type Node,
  type NodePatchResult,
  type PatchNodeBody,
  type ServerVaultMessage,
  type SessionId,
  type UserId,
  type VaultId,
} from '@iridium/contracts';
import { sql, type Transaction } from 'kysely';

import type { AuditEventContext, AuditEventInput } from '../auth/audit.ts';
import { idBytes } from '../auth/ids.ts';
import { assertVersionedUpdate } from '../db/cas.ts';
import type { Database } from '../db/schema.ts';
import { withVaultLock } from '../db/withVaultLock.ts';
import type { SearchIndexWrites } from '../search/index.ts';
import { ProblemError } from '../security/problem.ts';
import type { NodeRow } from './dto.ts';
import { invalidMove } from './invalid-move.ts';
import { storedNodeName, tooDeep } from './names.ts';
import { parentDepth } from './paths.ts';
import { ancestorsContain, readNodesByIds, subtreeRows, type TreeExecutor } from './queries.ts';
import { renameImpact } from './rename-impact.ts';
import { readNode, type TreeServiceDeps } from './service.ts';

/** The caller identity recorded for a structural action. Jobs use a system actor for purge. */
export interface TreeActor {
  readonly userId: UserId | null;
  readonly sessionId: SessionId | null;
  readonly displayName: string;
}

/** The identity and validator common to structural writes. */
export interface NodeMutationInput {
  readonly vaultId: VaultId;
  readonly nodeId: NodeId;
  readonly version: number;
  readonly actor: TreeActor;
  readonly context: AuditEventContext;
}

/** One committed delta on the read-only vault channel. */
export type TreeChange = Extract<ServerVaultMessage, { t: 'tree-changed' }>['changes'][number];

/** Rows become deltas only after their transaction has committed. */
export function treeChanges(nodes: readonly Node[], op: TreeChange['op']): readonly TreeChange[] {
  return nodes.map((node) => ({
    nodeId: NodeId.parse(node.id),
    parentId: NodeId.parse(node.parentId),
    kind: node.kind,
    name: node.name,
    path: node.path,
    op,
    version: node.version,
  }));
}

/** A live or trashed target, checked under the same lock as its eventual mutation. */
export async function mutationNode(db: TreeExecutor, input: NodeMutationInput): Promise<NodeRow> {
  const row = await db
    .selectFrom('nodes')
    .selectAll()
    .where('id', '=', idBytes(input.nodeId))
    .where('vault_id', '=', idBytes(input.vaultId))
    .executeTakeFirst();
  if (row === undefined) throw new ProblemError('not_found');
  if (row.id.equals(row.parent_id))
    throw new ProblemError('invalid_state', { detail: 'The vault root is immutable.' });
  if (row.version !== input.version) {
    throw new ProblemError('stale_version', { current: await readNode(db, input.nodeId) });
  }
  return row;
}

/** Validate every move invariant against the serialized structural snapshot. */
export async function validateParent(
  db: TreeExecutor,
  node: NodeRow,
  parentId: Buffer,
  options: { readonly restoring?: ReadonlySet<string>; readonly checkDepth?: boolean } = {},
): Promise<NodeRow> {
  const parent = await db
    .selectFrom('nodes')
    .selectAll()
    .where('id', '=', parentId)
    .executeTakeFirst();
  if (parent === undefined)
    throw invalidMove(
      'parent_not_category',
      'The parent no longer exists; choose a live category.',
    );
  if (!parent.vault_id.equals(node.vault_id))
    throw invalidMove('cross_vault', 'A node cannot move to another vault.');
  if (await ancestorsContain(db, parentId, node.id))
    throw invalidMove('cycle', 'A node cannot be its own ancestor.');
  if (
    parent.kind !== 'category' ||
    (parent.deleted_at !== null && !options.restoring?.has(parent.id.toString('hex')))
  ) {
    throw invalidMove('parent_not_category', 'The parent must be a live category.');
  }
  if (options.checkDepth !== false) {
    const subtree = await subtreeRows(db, node.id, true);
    const height = Math.max(0, ...subtree.map((row) => row.depth));
    const depth = (await parentDepth(db, parentId)) + 1 + height;
    if (depth > LIMITS.TREE_MAX_DEPTH) throw tooDeep(depth);
  }
  return parent;
}

/** SELECT uses the same collation and live predicate as uq_sibling, including dry runs. */
export async function assertSiblingAvailable(
  db: TreeExecutor,
  nodeId: Buffer,
  parentId: Buffer,
  name: string,
): Promise<void> {
  if (await siblingNameConflicts(db, nodeId, parentId, name))
    throw new ProblemError('name_conflict', { detail: 'A live sibling already has that name.' });
}

/** The collision predicate is shared by previews and accepted writes. */
export async function siblingNameConflicts(
  db: TreeExecutor,
  nodeId: Buffer,
  parentId: Buffer,
  name: string,
): Promise<boolean> {
  const existing = await db
    .selectFrom('nodes')
    .select('id')
    .where('parent_id', '=', parentId)
    .where('name', '=', name)
    .where('deleted_at', 'is', null)
    .where('id', '!=', nodeId)
    .executeTakeFirst();
  return existing !== undefined;
}

/** One event descriptor; callers write it only after all other database work. */
export function structuralAudit(
  input: NodeMutationInput,
  action: AuditEventInput['action'],
  nodes: readonly Node[],
  metadata?: Readonly<Record<string, unknown>>,
): AuditEventInput {
  return {
    action,
    actorType: input.actor.userId === null ? 'system' : 'user',
    actorId: input.actor.userId,
    actorDisplay: input.actor.displayName,
    credentialType: input.actor.sessionId === null ? 'system' : 'session',
    credentialId: input.actor.sessionId,
    vaultId: input.vaultId,
    targetType: 'node',
    targetId: input.nodeId,
    targets: nodes.map((node) => ({ type: 'node', id: node.id, path: node.path })),
    outcome: 'success',
    context: input.context,
    ...(metadata === undefined ? {} : { metadata }),
  };
}

/** Versioned UPDATE shared by rename/move and lifecycle operations. */
export async function updateNode(
  trx: Transaction<Database>,
  node: NodeRow,
  values: {
    readonly name?: string;
    readonly parent_id?: Buffer;
    readonly deleted_at?: Date | null;
  },
  input: NodeMutationInput,
  now: Date,
): Promise<void> {
  if (input.actor.userId === null) throw new ProblemError('invalid_state');
  const result = await trx
    .updateTable('nodes')
    .set({
      ...values,
      version: sql<number>`version + 1`,
      updated_by: idBytes(input.actor.userId),
      updated_at: now,
    })
    .where('id', '=', node.id)
    .where('vault_id', '=', node.vault_id)
    .where('version', '=', node.version)
    .where('deleted_at', node.deleted_at === null ? 'is' : 'is not', null)
    .executeTakeFirstOrThrow();
  assertVersionedUpdate(result, {
    table: 'nodes',
    id: idFromBytes(node.id),
    expected: node.version,
  });
}

/** Filename-derived search titles follow a structural rename; projected H1 titles remain authoritative. */
export async function updateSearchTitle(
  trx: Transaction<Database>,
  nodeId: Buffer,
  name: string,
  searchIndex: SearchIndexWrites,
): Promise<void> {
  await searchIndex.index(
    { noteId: NoteId.parse(idFromBytes(nodeId)), title: name, source: 'filename' },
    trx,
  );
}

/** Rename and move have one validation path; preview holds the lock but cannot bump or write. */
export async function patchNode(
  deps: TreeServiceDeps,
  input: NodeMutationInput,
  patch: PatchNodeBody,
): Promise<{
  readonly result: NodePatchResult;
  readonly treeVersion: number;
  readonly changes: readonly TreeChange[];
}> {
  return withVaultLock(
    {
      db: deps.db,
      clock: deps.clock,
      ownerFence: deps.ownerFence,
      vaultId: input.vaultId,
      mode: patch.dryRun ? 'read' : 'structural',
    },
    async (ctx) => {
      const node = await mutationNode(ctx.trx, input);
      if (node.deleted_at !== null) throw new ProblemError('node_trashed');
      const name = patch.name === undefined ? node.name : storedNodeName(patch.name, node.kind);
      const parentId = patch.parentId === undefined ? node.parent_id : idBytes(patch.parentId);
      await validateParent(ctx.trx, node, parentId);
      await assertSiblingAvailable(ctx.trx, node.id, parentId, name);
      const affectedLinks = await renameImpact(ctx.trx, input.vaultId, input.nodeId);
      if (patch.dryRun) {
        const current = await readNode(ctx.trx, input.nodeId);
        if (current === null) throw new ProblemError('not_found');
        return {
          result: { node: current, affectedLinks, dryRun: true },
          treeVersion: ctx.vault.treeVersion,
          changes: [],
        };
      }
      await updateNode(ctx.trx, node, { name, parent_id: parentId }, input, deps.clock.date());
      if (node.kind === 'note' && patch.name !== undefined) {
        await updateSearchTitle(ctx.trx, node.id, name, deps.searchIndex);
      }
      const treeVersion = await ctx.bumpTreeVersion();
      const [changed] = await readNodesByIds(ctx.trx, idBytes(input.vaultId), [node.id]);
      if (changed === undefined) throw new ProblemError('not_found');
      const op = patch.parentId === undefined ? 'renamed' : 'moved';
      await deps.audit.record(
        ctx.trx,
        structuralAudit(input, op === 'renamed' ? 'node.renamed' : 'node.moved', [changed], {
          before: { name: node.name, parentId: idFromBytes(node.parent_id) },
          after: { name, parentId: idFromBytes(parentId) },
        }),
      );
      return {
        result: { node: changed, affectedLinks, dryRun: false },
        treeVersion,
        changes: treeChanges([changed], op),
      };
    },
  );
}
