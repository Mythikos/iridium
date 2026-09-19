/** Grant only the existing singleton read and generation update to the application role. */
import { applyGrants } from '../src/db/grants.ts';
import type { MigrationDb } from '../src/db/migration-types.ts';

/** Apply the fence's table grants after the singleton exists. */
export async function up(db: MigrationDb): Promise<void> {
  await applyGrants(db, ['collab_owner_fence']);
}

/** Grants are forward-only; dropping the table removes its effective grants. */
export function down(): Promise<void> {
  return Promise.resolve();
}
