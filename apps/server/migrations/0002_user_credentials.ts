/**
 * 0002_user_credentials
 *
 * `user_credentials` (03-data-model.md section 3): the argon2id PHC string and the pepper
 * generation that verifies it.
 *
 * Its own file because of the foreign key to `users`. The row is absent until the user sets a
 * password through a setup link, which is why this is a separate table and not columns on `users`.
 */
import { sql } from 'kysely';

import type { MigrationDb } from '../src/db/migration-types.ts';

export async function up(db: MigrationDb): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS user_credentials (
      user_id             BINARY(16)   NOT NULL PRIMARY KEY,
      password_hash       VARCHAR(255) NOT NULL,
      pepper_version      TINYINT UNSIGNED NOT NULL,
      password_changed_at DATETIME(6)  NOT NULL,
      CONSTRAINT fk_cred_user FOREIGN KEY (user_id) REFERENCES users(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);
}

export async function down(db: MigrationDb): Promise<void> {
  await sql`DROP TABLE IF EXISTS user_credentials`.execute(db);
}
