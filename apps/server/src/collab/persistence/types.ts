/**
 * The shapes the persistence pipeline passes between its parts (05-collaboration-and-durability.md,
 * "The NoteWriter", "Loading a document", "The compaction job"; 03-data-model.md §8).
 *
 * Every sequence counter is a JS `number` (03 §1.3, D05-15): `guards.seq-is-number.guard` refuses a
 * `bigint` anywhere under this directory, so the one `bigint` in the write path — Kysely's
 * `numUpdatedRows` — is compared inside `db/cas.ts` and never travels through these types.
 */
import type { NoteId, SessionId, UserId, VaultId } from '@iridium/contracts';
import type {
  NoteDoc,
  SnapshotFormat,
  StateVector,
  TextDiff,
  V1Update,
  V2State,
} from '@iridium/crdt';
import type { NoteProjection } from '@iridium/markdown';

import type { AuditEventInput } from '../../audit/chain.ts';
import type { RevisionKind, UpdateOrigin } from '../../db/schema.ts';

/**
 * Brands bytes read from `note_updates.update_v1`. The column holds V1 wire updates by construction
 * (03 §8.4: the writer stores the frame bytes as applied, never re-encoded), and the brand records
 * that fact for the codec; the bytes themselves cannot prove it, which is why this is an assertion.
 */
export function asV1Update(bytes: Uint8Array): V1Update {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the column's format is V1 by 03 §8.4
  return bytes as V1Update;
}

// ---- what the loader reads ---------------------------------------------------------------------

/** The `note_docs` row joined with the note's `nodes` and `notes` rows, as the loader reads them. */
export interface LoadedDocRow {
  readonly headSeq: number;
  readonly snapshot: Uint8Array | null;
  readonly snapshotFormat: SnapshotFormat;
  readonly snapshotSv: Uint8Array | null;
  readonly snapshotThroughSeq: number;
  readonly snapshotSize: number;
  readonly projectedSeq: number;
  readonly yjsMajor: number;
  readonly vaultId: VaultId;
  readonly deletedAt: Date | null;
  readonly initializedAt: Date | null;
  readonly contentInvalid: boolean;
  readonly oversize: boolean;
}

/** One `note_updates` row above `snapshot_through_seq`. */
export interface UpdateRow {
  readonly seq: number;
  readonly updateV1: V1Update;
  /** `sv_after` as stored: zero length means "not recorded" (D03-01). */
  readonly svAfter: Uint8Array;
}

/** What `loader.load` returns: the doc row plus the rows the snapshot does not cover. */
export interface LoadedState extends LoadedDocRow {
  readonly updates: readonly UpdateRow[];
}

// ---- what the writer queues and writes ---------------------------------------------------------

/** Authorship of a queued update, from `connection.context` and never from awareness (spec §8). */
export interface UpdateActor {
  readonly userId: UserId | null;
  readonly sessionId: SessionId | null;
  readonly actorType: 'user' | 'system';
}

/** The origins the writer persists; `LOAD_ORIGIN` and unknown origins never reach the queue. */
export type WriterOrigin = Extract<UpdateOrigin, 'connection' | 'restore' | 'repair'>;

/** One update as captured by the `document.on('update')` listener. */
export interface PendingUpdate {
  readonly update: V1Update;
  /** `stateVector(document)` captured synchronously after the apply. */
  readonly svAfter: StateVector;
  /** Deletion-set fingerprint from that same update event, including deletion-only changes. */
  readonly dsAfter: string;
  readonly actor: UpdateActor;
  readonly origin: WriterOrigin;
  readonly bytes: number;
  /** `clock.monotonic()` at enqueue, for `iridium_persist_backlog_age_seconds`. */
  readonly enqueuedAt: number;
}

/** One coalesced run: the row the transaction inserts. */
export interface WriteRun {
  readonly merged: V1Update;
  readonly svAfter: StateVector;
  readonly dsAfter: string;
  /** `storedSv(svAfter)`: zero length when the vector exceeds `SV_STORED_MAX_BYTES`. */
  readonly storedSv: StateVector;
  readonly actor: UpdateActor;
  readonly origin: WriterOrigin;
  /** How many queued updates the run coalesced, so the writer can pop exactly those. */
  readonly members: number;
}

/** One `note_updates` row, as the write transaction inserts it. */
export interface UpdateInsert {
  readonly seq: number;
  readonly updateV1: Uint8Array;
  readonly svAfter: Uint8Array;
  readonly actor: UpdateActor;
  readonly origin: UpdateOrigin;
  readonly createdAt: Date;
}

/** The `note_docs` head and the note's trash state, read under `FOR UPDATE`. */
export interface HeadRow {
  readonly headSeq: number;
  readonly deletedAt: Date | null;
}

// ---- what the compactor captures and writes ----------------------------------------------------

/** What `onStoreDocument`, `flush` and the last-client path ask a compaction to do. */
export type CompactTrigger = 'debounce' | 'flush' | 'unload';

/** The strength order used to coalesce a pending job with a newer request (05, "Compaction shares the FIFO"). */
export const COMPACT_TRIGGER_RANK: Readonly<Record<CompactTrigger, number>> = Object.freeze({
  debounce: 0,
  flush: 1,
  unload: 2,
});

/** The last committed batch's actor, handed to the next compaction (D03-14). */
export interface LastEditor {
  readonly userId: UserId | null;
  readonly at: Date;
}

/** Everything a compaction captures synchronously at the head of the FIFO. */
export interface Captured {
  readonly stateV2: V2State;
  readonly sv: StateVector;
  /** `writer.lastCommittedSeq` at capture: the head of the committed log at this instant. */
  readonly throughSeq: number;
  readonly markdown: string;
  readonly sizeChars: number;
  readonly scan:
    | { readonly ok: true }
    | { readonly ok: false; readonly reason: 'cr' | 'attributes' };
  readonly contentHash: Buffer;
  readonly lastEditor: LastEditor | null;
}

/** An explicit recoverable checkpoint, serialized with accepted updates in the writer FIFO. */
export interface CheckpointRequest {
  readonly kind: 'pre_restore' | 'named';
  readonly label: string;
  readonly actor: UpdateActor;
  readonly audit?: AuditEventInput;
}

/** A trusted synchronous edit on the already loaded document, serialized by the writer. */
export interface RestoreRequest {
  readonly document: NoteDoc;
  readonly target: string;
  readonly revisionId: number;
  readonly actor: UpdateActor;
  readonly audit: AuditEventInput;
  readonly apply: (diff: TextDiff) => void;
}

/** No-op restores write no revision rows; changed restores always return both durable ends. */
export type RestoreResult = {
  readonly seq: number;
  readonly contentHash: string;
} & (
  | { readonly changed: false }
  | {
      readonly changed: true;
      readonly preRestoreRevisionId: number;
      readonly restoreRevisionId: number;
    }
);

/** The exact committed prefix and its durable immutable revision. */
export interface CheckpointResult {
  readonly captured: Captured;
  readonly revision: { readonly id: number; readonly inserted: boolean };
}

/** The snapshot write of step 1. */
export interface SnapshotWrite {
  readonly snapshot: Uint8Array;
  readonly snapshotSv: Uint8Array;
  readonly snapshotSize: number;
  readonly throughSeq: number;
  readonly now: Date;
}

/** The text projection write of step 2. */
export interface ProjectionInput {
  readonly prepared?: NoteProjection;
  readonly revision: number;
  readonly markdown: string;
  readonly contentHash: Buffer;
  readonly now: Date;
}

/** One `note_revisions` row, as step 3 inserts it. */
export interface RevisionInsert {
  readonly seq: number;
  readonly kind: RevisionKind;
  readonly label: string | null;
  readonly markdown: string;
  readonly contentHash: Buffer;
  readonly sizeChars: number;
  readonly snapshot: Uint8Array | null;
  readonly snapshotSv: Uint8Array | null;
  readonly actor: UpdateActor;
  readonly createdAt: Date;
  readonly restoredFromRevisionId?: number;
}

/** The newest revision's identity, for the checkpoint policy. */
export interface NewestRevision {
  readonly seq: number;
  readonly contentHash: Uint8Array;
}

/** What the checkpoint policy reads off `notes` and `vaults`. */
export interface CheckpointPolicyInputs {
  readonly lastCheckpointAt: Date | null;
  /** `vaults.auto_checkpoint_interval_min`. */
  readonly intervalMinutes: number;
}

/** The single `UPDATE notes` of step 4 (D03-14). */
export interface NoteMetadataWrite {
  readonly sizeChars: number;
  readonly oversize: boolean;
  readonly contentInvalid: boolean;
  readonly lastEditor: LastEditor | null;
  /** Set when a checkpoint row was written this time; `null` keeps the stored value. */
  readonly lastCheckpointAt: Date | null;
  readonly now: Date;
}

/** How a compaction ended (03 §8.6.1, "The three terminal outcomes"). */
export type CompactStatus = 'ok' | 'refused' | 'skipped_trashed';

/** What a compaction resolves to. Every member is about what committed, never about a rejection. */
export interface CompactOutcome {
  readonly status: CompactStatus;
  readonly throughSeq: number;
  /** Step 2 ran: `projected {seq}` is due after COMMIT. */
  readonly projected: boolean;
  /** The revision row written this time, when the policy fired. */
  readonly revision: {
    readonly id: number;
    readonly kind: RevisionKind;
    readonly label: string | null;
  } | null;
  /** The latches after this compaction. */
  readonly contentInvalid: { readonly reason: 'cr' | 'attributes' } | null;
  readonly oversize: boolean;
  /** The snapshot blob was refused above `SNAPSHOT_REFUSE_BYTES` (the blob only, D05-14). */
  readonly snapshotRefused: boolean;
  readonly snapshotBytes: number;
  /** UTF-16 units measured at capture: what `size-exceeded.size` reports. */
  readonly sizeChars: number;
}

/** The result `persistence.compactNow` and `NoteWriter.enqueueCompaction` resolve to. */
export type CompactResult = CompactOutcome;

/** The seven writer states of 05, "Writer state reference". */
export type WriterState =
  | 'idle'
  | 'writing'
  | 'retrying'
  | 'failed'
  | 'backpressure'
  | 'trashed'
  | 'disposed';

/** The baseline the writer answers `baseline` from. */
export interface Persisted {
  readonly seq: number;
  readonly sv: StateVector;
  /** SHA-256 of the canonical committed deletion set, never sampled from later live edits. */
  readonly ds: string;
}

/** The identity a writer is created with. */
export interface WriterIdentity {
  readonly noteId: NoteId;
  readonly vaultId: VaultId;
  readonly documentName: string;
}
