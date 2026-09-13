/**
 * 0030_access_log
 *
 * `access_log` (03-data-model.md section 12.5): every token-authenticated read and the four OAuth
 * grant steps, partitioned monthly by `occurred_at`.
 *
 * Raw `sql`, because partition definitions cannot be expressed by the Kysely builder.
 * `PRIMARY KEY (id, occurred_at)` is not a style choice: InnoDB requires every unique key of a
 * partitioned table to contain every partitioning column, and `id` stays first so it is still the
 * `AUTO_INCREMENT` column and still gives a total insertion order. Partitioned InnoDB tables support
 * no foreign keys, and the log must outlive everything it references anyway.
 *
 * The partition list is deliberately fixed rather than derived from the current date, so that the
 * schema this migration produces is the same on every engine and on every day. `p_overflow` is a
 * `MAXVALUE` catch-all: a missed maintenance run degrades performance instead of failing inserts with
 * "table has no partition for value". The `access_log_partitions` job keeps three months of future
 * partitions ahead of it and drops partitions past `retention.accessLogDays`, under the migrator role,
 * because both statements are DDL and `iridium_app` holds none (D03-03).
 *
 * `oauth_client_id` arrives in `0048`.
 */
import { sql } from 'kysely';

import type { MigrationDb } from '../src/db/migration-types.ts';

export async function up(db: MigrationDb): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS access_log (
      id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      occurred_at        DATETIME(6)  NOT NULL,
      token_id           BINARY(16)   NULL,
      user_id            BINARY(16)   NOT NULL,
      surface            ENUM('mcp','rest','export','oauth') NOT NULL,
      action             VARCHAR(64)  NOT NULL,
      vault_id           BINARY(16)   NULL,
      note_ids           JSON         NULL,
      note_ids_truncated TINYINT(1)   NOT NULL DEFAULT 0,
      revision           BIGINT UNSIGNED NULL,
      status             ENUM('ok','denied','not_found','error','rate_limited') NOT NULL,
      latency_ms         INT UNSIGNED NOT NULL,
      bytes_out          INT UNSIGNED NULL,
      client_name        VARCHAR(64)  NULL,
      client_version     VARCHAR(32)  NULL,
      ip                 VARBINARY(16) NULL,
      request_id         BINARY(16)   NULL,
      PRIMARY KEY (id, occurred_at),
      KEY ix_access_token_time (token_id, occurred_at),
      KEY ix_access_vault_time (vault_id, occurred_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    PARTITION BY RANGE COLUMNS (occurred_at) (
      PARTITION p2026_09 VALUES LESS THAN ('2026-10-01 00:00:00.000000'),
      PARTITION p2026_10 VALUES LESS THAN ('2026-11-01 00:00:00.000000'),
      PARTITION p_overflow VALUES LESS THAN (MAXVALUE)
    )
  `.execute(db);
}

export async function down(db: MigrationDb): Promise<void> {
  await sql`DROP TABLE IF EXISTS access_log`.execute(db);
}
