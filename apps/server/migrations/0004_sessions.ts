/**
 * 0004_sessions
 *
 * `sessions` (03-data-model.md section 3): one row per login; the secret is never stored.
 *
 * Its own file because of the foreign key to `users`. `ix_sessions_absolute` is what the
 * `session_ticket_sweep` job scans.
 */
import { sql } from 'kysely';

import type { MigrationDb } from '../src/db/migration-types.ts';

export async function up(db: MigrationDb): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS sessions (
      id                    BINARY(16)  NOT NULL PRIMARY KEY,
      token_id              CHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      secret_hash           BINARY(32)  NOT NULL,
      user_id               BINARY(16)  NOT NULL,
      kind                  ENUM('web','desktop') NOT NULL,
      created_at            DATETIME(6) NOT NULL,
      last_seen_at          DATETIME(6) NOT NULL,
      idle_expires_at       DATETIME(6) NOT NULL,
      absolute_expires_at   DATETIME(6) NOT NULL,
      last_authenticated_at DATETIME(6) NOT NULL,
      mfa_verified_at       DATETIME(6) NULL,
      ip                    VARBINARY(16) NULL,
      user_agent            VARCHAR(255) NULL,
      client_name           VARCHAR(64)  NULL,
      device_name           VARCHAR(120) NULL,
      client_version        VARCHAR(32)  NULL,
      revoked_at            DATETIME(6) NULL,
      revoked_reason        ENUM('logout','admin','password_change','user_disabled','expired','replaced') NULL,
      UNIQUE KEY uq_sessions_token_id (token_id),
      KEY ix_sessions_user (user_id, revoked_at),
      KEY ix_sessions_absolute (absolute_expires_at),
      CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);
}

export async function down(db: MigrationDb): Promise<void> {
  await sql`DROP TABLE IF EXISTS sessions`.execute(db);
}
