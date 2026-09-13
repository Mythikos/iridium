/**
 * 0042_oauth_authorization_codes
 *
 * `oauth_authorization_codes` (03-data-model.md section 4A): 60-second single-use codes, found by
 * `uq_oauth_codes_code_id` and compared with `timingSafeEqual`; nothing is ever found by scanning a
 * secret.
 *
 * `session_id` deliberately carries no foreign key. It is not a reference but a live re-check: at code
 * exchange the server looks the session up and refuses the exchange if it is gone, which is a stronger
 * property than a constraint would give -- and a swept session must make the exchange fail rather than
 * make the sweep fail.
 */
import { sql } from 'kysely';

import type { MigrationDb } from '../src/db/migration-types.ts';

export async function up(db: MigrationDb): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
      id                    BINARY(16)  NOT NULL PRIMARY KEY,
      code_id               CHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      secret_hash           BINARY(32)  NOT NULL,
      client_id             BINARY(16)  NOT NULL,
      user_id               BINARY(16)  NOT NULL,
      consent_id            BINARY(16)  NOT NULL,
      session_id            BINARY(16)  NOT NULL,
      redirect_uri          VARCHAR(512) NOT NULL,
      code_challenge        CHAR(43)    NOT NULL,
      code_challenge_method ENUM('S256') NOT NULL,
      resource              VARCHAR(255) NOT NULL,
      scopes                JSON        NOT NULL,
      issued_at             DATETIME(6) NOT NULL,
      expires_at            DATETIME(6) NOT NULL,
      consumed_at           DATETIME(6) NULL,
      UNIQUE KEY uq_oauth_codes_code_id (code_id),
      KEY ix_oauth_codes_expires (expires_at),
      CONSTRAINT fk_oauth_codes_client  FOREIGN KEY (client_id)  REFERENCES oauth_clients(id),
      CONSTRAINT fk_oauth_codes_user    FOREIGN KEY (user_id)    REFERENCES users(id),
      CONSTRAINT fk_oauth_codes_consent FOREIGN KEY (consent_id) REFERENCES oauth_consents(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);
}

export async function down(db: MigrationDb): Promise<void> {
  await sql`DROP TABLE IF EXISTS oauth_authorization_codes`.execute(db);
}
