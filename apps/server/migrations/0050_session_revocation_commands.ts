/** Durable operator commands executed by the collaboration owner, with a transactional result. */
import { sql } from 'kysely';

import type { MigrationDb } from '../src/db/migration-types.ts';

export async function up(db: MigrationDb): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS session_revocation_commands (
      id BINARY(16) NOT NULL PRIMARY KEY,
      user_id BINARY(16) NULL,
      actor_type ENUM('user','token','system') NOT NULL,
      actor_id BINARY(16) NULL,
      actor_display VARCHAR(120) NULL,
      context JSON NOT NULL,
      created_at DATETIME(6) NOT NULL,
      result JSON NULL,
      delivered_at DATETIME(6) NULL,
      KEY ix_session_commands_pending (delivered_at, created_at, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);
}

export async function down(db: MigrationDb): Promise<void> {
  await sql`DROP TABLE IF EXISTS session_revocation_commands`.execute(db);
}
