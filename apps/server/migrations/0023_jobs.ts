/**
 * 0023_jobs
 *
 * `jobs` (03-data-model.md section 11): one row for every asynchronous unit of work, so the admin
 * jobs view, the CLI and the metrics all read one place.
 *
 * Created before its two extension tables, which key off `job_id`. There is no separate lock table:
 * the status transition *is* the claim (`WHERE id = ? AND status = 'queued'`), which is why the table
 * carries no `version` column. `vault_id` and `requested_by` carry no foreign keys -- a job record
 * outlives an aborted-import vault and is itself part of the operational record.
 */
import { sql } from 'kysely';

import type { MigrationDb } from '../src/db/migration-types.ts';

export async function up(db: MigrationDb): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS jobs (
      id           BINARY(16)  NOT NULL PRIMARY KEY,
      type         VARCHAR(48) NOT NULL,
      status       ENUM('queued','running','succeeded','failed','cancelled') NOT NULL,
      vault_id     BINARY(16)  NULL,
      requested_by BINARY(16)  NULL,
      payload      JSON        NOT NULL,
      progress     JSON        NULL,
      result       JSON        NULL,
      error        TEXT        NULL,
      attempts     TINYINT UNSIGNED NOT NULL DEFAULT 0,
      locked_by    VARCHAR(64) NULL,
      locked_at    DATETIME(6) NULL,
      created_at   DATETIME(6) NOT NULL,
      started_at   DATETIME(6) NULL,
      finished_at  DATETIME(6) NULL,
      KEY ix_jobs_status (status, created_at),
      KEY ix_jobs_vault_type (vault_id, type)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);
}

export async function down(db: MigrationDb): Promise<void> {
  await sql`DROP TABLE IF EXISTS jobs`.execute(db);
}
