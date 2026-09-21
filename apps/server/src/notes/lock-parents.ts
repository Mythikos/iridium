/** Explicit parent locks include the locks that InnoDB would otherwise take through child FKs. */
import type { Kysely } from 'kysely';

import type { Database } from '../db/schema.ts';

/**
 * Called inside an owner-fenced mutation transaction before note_docs or any derived table.
 * The shared structural lock preserves the name and tombstone while content commits; locking the
 * notes row up front also prevents a late metadata update or FK check from reversing the order.
 */
export async function lockNoteParents(
  trx: Kysely<Database>,
  noteId: Buffer,
): Promise<{ readonly deletedAt: Date | null } | null> {
  const node = await trx
    .selectFrom('nodes')
    .select('deleted_at')
    .where('id', '=', noteId)
    .forShare()
    .executeTakeFirst();
  if (node === undefined) return null;
  const note = await trx
    .selectFrom('notes')
    .select('node_id')
    .where('node_id', '=', noteId)
    .forUpdate()
    .executeTakeFirst();
  return note === undefined ? null : { deletedAt: node.deleted_at };
}
