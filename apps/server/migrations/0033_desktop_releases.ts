/**
 * 0033_desktop_releases
 *
 * `desktop_releases` (03-data-model.md section 13.3): the source the `/desktop/updates/<channel>/`
 * feed is generated from.
 *
 * A published row's own fields are immutable -- `(version, channel)` is the primary key and a
 * republish of the same version is refused -- and the one lifecycle change a release admits is a soft
 * withdrawal (`withdrawn_at`, `withdrawn_by`), which keeps the row and the artefacts while dropping
 * the version from the generated feed (D03-17). Rows are never deleted.
 */
import { sql } from 'kysely';

import type { MigrationDb } from '../src/db/migration-types.ts';

export async function up(db: MigrationDb): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS desktop_releases (
      version       VARCHAR(32) NOT NULL,
      channel       ENUM('stable','beta') NOT NULL,
      published_at  DATETIME(6) NOT NULL,
      published_by  BINARY(16)  NULL,
      notes         TEXT        NULL,
      files         JSON        NOT NULL,
      withdrawn_at  DATETIME(6) NULL,
      withdrawn_by  BINARY(16)  NULL,
      PRIMARY KEY (version, channel)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);
}

export async function down(db: MigrationDb): Promise<void> {
  await sql`DROP TABLE IF EXISTS desktop_releases`.execute(db);
}
