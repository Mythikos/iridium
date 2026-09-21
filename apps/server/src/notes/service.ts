/**
 * `NoteService` — the note kernel (12-milestones.md §5.2, the `notes` row;
 * 05-collaboration-and-durability.md, "`NoteService.initialize` — the single Markdown → Y.Doc path";
 * 03-data-model.md §8.8).
 *
 * `initialize` is the **only** code path that turns Markdown into a Y.Doc, and it runs inside the
 * caller's `dbApp` transaction — note creation and, from M6, the import commit — never one of its
 * own. Its guard is a row lock, not an application flag: `SELECT initialized_at … FOR UPDATE`, refuse
 * when set, and flip it last inside the same transaction, so two requests racing to initialise one
 * node serialise on the lock and the loser sees the flag. `collab.no-reinit.guard` and
 * `collab.initial-state-only-path.guard` keep this the only path.
 *
 * `markdownOf` is the committed read every REST route and, from M3, every tool answers from:
 * `note_projections` at its `revision`, never the live document (A37). `fresh: true` runs a
 * compaction first for a loaded note; an unloaded note is already current.
 */
import { LIMITS, type NoteId } from '@iridium/contracts';
import { normalizeSource, type NoteProjection } from '@iridium/markdown';
import type { Kysely, Transaction } from 'kysely';

import { idBytes } from '../auth/ids.ts';
import type { CollabGateway } from '../collab/gateway.ts';
import { CollabLeaseHeldError, type CollabOwnerLease } from '../collab/owner-lease.ts';
import type { CollabPersistenceService } from '../collab/persistence/index.ts';
import { initialRows } from '../collab/persistence/initial-state.ts';
import type { UpdateActor } from '../collab/persistence/types.ts';
import type { Database } from '../db/schema.ts';
import type { Clock } from '../ops/clock.ts';
import type { ServerLogger } from '../ops/logging.ts';
import type { PrepareProjection } from '../projection/prepare.ts';
import { readCommittedMarkdown, type CommittedMarkdown } from '../projection/read.ts';
import { upsertProjection } from '../projection/write.ts';
import type { SearchIndexWrites } from '../search/index.ts';
import { ProblemError } from '../security/problem.ts';
import { NoteOversizedError } from './errors.ts';

export { NoteOversizedError } from './errors.ts';

import { repairContent, type RepairDeps, type RepairOptions, type RepairReport } from './repair.ts';

/** What `initialize` takes. */
export interface InitializeNoteInput {
  /** Prepared before the caller's structural transaction, using prepare(). */
  readonly prepared?: NoteProjection;
  readonly noteId: NoteId;
  /** The raw text as received: `normalizeSource` runs here, exactly once. */
  readonly markdown: string;
  readonly origin: 'create' | 'import';
  readonly actor: UpdateActor;
  readonly now: Date;
}

/** What `initialize` answers: the first revision and what the route's ETag is built from. */
export interface InitializedNote {
  readonly seq: 1;
  readonly contentHash: Buffer;
  readonly sizeChars: number;
}

/** The note kernel as the instance decorates it (`app.notes`). */
export interface NoteServices {
  prepare(markdown: string): Promise<NoteProjection>;
  initialize(trx: Transaction<Database>, input: InitializeNoteInput): Promise<InitializedNote>;
  markClosing(noteId: NoteId): void;
  clearClosing(noteId: NoteId): void;
  closeNote(noteId: NoteId, reason: 'note-trashed' | 'note-closing'): Promise<void>;
  repairContent(noteId: NoteId, options: RepairOptions): Promise<RepairReport>;
  markdownOf(
    noteId: NoteId,
    options?: { readonly fresh?: boolean },
  ): Promise<CommittedMarkdown | null>;
}

/** Thrown when `notes.initialized_at` is already set: the note has a document of record. */
export class AlreadyInitializedError extends Error {
  readonly code = 'notes.already_initialized';
  readonly noteId: NoteId;

  constructor(noteId: NoteId) {
    super(
      `note ${noteId} is already initialised. A note's document is built from Markdown exactly once ` +
        '(05-collaboration-and-durability.md); an import that resumes after a crash skips it, and a ' +
        'second creation is a new node.',
    );
    this.name = 'AlreadyInitializedError';
    this.noteId = noteId;
  }
}

/** Thrown when the `notes` row the caller should have inserted is absent. */
export class NoteRowMissingError extends Error {
  readonly code = 'notes.row_missing';

  constructor(noteId: NoteId) {
    super(
      `note ${noteId} has no notes row. The caller inserts the nodes and notes rows in the same ` +
        'transaction before calling NoteService.initialize (03-data-model.md §8.8).',
    );
    this.name = 'NoteRowMissingError';
  }
}

/** What the kernel needs. */
export interface NoteServicesOptions {
  readonly logger?: Pick<ServerLogger, 'warn'>;
  readonly searchIndex: SearchIndexWrites;
  readonly prepareProjection: PrepareProjection;
  readonly gateway: CollabGateway;
  readonly persistence: CollabPersistenceService;
  /** `dbApp`, resolved per call. */
  readonly db: () => Kysely<Database> | null;
  readonly clock: Clock;
  readonly repair: Omit<RepairDeps, 'gateway' | 'persistence' | 'db' | 'clock'>;
  /** A `server` already holds the lease; a `cli` boot takes it around the repair (D10-33). */
  readonly role: 'server' | 'cli';
  readonly ownerLease: Pick<CollabOwnerLease, 'tryAcquire' | 'relinquish' | 'held'>;
}

/** Builds the kernel. */
export function createNoteServices(options: NoteServicesOptions): NoteServices {
  const { gateway, persistence } = options;

  const initialize = async (
    trx: Transaction<Database>,
    input: InitializeNoteInput,
  ): Promise<InitializedNote> => {
    const id = idBytes(input.noteId);

    // 1. The double-initialisation guard: a row lock, not an application flag.
    const row = await trx
      .selectFrom('notes')
      .select(['initialized_at'])
      .where('node_id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    if (row === undefined) throw new NoteRowMissingError(input.noteId);
    if (row.initialized_at !== null) throw new AlreadyInitializedError(input.noteId);

    // 2. Normalise once; the hard cap is enforced here.
    const normalized = normalizeSource(input.markdown);
    if (normalized.text.length > LIMITS.NOTE_HARD_MAX_UTF16) {
      throw new NoteOversizedError(normalized.text.length);
    }

    // 3. The throwaway document, and the five rows.
    const rows = initialRows({
      noteId: input.noteId,
      markdownLf: normalized.text,
      origin: input.origin,
      actor: input.actor,
      now: input.now,
      originalEol: normalized.originalEol,
      hadBom: normalized.hadBom,
    });

    // 4. seq 1 of the durability log.
    await trx
      .insertInto('note_updates')
      .values({
        note_id: id,
        seq: rows.update.seq,
        update_v1: Buffer.from(rows.update.updateV1),
        yjs_major: rows.doc.yjsMajor,
        sv_after: Buffer.from(rows.update.svAfter),
        actor_type: rows.update.actor.actorType,
        actor_id: rows.update.actor.userId === null ? null : idBytes(rows.update.actor.userId),
        session_id:
          rows.update.actor.sessionId === null ? null : idBytes(rows.update.actor.sessionId),
        origin: rows.update.origin,
        created_at: rows.update.createdAt,
      })
      .execute();

    // 5. The persistence anchor, already compacted through seq 1.
    await trx
      .insertInto('note_docs')
      .values({
        note_id: id,
        head_seq: rows.doc.headSeq,
        snapshot_format: rows.doc.snapshotFormat,
        yjs_major: rows.doc.yjsMajor,
        snapshot: Buffer.from(rows.doc.snapshot),
        snapshot_sv: Buffer.from(rows.doc.snapshotSv),
        snapshot_through_seq: rows.doc.snapshotThroughSeq,
        snapshot_size: rows.doc.snapshotSize,
        snapshot_at: rows.doc.snapshotAt,
        projected_seq: rows.doc.projectedSeq,
        updated_at: input.now,
      })
      .execute();

    // 6. The first checkpoint (kind = origin) and the first committed projection.
    await trx
      .insertInto('note_revisions')
      .values({
        note_id: id,
        seq: rows.revision.seq,
        kind: rows.revision.kind,
        label: null,
        markdown: rows.revision.markdown,
        content_hash: rows.revision.contentHash,
        size_chars: rows.revision.sizeChars,
        snapshot: rows.revision.snapshot === null ? null : Buffer.from(rows.revision.snapshot),
        snapshot_format: rows.doc.snapshotFormat,
        yjs_major: rows.doc.yjsMajor,
        snapshot_sv:
          rows.revision.snapshotSv === null ? null : Buffer.from(rows.revision.snapshotSv),
        actor_type: rows.revision.actor.actorType,
        actor_id: rows.revision.actor.userId === null ? null : idBytes(rows.revision.actor.userId),
        restored_from_revision_id: null,
        created_at: rows.revision.createdAt,
      })
      .execute();
    await upsertProjection(
      trx,
      {
        ...(input.prepared === undefined ? {} : { prepared: input.prepared }),
        logger: options.logger,
        noteId: id,
        revision: rows.projection.revision,
        markdown: rows.projection.markdown,
        contentHash: rows.projection.contentHash,
        pipelineVersion: rows.projection.pipelineVersion,
        now: rows.projection.now,
        strict: false,
      },
      options.searchIndex,
    );

    // 7. The guard, flipped last, inside the same transaction.
    await trx
      .updateTable('notes')
      .set({
        initialized_at: rows.note.initializedAt,
        original_eol: rows.note.originalEol,
        had_bom: rows.note.hadBom,
        size_chars: rows.note.sizeChars,
        updated_at: input.now,
      })
      .where('node_id', '=', id)
      .where('initialized_at', 'is', null)
      .execute();

    return { seq: 1, contentHash: rows.contentHash, sizeChars: rows.sizeChars };
  };

  const markdownOf = async (
    noteId: NoteId,
    readOptions: { readonly fresh?: boolean } = {},
  ): Promise<CommittedMarkdown | null> => {
    const db = options.db();
    if (db === null) return null;
    const committed = await readCommittedMarkdown(db, idBytes(noteId));
    if (readOptions.fresh !== true || committed === null) return committed;
    if (committed.status === 'invalid_content') throw new ProblemError('content_invalid');
    if (committed.revision === committed.headSeq) return committed;
    if (!options.ownerLease.held) throw new ProblemError('unavailable', { retryAfterMs: 1_000 });
    const held =
      persistence.writerOf(noteId) === undefined
        ? await gateway.openServerDocument(noteId, {
            principal: { kind: 'system', job: 'notes:fresh' },
            permission: 'history:read',
          })
        : null;
    try {
      const outcome = await persistence.compactNow(noteId, { trigger: 'flush' });
      if (outcome?.contentInvalid !== null && outcome?.contentInvalid !== undefined) {
        throw new ProblemError('content_invalid');
      }
      const fresh = await readCommittedMarkdown(db, idBytes(noteId));
      if (fresh?.status === 'invalid_content') throw new ProblemError('content_invalid');
      return fresh;
    } finally {
      await held?.disconnect();
    }
  };

  const repairDeps: RepairDeps = {
    ...options.repair,
    gateway,
    persistence,
    db: options.db,
    clock: options.clock,
  };

  /**
   * A server-role process holds the lease for as long as it serves. A CLI boot holds none, so the
   * repair takes it for its own duration and refuses — with the remedy — while a server has it.
   */
  const repairWithLease = async (
    noteId: NoteId,
    repairOptions: RepairOptions,
  ): Promise<RepairReport> => {
    if (options.role === 'server') {
      if (!options.ownerLease.held) throw new CollabLeaseHeldError();
      return repairContent(repairDeps, noteId, repairOptions);
    }
    if (!(await options.ownerLease.tryAcquire())) throw new CollabLeaseHeldError();
    try {
      return await repairContent(repairDeps, noteId, repairOptions);
    } finally {
      await options.ownerLease.relinquish();
    }
  };

  return {
    prepare: (markdown) => options.prepareProjection(normalizeSource(markdown).text),
    initialize,
    markClosing: (noteId) => gateway.markClosing(noteId),
    clearClosing: (noteId) => gateway.clearClosing(noteId),
    closeNote: (noteId, reason) => gateway.closeNote(noteId, reason),
    repairContent: repairWithLease,
    markdownOf,
  };
}
