/**
 * 0027_audit_chain_heads
 *
 * `audit_chain_heads` (03-data-model.md section 12.2): one row per chain, locked `FOR UPDATE` as
 * the serialisation point of every audited mutation.
 *
 * A per-row `prev_hash` computed from "the last row I can see" forks under concurrency -- two
 * transactions read the same predecessor and both claim it -- so the head row exists to make the chain
 * a single writer. It is cheap because audited mutations are low-rate, and it is always the **last**
 * lock taken in the global lock order.
 *
 * `iridium_app` holds no `DELETE` here (section 2): deleting a head and re-inserting a genesis row
 * would restart a chain that `verify-chain` would then happily accept.
 */
import { sql } from 'kysely';

import type { MigrationDb } from '../src/db/migration-types.ts';

export async function up(db: MigrationDb): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS audit_chain_heads (
      chain_id   VARCHAR(40)     NOT NULL PRIMARY KEY,
      last_id    BIGINT UNSIGNED NOT NULL,
      last_hash  BINARY(32)      NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);
}

export async function down(db: MigrationDb): Promise<void> {
  await sql`DROP TABLE IF EXISTS audit_chain_heads`.execute(db);
}
