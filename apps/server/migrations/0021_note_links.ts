/**
 * 0021_note_links
 *
 * `note_links` (03-data-model.md section 9.5): one row per outgoing reference in a note's committed
 * Markdown, in source order.
 *
 * Its own file because of the foreign key to `notes`. `resolved_node_id` and
 * `resolved_attachment_id` deliberately carry none: a target may be trashed (the row stays and the UI
 * shows "in trash") or purged (the purge transaction nulls the reference and marks the row `broken`).
 *
 * `line` is stored rather than derived (D03-18) because every link-facing DTO addresses lines, and
 * re-scanning `note_projections.markdown` for every backlink listing to recover a number the
 * projection already had is work nobody needs to do twice.
 */
import { sql } from 'kysely';

import type { MigrationDb } from '../src/db/migration-types.ts';

export async function up(db: MigrationDb): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS note_links (
      id                     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      from_note_id           BINARY(16)   NOT NULL,
      vault_id               BINARY(16)   NOT NULL,
      revision               BIGINT UNSIGNED NOT NULL,
      ordinal                INT UNSIGNED NOT NULL,
      kind                   ENUM('markdown','image','wikilink','embed','definition') NOT NULL,
      raw_target             VARCHAR(2048) NOT NULL,
      resolved_node_id       BINARY(16)   NULL,
      resolved_attachment_id BINARY(16)   NULL,
      fragment               VARCHAR(255) NULL,
      status                 ENUM('resolved','ambiguous','broken','external') NOT NULL,
      start_offset           INT UNSIGNED NOT NULL,
      end_offset             INT UNSIGNED NOT NULL,
      line                   INT UNSIGNED NOT NULL,
      UNIQUE KEY uq_links_from_ordinal (from_note_id, ordinal),
      KEY ix_links_target_node (vault_id, resolved_node_id),
      KEY ix_links_target_attachment (resolved_attachment_id),
      KEY ix_links_status (vault_id, status),
      CONSTRAINT fk_links_note FOREIGN KEY (from_note_id) REFERENCES notes(node_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);
}

export async function down(db: MigrationDb): Promise<void> {
  await sql`DROP TABLE IF EXISTS note_links`.execute(db);
}
