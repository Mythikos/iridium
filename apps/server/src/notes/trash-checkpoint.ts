/** Trash retains the exact committed head in the tombstone transaction. */
import type { NoteId } from '@iridium/contracts';
import { storedSv } from '@iridium/crdt';
import { sql, type Transaction } from 'kysely';

import { idBytes } from '../auth/ids.ts';
import { HEAD_UNVERIFIED_LABEL } from '../collab/persistence/compactor.ts';
import { YJS_MAJOR } from '../collab/persistence/initial-state.ts';
import type { UpdateActor } from '../collab/persistence/types.ts';
import type { Database } from '../db/schema.ts';
import { captureStoredState } from './committed-state.ts';

/** The structural caller already holds the vault and nodes; audit remains the last lock. */
export async function checkpointTrash(
  trx: Transaction<Database>,
  noteIds: readonly NoteId[],
  actor: UpdateActor,
  now: Date,
): Promise<void> {
  for (const noteId of noteIds.toSorted()) {
    // eslint-disable-next-line no-await-in-loop -- deterministic per-note lock order inside the vault lock
    const captured = await captureStoredState(trx, noteId, true);
    // eslint-disable-next-line no-await-in-loop -- the checkpoint must commit with this note's tombstone
    await trx
      .insertInto('note_revisions')
      .values({
        note_id: idBytes(noteId),
        seq: captured.throughSeq,
        kind: 'trash',
        label: captured.scan.ok ? null : HEAD_UNVERIFIED_LABEL,
        markdown: captured.markdown,
        content_hash: captured.contentHash,
        size_chars: captured.sizeChars,
        snapshot: Buffer.from(captured.stateV2),
        snapshot_format: 2,
        yjs_major: YJS_MAJOR,
        snapshot_sv: Buffer.from(storedSv(captured.sv)),
        actor_type: actor.actorType,
        actor_id: actor.userId === null ? null : idBytes(actor.userId),
        restored_from_revision_id: null,
        created_at: now,
      })
      .onDuplicateKeyUpdate({ id: sql`id` })
      .execute();
  }
}
