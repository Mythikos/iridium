/**
 * The compaction job (05-collaboration-and-durability.md, "The compaction job", "Checkpoint policy";
 * 03-data-model.md §8.6 and §8.6.1).
 *
 * `capture` runs synchronously at the head of the writer FIFO — after every lower-`seq` update has
 * committed, which is what makes `throughSeq = lastCommittedSeq` honest and `snapshot_through_seq
 * <= head_seq` an invariant rather than a hope. `runCompaction` then runs the one transaction, in the
 * plan's order, with `note_docs.projected_seq` written last so a crash leaves it behind and never
 * ahead.
 *
 * A job that reaches step 0 ends in exactly one of three ways, and every one of them **resolves**:
 * committed normally, snapshot refused above 64 MB (the blob only; the projection, the checkpoint and
 * the `oversize` latch still commit), or content invalid (the projection skipped, the checkpoint
 * written with `label = 'head-unverified'` on an unload). A rejection is reserved for an I/O failure,
 * where the document deliberately stays in memory. The writer therefore stays `idle` in the refusal
 * and invalid cases — writer `failed` is itself an unload veto, and an oversize note must not pin its
 * document for the life of the process.
 */
import { LIMITS, type NoteId, type VaultId } from '@iridium/contracts';
import {
  encodeState,
  projectMarkdown,
  scanHostileContent,
  stateVector,
  storedSv,
  type NoteDoc,
} from '@iridium/crdt';

import { HeadSeqCasViolation } from '../../db/cas.ts';
import { contentHash } from '../../projection/hash.ts';
import { NoteDocMissing } from './errors.ts';
import type { PersistenceStore } from './store.ts';
import type {
  Captured,
  CompactOutcome,
  CompactTrigger,
  LastEditor,
  RevisionInsert,
  UpdateActor,
} from './types.ts';

/** A revision row carries its V2 snapshot when the snapshot is below this (05, "Checkpoint policy"). */
export const REVISION_SNAPSHOT_ATTACH_BYTES = 4_000_000;

/** The label of an `unload` row written from a head that failed the content scan (03 §8.6.1). */
export const HEAD_UNVERIFIED_LABEL = 'head-unverified';

const MS_PER_MINUTE = 60_000;

/** What `capture` reads off the writer. */
export interface CaptureSource {
  readonly lastCommittedSeq: number;
  readonly lastEditor: LastEditor | null;
}

/** Captures everything the transaction needs from a document rebuilt from the committed prefix. */
export function capture(document: NoteDoc, writer: CaptureSource): Captured {
  const stateV2 = encodeState(document, 2);
  const sv = stateVector(document);
  const markdown = projectMarkdown(document);
  return {
    stateV2,
    sv,
    throughSeq: writer.lastCommittedSeq,
    markdown,
    sizeChars: markdown.length,
    scan: scanHostileContent(document),
    contentHash: contentHash(markdown),
    lastEditor: writer.lastEditor,
  };
}

/** The two fault points the compactor honours, as callbacks so the algorithm stays registry-free. */
export interface CompactionFaults {
  /** `compact.throw`: throws before the snapshot is written. */
  beforeSnapshot(): void;
  /** `compact.snapshot-oversize`: arms the 64 MB refusal without a 64 MB document. */
  snapshotRefusedByFault(): boolean;
}

/** What `runCompaction` needs beside the store. */
export interface RunCompactionOptions {
  readonly noteId: NoteId;
  readonly vaultId: VaultId;
  readonly captured: Captured;
  readonly trigger: CompactTrigger;
  readonly now: Date;
  readonly faults: CompactionFaults;
  /** The actor a checkpoint row is attributed to: the last editor, else the system. */
  readonly actor: UpdateActor;
  /** Counts `iridium_state_vector_oversize_total` when the captured vector is stored zero length. */
  readonly onStateVectorOversize: (bytes: number) => void;
}

const NO_OP_FAULTS: CompactionFaults = Object.freeze({
  beforeSnapshot(): void {},
  snapshotRefusedByFault(): boolean {
    return false;
  },
});

/** @internal The fault slice the unit/property mirrors pass without a fault registry. */
export const NO_COMPACTION_FAULTS: CompactionFaults = NO_OP_FAULTS;

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let index = 0; index < a.byteLength; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

/**
 * Runs steps 0 to 6 in one transaction and returns what committed. Step 7 — the broadcasts, the
 * read-only latches and the metrics — is the writer's, after COMMIT, because it touches live
 * connections and a transaction must not.
 *
 * @throws NoteDocMissing when the `note_docs` row is gone (corruption, never a normal outcome).
 * @throws whatever the store throws on an I/O or SQL failure, which the writer reports as a rejected
 * job and Hocuspocus answers by keeping the document in memory.
 */
export async function runCompaction(
  store: PersistenceStore,
  options: RunCompactionOptions,
): Promise<CompactOutcome> {
  const { noteId, captured, trigger, now, faults } = options;
  const snapshotBytes = captured.stateV2.byteLength;

  return store.runCompaction(noteId, async (tx) => {
    // Step 0: the trashed guard, under the same lock the writer takes.
    const head = await tx.lockHead();
    if (head === null) throw new NoteDocMissing(noteId);
    if (head.deletedAt !== null) {
      return {
        status: 'skipped_trashed',
        throughSeq: captured.throughSeq,
        projected: false,
        revision: null,
        contentInvalid: null,
        oversize: false,
        snapshotRefused: false,
        snapshotBytes,
        sizeChars: captured.sizeChars,
      };
    }

    // The owner lease is primary, but a stale owner must never publish a snapshot of an older doc.
    if (head.headSeq !== captured.throughSeq) {
      throw new HeadSeqCasViolation({
        table: 'note_docs',
        id: noteId,
        expected: captured.throughSeq,
      });
    }

    // Step 1: the snapshot, monotonic on `snapshot_through_seq`; refused above 64 MB (the blob only).
    faults.beforeSnapshot();
    const snapshotRefused =
      faults.snapshotRefusedByFault() || snapshotBytes > LIMITS.SNAPSHOT_REFUSE_BYTES;
    const snapshotSv = storedSv(captured.sv);
    if (snapshotSv.byteLength === 0) options.onStateVectorOversize(captured.sv.byteLength);
    if (!snapshotRefused) {
      await tx.updateSnapshot({
        snapshot: captured.stateV2,
        snapshotSv,
        snapshotSize: snapshotBytes,
        throughSeq: captured.throughSeq,
        now,
      });
    }

    // Step 2: the committed projection, or the A22 branch.
    const scanOk = captured.scan.ok;
    if (scanOk) {
      await tx.writeProjection({
        revision: captured.throughSeq,
        markdown: captured.markdown,
        contentHash: captured.contentHash,
        now,
      });
    } else {
      await tx.markProjectionInvalid(now);
      await tx.recordAudit({
        action: 'note.content.invalid',
        actorType: 'system',
        actorId: null,
        credentialType: 'system',
        vaultId: options.vaultId,
        targetType: 'note',
        targetId: noteId,
        outcome: 'failure',
        reason: captured.scan.ok ? null : captured.scan.reason,
        context: {},
        metadata: { seq: captured.throughSeq, trigger },
      });
    }

    // Step 3: the checkpoint policy. Always evaluated, whatever steps 1 and 2 did.
    const newest = await tx.newestRevision();
    const existsAtHead = await tx.revisionExistsAt(captured.throughSeq);
    const hashChanged = newest === null || !bytesEqual(newest.contentHash, captured.contentHash);
    let revisionRow: RevisionInsert | null = null;
    if (trigger === 'unload' && (!existsAtHead || hashChanged)) {
      revisionRow = checkpointRow(
        options,
        'unload',
        scanOk ? null : HEAD_UNVERIFIED_LABEL,
        snapshotSv,
      );
    } else if (hashChanged) {
      const policy = await tx.checkpointPolicyInputs();
      const intervalMs = policy.intervalMinutes * MS_PER_MINUTE;
      const since =
        policy.lastCheckpointAt === null
          ? Number.POSITIVE_INFINITY
          : now.getTime() - policy.lastCheckpointAt.getTime();
      if (since >= intervalMs) revisionRow = checkpointRow(options, 'checkpoint', null, snapshotSv);
    }
    let revision: CompactOutcome['revision'] = null;
    if (revisionRow !== null) {
      const written = await tx.insertRevision(revisionRow);
      revision = written.inserted
        ? { id: written.id, kind: revisionRow.kind, label: revisionRow.label }
        : null;
    }

    // Step 4: the one `UPDATE notes` (D03-14).
    const oversize =
      captured.sizeChars > LIMITS.NOTE_SOFT_MAX_UTF16 ||
      snapshotBytes > LIMITS.SNAPSHOT_ALERT_BYTES ||
      snapshotRefused;
    await tx.updateNoteMetadata({
      sizeChars: captured.sizeChars,
      oversize,
      contentInvalid: !scanOk,
      lastEditor: captured.lastEditor,
      lastCheckpointAt: revision === null ? null : now,
      now,
    });

    // Step 5: `projected_seq`, last, and only when step 2 wrote a projection.
    if (scanOk) await tx.advanceProjectedSeq(captured.throughSeq, now);

    return {
      status: snapshotRefused ? 'refused' : 'ok',
      throughSeq: captured.throughSeq,
      projected: scanOk,
      revision,
      contentInvalid: captured.scan.ok ? null : { reason: captured.scan.reason },
      oversize,
      snapshotRefused,
      snapshotBytes,
      sizeChars: captured.sizeChars,
    };
  });
}

function checkpointRow(
  options: RunCompactionOptions,
  kind: 'checkpoint' | 'unload',
  label: string | null,
  snapshotSv: Uint8Array,
): RevisionInsert {
  const { captured, now } = options;
  const attach = captured.stateV2.byteLength < REVISION_SNAPSHOT_ATTACH_BYTES;
  return {
    seq: captured.throughSeq,
    kind,
    label,
    markdown: captured.markdown,
    contentHash: captured.contentHash,
    sizeChars: captured.sizeChars,
    snapshot: attach ? captured.stateV2 : null,
    snapshotSv: attach ? snapshotSv : null,
    actor: options.actor,
    createdAt: now,
  };
}
