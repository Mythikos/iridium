/**
 * 0006_vaults
 *
 * `vaults` (03-data-model.md section 5), referenced by tokens, nodes and attachments.
 *
 * `name` is `VARCHAR(120)` because `LIMITS.VAULT_NAME_MAX_CHARS` is 120, and it collates
 * `utf8mb4_0900_as_ci` (case-insensitive, accent-sensitive) so a vault name means on disk what it
 * means in the database. `root_node_id` carries no foreign key: it is circular with `nodes.vault_id`
 * and is enforced as application invariant I-05.
 */
import { sql } from 'kysely';

import type { MigrationDb } from '../src/db/migration-types.ts';

export async function up(db: MigrationDb): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS vaults (
      id                           BINARY(16)   NOT NULL PRIMARY KEY,
      name                         VARCHAR(120) COLLATE utf8mb4_0900_as_ci NOT NULL,
      slug                         VARCHAR(64)  CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      description                  VARCHAR(500) NULL,
      root_node_id                 BINARY(16)   NULL,
      status                       ENUM('importing','active','archived','deleting') NOT NULL DEFAULT 'active',
      archived_at                  DATETIME(6)  NULL,
      markdown_flavor              ENUM('gfm','obsidian-compat') NOT NULL DEFAULT 'gfm',
      soft_breaks                  TINYINT(1)   NOT NULL DEFAULT 0,
      attachment_folder            VARCHAR(255) NOT NULL DEFAULT 'attachments',
      load_external_images         ENUM('never','click','always') NOT NULL DEFAULT 'click',
      mcp_enabled                  TINYINT(1)   NOT NULL DEFAULT 1,
      ai_guidance                  TEXT         NULL,
      trash_retention_days         SMALLINT UNSIGNED NOT NULL DEFAULT 30,
      auto_checkpoint_interval_min SMALLINT UNSIGNED NOT NULL DEFAULT 10,
      tree_version                 BIGINT UNSIGNED NOT NULL DEFAULT 0,
      version                      INT UNSIGNED NOT NULL DEFAULT 1,
      created_by                   BINARY(16)   NOT NULL,
      created_at                   DATETIME(6)  NOT NULL,
      updated_at                   DATETIME(6)  NOT NULL,
      UNIQUE KEY uq_vaults_name (name),
      UNIQUE KEY uq_vaults_slug (slug),
      KEY ix_vaults_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);
}

export async function down(db: MigrationDb): Promise<void> {
  await sql`DROP TABLE IF EXISTS vaults`.execute(db);
}
