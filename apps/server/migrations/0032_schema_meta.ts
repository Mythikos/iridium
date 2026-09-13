/**
 * 0032_schema_meta
 *
 * `schema_meta` (03-data-model.md section 13.2), seeded with `iridium_version`, `api_version`,
 * `pipeline_version` and the four key versions.
 *
 * A narrow key/value table rather than a one-row table, deliberately, so a later migration can add a
 * key without an `ALTER`.
 *
 * The seed is the second statement of this file and is DML, not DDL, so the one-DDL-statement rule
 * holds. It is written with `ON DUPLICATE KEY UPDATE \`key\` = schema_meta.\`key\`` -- a self-assignment
 * that changes nothing -- so a re-run is a no-op and an operator's or a release migration's later
 * value is never overwritten. The deprecated `VALUES` function form of `ON DUPLICATE KEY UPDATE` is
 * not used anywhere: it is deprecated on both supported lines and banned by `db.dialect-floor.guard`.
 *
 * `iridium_version` is what the `FOUND_ROWS` boot assertion probes (section 1.3), which is why that
 * row is guaranteed to exist from this migration onwards.
 */
import { sql } from 'kysely';

import type { MigrationDb } from '../src/db/migration-types.ts';

export async function up(db: MigrationDb): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_meta (
      \`key\`  VARCHAR(32)  NOT NULL PRIMARY KEY,
      value  VARCHAR(255) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);

  await sql`
    INSERT INTO schema_meta (\`key\`, value) VALUES
      ('iridium_version', '0.0.0'),
      ('api_version', '1'),
      ('pipeline_version', '1'),
      ('pepper_version', '1'),
      ('audit_key_version', '1'),
      ('cursor_key_version', '1'),
      ('attachment_key_version', '1')
    ON DUPLICATE KEY UPDATE \`key\` = schema_meta.\`key\`
  `.execute(db);
}

export async function down(db: MigrationDb): Promise<void> {
  await sql`DROP TABLE IF EXISTS schema_meta`.execute(db);
}
