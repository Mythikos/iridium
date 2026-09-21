/**
 * Category and note creation (09-api-reference.md §2.7; 03-data-model.md §6.4).
 *
 * The transaction is `withVaultLock`'s: the owner generation and then the vault row are locked, so the snapshot is established
 * after the lock, the parent is validated against the rules of §2.7, the `nodes` row is inserted,
 * `NoteService.initialize` runs **inside the same transaction** for a note, `tree_version` is bumped,
 * and the audit row is last because it locks `audit_chain_heads` (A46). The `tree-changed` broadcast
 * is a post-COMMIT side effect and belongs to the caller.
 *
 * **Why the parent is read without `FOR UPDATE`.** The vault lock is the per-vault mutex: no other
 * structural transaction on this vault can run concurrently, so the parent cannot be trashed or
 * renamed between the read and the insert. Locking it as well would add a second row lock for no
 * additional serialisation and would widen the window for a deadlock against a subtree operation.
 *
 * Categories have no document. Note parsing happens before the lock and initialization commits
 * with the structural row, so neither an orphan note nor a partially projected note is visible.
 */
import {
  newId,
  NodeId,
  NoteId,
  type Node,
  type SessionId,
  type UserId,
  type VaultId,
} from '@iridium/contracts';
import type { NoteProjection } from '@iridium/markdown';
import type { Kysely, Transaction } from 'kysely';

import type { AuditEventContext, AuditRecorder } from '../auth/audit.ts';
import { idBytes } from '../auth/ids.ts';
import type { OwnerFence } from '../collab/owner-lease.ts';
import type { Database } from '../db/index.ts';
import type { NodeKind } from '../db/schema.ts';
import { withVaultLock } from '../db/withVaultLock.ts';
import type { Clock } from '../ops/clock.ts';
import type { SearchIndexWrites } from '../search/index.ts';
import { ProblemError } from '../security/problem.ts';
import { NODE_COLUMNS, toNodeDto, type NoteSummaryRow, type UserRefRow } from './dto.ts';
import { assertChildDepth, storedNodeName } from './names.ts';
import { derivePath, parentDepth } from './paths.ts';

/**
 * The note kernel this area calls into. It is the shape of `app.notes` that node creation uses and
 * nothing more, declared structurally so the tree area depends on the *contract* of the note service
 * (05-collaboration-and-durability.md, "NoteService.initialize") rather than on its module.
 */
export interface NoteInitializer {
  prepare?(markdown: string): Promise<NoteProjection>;
  initialize(
    trx: Transaction<Database>,
    input: {
      readonly noteId: NoteId;
      readonly markdown: string;
      readonly origin: 'create' | 'import';
      readonly actor: {
        readonly userId: UserId | null;
        readonly sessionId: SessionId | null;
        readonly actorType: 'user' | 'system';
      };
      readonly now: Date;
      readonly prepared?: NoteProjection;
    },
  ): Promise<unknown>;
}

/** What creating a node takes. */
export interface CreateNodeInput {
  readonly vaultId: VaultId;
  readonly kind: NodeKind;
  readonly parentId: string;
  readonly name: string;
  readonly markdown?: string | undefined;
  readonly actor: {
    readonly userId: UserId;
    readonly sessionId: SessionId;
    readonly displayName: string;
  };
  readonly context: AuditEventContext;
}

/** What creating a node answers: the `201` body and the tree version the broadcast carries. */
export interface CreatedNode {
  readonly node: Node;
  readonly treeVersion: number;
}

/** What node creation needs from the instance. */
export interface TreeServiceDeps {
  readonly searchIndex: SearchIndexWrites;
  readonly ownerFence: OwnerFence;
  readonly db: Kysely<Database>;
  readonly clock: Clock;
  readonly audit: AuditRecorder;
  readonly notes: NoteInitializer;
}

/** The reasons a `409 invalid_move` carries on this route (§2.7). */
type InvalidMoveReason = 'parent_not_category' | 'cross_vault' | 'depth';

function invalidMove(reason: InvalidMoveReason, detail: string): ProblemError {
  return new ProblemError('invalid_move', {
    detail,
    errors: [{ path: 'body.parentId', message: reason, code: reason }],
  });
}

/** The `UserRef` rows a node read needs, by id. */
async function userRefs(
  db: Kysely<Database>,
  ids: readonly Buffer[],
): Promise<ReadonlyMap<string, UserRefRow>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .selectFrom('users')
    .select(['id', 'display_name', 'color_hue'])
    .where('id', 'in', [...ids])
    .execute();
  return new Map(rows.map((row) => [row.id.toString('hex'), row]));
}

/** An actor row that is not in `users` any more: attribution survives, the name does not. */
function unknownUser(id: Buffer): UserRefRow {
  return { id, display_name: 'unknown', color_hue: 0 };
}

/** One node with its derived path and, for a note, its committed `NoteSummary` block. */
export async function readNode(db: Kysely<Database>, nodeId: NodeId): Promise<Node | null> {
  const id = idBytes(nodeId);
  const row = await db
    .selectFrom('nodes')
    .select(NODE_COLUMNS)
    .where('nodes.id', '=', id)
    .executeTakeFirst();
  if (row === undefined) return null;

  const [path, refs, note] = await Promise.all([
    derivePath(db, id),
    userRefs(db, [row.created_by, row.updated_by]),
    row.kind === 'note' ? readNoteSummaryRow(db, id) : Promise.resolve(undefined),
  ]);

  return toNodeDto(row, {
    path: path.path,
    createdBy: refs.get(row.created_by.toString('hex')) ?? unknownUser(row.created_by),
    updatedBy: refs.get(row.updated_by.toString('hex')) ?? unknownUser(row.updated_by),
    ...(note === undefined ? {} : { note }),
  });
}

/** The note-side columns of one note node, joined across `notes`, `note_docs` and the projection. */
export async function readNoteSummaryRow(
  db: Kysely<Database>,
  noteId: Buffer,
): Promise<NoteSummaryRow | undefined> {
  const row = await db
    .selectFrom('notes')
    .leftJoin('note_docs', 'note_docs.note_id', 'notes.node_id')
    .leftJoin('note_projections', 'note_projections.note_id', 'notes.node_id')
    .leftJoin('users as editor', 'editor.id', 'notes.last_edited_by')
    .select((eb) => [
      eb.ref('notes.size_chars').as('size_chars'),
      eb.ref('notes.oversize').as('oversize'),
      eb.ref('notes.content_invalid').as('content_invalid'),
      eb.ref('notes.last_edited_at').as('last_edited_at'),
      eb.ref('notes.last_edited_by').as('last_edited_by'),
      eb.ref('editor.display_name').as('last_edited_name'),
      eb.ref('editor.color_hue').as('last_edited_hue'),
      eb.ref('note_docs.head_seq').as('head_seq'),
      eb.ref('note_projections.revision').as('revision'),
      eb.ref('note_projections.content_hash').as('content_hash'),
      eb.ref('note_projections.heading_title').as('heading_title'),
      eb.ref('note_projections.status').as('projection_status'),
      eb.ref('note_projections.fm_tags').as('fm_tags'),
      eb.ref('note_projections.fm_aliases').as('fm_aliases'),
    ])
    .where('notes.node_id', '=', noteId)
    .executeTakeFirst();
  return row;
}

/**
 * `POST /vaults/:vaultId/nodes` — create a note under a live category (§2.7).
 *
 * @throws ProblemError `404 not_found` (unknown parent), `409 invalid_move`, `409 name_conflict`
 * (through `db/failure.ts` on `uq_sibling`), `409 vault_archived`, `409 note_oversized`,
 * `422 validation_failed` (an invalid name or an unsupported kind).
 */
export async function createNode(
  deps: TreeServiceDeps,
  input: CreateNodeInput,
): Promise<CreatedNode> {
  if (input.kind !== 'note' && input.kind !== 'category') {
    throw new ProblemError('validation_failed', {
      detail: 'Only categories and notes can be created.',
      errors: [{ path: 'body.kind', message: 'unsupported_kind', code: 'unsupported_kind' }],
    });
  }

  const name = storedNodeName(input.name, input.kind);
  const nodeId = NodeId.parse(newId());
  const nodeBytes = idBytes(nodeId);
  const vaultBytes = idBytes(input.vaultId);
  const parentBytes = idBytes(input.parentId);
  const actorBytes = idBytes(input.actor.userId);
  const prepared =
    input.kind === 'note' ? await deps.notes.prepare?.(input.markdown ?? '') : undefined;

  return withVaultLock(
    { db: deps.db, clock: deps.clock, vaultId: input.vaultId, ownerFence: deps.ownerFence },
    async (ctx) => {
      const now = deps.clock.date();
      const parent = await ctx.trx
        .selectFrom('nodes')
        .select(['vault_id', 'kind', 'deleted_at'])
        .where('id', '=', parentBytes)
        .executeTakeFirst();
      if (parent === undefined) {
        throw new ProblemError('not_found', { detail: 'No such parent node.' });
      }
      if (!parent.vault_id.equals(vaultBytes)) {
        // A parent in another vault is not a hint that the id exists: `vault_id` is immutable and a
        // cross-vault create is refused for the same reason a cross-vault move is (§6.4 step 3).
        throw invalidMove('cross_vault', 'The parent belongs to a different vault.');
      }
      if (parent.kind !== 'category') {
        throw invalidMove('parent_not_category', 'A node can only be created inside a category.');
      }
      if (parent.deleted_at !== null) {
        throw invalidMove('parent_not_category', 'The parent is in the trash; restore it first.');
      }
      assertChildDepth(await parentDepth(ctx.trx, parentBytes));

      await ctx.trx
        .insertInto('nodes')
        .values({
          id: nodeBytes,
          vault_id: vaultBytes,
          parent_id: parentBytes,
          kind: input.kind,
          name,
          deleted_at: null,
          created_by: actorBytes,
          updated_by: actorBytes,
          created_at: now,
          updated_at: now,
        })
        .execute();

      if (input.kind === 'note') {
        await ctx.trx
          .insertInto('notes')
          .values({
            node_id: nodeBytes,
            vault_id: vaultBytes,
            initialized_at: null,
            last_edited_by: actorBytes,
            last_edited_at: now,
            last_checkpoint_at: null,
            created_at: now,
            updated_at: now,
          })
          .execute();

        // The single Markdown → Y.Doc path in the system (03-data-model.md §8.8), inside this
        // transaction so a note can never exist without its initial state.
        await deps.notes.initialize(ctx.trx, {
          noteId: NoteId.parse(nodeId),
          markdown: input.markdown ?? '',
          origin: 'create',
          actor: {
            userId: input.actor.userId,
            sessionId: input.actor.sessionId,
            actorType: 'user',
          },
          now,
          ...(prepared === undefined ? {} : { prepared }),
        });
      }

      const bumped = await ctx.bumpTreeVersion();
      const node = await readNode(ctx.trx, nodeId);
      if (node === null) throw new ProblemError('not_found');

      await deps.audit.record(ctx.trx, {
        action: 'node.created',
        actorType: 'user',
        actorId: input.actor.userId,
        actorDisplay: input.actor.displayName,
        credentialType: 'session',
        credentialId: input.actor.sessionId,
        vaultId: input.vaultId,
        targetType: 'node',
        targetId: nodeId,
        outcome: 'success',
        context: input.context,
        metadata: { kind: input.kind, name, parentId: input.parentId },
      });

      return { node, treeVersion: bumped };
    },
  );
}
