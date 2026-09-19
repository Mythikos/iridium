/** Serialize user creation ordinals and mutations that can remove the last active admin. */
import { sql } from 'kysely';

import type { MigrationDb } from '../src/db/migration-types.ts';

/** Add an independent row lock; neither user FKs nor the audit-last order can invert it. */
export async function up(db: MigrationDb): Promise<void> {
  await sql`INSERT INTO schema_meta (\`key\`, value) VALUES ('admin_users_lock', '1')
    ON DUPLICATE KEY UPDATE \`key\` = schema_meta.\`key\``.execute(db);
}

/** Remove only the serialization key when rolling back the M1 extension. */
export async function down(db: MigrationDb): Promise<void> {
  await sql`DELETE FROM schema_meta WHERE \`key\` = 'admin_users_lock'`.execute(db);
}
