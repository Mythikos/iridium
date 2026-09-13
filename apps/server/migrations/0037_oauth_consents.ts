/**
 * 0037_oauth_consents
 *
 * `oauth_consents` (03-data-model.md section 4A), including the `live_consent_key` virtual generated
 * column.
 *
 * A revoked consent is the record of what a user once granted a connector and is never deleted, so
 * `(user_id, client_id)` cannot simply be unique. `live_consent_key` is `CONCAT(user_id, client_id)`
 * while `revoked_at IS NULL` and `NULL` afterwards, and the unique key over it -- `0038`, its own file
 * for the same reason `0011` is -- constrains only live rows.
 */
import { sql } from 'kysely';

import type { MigrationDb } from '../src/db/migration-types.ts';

export async function up(db: MigrationDb): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS oauth_consents (
      id                 BINARY(16)  NOT NULL PRIMARY KEY,
      user_id            BINARY(16)  NOT NULL,
      client_id          BINARY(16)  NOT NULL,
      scopes             JSON        NOT NULL,
      all_vaults         TINYINT(1)  NOT NULL DEFAULT 0,
      admin_owned        TINYINT(1)  NOT NULL DEFAULT 0,
      granted_at         DATETIME(6) NOT NULL,
      granted_session_id BINARY(16)  NULL,
      updated_at         DATETIME(6) NOT NULL,
      last_authorized_at DATETIME(6) NULL,
      revoked_at         DATETIME(6) NULL,
      revoked_by         BINARY(16)  NULL,
      revoke_reason      VARCHAR(120) NULL,
      version            INT UNSIGNED NOT NULL DEFAULT 1,
      live_consent_key   VARBINARY(32) GENERATED ALWAYS AS
      (IF(revoked_at IS NULL, CONCAT(user_id, client_id), NULL)) VIRTUAL,
      KEY ix_oauth_consents_user (user_id, revoked_at),
      KEY ix_oauth_consents_client (client_id, revoked_at),
      CONSTRAINT fk_oauth_consents_user   FOREIGN KEY (user_id)   REFERENCES users(id),
      CONSTRAINT fk_oauth_consents_client FOREIGN KEY (client_id) REFERENCES oauth_clients(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);
}

export async function down(db: MigrationDb): Promise<void> {
  await sql`DROP TABLE IF EXISTS oauth_consents`.execute(db);
}
