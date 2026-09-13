/**
 * 0003_password_setup_tokens
 *
 * `password_setup_tokens` (03-data-model.md section 3): the one-time `irid_spl_...` set-password
 * links.
 *
 * Its own file because of the foreign key to `users`. `issued_by` deliberately carries none: it is an
 * attribution column, and users are anonymised rather than deleted (section 1.4).
 */
import { sql } from 'kysely';

import type { MigrationDb } from '../src/db/migration-types.ts';

export async function up(db: MigrationDb): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS password_setup_tokens (
      id            BINARY(16)  NOT NULL PRIMARY KEY,
      token_id      CHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      secret_hash   BINARY(32)  NOT NULL,
      user_id       BINARY(16)  NOT NULL,
      purpose       ENUM('initial','reset') NOT NULL,
      issued_by     BINARY(16)  NOT NULL,
      expires_at    DATETIME(6) NOT NULL,
      consumed_at   DATETIME(6) NULL,
      created_at    DATETIME(6) NOT NULL,
      UNIQUE KEY uq_spl_token_id (token_id),
      KEY ix_spl_user (user_id, consumed_at),
      CONSTRAINT fk_spl_user FOREIGN KEY (user_id) REFERENCES users(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);
}

export async function down(db: MigrationDb): Promise<void> {
  await sql`DROP TABLE IF EXISTS password_setup_tokens`.execute(db);
}
