/**
 * 0001_users
 *
 * `users`, including the `email_key` stored generated column and `uq_users_email_key`
 * (03-data-model.md section 3).
 *
 * The root of every foreign-key chain, so it is migration 0001. The unique key is on the generated
 * `LOWER(email)` rather than on `email`, so the display form keeps the user's own casing while
 * uniqueness is case-insensitive regardless of collation choices.
 */
import { sql } from 'kysely';

import type { MigrationDb } from '../src/db/migration-types.ts';

export async function up(db: MigrationDb): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS users (
      id               BINARY(16)   NOT NULL PRIMARY KEY,
      email            VARCHAR(320) NOT NULL,
      email_key        VARCHAR(320) GENERATED ALWAYS AS (LOWER(email)) STORED,
      display_name     VARCHAR(120) NOT NULL,
      is_server_admin  TINYINT(1)   NOT NULL DEFAULT 0,
      status           ENUM('active','disabled','deleted') NOT NULL DEFAULT 'active',
      color_hue        SMALLINT UNSIGNED NOT NULL,
      authz_version    INT UNSIGNED NOT NULL DEFAULT 1,
      version          INT UNSIGNED NOT NULL DEFAULT 1,
      created_at       DATETIME(6)  NOT NULL,
      updated_at       DATETIME(6)  NOT NULL,
      last_login_at    DATETIME(6)  NULL,
      UNIQUE KEY uq_users_email_key (email_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);
}

export async function down(db: MigrationDb): Promise<void> {
  await sql`DROP TABLE IF EXISTS users`.execute(db);
}
