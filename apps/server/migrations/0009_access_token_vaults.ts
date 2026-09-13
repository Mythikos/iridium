/**
 * 0009_access_token_vaults
 *
 * `access_token_vaults` (03-data-model.md section 4): the explicit vault allowlist a token carries
 * when `all_vaults = 0`.
 *
 * Its own file because of the two foreign keys. A token with `all_vaults = 1` carries no rows here at
 * all, which is the same rule `oauth_consent_vaults` follows (invariant I-26).
 */
import { sql } from 'kysely';

import type { MigrationDb } from '../src/db/migration-types.ts';

export async function up(db: MigrationDb): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS access_token_vaults (
      token_id  BINARY(16) NOT NULL,
      vault_id  BINARY(16) NOT NULL,
      PRIMARY KEY (token_id, vault_id),
      KEY ix_atv_vault (vault_id),
      CONSTRAINT fk_atv_token FOREIGN KEY (token_id) REFERENCES access_tokens(id),
      CONSTRAINT fk_atv_vault FOREIGN KEY (vault_id) REFERENCES vaults(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);
}

export async function down(db: MigrationDb): Promise<void> {
  await sql`DROP TABLE IF EXISTS access_token_vaults`.execute(db);
}
