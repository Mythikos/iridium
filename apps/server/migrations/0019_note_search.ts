/**
 * 0019_note_search
 *
 * `note_search` (03-data-model.md section 9.4): the deliberately narrow FULLTEXT projection.
 *
 * The table must be **empty** when the FULLTEXT index is added, which is why `0020` follows
 * immediately: InnoDB adds its hidden `FTS_DOC_ID` during an instant rebuild of an empty table, so
 * nothing needs predefining and the rebuild costs nothing.
 *
 * `vault_id` and `title` are duplicated here on purpose: every query filters by vault inside SQL, and
 * `MATCH()` requires the exact column list of the index, so title has to live in the same index as the
 * body.
 */
import { sql } from 'kysely';

import type { MigrationDb } from '../src/db/migration-types.ts';

export async function up(db: MigrationDb): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS note_search (
      note_id    BINARY(16)      NOT NULL PRIMARY KEY,
      vault_id   BINARY(16)      NOT NULL,
      title      VARCHAR(255)    NOT NULL,
      body_text  MEDIUMTEXT      NOT NULL,
      revision   BIGINT UNSIGNED NOT NULL,
      updated_at DATETIME(6)     NOT NULL,
      KEY ix_search_vault (vault_id),
      CONSTRAINT fk_search_note FOREIGN KEY (note_id) REFERENCES notes(node_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);
}

export async function down(db: MigrationDb): Promise<void> {
  await sql`DROP TABLE IF EXISTS note_search`.execute(db);
}
