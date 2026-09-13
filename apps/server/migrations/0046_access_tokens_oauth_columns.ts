/**
 * 0046_access_tokens_oauth_columns
 *
 * `client_id`, `consent_id`, `refresh_id` and `resource` on `access_tokens`, with the two foreign keys
 * `fk_tokens_oauth_client` and `fk_tokens_oauth_consent` (03-data-model.md section 4).
 *
 * An `ALTER` rather than part of `0008`, because the referenced tables do not exist until `0035` and
 * `0037`: a foreign key cannot be declared against a table that has not been created yet.
 *
 * `refresh_id` carries **no** foreign key, and the reason is a real conflict rather than an oversight.
 * Token rows are never deleted (A31) while `oauth_refresh_tokens` rows are swept 30 days after the
 * family expires, so a RESTRICT constraint here would make that sweep a dead letter: every refresh row
 * would be pinned forever by the access tokens it minted. It is provenance of exactly the kind
 * `rotated_from_id` has been since `0008` (D03-24).
 *
 * All four columns are appended at the end of the row, which is what an `ADD COLUMN` without `AFTER`
 * does and what keeps the change cheap; section 4's block is the resulting logical shape, not a
 * physical column order.
 */
import { sql } from 'kysely';

import { columnExists } from '../src/db/migration-helpers.ts';
import type { MigrationDb } from '../src/db/migration-types.ts';

export async function up(db: MigrationDb): Promise<void> {
  if (await columnExists(db, 'access_tokens', 'client_id')) return;
  await sql`
    ALTER TABLE access_tokens
      ADD COLUMN client_id  BINARY(16)   NULL,
      ADD COLUMN consent_id BINARY(16)   NULL,
      ADD COLUMN refresh_id BINARY(16)   NULL,
      ADD COLUMN resource   VARCHAR(255) NULL,
      ADD CONSTRAINT fk_tokens_oauth_client  FOREIGN KEY (client_id)  REFERENCES oauth_clients(id),
      ADD CONSTRAINT fk_tokens_oauth_consent FOREIGN KEY (consent_id) REFERENCES oauth_consents(id)
  `.execute(db);
}

export async function down(db: MigrationDb): Promise<void> {
  if (!(await columnExists(db, 'access_tokens', 'client_id'))) return;
  await sql`
    ALTER TABLE access_tokens
      DROP FOREIGN KEY fk_tokens_oauth_consent,
      DROP FOREIGN KEY fk_tokens_oauth_client,
      DROP COLUMN resource,
      DROP COLUMN refresh_id,
      DROP COLUMN consent_id,
      DROP COLUMN client_id
  `.execute(db);
}
