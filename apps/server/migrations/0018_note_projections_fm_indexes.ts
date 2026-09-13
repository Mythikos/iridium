/**
 * 0018_note_projections_fm_indexes
 *
 * `ix_proj_fm_tags` and `ix_proj_fm_aliases` on `note_projections` (03-data-model.md section 9.1,
 * 9.3).
 *
 * Multi-valued indexes over `CAST(... ARRAY)`, which the Kysely schema builder cannot express, so the
 * statement is a raw `sql` template. Multi-valued index support arrived in MySQL 8.0.17 and is
 * therefore inside the 8.4.11 floor; that it produces the same index on both required engines is
 * asserted by `migrations.parity.integration` rather than by this comment.
 *
 * Both indexes exist from day one even though `tag:` search is reserved for post-MVP (A39), because
 * adding them later to a populated table is an expensive rebuild and because the vault-wide "notes
 * with this tag" query is what the link and alias resolver needs. The `CHAR(64)` and `CHAR(255)`
 * bounds are why an over-long tag or alias is dropped from the projection with a `tag_invalid`
 * finding (D03-12): a multi-valued index rejects a longer value at insert time.
 *
 * The two indexes are added by **one** `ALTER TABLE`, which is one DDL statement and is atomic, so the
 * half-applied state the guard would otherwise have to repair cannot arise.
 */
import { sql } from 'kysely';

import { indexExists } from '../src/db/migration-helpers.ts';
import type { MigrationDb } from '../src/db/migration-types.ts';

export async function up(db: MigrationDb): Promise<void> {
  const clauses: string[] = [];
  if (!(await indexExists(db, 'note_projections', 'ix_proj_fm_tags'))) {
    clauses.push('ADD INDEX ix_proj_fm_tags ((CAST(fm_tags AS CHAR(64) ARRAY)))');
  }
  if (!(await indexExists(db, 'note_projections', 'ix_proj_fm_aliases'))) {
    clauses.push('ADD INDEX ix_proj_fm_aliases ((CAST(fm_aliases AS CHAR(255) ARRAY)))');
  }
  if (clauses.length === 0) return;
  await sql.raw(`ALTER TABLE note_projections ${clauses.join(', ')}`).execute(db);
}

export async function down(db: MigrationDb): Promise<void> {
  const clauses: string[] = [];
  if (await indexExists(db, 'note_projections', 'ix_proj_fm_tags')) {
    clauses.push('DROP INDEX ix_proj_fm_tags');
  }
  if (await indexExists(db, 'note_projections', 'ix_proj_fm_aliases')) {
    clauses.push('DROP INDEX ix_proj_fm_aliases');
  }
  if (clauses.length === 0) return;
  await sql.raw(`ALTER TABLE note_projections ${clauses.join(', ')}`).execute(db);
}
