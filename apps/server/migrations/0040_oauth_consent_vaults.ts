/**
 * 0040_oauth_consent_vaults
 *
 * `oauth_consent_vaults` (03-data-model.md section 4A), deliberately the same two-column shape as
 * `access_token_vaults`.
 *
 * That is the point: the consent's vault selection is copied into `access_token_vaults` at every
 * issuance rather than joined at read time, so `authorize()` reads one table shape for every token
 * principal and contains no branch on where the vault list came from. An OAuth principal and a PAT
 * principal with the same user, scopes and vaults therefore produce the identical decision.
 *
 * A consent with `all_vaults = 1` carries no rows here at all (invariant I-26).
 */
import { sql } from 'kysely';

import type { MigrationDb } from '../src/db/migration-types.ts';

export async function up(db: MigrationDb): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS oauth_consent_vaults (
      consent_id BINARY(16) NOT NULL,
      vault_id   BINARY(16) NOT NULL,
      PRIMARY KEY (consent_id, vault_id),
      KEY ix_ocv_vault (vault_id),
      CONSTRAINT fk_ocv_consent FOREIGN KEY (consent_id) REFERENCES oauth_consents(id),
      CONSTRAINT fk_ocv_vault   FOREIGN KEY (vault_id)   REFERENCES vaults(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);
}

export async function down(db: MigrationDb): Promise<void> {
  await sql`DROP TABLE IF EXISTS oauth_consent_vaults`.execute(db);
}
