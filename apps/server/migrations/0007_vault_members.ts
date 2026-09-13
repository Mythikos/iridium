/**
 * 0007_vault_members
 *
 * `vault_members` (03-data-model.md section 5): the only source of a user's vault role.
 *
 * Its own file because of the two foreign keys. Server administrators have no row here at all --
 * admin rights are computed by `authorize()`, never materialised -- and `version` is the membership
 * half of the collaboration authz epoch tuple.
 */
import { sql } from 'kysely';

import type { MigrationDb } from '../src/db/migration-types.ts';

export async function up(db: MigrationDb): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS vault_members (
      vault_id    BINARY(16) NOT NULL,
      user_id     BINARY(16) NOT NULL,
      role        ENUM('viewer','editor','manager') NOT NULL,
      version     INT UNSIGNED NOT NULL DEFAULT 1,
      granted_by  BINARY(16) NOT NULL,
      created_at  DATETIME(6) NOT NULL,
      updated_at  DATETIME(6) NOT NULL,
      PRIMARY KEY (vault_id, user_id),
      KEY ix_members_user (user_id),
      CONSTRAINT fk_members_vault FOREIGN KEY (vault_id) REFERENCES vaults(id),
      CONSTRAINT fk_members_user FOREIGN KEY (user_id) REFERENCES users(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);
}

export async function down(db: MigrationDb): Promise<void> {
  await sql`DROP TABLE IF EXISTS vault_members`.execute(db);
}
