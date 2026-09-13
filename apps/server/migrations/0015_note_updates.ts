/**
 * 0015_note_updates
 *
 * `note_updates` (03-data-model.md section 8.4): the append-only durability log, in V1 wire bytes
 * exactly as applied to the server document.
 *
 * Its own file because of the foreign key to `notes`. `PRIMARY KEY (note_id, seq)` is the clustered
 * key, so one note's log rows are physically contiguous in seq order and the load scan is one index
 * range read; there is no surrogate key, which is what makes a duplicate seq a primary-key violation
 * rather than a silent fork.
 *
 * `iridium_app` holds no `UPDATE` on this table at all (section 2): rows leave only through
 * `update_log_prune`.
 */
import { sql } from 'kysely';

import type { MigrationDb } from '../src/db/migration-types.ts';

export async function up(db: MigrationDb): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS note_updates (
      note_id     BINARY(16)      NOT NULL,
      seq         BIGINT UNSIGNED NOT NULL,
      update_v1   MEDIUMBLOB      NOT NULL,
      yjs_major   TINYINT UNSIGNED NOT NULL DEFAULT 13,
      sv_after    VARBINARY(4096) NOT NULL,
      actor_type  ENUM('user','system') NOT NULL,
      actor_id    BINARY(16)      NULL,
      session_id  BINARY(16)      NULL,
      origin      ENUM('connection','create','import','restore','repair') NOT NULL,
      created_at  DATETIME(6)     NOT NULL,
      PRIMARY KEY (note_id, seq),
      KEY ix_updates_created (created_at),
      CONSTRAINT fk_updates_note FOREIGN KEY (note_id) REFERENCES notes(node_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);
}

export async function down(db: MigrationDb): Promise<void> {
  await sql`DROP TABLE IF EXISTS note_updates`.execute(db);
}
