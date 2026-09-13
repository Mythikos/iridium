/**
 * 0024_import_jobs
 *
 * `import_jobs` (03-data-model.md section 11.3): the 1:0..1 extension row that carries the
 * two-phase import state machine.
 *
 * Its own file because of the foreign key to `jobs`. `target_vault_id` deliberately carries none: the
 * job record must survive the teardown of an aborted-import vault (section 1.4). `report` and
 * `options` are the only place a user's import decisions are recorded, and both are quoted verbatim in
 * the `import.committed` audit event.
 */
import { sql } from 'kysely';

import type { MigrationDb } from '../src/db/migration-types.ts';

export async function up(db: MigrationDb): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS import_jobs (
      job_id           BINARY(16)  NOT NULL PRIMARY KEY,
      target_vault_id  BINARY(16)  NULL,
      target_parent_id BINARY(16)  NULL,
      source_kind      ENUM('zip','files') NOT NULL,
      source_sha256    BINARY(32)  NULL,
      staging_key      VARCHAR(512) NOT NULL,
      phase            ENUM('uploading','scanning','reported','committing','done','failed','aborted') NOT NULL,
      report           JSON        NULL,
      options          JSON        NULL,
      stats            JSON        NULL,
      committed_at     DATETIME(6) NULL,
      expires_at       DATETIME(6) NOT NULL,
      CONSTRAINT fk_import_job FOREIGN KEY (job_id) REFERENCES jobs(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);
}

export async function down(db: MigrationDb): Promise<void> {
  await sql`DROP TABLE IF EXISTS import_jobs`.execute(db);
}
