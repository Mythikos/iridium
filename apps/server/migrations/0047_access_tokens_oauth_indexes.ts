/**
 * 0047_access_tokens_oauth_indexes
 *
 * `ix_tokens_consent (consent_id, revoked_at)` and `ix_tokens_client (client_id, revoked_at)` on
 * `access_tokens` (03-data-model.md section 4).
 *
 * These two indexes exist for exactly three sweeps and for nothing else: revoking a consent revokes
 * every token with that `consent_id`, disabling or deleting a client does the same through
 * `client_id`, and a detected refresh reuse revokes the family's tokens through the consent's live
 * set. Without them each is a full scan of a table whose rows are never deleted.
 *
 * Both are added by one `ALTER TABLE`, which is one DDL statement and is atomic.
 */
import { sql } from 'kysely';

import { indexExists } from '../src/db/migration-helpers.ts';
import type { MigrationDb } from '../src/db/migration-types.ts';

export async function up(db: MigrationDb): Promise<void> {
  const clauses: string[] = [];
  if (!(await indexExists(db, 'access_tokens', 'ix_tokens_consent'))) {
    clauses.push('ADD INDEX ix_tokens_consent (consent_id, revoked_at)');
  }
  if (!(await indexExists(db, 'access_tokens', 'ix_tokens_client'))) {
    clauses.push('ADD INDEX ix_tokens_client (client_id, revoked_at)');
  }
  if (clauses.length === 0) return;
  await sql.raw(`ALTER TABLE access_tokens ${clauses.join(', ')}`).execute(db);
}

export async function down(db: MigrationDb): Promise<void> {
  const clauses: string[] = [];
  if (await indexExists(db, 'access_tokens', 'ix_tokens_consent')) {
    clauses.push('DROP INDEX ix_tokens_consent');
  }
  if (await indexExists(db, 'access_tokens', 'ix_tokens_client')) {
    clauses.push('DROP INDEX ix_tokens_client');
  }
  if (clauses.length === 0) return;
  await sql.raw(`ALTER TABLE access_tokens ${clauses.join(', ')}`).execute(db);
}
