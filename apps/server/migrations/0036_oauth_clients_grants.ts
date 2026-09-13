/**
 * 0036_oauth_clients_grants
 *
 * The `iridium_app` grants for `oauth_clients`, rendered from `GRANT_MATRIX` in
 * `apps/server/src/db/grants.ts` (03-data-model.md section 2).
 *
 * Every table created after `0034_grants` gets its own `NNNN_<table>_grants` companion, and
 * `db-grants.integration` fails if a table exists in `information_schema.TABLES` without a matching
 * grant, so the pair cannot be forgotten.
 */

import { applyGrants } from '../src/db/grants.ts';
import type { MigrationDb } from '../src/db/migration-types.ts';

export async function up(db: MigrationDb): Promise<void> {
  await applyGrants(db, ['oauth_clients']);
}

export function down(): Promise<void> {
  // Forward-only by design: see 0034_grants.
  return Promise.resolve();
}
