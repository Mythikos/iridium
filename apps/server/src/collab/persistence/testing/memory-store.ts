/**
 * `MemoryPersistenceStore` — the in-memory `CollabPersistence` double the `unit` mirrors of
 * `persistence.model.prop` and `convergence.model.prop` drive (10-testing-and-quality.md,
 * "Property and model suites").
 *
 * It implements the same port as `KyselyPersistenceStore`, statement for statement, over maps — so
 * the real `NoteWriter`, loader and compactor run unchanged against it and the mirrors exercise the
 * product's algorithms at `PROP` strength every night. A transaction is a draft copy of the note's
 * record that becomes current when the callback resolves and is discarded when it throws, which is
 * what makes the model's `Crash` command (abandon in-flight work) and the invariant "a load after a
 * crash returns exactly the committed prefix" testable without a database.
 *
 * It lives under `testing/` so coverage excludes it and knip treats it as test support; nothing in
 * the product imports it.
 */
import type { NoteId, VaultId } from '@iridium/contracts';
import { LIMITS } from '@iridium/contracts';
import { PIPELINE_VERSION } from '@iridium/markdown';

import type { AuditEventInput } from '../../../audit/chain.ts';
import type { NoteEol, ProjectionStatus, RevisionKind, UpdateOrigin } from '../../../db/schema.ts';
import { initialRows, YJS_MAJOR } from '../initial-state.ts';
import type { CompactionTransaction, PersistenceStore, WriteTransaction } from '../store.ts';
import {
  asV1Update,
  type LoadedDocRow,
  type RevisionInsert,
  type UpdateActor,
  type UpdateInsert,
  type UpdateRow,
} from '../types.ts';

/** One stored `note_updates` row, with the authorship columns the model's invariant 9 reads. */
export interface StoredUpdate extends UpdateRow {
  readonly actor: UpdateActor;
  readonly origin: UpdateOrigin;
  readonly createdAt: Date;
}

/** One stored `note_revisions` row. */
export interface StoredRevision extends RevisionInsert {
  readonly id: number;
}

/** The `note_projections` row. */
export interface StoredProjection {
  readonly revision: number;
  readonly markdown: string;
  readonly contentHash: Uint8Array;
  readonly status: ProjectionStatus;
  readonly pipelineVersion: number;
  readonly projectedAt: Date;
}

/** Everything the store keeps for one note — the five tables' worth. */
export interface StoredNote {
  vaultId: VaultId;
  deletedAt: Date | null;
  initializedAt: Date | null;
  originalEol: NoteEol;
  hadBom: boolean;
  headSeq: number;
  snapshot: Uint8Array | null;
  snapshotFormat: 1 | 2;
  snapshotSv: Uint8Array | null;
  snapshotThroughSeq: number;
  snapshotSize: number;
  snapshotAt: Date | null;
  projectedSeq: number;
  yjsMajor: number;
  contentInvalid: boolean;
  oversize: boolean;
  sizeChars: number;
  lastEditedBy: string | null;
  lastEditedAt: Date | null;
  lastCheckpointAt: Date | null;
  updates: StoredUpdate[];
  revisions: StoredRevision[];
  projection: StoredProjection | null;
  checkpointIntervalMinutes: number;
}

/** What `seed` takes: the create path's inputs. */
export interface SeedInput {
  readonly noteId: NoteId;
  readonly vaultId: VaultId;
  readonly markdownLf: string;
  readonly actor: UpdateActor;
  readonly now: Date;
  readonly origin?: 'create' | 'import';
  readonly checkpointIntervalMinutes?: number;
}

/**
 * A fault a test arms: the next transaction of a kind throws `error`, or — `cas` — the next
 * `head_seq` compare-and-set matches no row, which is the corruption alarm the writer must never
 * retry.
 */
export type MemoryFault =
  | { readonly kind: 'write' | 'write-ack' | 'compaction'; readonly error: Error }
  | { readonly kind: 'cas' };

/** A gate a test closes to keep every write transaction from committing until it opens it. */
export interface WriteGate {
  /** Opens the gate: every transaction waiting on it proceeds. */
  release(): void;
  /** How many transactions are waiting. */
  readonly waiting: number;
}

function cloneNote(note: StoredNote): StoredNote {
  return structuredClone(note);
}

function noRow(): never {
  throw new Error('memory store: no note_docs row was locked; the guard statement found nothing');
}

/** What a transaction on an unknown note sees: the guard finds no row, everything else is a bug. */
function missingWriteTransaction(): WriteTransaction {
  return {
    lockHead: async () => null,
    matchesUpdates: async () => noRow(),
    insertUpdates: async () => noRow(),
    casHead: async () => noRow(),
  };
}

function missingCompactionTransaction(): CompactionTransaction {
  return {
    lockHead: async () => null,
    updateSnapshot: async () => noRow(),
    writeProjection: async () => noRow(),
    markProjectionInvalid: async () => noRow(),
    newestRevision: async () => noRow(),
    revisionExistsAt: async () => noRow(),
    checkpointPolicyInputs: async () => noRow(),
    insertRevision: async () => noRow(),
    updateNoteMetadata: async () => noRow(),
    advanceProjectedSeq: async () => noRow(),
    recordAudit: async () => noRow(),
  };
}

/** The double. */
export class MemoryPersistenceStore implements PersistenceStore {
  /** The SQL port locks note_docs before reading a draft; the double must serialize that row too. */
  readonly #rowLocks = new Map<NoteId, Promise<void>>();

  async #withRowLock<T>(noteId: NoteId, work: () => Promise<T>): Promise<T> {
    const previous = this.#rowLocks.get(noteId);
    const lock = Promise.withResolvers<void>();
    this.#rowLocks.set(noteId, lock.promise);
    if (previous !== undefined) await previous;
    try {
      return await work();
    } finally {
      lock.resolve();
      if (this.#rowLocks.get(noteId) === lock.promise) this.#rowLocks.delete(noteId);
    }
  }
  readonly #notes = new Map<NoteId, StoredNote>();
  readonly #audits: AuditEventInput[] = [];
  #nextRevisionId = 1;
  #pendingFaults: MemoryFault[] = [];
  #outage: Error | null = null;
  #writeGate: { promise: Promise<void>; open: () => void; waiting: number } | null = null;
  /** Transactions started and committed, for assertions on idempotence and coalescing. */
  readonly counts = { writes: 0, compactions: 0, commits: 0, rollbacks: 0 };

  /** The rows of one note, as committed. */
  note(noteId: NoteId): StoredNote | undefined {
    return this.#notes.get(noteId);
  }

  /** Every note id the store holds. */
  get noteIds(): readonly NoteId[] {
    return [...this.#notes.keys()];
  }

  /** The audit events compactions recorded, in order. */
  get audits(): readonly AuditEventInput[] {
    return this.#audits;
  }

  /** Arms one failure for the next transaction of that kind. */
  failNext(fault: MemoryFault): void {
    this.#pendingFaults.push(fault);
  }

  /**
   * An outage: every write transaction throws `error` until `null` is passed — what drives a writer
   * through its whole retry ladder into `failed`, and back out when the outage ends.
   */
  failWrites(error: Error | null): void {
    this.#outage = error;
  }

  /** Closes the write gate: every write transaction parks before its statements until `release`. */
  holdWrites(): WriteGate {
    let open: (() => void) | null = null;
    const promise = new Promise<void>((resolve) => {
      open = resolve;
    });
    const gate = { promise, open: (): void => open?.(), waiting: 0 };
    this.#writeGate = gate;
    return {
      release: (): void => {
        if (this.#writeGate === gate) this.#writeGate = null;
        gate.open();
      },
      get waiting(): number {
        return gate.waiting;
      },
    };
  }

  /** `NoteService.initialize` over the double: the five rows at `seq = 1`. */
  seed(input: SeedInput): void {
    const rows = initialRows({
      noteId: input.noteId,
      markdownLf: input.markdownLf,
      origin: input.origin ?? 'create',
      actor: input.actor,
      now: input.now,
      originalEol: 'lf',
      hadBom: false,
    });
    this.#notes.set(input.noteId, {
      vaultId: input.vaultId,
      deletedAt: null,
      initializedAt: input.now,
      originalEol: 'lf',
      hadBom: false,
      headSeq: rows.doc.headSeq,
      snapshot: rows.doc.snapshot,
      snapshotFormat: 2,
      snapshotSv: rows.doc.snapshotSv,
      snapshotThroughSeq: rows.doc.snapshotThroughSeq,
      snapshotSize: rows.doc.snapshotSize,
      snapshotAt: rows.doc.snapshotAt,
      projectedSeq: rows.doc.projectedSeq,
      yjsMajor: YJS_MAJOR,
      contentInvalid: false,
      oversize: false,
      sizeChars: rows.note.sizeChars,
      lastEditedBy: null,
      lastEditedAt: null,
      lastCheckpointAt: null,
      updates: [
        {
          seq: rows.update.seq,
          updateV1: asV1Update(rows.update.updateV1),
          svAfter: rows.update.svAfter,
          actor: rows.update.actor,
          origin: rows.update.origin,
          createdAt: rows.update.createdAt,
        },
      ],
      revisions: [{ id: this.#takeRevisionId(), ...rows.revision }],
      projection: {
        revision: rows.projection.revision,
        markdown: rows.projection.markdown,
        contentHash: rows.projection.contentHash,
        status: 'ok',
        pipelineVersion: PIPELINE_VERSION,
        projectedAt: rows.projection.now,
      },
      checkpointIntervalMinutes:
        input.checkpointIntervalMinutes ?? LIMITS.CHECKPOINT_MIN_INTERVAL_MIN,
    });
  }

  /** The trash flow's effect on the row the writer's guard reads. */
  trash(noteId: NoteId, at: Date): void {
    const note = this.#require(noteId);
    note.deletedAt = at;
  }

  /** `jobs/update_log_prune`: rows at or below `snapshot_through_seq` older than the window. */
  prune(noteId: NoteId, olderThan: Date): number {
    const note = this.#require(noteId);
    const before = note.updates.length;
    note.updates = note.updates.filter(
      (row) => !(row.seq <= note.snapshotThroughSeq && row.createdAt < olderThan),
    );
    return before - note.updates.length;
  }

  #require(noteId: NoteId): StoredNote {
    const note = this.#notes.get(noteId);
    if (note === undefined) throw new Error(`memory store: unknown note ${noteId}`);
    return note;
  }

  #takeRevisionId(): number {
    const id = this.#nextRevisionId;
    this.#nextRevisionId += 1;
    return id;
  }

  #takeFault(kind: MemoryFault['kind']): Error | null {
    const index = this.#pendingFaults.findIndex((fault) => fault.kind === kind);
    if (index === -1) return null;
    const [fault] = this.#pendingFaults.splice(index, 1);
    if (fault === undefined) return null;
    return fault.kind === 'cas' ? new Error('cas') : fault.error;
  }

  async loadDoc(noteId: NoteId): Promise<LoadedDocRow | null> {
    const note = this.#notes.get(noteId);
    if (note === undefined) return null;
    return {
      headSeq: note.headSeq,
      snapshot: note.snapshot,
      snapshotFormat: note.snapshotFormat,
      snapshotSv: note.snapshotSv,
      snapshotThroughSeq: note.snapshotThroughSeq,
      snapshotSize: note.snapshotSize,
      projectedSeq: note.projectedSeq,
      yjsMajor: note.yjsMajor,
      vaultId: note.vaultId,
      deletedAt: note.deletedAt,
      initializedAt: note.initializedAt,
      contentInvalid: note.contentInvalid,
      oversize: note.oversize,
    };
  }

  async loadUpdatesAfter(noteId: NoteId, after: number): Promise<readonly UpdateRow[]> {
    const note = this.#notes.get(noteId);
    if (note === undefined) return [];
    return note.updates
      .filter((row) => row.seq > after)
      .toSorted((a, b) => a.seq - b.seq)
      .map((row) => ({ seq: row.seq, updateV1: row.updateV1, svAfter: row.svAfter }));
  }

  async revisionExistsAt(noteId: NoteId, seq: number): Promise<boolean> {
    const note = this.#notes.get(noteId);
    return note !== undefined && note.revisions.some((row) => row.seq === seq);
  }

  async insertRevision(
    noteId: NoteId,
    row: RevisionInsert,
  ): Promise<{ readonly id: number; readonly inserted: boolean }> {
    return this.#insertRevision(this.#require(noteId), row);
  }

  #insertRevision(
    note: StoredNote,
    row: RevisionInsert,
  ): { readonly id: number; readonly inserted: boolean } {
    const existing = note.revisions.find(
      (candidate) => candidate.seq === row.seq && candidate.kind === row.kind,
    );
    if (existing !== undefined) return { id: existing.id, inserted: false };
    const id = this.#takeRevisionId();
    note.revisions.push({ id, ...row });
    return { id, inserted: true };
  }

  async runWrite<T>(noteId: NoteId, work: (tx: WriteTransaction) => Promise<T>): Promise<T> {
    return this.#withRowLock(noteId, () => this.#runWrite(noteId, work));
  }

  async #runWrite<T>(noteId: NoteId, work: (tx: WriteTransaction) => Promise<T>): Promise<T> {
    this.counts.writes += 1;
    const gate = this.#writeGate;
    if (gate !== null) {
      gate.waiting += 1;
      await gate.promise;
      gate.waiting -= 1;
    }
    const fault = this.#outage ?? this.#takeFault('write');
    if (fault !== null) {
      this.counts.rollbacks += 1;
      throw fault;
    }
    const casFault = this.#takeFault('cas') !== null;
    const current = this.#notes.get(noteId);
    if (current === undefined) return work(missingWriteTransaction());
    const draft = cloneNote(current);
    const tx: WriteTransaction = {
      lockHead: async () => ({ headSeq: draft.headSeq, deletedAt: draft.deletedAt }),
      matchesUpdates: async (expected) => {
        const first = expected[0];
        const last = expected.at(-1);
        if (first === undefined || last === undefined) return false;
        const actual = draft.updates.filter((row) => row.seq >= first.seq && row.seq <= last.seq);
        return (
          actual.length === expected.length &&
          actual.every((row, index) => {
            const attempt = expected[index];
            return (
              attempt !== undefined &&
              row.seq === attempt.seq &&
              Buffer.from(row.updateV1).equals(attempt.updateV1) &&
              Buffer.from(row.svAfter).equals(attempt.svAfter) &&
              row.actor.actorType === attempt.actor.actorType &&
              row.actor.userId === attempt.actor.userId &&
              row.actor.sessionId === attempt.actor.sessionId &&
              row.origin === attempt.origin &&
              row.createdAt.getTime() === attempt.createdAt.getTime()
            );
          })
        );
      },
      insertUpdates: async (rows: readonly UpdateInsert[]) => {
        for (const row of rows) {
          if (draft.updates.some((existing) => existing.seq === row.seq)) {
            throw new Error(`memory store: duplicate note_updates seq ${String(row.seq)}`);
          }
          draft.updates.push({
            seq: row.seq,
            updateV1: asV1Update(row.updateV1),
            svAfter: row.svAfter,
            actor: row.actor,
            origin: row.origin,
            createdAt: row.createdAt,
          });
        }
      },
      casHead: async (from, to) => {
        if (casFault || draft.headSeq !== from) return false;
        draft.headSeq = to;
        return true;
      },
    };
    const result = await this.#commit(noteId, draft, work(tx));
    const lostReply = this.#takeFault('write-ack');
    if (lostReply !== null) throw lostReply;
    return result;
  }

  async runCompaction<T>(
    noteId: NoteId,
    work: (tx: CompactionTransaction) => Promise<T>,
  ): Promise<T> {
    return this.#withRowLock(noteId, () => this.#runCompaction(noteId, work));
  }

  async #runCompaction<T>(
    noteId: NoteId,
    work: (tx: CompactionTransaction) => Promise<T>,
  ): Promise<T> {
    this.counts.compactions += 1;
    const fault = this.#takeFault('compaction');
    if (fault !== null) {
      this.counts.rollbacks += 1;
      throw fault;
    }
    const current = this.#notes.get(noteId);
    if (current === undefined) return work(missingCompactionTransaction());
    const draft = cloneNote(current);
    const audits: AuditEventInput[] = [];
    const tx: CompactionTransaction = {
      lockHead: async () => ({ headSeq: draft.headSeq, deletedAt: draft.deletedAt }),
      updateSnapshot: async (write) => {
        if (!(draft.snapshotThroughSeq < write.throughSeq)) return false;
        draft.snapshot = write.snapshot;
        draft.snapshotSv = write.snapshotSv;
        draft.snapshotFormat = 2;
        draft.snapshotSize = write.snapshotSize;
        draft.snapshotThroughSeq = write.throughSeq;
        draft.snapshotAt = write.now;
        return true;
      },
      writeProjection: async (input) => {
        const existing = draft.projection;
        if (existing !== null && !(input.revision > existing.revision)) return;
        draft.projection = {
          revision: input.revision,
          markdown: input.markdown,
          contentHash: input.contentHash,
          status: 'ok',
          pipelineVersion: PIPELINE_VERSION,
          projectedAt: input.now,
        };
      },
      markProjectionInvalid: async (now) => {
        if (draft.projection === null) return;
        draft.projection = { ...draft.projection, status: 'invalid_content', projectedAt: now };
      },
      newestRevision: async () => {
        const newest = draft.revisions.toSorted((a, b) => b.seq - a.seq || b.id - a.id)[0];
        return newest === undefined ? null : { seq: newest.seq, contentHash: newest.contentHash };
      },
      revisionExistsAt: async (seq) => draft.revisions.some((row) => row.seq === seq),
      checkpointPolicyInputs: async () => ({
        lastCheckpointAt: draft.lastCheckpointAt,
        intervalMinutes: draft.checkpointIntervalMinutes,
      }),
      insertRevision: async (row) => this.#insertRevision(draft, row),
      updateNoteMetadata: async (write) => {
        draft.sizeChars = write.sizeChars;
        draft.oversize = write.oversize;
        draft.contentInvalid = write.contentInvalid;
        if (write.lastEditor !== null) {
          draft.lastEditedBy = write.lastEditor.userId;
          draft.lastEditedAt = write.lastEditor.at;
        }
        if (write.lastCheckpointAt !== null) draft.lastCheckpointAt = write.lastCheckpointAt;
      },
      advanceProjectedSeq: async (seq) => {
        if (draft.projectedSeq < seq) draft.projectedSeq = seq;
      },
      recordAudit: async (event) => {
        audits.push(event);
      },
    };
    const result = await this.#commit(noteId, draft, work(tx));
    this.#audits.push(...audits);
    return result;
  }

  async #commit<T>(noteId: NoteId, draft: StoredNote, work: Promise<T>): Promise<T> {
    let result: T;
    try {
      result = await work;
    } catch (error) {
      this.counts.rollbacks += 1;
      throw error;
    }
    this.#notes.set(noteId, draft);
    this.counts.commits += 1;
    return result;
  }
}

/** The revision kinds the model may assert on, re-exported for the mirrors. */
export type { RevisionKind };
