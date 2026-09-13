/**
 * 0044_oauth_refresh_tokens
 *
 * `oauth_refresh_tokens` (03-data-model.md section 4A): the rotating refresh chain and the reuse
 * detector it exists for.
 *
 * Presenting a row that already carries `rotated_at` or `revoked_at` is the theft signal, and the
 * response is one transaction that revokes every row of that `family_id` and every access token the
 * family minted. `ix_oauth_refresh_family (family_id, revoked_at)` is what makes the refresh half of
 * that a single indexed sweep; `ix_oauth_refresh_expires` drives the sliding/absolute expiry sweep.
 */
import { sql } from 'kysely';

import type { MigrationDb } from '../src/db/migration-types.ts';

export async function up(db: MigrationDb): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
      id                  BINARY(16)  NOT NULL PRIMARY KEY,
      token_id            CHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      secret_hash         BINARY(32)  NOT NULL,
      family_id           BINARY(16)  NOT NULL,
      rotated_from_id     BINARY(16)  NULL,
      client_id           BINARY(16)  NOT NULL,
      user_id             BINARY(16)  NOT NULL,
      consent_id          BINARY(16)  NOT NULL,
      resource            VARCHAR(255) NOT NULL,
      scopes              JSON        NOT NULL,
      issued_at           DATETIME(6) NOT NULL,
      expires_at          DATETIME(6) NOT NULL,
      absolute_expires_at DATETIME(6) NOT NULL,
      last_used_at        DATETIME(6) NULL,
      rotated_at          DATETIME(6) NULL,
      revoked_at          DATETIME(6) NULL,
      revoke_reason       VARCHAR(120) NULL,
      UNIQUE KEY uq_oauth_refresh_token_id (token_id),
      KEY ix_oauth_refresh_family (family_id, revoked_at),
      KEY ix_oauth_refresh_consent (consent_id, revoked_at),
      KEY ix_oauth_refresh_expires (absolute_expires_at),
      CONSTRAINT fk_oauth_refresh_client  FOREIGN KEY (client_id)  REFERENCES oauth_clients(id),
      CONSTRAINT fk_oauth_refresh_user    FOREIGN KEY (user_id)    REFERENCES users(id),
      CONSTRAINT fk_oauth_refresh_consent FOREIGN KEY (consent_id) REFERENCES oauth_consents(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);
}

export async function down(db: MigrationDb): Promise<void> {
  await sql`DROP TABLE IF EXISTS oauth_refresh_tokens`.execute(db);
}
