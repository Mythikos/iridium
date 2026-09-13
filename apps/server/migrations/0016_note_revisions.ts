/**
 * 0016_note_revisions
 *
 * `note_revisions` (03-data-model.md section 8.7): recoverable Markdown checkpoints, deliberately
 * separate from the synchronisation state.
 *
 * Its own file because of the foreign key to `notes`. `uq_revisions_note_seq_kind` is what makes every
 * checkpoint write idempotent -- a retried compaction, a replayed job or a second unload at the same
 * seq inserts nothing through `INSERT ... ON DUPLICATE KEY UPDATE id = id` -- and it is also what lets
 * a `named` row and a `checkpoint` row coexist at one seq, which is what naming the current version
 * does.
 *
 * `iridium_app` holds `UPDATE (id)` and nothing more on this table, so that self-assignment is the
 * only write the column-scoped privilege admits (section 2).
 */
import { sql } from 'kysely';

import type { MigrationDb } from '../src/db/migration-types.ts';

export async function up(db: MigrationDb): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS note_revisions (
      id                        BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      note_id                   BINARY(16)      NOT NULL,
      seq                       BIGINT UNSIGNED NOT NULL,
      kind                      ENUM('create','import','checkpoint','unload','named','pre_restore','restore','trash') NOT NULL,
      label                     VARCHAR(200)    NULL,
      markdown                  MEDIUMTEXT      NOT NULL,
      content_hash              BINARY(32)      NOT NULL,
      size_chars                INT UNSIGNED    NOT NULL,
      snapshot                  LONGBLOB        NULL,
      snapshot_format           TINYINT UNSIGNED NULL,
      yjs_major                 TINYINT UNSIGNED NULL,
      snapshot_sv               VARBINARY(4096) NULL,
      actor_type                ENUM('user','token','system') NOT NULL,
      actor_id                  BINARY(16)      NULL,
      restored_from_revision_id BIGINT UNSIGNED NULL,
      created_at                DATETIME(6)     NOT NULL,
      UNIQUE KEY uq_revisions_note_seq_kind (note_id, seq, kind),
      KEY ix_revisions_note_created (note_id, created_at),
      CONSTRAINT fk_revisions_note FOREIGN KEY (note_id) REFERENCES notes(node_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);
}

export async function down(db: MigrationDb): Promise<void> {
  await sql`DROP TABLE IF EXISTS note_revisions`.execute(db);
}
