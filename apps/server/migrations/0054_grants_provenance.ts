/**
 * Reconcile grant application evidence once on upgrade, without editing earlier migration history.
 * A skipped historical GRANT was indistinguishable from a successful one before this migration.
 */
import { applyGrants, GRANT_MATRIX } from '../src/db/grants.ts';
import type { MigrationDb } from '../src/db/migration-types.ts';

/** Idempotently apply the current matrix and persist its actual per-table result. */
export async function up(db: MigrationDb): Promise<void> {
  await applyGrants(
    db,
    GRANT_MATRIX.map((row) => row.table),
  );
}

/** Grant evidence is retained; a rollback must not assert a different historical outcome. */
export function down(): Promise<void> {
  return Promise.resolve();
}
