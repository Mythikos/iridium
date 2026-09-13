/**
 * 0020_note_search_fulltext
 *
 * `CREATE FULLTEXT INDEX ft_note_search ON note_search (title, body_text)` (03-data-model.md
 * section 9.4, D03-11).
 *
 * Raw `sql`, because Kysely has no FULLTEXT builder. Its own file because it freezes two server
 * settings at build time: `innodb_ft_min_token_size = 2` and `innodb_ft_enable_stopword = OFF` are
 * read when the index is created, not when it is queried, which is why `infra/docker/mysql/my.cnf`
 * must be in effect before this migration runs. Changing either later is a documented operator rebuild
 * (drop the index, change the setting, re-create, `iridium reindex`), never an online migration.
 *
 * No `ngram_token_size` line is shipped and no second parser index exists: CJK tokenisation was
 * answered out of scope for 1.0 (G5, 2026-09-12), and the parser choice is frozen here for every vault
 * indexed afterwards.
 *
 * One object, one name: `ft_note_search` over `(title, body_text)`.
 */
import { sql } from 'kysely';

import { indexExists } from '../src/db/migration-helpers.ts';
import type { MigrationDb } from '../src/db/migration-types.ts';

export async function up(db: MigrationDb): Promise<void> {
  if (await indexExists(db, 'note_search', 'ft_note_search')) return;
  await sql`CREATE FULLTEXT INDEX ft_note_search ON note_search (title, body_text)`.execute(db);
}

export async function down(db: MigrationDb): Promise<void> {
  if (!(await indexExists(db, 'note_search', 'ft_note_search'))) return;
  await sql`ALTER TABLE note_search DROP INDEX ft_note_search`.execute(db);
}
