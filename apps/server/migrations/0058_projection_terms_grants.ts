/** Apply the derived-term table's application privileges after its schema exists. */
import { applyGrants } from '../src/db/grants.ts';
import type { MigrationDb } from '../src/db/migration-types.ts';

export async function up(db: MigrationDb): Promise<void> {
  await applyGrants(db, ['note_projection_terms']);
}

/** Grants are forward-only; dropping the table removes its effective privileges. */
export function down(): Promise<void> {
  return Promise.resolve();
}
