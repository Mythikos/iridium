/** Binary replay for maintenance and structural checkpoints, never Markdown reinitialization. */
import { LIMITS, type NoteId } from '@iridium/contracts';
import { applyV1, createNoteDoc, loadState, LOAD_ORIGIN, type NoteDoc } from '@iridium/crdt';
import type { Kysely } from 'kysely';

import { idBytes } from '../auth/ids.ts';
import { capture } from '../collab/persistence/compactor.ts';
import { YJS_MAJOR } from '../collab/persistence/initial-state.ts';
import { asV1Update, type Captured } from '../collab/persistence/types.ts';
import type { Database } from '../db/schema.ts';
import { ProblemError } from '../security/problem.ts';
import { lockNoteParents } from './lock-parents.ts';

/** A damaged durable prefix must be repaired explicitly, never guessed from projected text. */
export class CommittedStateInvalid extends Error {
  constructor(noteId: NoteId, reason: string) {
    super(`Cannot replay committed note ${noteId}: ${reason}`);
    this.name = 'CommittedStateInvalid';
  }
}
/** Caller chooses transaction/snapshot lifetime; lockHead is for the mutation transaction. */
export async function captureStoredState(
  db: Kysely<Database>,
  noteId: NoteId,
  lockHead: boolean,
): Promise<Captured> {
  const id = idBytes(noteId);
  if (lockHead && (await lockNoteParents(db, id)) === null) throw new ProblemError('not_found');
  let statement = db.selectFrom('note_docs').selectAll().where('note_id', '=', id);
  if (lockHead) statement = statement.forUpdate();
  const head = await statement.executeTakeFirst();
  if (head === undefined) throw new ProblemError('not_found');
  if (head.yjs_major !== YJS_MAJOR || (head.snapshot_format !== 1 && head.snapshot_format !== 2))
    throw new CommittedStateInvalid(noteId, 'unsupported snapshot codec');
  if (head.snapshot === null && head.snapshot_through_seq > 0)
    throw new CommittedStateInvalid(noteId, 'missing snapshot for the retained log prefix');
  let tail = db
    .selectFrom('note_updates')
    .select(['seq', 'update_v1', 'yjs_major'])
    .where('note_id', '=', id)
    .where('seq', '>', head.snapshot_through_seq)
    .where('seq', '<=', head.head_seq)
    .orderBy('seq', 'asc');
  // A structural transaction may already have a repeatable-read snapshot. Its locked head is a
  // current read, so the tail must also see commits newer than that earlier snapshot.
  if (lockHead) tail = tail.forShare();
  const updates = await tail.execute();
  let through = head.snapshot_through_seq;
  for (const update of updates) {
    if (update.seq !== through + 1 || update.yjs_major !== YJS_MAJOR)
      throw new CommittedStateInvalid(noteId, 'gap or incompatible update codec');
    through = update.seq;
  }
  if (through !== head.head_seq)
    throw new CommittedStateInvalid(noteId, 'missing committed log tail');
  const document: NoteDoc = createNoteDoc({ gc: true });
  try {
    if (head.snapshot !== null)
      loadState(document, head.snapshot, head.snapshot_format, LOAD_ORIGIN);
    for (const update of updates) applyV1(document, asV1Update(update.update_v1), LOAD_ORIGIN);
    const captured = capture(document, { lastCommittedSeq: head.head_seq, lastEditor: null });
    if (captured.sizeChars > LIMITS.NOTE_HARD_MAX_UTF16)
      throw new CommittedStateInvalid(noteId, 'head exceeds the hard source bound');
    return captured;
  } finally {
    document.destroy();
  }
}
