/**
 * `PersistenceStore` — the storage port the writer, the loader and the compactor are written against.
 *
 * The pipeline's algorithms are what 05-collaboration-and-durability.md specifies and what the
 * property suites prove: strict FIFO ordering, the `head_seq` compare-and-set, coalescing, the seven
 * compaction steps and their three terminal outcomes. Those algorithms live in `writer.ts`,
 * `loader.ts` and `compactor.ts` exactly once. What differs between "against MySQL" and "against the
 * in-memory double the `unit` mirrors of `persistence.model.prop` and `convergence.model.prop` drive"
 * is only how a statement is executed — so that is the seam: two adapters (`kysely-store.ts`,
 * `testing/memory-store.ts`), one algorithm, and the mirrors exercise the real code rather than a
 * second implementation of it.
 *
 * A transaction is a callback: `runWrite` and `runCompaction` open it, hand the algorithm a handle
 * whose methods are the statements of 03-data-model.md §8.4 and §8.6 in the order the plan lists
 * them, and COMMIT when the callback resolves. A callback that throws rolls back. The handle exposes
 * no way to issue an arbitrary statement, which is how the lock set stays what the plan says it is.
 */
import type { NoteId, VaultId } from '@iridium/contracts';

import type { AuditEventInput } from '../../audit/chain.ts';
import type {
  CheckpointPolicyInputs,
  HeadRow,
  LoadedDocRow,
  NewestRevision,
  NoteMetadataWrite,
  ProjectionInput,
  RevisionInsert,
  SnapshotWrite,
  UpdateInsert,
  UpdateRow,
} from './types.ts';

/** The statements of the write transaction (03 §8.4), in the order the writer issues them. */
export interface WriteTransaction {
  /** `SELECT d.head_seq, n.deleted_at … FOR UPDATE`; `null` when the `note_docs` row is missing. */
  lockHead(): Promise<HeadRow | null>;
  /** Exact attempted rows, checked under the same owner fence and head lock before an acknowledgement. */
  matchesUpdates(rows: readonly UpdateInsert[]): Promise<boolean>;
  /** `INSERT INTO note_updates …`, one row per coalesced run. */
  insertUpdates(rows: readonly UpdateInsert[]): Promise<void>;
  /** `UPDATE note_docs SET head_seq = to … WHERE head_seq = from`; whether exactly one row matched. */
  casHead(from: number, to: number, now: Date): Promise<boolean>;
  /** Restore checkpoints share the update transaction, so a durable restore is always reversible. */
  insertRevision(row: RevisionInsert): Promise<{ readonly id: number; readonly inserted: boolean }>;
  /** The restore audit is the final lock in the same transaction as both revision rows. */
  recordAudit(event: AuditEventInput): Promise<void>;
}

/** The statements of the compaction transaction (03 §8.6), in the order the compactor issues them. */
export interface CompactionTransaction {
  /** Step 0: the same guard shape as the writer's. */
  lockHead(): Promise<HeadRow | null>;
  /** Step 1: guarded by `snapshot_through_seq < ?`; whether the row was replaced. */
  updateSnapshot(write: SnapshotWrite): Promise<boolean>;
  /** Step 2: the guarded text-projection upsert. */
  writeProjection(input: ProjectionInput): Promise<void>;
  /** Step 2, the A22 branch: `status = 'invalid_content'` on the existing row. */
  markProjectionInvalid(now: Date): Promise<void>;
  /** Step 3's inputs: the newest revision, whether one exists at `seq`, and the policy row. */
  newestRevision(): Promise<NewestRevision | null>;
  revisionExistsAt(seq: number): Promise<boolean>;
  checkpointPolicyInputs(): Promise<CheckpointPolicyInputs>;
  /** Step 3: `INSERT … ON DUPLICATE KEY UPDATE id = id`; `inserted` is false when the row existed. */
  insertRevision(row: RevisionInsert): Promise<{ readonly id: number; readonly inserted: boolean }>;
  /** Step 4: the one `UPDATE notes` (D03-14). */
  updateNoteMetadata(write: NoteMetadataWrite): Promise<void>;
  /** Step 5: `UPDATE note_docs SET projected_seq = ? … WHERE projected_seq < ?`, written last. */
  advanceProjectedSeq(seq: number, now: Date): Promise<void>;
  /** `AuditWriter.record(trx, …)` for `note.content.invalid`, chained inside this transaction. */
  recordAudit(event: AuditEventInput): Promise<void>;
}

/** An explicit retained checkpoint does not publish links or acquire a structural read gate. */
export type CheckpointTransaction = Pick<
  CompactionTransaction,
  'lockHead' | 'insertRevision' | 'recordAudit'
>;

/** The storage port. */
export interface PersistenceStore {
  /** The joined `note_docs` / `nodes` / `notes` row, or `null` when the note has no `note_docs` row. */
  loadDoc(noteId: NoteId): Promise<LoadedDocRow | null>;
  /** The `note_updates` rows with `seq > after`, ascending. */
  loadUpdatesAfter(noteId: NoteId, after: number): Promise<readonly UpdateRow[]>;
  /** Whether a `note_revisions` row exists at `seq`, outside any transaction (the unload veto). */
  revisionExistsAt(noteId: NoteId, seq: number): Promise<boolean>;
  /**
   * `INSERT … ON DUPLICATE KEY UPDATE id = id` outside a compaction — the trashed-note unload
   * checkpoint written from the committed log (05, "Unload, veto, and completing the unload").
   */
  insertRevision(
    noteId: NoteId,
    row: RevisionInsert,
  ): Promise<{ readonly id: number; readonly inserted: boolean }>;
  /** One write transaction on `dbPersist`, committed when `work` resolves. */
  runWrite<T>(noteId: NoteId, work: (tx: WriteTransaction) => Promise<T>): Promise<T>;
  /** Publication locks the known vault shared before its source parents and derived rows. */
  runCompaction<T>(
    noteId: NoteId,
    vaultId: VaultId,
    work: (tx: CompactionTransaction) => Promise<T>,
  ): Promise<T>;
  /** Retained revision metadata takes only the per-note locks and final audit head. */
  runCheckpoint<T>(noteId: NoteId, work: (tx: CheckpointTransaction) => Promise<T>): Promise<T>;
}

/** A loaded document's store belongs to one owner generation, including its asynchronous load. */
export interface OwnedPersistenceStore extends PersistenceStore {
  assertActive(): void;
}
