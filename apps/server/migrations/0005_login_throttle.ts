/**
 * 0005_login_throttle
 *
 * `login_throttle` (03-data-model.md section 3): the `rate-limiter-flexible` `RateLimiterMySQL`
 * store.
 *
 * Pre-created by a migration rather than by the limiter, because `iridium_app` holds no DDL privilege
 * at all: the limiter therefore runs with `tableCreated:true` and `tableName:'login_throttle'`. Keys
 * are `login:<email_key>|<ip>` and `login-ip:<ip>`, hashed to at most 191 bytes by the limiter
 * wrapper, which is what the column width states.
 */
import { sql } from 'kysely';

import type { MigrationDb } from '../src/db/migration-types.ts';

export async function up(db: MigrationDb): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS login_throttle (
      \`key\`   VARCHAR(191) NOT NULL PRIMARY KEY,
      points  INT NOT NULL,
      expire  BIGINT UNSIGNED NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);
}

export async function down(db: MigrationDb): Promise<void> {
  await sql`DROP TABLE IF EXISTS login_throttle`.execute(db);
}
