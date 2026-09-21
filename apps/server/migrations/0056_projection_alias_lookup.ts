// -- iridium: long-running
/** Atomic table rebuild for the full Unicode frontmatter policy (08 sections 2.5, 5.2). */
import { sql } from 'kysely';

import { indexExists } from '../src/db/migration-helpers.ts';
import type { MigrationDb } from '../src/db/migration-types.ts';

export async function up(db: MigrationDb): Promise<void> {
  const clauses: string[] = [];
  const rawType = await sql<{ DATA_TYPE: string }>`SELECT DATA_TYPE FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='note_projections'
      AND COLUMN_NAME='frontmatter_raw'`.execute(db);
  // A legal frontmatter block can occupy the same byte budget as its containing Markdown source.
  if (rawType.rows[0]?.DATA_TYPE !== 'mediumtext')
    clauses.push('MODIFY COLUMN frontmatter_raw MEDIUMTEXT NULL');
  // MVI arrays share an undo-page budget that cannot represent the declared Unicode tag/alias caps.
  if (await indexExists(db, 'note_projections', 'ix_proj_fm_tags'))
    clauses.push('DROP INDEX ix_proj_fm_tags');
  if (await indexExists(db, 'note_projections', 'ix_proj_fm_aliases'))
    clauses.push('DROP INDEX ix_proj_fm_aliases');
  if (clauses.length > 0)
    await sql.raw(`ALTER TABLE note_projections ${clauses.join(', ')}`).execute(db);
}

export async function down(db: MigrationDb): Promise<void> {
  const clauses: string[] = [];
  const rawType = await sql<{ DATA_TYPE: string }>`SELECT DATA_TYPE FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='note_projections'
      AND COLUMN_NAME='frontmatter_raw'`.execute(db);
  // Atomic DDL refuses a downgrade if newly legal metadata cannot fit the historical schema.
  if (rawType.rows[0]?.DATA_TYPE !== 'text')
    clauses.push('MODIFY COLUMN frontmatter_raw TEXT NULL');
  if (!(await indexExists(db, 'note_projections', 'ix_proj_fm_tags')))
    clauses.push('ADD INDEX ix_proj_fm_tags ((CAST(fm_tags AS CHAR(64) ARRAY)))');
  if (!(await indexExists(db, 'note_projections', 'ix_proj_fm_aliases')))
    clauses.push('ADD INDEX ix_proj_fm_aliases ((CAST(fm_aliases AS CHAR(255) ARRAY)))');
  if (clauses.length > 0)
    await sql.raw(`ALTER TABLE note_projections ${clauses.join(', ')}`).execute(db);
}
