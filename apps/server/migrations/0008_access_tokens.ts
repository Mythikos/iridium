/**
 * 0008_access_tokens
 *
 * `access_tokens` (03-data-model.md section 4): one table for both credential kinds, `pat` and
 * `oauth`.
 *
 * Created here without its four OAuth columns and their two foreign keys, which arrive in
 * `0046_access_tokens_oauth_columns`, and without `ix_tokens_consent`/`ix_tokens_client`, which
 * arrive in `0047`: a foreign key cannot be declared against a table that has not been created yet,
 * and `oauth_clients`/`oauth_consents` do not exist until `0035`/`0037`.
 *
 * `rotated_from_id` carries no foreign key deliberately -- it is provenance, and token rows are never
 * deleted (A31), so a RESTRICT constraint would buy nothing.
 */
import { sql } from 'kysely';

import type { MigrationDb } from '../src/db/migration-types.ts';

export async function up(db: MigrationDb): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS access_tokens (
      id                      BINARY(16)  NOT NULL PRIMARY KEY,
      token_id                CHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      secret_hash             BINARY(32)  NOT NULL,
      user_id                 BINARY(16)  NOT NULL,
      kind                    ENUM('pat','oauth','scim') NOT NULL DEFAULT 'pat',
      name                    VARCHAR(120) NOT NULL,
      display_prefix          CHAR(26)    NOT NULL,
      scopes                  JSON        NOT NULL,
      all_vaults              TINYINT(1)  NOT NULL DEFAULT 0,
      admin_owned             TINYINT(1)  NOT NULL DEFAULT 0,
      expires_at              DATETIME(6) NOT NULL,
      last_used_at            DATETIME(6) NULL,
      last_used_ip            VARBINARY(16) NULL,
      last_client             VARCHAR(120) NULL,
      rate_limit_per_hour     INT UNSIGNED NULL,
      created_at              DATETIME(6) NOT NULL,
      created_from_session_id BINARY(16)  NULL,
      created_ip              VARBINARY(16) NULL,
      created_user_agent      VARCHAR(255) NULL,
      rotated_from_id         BINARY(16)  NULL,
      rotation_overlap_until  DATETIME(6) NULL,
      revoked_at              DATETIME(6) NULL,
      revoked_by              BINARY(16)  NULL,
      revoke_reason           VARCHAR(120) NULL,
      version                 INT UNSIGNED NOT NULL DEFAULT 1,
      UNIQUE KEY uq_tokens_token_id (token_id),
      KEY ix_tokens_user (user_id, revoked_at, expires_at),
      KEY ix_tokens_expires (expires_at),
      CONSTRAINT fk_tokens_user FOREIGN KEY (user_id) REFERENCES users(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);
}

export async function down(db: MigrationDb): Promise<void> {
  await sql`DROP TABLE IF EXISTS access_tokens`.execute(db);
}
