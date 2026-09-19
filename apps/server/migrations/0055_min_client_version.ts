/** Seed the release-controlled client floor without changing an operator's committed policy (A54). */
import { sql } from 'kysely';

import type { MigrationDb } from '../src/db/migration-types.ts';

/** Missing installations start unrestricted; rerunning never lowers an existing client floor. */
export async function up(db: MigrationDb): Promise<void> {
  await sql`INSERT INTO schema_meta (\`key\`, value) VALUES ('min_client_version', '0.0.0')
    ON DUPLICATE KEY UPDATE \`key\` = schema_meta.\`key\``.execute(db);
}

/** Preserve the release policy on a local down migration; data rollback must not admit old clients. */
export function down(): Promise<void> {
  return Promise.resolve();
}
