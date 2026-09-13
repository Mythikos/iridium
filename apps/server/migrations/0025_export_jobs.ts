/**
 * 0025_export_jobs
 *
 * `export_jobs` (03-data-model.md section 11.4).
 *
 * Its own file because of the foreign key to `jobs`. `include_trashed` is a column and not a request
 * parameter (D03-19) for the same reason `restore_eol` and `include_attachments` are: an option with
 * no column is lost on the worker's first restart, and the artifact would then silently change scope
 * relative to the request the `export.created` audit event recorded.
 */
import { sql } from 'kysely';

import type { MigrationDb } from '../src/db/migration-types.ts';

export async function up(db: MigrationDb): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS export_jobs (
      job_id              BINARY(16)  NOT NULL PRIMARY KEY,
      vault_id            BINARY(16)  NOT NULL,
      scope_node_id       BINARY(16)  NULL,
      format              ENUM('zip') NOT NULL,
      restore_eol         TINYINT(1)  NOT NULL DEFAULT 1,
      include_attachments TINYINT(1)  NOT NULL DEFAULT 1,
      include_trashed     TINYINT(1)  NOT NULL DEFAULT 0,
      manifest            JSON        NULL,
      artifact_key        VARCHAR(512) NULL,
      artifact_sha256     BINARY(32)  NULL,
      size_bytes          BIGINT UNSIGNED NULL,
      expires_at          DATETIME(6) NOT NULL,
      CONSTRAINT fk_export_job FOREIGN KEY (job_id) REFERENCES jobs(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);
}

export async function down(db: MigrationDb): Promise<void> {
  await sql`DROP TABLE IF EXISTS export_jobs`.execute(db);
}
