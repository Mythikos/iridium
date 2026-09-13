/**
 * 0031_server_settings
 *
 * `server_settings` (03-data-model.md section 13.1): one row per policy group, each holding a
 * zod-validated JSON object.
 *
 * A missing row means "use the environment baseline", so a fresh install needs no seeding at all:
 * `resolvePolicy(key)` merges the baseline with the stored row field by field and takes whichever
 * value is stricter, which is what stops an administrator loosening what the operator pinned in the
 * deployment.
 */
import { sql } from 'kysely';

import type { MigrationDb } from '../src/db/migration-types.ts';

export async function up(db: MigrationDb): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS server_settings (
      \`key\`      VARCHAR(64) NOT NULL PRIMARY KEY,
      value      JSON        NOT NULL,
      updated_by BINARY(16)  NULL,
      updated_at DATETIME(6) NOT NULL,
      version    INT UNSIGNED NOT NULL DEFAULT 1
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);
}

export async function down(db: MigrationDb): Promise<void> {
  await sql`DROP TABLE IF EXISTS server_settings`.execute(db);
}
