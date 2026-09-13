/**
 * 0012_trash_entries
 *
 * `trash_entries` (03-data-model.md section 6.6): one row per trashed node, each pointing at the
 * cascade root the user actually trashed.
 *
 * Its own file because of the foreign key to `nodes`. `ix_trash_vault_root` groups members under
 * their restore unit; `ix_trash_vault_expires` is what the `trash_purge` job scans.
 */
import { sql } from 'kysely';

import type { MigrationDb } from '../src/db/migration-types.ts';

export async function up(db: MigrationDb): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS trash_entries (
      node_id            BINARY(16)  NOT NULL PRIMARY KEY,
      vault_id           BINARY(16)  NOT NULL,
      cascade_root_id    BINARY(16)  NOT NULL,
      deleted_by         BINARY(16)  NOT NULL,
      deleted_at         DATETIME(6) NOT NULL,
      original_parent_id BINARY(16)  NOT NULL,
      original_path      TEXT        NOT NULL,
      expires_at         DATETIME(6) NOT NULL,
      KEY ix_trash_vault_expires (vault_id, expires_at),
      KEY ix_trash_vault_root (vault_id, cascade_root_id),
      CONSTRAINT fk_trash_node FOREIGN KEY (node_id) REFERENCES nodes(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);
}

export async function down(db: MigrationDb): Promise<void> {
  await sql`DROP TABLE IF EXISTS trash_entries`.execute(db);
}
