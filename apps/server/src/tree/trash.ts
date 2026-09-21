/** Trash, restore and purge, with transient fences released on every success and failure path. */
import {
  idFromBytes,
  LIMITS,
  NoteId,
  type Node,
  type RestoreNodeBody,
  type RestoreNodeResult,
  type TrashEntry,
  type TrashNodeResult,
  type VaultId,
} from '@iridium/contracts';
import { sql, type Transaction } from 'kysely';

import { idBytes, userIdFromBytes } from '../auth/ids.ts';
import type { Database } from '../db/schema.ts';
import { withVaultLock } from '../db/withVaultLock.ts';
import { ProblemError } from '../security/problem.ts';
import type { NodeRow } from './dto.ts';
import {
  invalidMove,
  mutationNode,
  structuralAudit,
  updateNode,
  updateSearchTitle,
  validateParent,
  assertSiblingAvailable,
  type NodeMutationInput,
  type TreeActor,
} from './mutations.ts';
import { storedNodeName, tooDeep } from './names.ts';
import {
  derivePaths,
  lockSubtreeRows,
  readNodesByIds,
  subtreeRows,
  type TreeExecutor,
} from './queries.ts';
import { readNode, type TreeServiceDeps } from './service.ts';

/** Lifecycle effects are injected so this module never owns a collaboration writer. */
export interface TreeLifecycleDeps extends TreeServiceDeps {
  readonly markClosing: (noteId: NoteId) => void;
  readonly clearClosing: (noteId: NoteId) => void;
  /** Save the acknowledged head as a trash revision in the same transaction as the tombstones. */
  readonly checkpointTrash: (
    trx: Transaction<Database>,
    noteIds: readonly NoteId[],
    actor: TreeActor,
    now: Date,
  ) => Promise<void>;
  /** The test fault registry may stop the process at this otherwise inert instruction boundary. */
  readonly afterTrashCommit?: () => void | Promise<void>;
  /** Publishes the committed lifecycle event and awaits session closure. */
  readonly afterTrash: (vaultId: VaultId, noteIds: readonly NoteId[]) => Promise<void>;
  /** Synchronously fences admitted writer queues; SQL settlement is awaited outside the vault lock. */
  readonly beginPurge: (noteIds: readonly NoteId[]) => Promise<void>;
  /** Disposes admitted tombstones outside the vault lock, before final locked revalidation. */
  readonly beforePurge: (noteIds: readonly NoteId[]) => Promise<void>;
  readonly afterPurge: (vaultId: VaultId, noteIds: readonly NoteId[]) => Promise<void>;
}

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/** The current trash entry, including its own version and surviving cascade size. */
export async function readTrashEntry(db: TreeExecutor, nodeId: Buffer): Promise<TrashEntry | null> {
  const row = await db
    .selectFrom('trash_entries as trash')
    .innerJoin('nodes', 'nodes.id', 'trash.node_id')
    .leftJoin('users', 'users.id', 'trash.deleted_by')
    .select([
      'trash.node_id',
      'trash.cascade_root_id',
      'trash.original_path',
      'trash.original_parent_id',
      'trash.deleted_by',
      'trash.deleted_at',
      'trash.expires_at',
      'nodes.kind',
      'nodes.name',
      'nodes.version',
      'users.display_name',
      'users.color_hue',
    ])
    .select((eb) =>
      eb
        .selectFrom('trash_entries as member')
        .select((inner) => inner.fn.countAll().as('count'))
        .whereRef('member.cascade_root_id', '=', 'trash.cascade_root_id')
        .as('group_count'),
    )
    .where('trash.node_id', '=', nodeId)
    .executeTakeFirst();
  if (row === undefined) return null;
  return {
    nodeId: idFromBytes(row.node_id),
    cascadeRootId: idFromBytes(row.cascade_root_id),
    kind: row.kind,
    name: row.name,
    originalPath: row.original_path,
    originalParentId: idFromBytes(row.original_parent_id),
    deletedBy: {
      id: userIdFromBytes(row.deleted_by),
      displayName: row.display_name ?? 'unknown',
      colorHue: row.color_hue ?? 0,
    },
    deletedAt: row.deleted_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    descendantCount: row.node_id.equals(row.cascade_root_id)
      ? Math.max(0, Number(row.group_count) - 1)
      : 0,
    version: row.version,
  };
}

/** Soft delete one live subtree. Closing marks precede the transaction and outlive its side effect. */
export async function trashNode(
  deps: TreeLifecycleDeps,
  input: NodeMutationInput,
  recursive: boolean,
): Promise<TrashNodeResult> {
  const marked = new Set<NoteId>();
  const mark = (rows: readonly { readonly id: Buffer; readonly kind: string }[]): void => {
    for (const row of rows) {
      if (row.kind !== 'note') continue;
      const noteId = NoteId.parse(idFromBytes(row.id));
      if (marked.has(noteId)) continue;
      deps.markClosing(noteId);
      marked.add(noteId);
    }
  };
  try {
    mark(await subtreeRows(deps.db, idBytes(input.nodeId)));
    const result = await withVaultLock(
      { db: deps.db, clock: deps.clock, vaultId: input.vaultId, ownerFence: deps.ownerFence },
      async (ctx) => {
        const target = await mutationNode(ctx.trx, input);
        if (target.deleted_at !== null)
          throw new ProblemError('invalid_state', { detail: 'The node is already trashed.' });
        const subtree = await subtreeRows(ctx.trx, target.id);
        if (subtree.length > 1 && !recursive) {
          throw new ProblemError('category_not_empty', {
            detail: `The category contains ${String(subtree.length - 1)} live descendants. Use recursive:true.`,
          });
        }
        // A creator may have won the lock after the preflight read. Fence its newly discovered note too.
        mark(subtree);
        const paths = new Map(
          (await derivePaths(ctx.trx, target.vault_id)).map((row) => [
            row.id.toString('hex'),
            row.path,
          ]),
        );
        const vault = await ctx.trx
          .selectFrom('vaults')
          .select('trash_retention_days')
          .where('id', '=', target.vault_id)
          .executeTakeFirstOrThrow();
        const now = deps.clock.date();
        const expiresAt = new Date(
          now.getTime() + vault.trash_retention_days * MILLISECONDS_PER_DAY,
        );
        await lockSubtreeRows(
          ctx.trx,
          'nodes',
          subtree.map((row) => row.id),
        );
        await deps.checkpointTrash(
          ctx.trx,
          subtree
            .filter((row) => row.kind === 'note')
            .map((row) => NoteId.parse(idFromBytes(row.id))),
          input.actor,
          now,
        );
        for (const row of subtree) {
          // eslint-disable-next-line no-await-in-loop -- all node rows precede every trash-entry row in the lock order
          await updateNode(ctx.trx, row, { deleted_at: now }, input, now);
        }
        if (input.actor.userId === null) throw new ProblemError('invalid_state');
        const actorBytes = idBytes(input.actor.userId);
        await ctx.trx
          .insertInto('trash_entries')
          .values(
            subtree.map((row) => ({
              node_id: row.id,
              vault_id: row.vault_id,
              cascade_root_id: target.id,
              deleted_by: actorBytes,
              deleted_at: now,
              original_parent_id: row.parent_id,
              original_path: paths.get(row.id.toString('hex')) ?? '',
              expires_at: expiresAt,
            })),
          )
          .execute();
        const treeVersion = await ctx.bumpTreeVersion();
        const nodes = await readNodesByIds(
          ctx.trx,
          target.vault_id,
          subtree.map((row) => row.id),
        );
        const trashEntry = await readTrashEntry(ctx.trx, target.id);
        if (trashEntry === null) throw new ProblemError('not_found');
        await deps.audit.record(ctx.trx, structuralAudit(input, 'node.trashed', nodes));
        return { nodes, trashEntry, treeVersion };
      },
    );
    await deps.afterTrashCommit?.();
    await deps.afterTrash(
      input.vaultId,
      result.nodes.filter((row) => row.kind === 'note').map((row) => NoteId.parse(row.id)),
    );
    return result;
  } finally {
    for (const noteId of marked) deps.clearClosing(noteId);
  }
}

/** Restore a cascade root's remaining members, or just the selected member. */
export async function restoreNode(
  deps: TreeServiceDeps,
  input: NodeMutationInput,
  options: RestoreNodeBody,
): Promise<RestoreNodeResult> {
  return withVaultLock(
    {
      db: deps.db,
      clock: deps.clock,
      vaultId: input.vaultId,
      ownerFence: deps.ownerFence,
      mode: options.dryRun ? 'read' : 'structural',
    },
    async (ctx) => {
      const target = await mutationNode(ctx.trx, input);
      if (target.deleted_at === null) throw new ProblemError('not_found');
      const entry = await ctx.trx
        .selectFrom('trash_entries')
        .selectAll()
        .where('node_id', '=', target.id)
        .executeTakeFirst();
      if (entry === undefined) throw new ProblemError('not_found');
      const entries = target.id.equals(entry.cascade_root_id)
        ? await ctx.trx
            .selectFrom('trash_entries')
            .selectAll()
            .where('cascade_root_id', '=', target.id)
            .execute()
        : [entry];
      const restoring = new Set(entries.map((row) => row.node_id.toString('hex')));
      const rows = await ctx.trx
        .selectFrom('nodes')
        .selectAll()
        .where(
          'id',
          'in',
          entries.map((row) => row.node_id),
        )
        .execute();
      const rowsById = new Map(rows.map((row) => [row.id.toString('hex'), row]));
      const planned = entries.map((trash) => {
        const row = rowsById.get(trash.node_id.toString('hex'));
        if (row === undefined) throw new ProblemError('not_found');
        return {
          row,
          parentId:
            row.id.equals(target.id) && options.newParentId !== undefined
              ? idBytes(options.newParentId)
              : trash.original_parent_id,
          name:
            row.id.equals(target.id) && options.newName !== undefined
              ? storedNodeName(options.newName, row.kind, 'body.newName')
              : row.name,
        };
      });
      const prospective = new Map(planned.map((item) => [item.row.id.toString('hex'), item]));
      const allNodes = await ctx.trx
        .selectFrom('nodes')
        .select(['id', 'parent_id'])
        .where('vault_id', '=', target.vault_id)
        .execute();
      const allParents = new Map(allNodes.map((row) => [row.id.toString('hex'), row.parent_id]));
      const depths = new Map<string, number>();
      const depthOf = (nodeId: Buffer, seen: ReadonlySet<string> = new Set()): number => {
        const key = nodeId.toString('hex');
        if (seen.has(key))
          throw invalidMove('cycle', 'Restoring these parents would create a cycle.');
        const known = depths.get(key);
        if (known !== undefined) return known;
        const parent = prospective.get(key)?.parentId ?? allParents.get(key);
        if (parent === undefined)
          throw invalidMove('parent_not_category', 'A restore parent no longer exists.');
        const depth = nodeId.equals(parent) ? 0 : depthOf(parent, new Set([...seen, key])) + 1;
        depths.set(key, depth);
        return depth;
      };
      for (const item of planned) {
        // eslint-disable-next-line no-await-in-loop -- validate against the one serialized restore snapshot
        await validateParent(ctx.trx, item.row, item.parentId, { restoring, checkDepth: false });
        // eslint-disable-next-line no-await-in-loop -- database collation decides each sibling conflict
        await assertSiblingAvailable(ctx.trx, item.row.id, item.parentId, item.name);
        const depth = depthOf(item.row.id);
        if (depth > LIMITS.TREE_MAX_DEPTH) throw tooDeep(depth);
      }
      // Trashed descendants from a different cascade still move with their restored ancestor.
      for (const node of allNodes) {
        const depth = depthOf(node.id);
        if (depth > LIMITS.TREE_MAX_DEPTH) throw tooDeep(depth);
      }
      const ordered = planned.toSorted(
        (left, right) =>
          (depths.get(left.row.id.toString('hex')) ?? 0) -
          (depths.get(right.row.id.toString('hex')) ?? 0),
      );
      const duplicates = await sql<{ total: number }>`SELECT COUNT(*) AS total FROM (
      ${sql.join(
        planned.map(
          (item) =>
            sql`SELECT ${item.parentId} AS parent_id, ${item.name} COLLATE utf8mb4_0900_as_ci AS name`,
        ),
        sql` UNION ALL `,
      )}
    ) proposed GROUP BY parent_id, name HAVING COUNT(*) > 1 LIMIT 1`.execute(ctx.trx);
      if (duplicates.rows.length > 0) throw new ProblemError('name_conflict');
      if (options.dryRun) {
        return {
          nodes: await readNodesByIds(ctx.trx, target.vault_id, [
            target.id,
            ...ordered.filter((item) => !item.row.id.equals(target.id)).map((item) => item.row.id),
          ]),
          treeVersion: ctx.vault.treeVersion,
          dryRun: true,
        };
      }
      for (const item of ordered) {
        // eslint-disable-next-line no-await-in-loop -- parents become live before their children; uq_sibling checks the proposed group too
        await updateNode(
          ctx.trx,
          item.row,
          { parent_id: item.parentId, name: item.name, deleted_at: null },
          input,
          deps.clock.date(),
        );
      }
      for (const item of ordered) {
        if (item.row.kind !== 'note' || item.name === item.row.name) continue;
        // eslint-disable-next-line no-await-in-loop -- every node update precedes search-title maintenance in the structural lock order
        await updateSearchTitle(ctx.trx, item.row.id, item.name, deps.searchIndex);
      }
      await ctx.trx
        .deleteFrom('trash_entries')
        .where(
          'node_id',
          'in',
          entries.map((row) => row.node_id),
        )
        .execute();
      const treeVersion = await ctx.bumpTreeVersion();
      const ids = [
        target.id,
        ...ordered.filter((item) => !item.row.id.equals(target.id)).map((item) => item.row.id),
      ];
      const nodes = await readNodesByIds(ctx.trx, target.vault_id, ids);
      await deps.audit.record(ctx.trx, structuralAudit(input, 'node.restored', nodes));
      return { nodes, treeVersion, dryRun: false };
    },
  );
}

type PurgeResult = { readonly nodes: readonly Node[]; readonly treeVersion: number };

/** A changed candidate is normal for a resumable job racing a user's restore. */
export type ExpiredTrashResult =
  | ({ readonly status: 'purged' } & PurgeResult)
  | {
      readonly status: 'skipped';
      readonly reason: 'missing' | 'changed' | 'not_expired' | 'not_root';
    };

class ExpiredTrashSkip extends Error {
  readonly reason: Extract<ExpiredTrashResult, { status: 'skipped' }>['reason'];
  constructor(reason: Extract<ExpiredTrashResult, { status: 'skipped' }>['reason']) {
    super(`The expired trash candidate was skipped: ${reason}.`);
    this.reason = reason;
  }
}

/** Expiry and validator are rechecked inside the same owner-fenced lock that deletes the subtree. */
export async function purgeExpiredTrash(
  deps: TreeLifecycleDeps,
  input: Pick<NodeMutationInput, 'vaultId' | 'nodeId' | 'version' | 'context'> & {
    readonly expiresBefore: Date;
  },
): Promise<ExpiredTrashResult> {
  try {
    const result = await purge(
      deps,
      { ...input, actor: { userId: null, sessionId: null, displayName: 'system' } },
      input.expiresBefore,
    );
    return { status: 'purged', ...result };
  } catch (error) {
    if (error instanceof ExpiredTrashSkip) return { status: 'skipped', reason: error.reason };
    if (error instanceof ProblemError && error.code === 'not_found')
      return { status: 'skipped', reason: 'missing' };
    throw error;
  }
}

/** Permanent deletion is restricted to tombstones, includes all descendants and retains audit hashes. */
export function purgeNode(deps: TreeLifecycleDeps, input: NodeMutationInput): Promise<PurgeResult> {
  return purge(deps, input);
}

async function purge(
  deps: TreeLifecycleDeps,
  input: NodeMutationInput,
  expiresBefore?: Date,
): Promise<{ readonly nodes: readonly Node[]; readonly treeVersion: number }> {
  const marked = new Set<NoteId>();
  const fences: Promise<void>[] = [];
  try {
    const prepared = await withVaultLock(
      {
        db: deps.db,
        clock: deps.clock,
        vaultId: input.vaultId,
        ownerFence: deps.ownerFence,
        mode: 'read',
      },
      async (ctx) => {
        const selection = await selectPurge(ctx.trx, input, expiresBefore);
        for (const noteId of selection.notes) {
          if (marked.has(noteId)) continue;
          deps.markClosing(noteId);
          marked.add(noteId);
        }
        const fence = deps.beginPurge(selection.notes);
        fences.push(fence);
        // Observe failure immediately while COMMIT is still awaiting I/O. Its original rejection
        // is propagated by the await outside the vault lock, never replaced with a successful result.
        void fence.catch(() => undefined);
        return selection.notes;
      },
    );
    // A projection publisher may already be waiting for the vault's shared lock. Never wait for
    // that writer while holding the structural lock it needs. The owned closing marks prevent
    // replacement documents from being admitted while the old writers settle and unload.
    await Promise.all(fences);
    await deps.beforePurge(prepared);
    const result = await withVaultLock(
      { db: deps.db, clock: deps.clock, vaultId: input.vaultId, ownerFence: deps.ownerFence },
      async (ctx) => {
        const { target, subtree, ids, notes } = await selectPurge(ctx.trx, input, expiresBefore);
        // A valid tombstone cannot gain children without a version-changing restore. Keep the
        // admission check explicit so no future structural operation can purge an unfenced writer.
        if (notes.some((noteId) => !marked.has(noteId))) {
          throw new ProblemError('stale_version', {
            current: await readNode(ctx.trx, input.nodeId),
          });
        }
        // Writers settled before this transaction. The point locks retain the declared global
        // parent order without broad scans locking unrelated notes in this vault.
        await lockSubtreeRows(ctx.trx, 'nodes', ids);
        const nodes = await readNodesByIds(ctx.trx, target.vault_id, ids);
        const hashes = nodes
          .filter((node) => node.kind === 'note')
          .map((node) => ({ noteId: node.id, contentHash: node.note?.contentHash ?? null }));
        const noteBytes = notes.map((noteId) => idBytes(noteId));
        if (noteBytes.length > 0) {
          await lockSubtreeRows(ctx.trx, 'notes', noteBytes);
          await lockSubtreeRows(ctx.trx, 'note_docs', noteBytes);
          await ctx.trx.deleteFrom('note_links').where('from_note_id', 'in', noteBytes).execute();
          await deps.searchIndex.remove(notes, ctx.trx);
          await ctx.trx
            .deleteFrom('note_projection_terms')
            .where('note_id', 'in', noteBytes)
            .execute();
          await ctx.trx.deleteFrom('note_projections').where('note_id', 'in', noteBytes).execute();
          await ctx.trx.deleteFrom('note_revisions').where('note_id', 'in', noteBytes).execute();
          await ctx.trx.deleteFrom('note_updates').where('note_id', 'in', noteBytes).execute();
          await ctx.trx.deleteFrom('note_docs').where('note_id', 'in', noteBytes).execute();
          await ctx.trx.deleteFrom('notes').where('node_id', 'in', noteBytes).execute();
        }
        await ctx.trx
          .updateTable('note_links')
          .set({ resolved_node_id: null, status: 'broken' })
          .where('vault_id', '=', target.vault_id)
          .where('resolved_node_id', 'in', ids)
          .execute();
        await ctx.trx.deleteFrom('trash_entries').where('node_id', 'in', ids).execute();
        for (const row of subtree.toReversed()) {
          // eslint-disable-next-line no-await-in-loop -- fk_nodes_parent requires descendants to disappear before parents
          await ctx.trx.deleteFrom('nodes').where('id', '=', row.id).execute();
        }
        const treeVersion = await ctx.bumpTreeVersion();
        await deps.audit.record(
          ctx.trx,
          structuralAudit(input, 'node.purged', nodes, { notes: hashes }),
        );
        return { nodes, treeVersion };
      },
    );
    await deps.afterPurge(
      input.vaultId,
      result.nodes.filter((node) => node.kind === 'note').map((node) => NoteId.parse(node.id)),
    );
    return result;
  } finally {
    // A failed admission COMMIT must not reopen a document while its old SQL is still settling.
    await Promise.allSettled(fences);
    for (const noteId of marked) deps.clearClosing(noteId);
  }
}

interface PurgeSelection {
  readonly target: NodeRow;
  readonly subtree: readonly (NodeRow & { readonly depth: number })[];
  readonly ids: readonly Buffer[];
  readonly notes: readonly NoteId[];
}

/** Admission and final deletion apply the same validator, cascade and retention rules. */
async function selectPurge(
  trx: Transaction<Database>,
  input: NodeMutationInput,
  expiresBefore: Date | undefined,
): Promise<PurgeSelection> {
  if (expiresBefore !== undefined) {
    const candidate = await trx
      .selectFrom('nodes')
      .select(['id', 'version', 'deleted_at'])
      .where('id', '=', idBytes(input.nodeId))
      .where('vault_id', '=', idBytes(input.vaultId))
      .executeTakeFirst();
    if (candidate === undefined) throw new ExpiredTrashSkip('missing');
    if (candidate.version !== input.version || candidate.deleted_at === null)
      throw new ExpiredTrashSkip('changed');
    const entry = await trx
      .selectFrom('trash_entries')
      .select(['cascade_root_id', 'expires_at'])
      .where('node_id', '=', candidate.id)
      .executeTakeFirst();
    if (entry === undefined) throw new ExpiredTrashSkip('changed');
    if (!entry.cascade_root_id.equals(candidate.id)) throw new ExpiredTrashSkip('not_root');
    if (entry.expires_at.getTime() > expiresBefore.getTime())
      throw new ExpiredTrashSkip('not_expired');
  }
  const target = await mutationNode(trx, input);
  if (target.deleted_at === null)
    throw new ProblemError('invalid_state', { detail: 'Only trashed nodes can be purged.' });
  const subtree = await subtreeRows(trx, target.id, true);
  if (subtree.some((row) => row.deleted_at === null))
    throw new ProblemError('invalid_state', {
      detail: 'A live descendant must be moved before this subtree is purged.',
    });
  const ids = subtree.map((row) => row.id);
  if (expiresBefore !== undefined) {
    const unexpired = await trx
      .selectFrom('trash_entries')
      .select('node_id')
      .where('node_id', 'in', ids)
      .where('expires_at', '>', expiresBefore)
      .executeTakeFirst();
    if (unexpired !== undefined) throw new ExpiredTrashSkip('not_expired');
  }
  const notes = subtree
    .filter((row) => row.kind === 'note')
    .map((row) => NoteId.parse(idFromBytes(row.id)));
  return { target, subtree, ids, notes };
}
