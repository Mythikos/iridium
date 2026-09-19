/**
 * `loader.load` — the read half of the load path (05-collaboration-and-durability.md, "Loading a
 * document"; 03-data-model.md §8.5), and `applyLoaded`, the in-place apply `onLoadDocument` performs.
 *
 * The refusals are the plan's, in its order, and two of them deliberately say the same thing: a
 * note in another vault answers `note-not-found`, exactly like a note that does not exist, because
 * knowing an identifier grants nothing (04 §5.4). A `yjs_major` other than 13 is refused with the
 * same reason plus an alarm on the log line — the marker a future Yjs v14 migration selects on.
 *
 * `applyLoaded` applies the snapshot with the format the row records and then every log row above
 * `snapshot_through_seq` in `seq` order, all under `LOAD_ORIGIN` so the writer's listener ignores
 * them. Over-inclusion is harmless (Yjs replay is idempotent); under-inclusion is impossible, because
 * the compactor captured the snapshot at the head of the FIFO after every lower row had committed.
 */
import type { NoteId, VaultId } from '@iridium/contracts';
import { applyV1, loadState, LOAD_ORIGIN, type NoteDoc } from '@iridium/crdt';

import { CollabRejection } from '../rejection.ts';
import { YJS_MAJOR } from './initial-state.ts';
import type { PersistenceStore } from './store.ts';
import type { LoadedState } from './types.ts';

/** What the loader logs beside a refusal. */
export interface LoaderLogger {
  warn(fields: Readonly<Record<string, unknown>>, message: string): void;
}

/**
 * Reads the state of one note for one vault, or throws the `CollabRejection` the hook forwards.
 *
 * @throws CollabRejection `note-not-found` (no row, never initialised, foreign vault, unsupported
 * Yjs major) or `note-trashed`.
 */
export async function loadNote(
  store: PersistenceStore,
  noteId: NoteId,
  vaultId: VaultId,
  logger: LoaderLogger,
): Promise<LoadedState> {
  const row = await store.loadDoc(noteId);
  if (row === null || row.initializedAt === null) throw new CollabRejection('note-not-found');
  if (row.vaultId !== vaultId) throw new CollabRejection('note-not-found');
  if (row.deletedAt !== null) throw new CollabRejection('note-trashed');
  if (row.yjsMajor !== YJS_MAJOR) {
    logger.warn(
      {
        event: 'collab.connection.rejected',
        noteId,
        alarm: 'yjs_major_mismatch',
        yjsMajor: row.yjsMajor,
      },
      'note_docs.yjs_major is not the major this build speaks',
    );
    throw new CollabRejection('note-not-found', { auditReason: 'yjs_major_mismatch' });
  }
  const updates = await store.loadUpdatesAfter(noteId, row.snapshotThroughSeq);
  return { ...row, updates };
}

/** Applies a loaded state to a document in place: the snapshot, then the rows, all `LOAD_ORIGIN`. */
export function applyLoaded(document: NoteDoc, loaded: LoadedState): void {
  if (loaded.snapshot !== null) {
    loadState(document, loaded.snapshot, loaded.snapshotFormat, LOAD_ORIGIN);
  }
  for (const row of loaded.updates) applyV1(document, row.updateV1, LOAD_ORIGIN);
}

/**
 * The recorded vector a baseline is built from: the last log row's `sv_after`, else the snapshot's.
 * Zero length and `null` both mean "not recorded" and are resolved by `recordedSv` at the call site.
 */
export function recordedVectorOf(loaded: LoadedState): Uint8Array | null {
  const last = loaded.updates.at(-1);
  return last === undefined ? loaded.snapshotSv : last.svAfter;
}
