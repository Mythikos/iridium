/** Derived term memberships use ordinary rows so all legal Unicode metadata fits the index. */
import { createHash } from 'node:crypto';

import { foldLinkPath } from '@iridium/markdown';
import type { Insertable, Transaction } from 'kysely';

import type { Database, NoteProjectionTermsTable } from '../db/schema.ts';

/** Hashes an already folded key without applying normalization a second time. */
export function projectionTermHash(folded: string): Buffer {
  return createHash('sha256').update(folded).digest();
}

/** Replaces memberships only after the caller locks and accepts the exact projection revision. */
export async function replaceProjectionTerms(
  db: Transaction<Database>,
  noteId: Buffer,
  vaultId: Buffer,
  tags: readonly string[],
  aliases: readonly string[],
): Promise<void> {
  const rows: Insertable<NoteProjectionTermsTable>[] = [];
  for (const [kind, values] of [
    ['tag', tags],
    ['alias', aliases],
  ] as const) {
    const hashes = new Map(
      values.map((value) => {
        const hash = projectionTermHash(foldLinkPath(value));
        return [hash.toString('hex'), hash];
      }),
    );
    for (const hash of hashes.values())
      rows.push({ note_id: noteId, vault_id: vaultId, kind, term_hash: hash });
  }
  await db.deleteFrom('note_projection_terms').where('note_id', '=', noteId).execute();
  if (rows.length > 0) await db.insertInto('note_projection_terms').values(rows).execute();
}
