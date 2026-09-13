/**
 * 0026_audit_events
 *
 * `audit_events` (03-data-model.md section 12.1): append-only, HMAC-chained per `chain_id`.
 *
 * It must exist before its triggers (`0028`) and before the archive copy (`0029`). No column carries a
 * foreign key: evidence must never block, or be blocked by, another row's lifecycle, and users are
 * anonymised rather than deleted so `actor_id` stays meaningful forever.
 *
 * `chain_id` is `VARCHAR(40)` because a vault chain is `'vault:'` plus 32 lowercase hex characters --
 * 38 -- while the canonical hyphenated UUID form would be 42 and would not fit (D03-05).
 *
 * `credential_type` already carries `'oauth'` here rather than gaining it by a later `ALTER`: the whole
 * authorization server ships in the same release, so an `ALTER` to a table created eight migrations
 * earlier in the same set would be ceremony, not safety.
 */
import { sql } from 'kysely';

import type { MigrationDb } from '../src/db/migration-types.ts';

export async function up(db: MigrationDb): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS audit_events (
      id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      occurred_at          DATETIME(6)  NOT NULL,
      schema_version       SMALLINT UNSIGNED NOT NULL DEFAULT 1,
      chain_id             VARCHAR(40)  NOT NULL,
      action               VARCHAR(64)  NOT NULL,
      actor_type           ENUM('user','token','system') NOT NULL,
      actor_id             BINARY(16)   NULL,
      actor_display        VARCHAR(160) NULL,
      on_behalf_of_user_id BINARY(16)   NULL,
      credential_type      ENUM('session','pat','oauth','ticket','setpw','cli','system','none') NOT NULL,
      credential_id        BINARY(16)   NULL,
      vault_id             BINARY(16)   NULL,
      target_type          VARCHAR(32)  NULL,
      target_id            BINARY(16)   NULL,
      targets              JSON         NULL,
      outcome              ENUM('success','failure') NOT NULL,
      reason               VARCHAR(128) NULL,
      context              JSON         NOT NULL,
      metadata             JSON         NULL,
      prev_hash            BINARY(32)   NOT NULL,
      hash                 BINARY(32)   NOT NULL,
      key_version          TINYINT UNSIGNED NOT NULL,
      KEY ix_audit_chain (chain_id, id),
      KEY ix_audit_vault_time (vault_id, occurred_at),
      KEY ix_audit_actor_time (actor_id, occurred_at),
      KEY ix_audit_action_time (action, occurred_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);
}

export async function down(db: MigrationDb): Promise<void> {
  await sql`DROP TABLE IF EXISTS audit_events`.execute(db);
}
