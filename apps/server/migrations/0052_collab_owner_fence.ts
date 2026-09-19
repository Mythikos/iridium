/** A transaction fence for schema ownership handoff (D10-33). */
import { sql } from 'kysely';

import type { MigrationDb } from '../src/db/migration-types.ts';

/** Seed one row; only the lease claimant changes its random generation. */
export async function up(db: MigrationDb): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS collab_owner_fence (
      id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
      generation BINARY(16) NOT NULL,
      CONSTRAINT chk_collab_owner_fence_singleton CHECK (id = 1)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);
  await sql`INSERT INTO collab_owner_fence (id, generation)
    VALUES (1, UNHEX('00000000000000000000000000000000'))
    ON DUPLICATE KEY UPDATE id = collab_owner_fence.id`.execute(db);
}

/** The serving processes must be stopped before removing their transaction fence. */
export async function down(db: MigrationDb): Promise<void> {
  await sql`DROP TABLE IF EXISTS collab_owner_fence`.execute(db);
}
