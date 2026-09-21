// -- iridium: long-running
/** Bounded, restart-safe backfill; each note replacement commits independently. */
import { createHash } from 'node:crypto';

import { sql } from 'kysely';

import type { MigrationDb } from '../src/db/migration-types.ts';

// Frozen with this migration, so future policy or resolver changes cannot change a replay.
const BATCH_SIZE = 500;

function legacyTermHashes(values: readonly string[]): Buffer[] {
  const hashes = values.map((value) =>
    createHash('sha256')
      .update(
        value
          .split('/')
          .map((part) => part.normalize('NFC').toLowerCase())
          .join('/'),
      )
      .digest('hex'),
  );
  return [...new Set(hashes)].toSorted().map((hash) => Buffer.from(hash, 'hex'));
}

export async function up(db: MigrationDb): Promise<void> {
  let cursor: Buffer | null = null;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- restart-safe bounded keyset backfill
    const page = await sql<{
      note_id: Buffer;
      vault_id: Buffer;
      fm_tags: string[] | null;
      fm_aliases: string[] | null;
    }>`SELECT p.note_id,n.vault_id,p.fm_tags,p.fm_aliases
      FROM note_projections p JOIN nodes n ON n.id=p.note_id
      ${cursor === null ? sql`` : sql`WHERE p.note_id > ${cursor}`}
      ORDER BY p.note_id LIMIT ${BATCH_SIZE}`.execute(db);
    if (page.rows.length === 0) return;
    for (const row of page.rows) {
      // eslint-disable-next-line no-await-in-loop -- replace each note atomically; safe after interruption
      await db.transaction().execute(async (trx) => {
        const tuples = (['tag', 'alias'] as const).flatMap((kind) =>
          legacyTermHashes((kind === 'tag' ? row.fm_tags : row.fm_aliases) ?? []).map(
            (hash) => sql`(${row.note_id},${row.vault_id},${kind},${hash})`,
          ),
        );
        await sql`DELETE FROM note_projection_terms WHERE note_id=${row.note_id}`.execute(trx);
        if (tuples.length > 0) {
          await sql`INSERT INTO note_projection_terms (note_id,vault_id,kind,term_hash) VALUES ${sql.join(tuples)}`.execute(
            trx,
          );
        }
      });
      cursor = row.note_id;
    }
  }
}

/** The data is derived; the earlier table migration owns its removal during development rollback. */
export function down(): Promise<void> {
  return Promise.resolve();
}
