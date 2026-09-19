/** Grant the application role access after migration 0050 creates the command table. */
import { applyGrants } from '../src/db/grants.ts';
import type { MigrationDb } from '../src/db/migration-types.ts';

export async function up(db: MigrationDb): Promise<void> {
  await applyGrants(db, ['session_revocation_commands']);
}

export function down(): Promise<void> {
  // Forward-only, like every grants migration: table removal also removes its effective grant.
  return Promise.resolve();
}
