/**
 * 0034_grants
 *
 * The `iridium_app` table-level grants of 03-data-model.md section 2, rendered from `GRANT_MATRIX` in
 * `apps/server/src/db/grants.ts`.
 *
 * It must run after every table exists, because MySQL cannot restrict a database-level grant per table
 * and a grant on a table that has not been created yet is an error. The matrix is not written twice:
 * this migration, every later `NNNN_<table>_grants` and `iridium migrate ensure-guards` execute the
 * same module, and `pnpm gen` renders `docs/ops/db-grants.sql` and the committed
 * `db-grants.snapshot.sql` fixture from it.
 *
 * `GRANT` is idempotent, so a re-run is a no-op. When the migrating account holds no `GRANT OPTION`,
 * or the three roles of `init/01_roles.sh` do not exist on the server (MySQL 8 refuses a `GRANT` to a
 * missing account with error 1410), the migration records itself as applied with a logged warning
 * and the DBA applies the generated script; `/readyz` then reports `grants: unverified` until
 * `iridium doctor --db-roles` confirms the effective privileges.
 *
 * The OAuth tables are not in this list because they do not exist yet: each gets its own `_grants`
 * companion (`0036`, `0039`, `0041`, `0043`, `0045`), and `db-grants.integration` fails if a table
 * exists in `information_schema.TABLES` without a matching grant, so the pair cannot be forgotten.
 */

import { applyGrants, GRANTS_0034_TABLES } from '../src/db/grants.ts';
import type { MigrationDb } from '../src/db/migration-types.ts';

export async function up(db: MigrationDb): Promise<void> {
  await applyGrants(db, GRANTS_0034_TABLES);
}

export function down(): Promise<void> {
  // Forward-only by design: revoking the application role's rights mid-flight would take the
  // running server down, and the schema this migration touches is unaffected either way.
  return Promise.resolve();
}
