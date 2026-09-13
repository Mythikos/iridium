/**
 * 0014_note_docs
 *
 * `note_docs` (03-data-model.md section 8.3): the persistence anchor and the writer's
 * compare-and-set target.
 *
 * Its own file because of the foreign key to `notes`. `head_seq` is the single authority on how far
 * the log goes; `snapshot_through_seq` and `projected_seq` are monotonic coverage counters that a
 * crash can only leave behind, never ahead.
 *
 * `snapshot_sv` is `VARBINARY(4096)` as a declared limit rather than an assumption: an oversized state
 * vector is stored zero-length ("not recorded") by `storedSv()` and recomputed from the loaded
 * document by `recordedSv()` (D03-01).
 */
import { sql } from 'kysely';

import type { MigrationDb } from '../src/db/migration-types.ts';

export async function up(db: MigrationDb): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS note_docs (
      note_id               BINARY(16)      NOT NULL PRIMARY KEY,
      head_seq              BIGINT UNSIGNED NOT NULL DEFAULT 0,
      snapshot_format       TINYINT UNSIGNED NOT NULL DEFAULT 2,
      yjs_major             TINYINT UNSIGNED NOT NULL DEFAULT 13,
      snapshot              LONGBLOB        NULL,
      snapshot_sv           VARBINARY(4096) NULL,
      snapshot_through_seq  BIGINT UNSIGNED NOT NULL DEFAULT 0,
      snapshot_size         INT UNSIGNED    NOT NULL DEFAULT 0,
      snapshot_at           DATETIME(6)     NULL,
      projected_seq         BIGINT UNSIGNED NOT NULL DEFAULT 0,
      updated_at            DATETIME(6)     NOT NULL,
      CONSTRAINT fk_docs_note FOREIGN KEY (note_id) REFERENCES notes(node_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);
}

export async function down(db: MigrationDb): Promise<void> {
  await sql`DROP TABLE IF EXISTS note_docs`.execute(db);
}
