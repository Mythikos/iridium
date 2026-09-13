/**
 * 0013_notes
 *
 * `notes` (03-data-model.md section 8.2): metadata about the body, one row per `nodes` row of kind
 * `note`.
 *
 * Its own file because of the two foreign keys. There is no separate note id -- `node_id` is both the
 * primary key and the reference -- and `vault_id` is denormalised from `nodes` so per-vault counts,
 * the unreferenced-attachment scan and the reindex job need no tree walk; both columns are immutable,
 * so the denormalisation cannot drift (invariant I-04).
 */
import { sql } from 'kysely';

import type { MigrationDb } from '../src/db/migration-types.ts';

export async function up(db: MigrationDb): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS notes (
      node_id            BINARY(16)  NOT NULL PRIMARY KEY,
      vault_id           BINARY(16)  NOT NULL,
      initialized_at     DATETIME(6) NULL,
      original_eol       ENUM('lf','crlf','cr','mixed') NOT NULL DEFAULT 'lf',
      had_bom            TINYINT(1)  NOT NULL DEFAULT 0,
      size_chars         INT UNSIGNED NOT NULL DEFAULT 0,
      oversize           TINYINT(1)  NOT NULL DEFAULT 0,
      content_invalid    TINYINT(1)  NOT NULL DEFAULT 0,
      last_edited_by     BINARY(16)  NULL,
      last_edited_at     DATETIME(6) NULL,
      last_checkpoint_at DATETIME(6) NULL,
      created_at         DATETIME(6) NOT NULL,
      updated_at         DATETIME(6) NOT NULL,
      KEY ix_notes_vault (vault_id),
      CONSTRAINT fk_notes_node FOREIGN KEY (node_id) REFERENCES nodes(id),
      CONSTRAINT fk_notes_vault FOREIGN KEY (vault_id) REFERENCES vaults(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);
}

export async function down(db: MigrationDb): Promise<void> {
  await sql`DROP TABLE IF EXISTS notes`.execute(db);
}
