/**
 * The named errors of the persistence pipeline (05-collaboration-and-durability.md, "Failure
 * handling, retry and `persist-failed`"; D05-20).
 *
 * Each one is a decision the writer makes rather than a symptom: a trashed note is a terminal state,
 * a compaction that cannot reach the FIFO head is a bounded rejection with a named reason, and a
 * `note_docs` row that vanished under a writer is corruption. `HeadSeqCasViolation` is deliberately
 * not here — it is `db/cas.ts`'s, because the CAS contract is the database layer's.
 */
import type { NoteId } from '@iridium/contracts';

import type { WriterState } from './types.ts';

/** The write transaction found `nodes.deleted_at` set under its own lock (05, "The transaction"). */
export class NoteTrashedDuringWrite extends Error {
  readonly code = 'persist.note_trashed';
  readonly noteId: NoteId;

  constructor(noteId: NoteId) {
    super(
      `note ${noteId} was trashed while its writer held a batch. The batch and the queue are ` +
        'dropped, the document is closed note-trashed, and the trash revision written by the trash ' +
        'transaction is the last artefact of its content (05-collaboration-and-durability.md).',
    );
    this.name = 'NoteTrashedDuringWrite';
    this.noteId = noteId;
  }
}

/** Accepted edits did not commit, so an authorization mutation must not proceed. */
export class PersistenceDrainUnavailable extends Error {
  readonly code = 'persist.drain_unavailable';
  constructor(noteId: NoteId, state: WriterState) {
    super(
      `accepted updates for note ${noteId} remain unconfirmed while its writer is ${state}; authorization was not changed`,
    );
    this.name = 'PersistenceDrainUnavailable';
  }
}

/** The compaction job provably cannot reach the FIFO head until the writer recovers (D05-20). */
export class CompactionUnavailable extends Error {
  readonly code = 'persist.compaction_unavailable';
  readonly noteId: NoteId;
  readonly writerState: WriterState;

  constructor(noteId: NoteId, writerState: WriterState) {
    super(
      `a compaction of note ${noteId} cannot run while its writer is ${writerState}; the job ` +
        'stays queued and commits when the writer recovers.',
    );
    this.name = 'CompactionUnavailable';
    this.noteId = noteId;
    this.writerState = writerState;
  }
}

/** The compaction job did not reach the FIFO head inside `COMPACTION_AWAIT_TIMEOUT_MS` (D05-20). */
export class CompactionTimeout extends Error {
  readonly code = 'persist.compaction_timeout';
  readonly noteId: NoteId;
  readonly timeoutMs: number;

  constructor(noteId: NoteId, timeoutMs: number) {
    super(
      `a compaction of note ${noteId} did not commit within ${String(timeoutMs)}ms; the job stays ` +
        'queued and commits when the writer drains.',
    );
    this.name = 'CompactionTimeout';
    this.noteId = noteId;
    this.timeoutMs = timeoutMs;
  }
}

/** An explicit checkpoint cannot reach a committed FIFO boundary in this writer lifetime. */
export class CheckpointUnavailable extends Error {
  readonly code = 'persist.checkpoint_unavailable';

  constructor(noteId: NoteId, state: WriterState) {
    super('a checkpoint of note ' + noteId + ' cannot run while its writer is ' + state);
    this.name = 'CheckpointUnavailable';
  }
}

/** The explicit checkpoint exceeded the existing snapshot-job await budget; no repair was applied. */
export class CheckpointTimeout extends Error {
  readonly code = 'persist.checkpoint_timeout';

  constructor(noteId: NoteId, timeoutMs: number) {
    super(
      'a checkpoint of note ' +
        noteId +
        ' did not commit within ' +
        String(timeoutMs) +
        'ms; no repair was applied',
    );
    this.name = 'CheckpointTimeout';
  }
}

/** A writer refuses a content mutation before the synchronous capture-and-apply boundary. */
export class RevisionContentRefused extends Error {
  readonly reason: 'content_invalid' | 'note_oversized';
  constructor(reason: 'content_invalid' | 'note_oversized') {
    super(`The revision operation cannot change ${reason} content.`);
    this.name = 'RevisionContentRefused';
    this.reason = reason;
  }
}

/** The accepted restore remains in the FIFO until its atomic write can commit. */
export class RestoreTimeout extends Error {
  readonly code = 'persist.restore_timeout';
  constructor(noteId: NoteId) {
    super(`The restore of ${noteId} has not committed within the writer deadline.`);
    this.name = 'RestoreTimeout';
  }
}

/** A `note_docs` row that should exist does not: invariant I-06 is broken (03 §8.3). */
export class NoteDocMissing extends Error {
  readonly code = 'persist.note_doc_missing';
  readonly noteId: NoteId;

  constructor(noteId: NoteId) {
    super(
      `note ${noteId} has no note_docs row although a document for it is loaded. ` +
        'NoteService.initialize inserts that row in the creating transaction, so this is corruption ' +
        'rather than an empty note; check `iridium doctor`.',
    );
    this.name = 'NoteDocMissing';
    this.noteId = noteId;
  }
}

/** Whether an error is one of the two bounded compaction rejections a caller maps to `503`. */
export function isCompactionRejection(
  error: unknown,
): error is CompactionUnavailable | CompactionTimeout {
  return error instanceof CompactionUnavailable || error instanceof CompactionTimeout;
}
