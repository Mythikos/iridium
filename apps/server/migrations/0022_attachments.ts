/**
 * 0022_attachments
 *
 * `attachments` (03-data-model.md section 10), including the `live` generated column and both
 * unique keys.
 *
 * Unlike `nodes`, both unique keys are declared in the create statement: neither is a separate schema
 * object with an independent failure mode here, because the table is created empty and the two
 * identities it keeps apart -- content (`vault_id`, `sha256`) and location (`vault_id`, `path_hint`,
 * `live`) -- are the point of the table.
 *
 * `path_hint` is `VARCHAR(760)` and not a rounder number because it is part of a unique index: InnoDB
 * caps an index key at 3072 bytes, `utf8mb4` costs four bytes per character and `vault_id` plus `live`
 * consume 17 of them, which leaves 763 (D03-04).
 *
 * `encryption`, `key_version`, `iv` and `auth_tag` are a reserved seam, not a feature: G4 was answered
 * "volume and database encryption only" on 2026-09-12, so no code path writes anything but `'none'`.
 * They are in the schema from here so that adding envelope encryption later is a `StorageDriver`
 * wrapper and a backfill job rather than a table rewrite on a populated store.
 */
import { sql } from 'kysely';

import type { MigrationDb } from '../src/db/migration-types.ts';

export async function up(db: MigrationDb): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS attachments (
      id             BINARY(16)   NOT NULL PRIMARY KEY,
      vault_id       BINARY(16)   NOT NULL,
      sha256         BINARY(32)   NOT NULL,
      size_bytes     BIGINT UNSIGNED NOT NULL,
      mime           VARCHAR(127) NOT NULL,
      original_name  VARCHAR(255) NOT NULL,
      path_hint      VARCHAR(760) COLLATE utf8mb4_0900_as_ci NULL,
      storage_key    VARCHAR(512) NOT NULL,
      encryption     ENUM('none','aes256gcm') NOT NULL DEFAULT 'none',
      key_version    TINYINT UNSIGNED NULL,
      iv             VARBINARY(12) NULL,
      auth_tag       VARBINARY(16) NULL,
      uploaded_by    BINARY(16)   NOT NULL,
      created_at     DATETIME(6)  NOT NULL,
      deleted_at     DATETIME(6)  NULL,
      live           TINYINT GENERATED ALWAYS AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL,
      version        INT UNSIGNED NOT NULL DEFAULT 1,
      UNIQUE KEY uq_attachment_vault_sha (vault_id, sha256),
      UNIQUE KEY uq_attachment_path (vault_id, path_hint, live),
      KEY ix_attachments_vault (vault_id, deleted_at),
      CONSTRAINT fk_att_vault FOREIGN KEY (vault_id) REFERENCES vaults(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);
}

export async function down(db: MigrationDb): Promise<void> {
  await sql`DROP TABLE IF EXISTS attachments`.execute(db);
}
