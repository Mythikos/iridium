/**
 * 0048_access_log_oauth_client
 *
 * `oauth_client_id BINARY(16) NULL` on `access_log` (03-data-model.md section 12.5).
 *
 * The first column in the schema that carries a **verified** client identity: it is set only for a
 * call authenticated by an OAuth access token, its value is `access_tokens.client_id` as the
 * authorization server wrote it, and nothing a caller sends can influence it. `client_name` and
 * `client_version` stay the untrusted self-report, and the admin activity view labels the two
 * differently, because presenting a self-declared name beside a verified one with no distinction is
 * how a log stops being evidence.
 *
 * It carries no foreign key for the same two reasons the rest of the table does not: partitioned
 * InnoDB tables support none, and the row must outlive the client.
 *
 * `ALGORITHM=INSTANT` is what keeps a populated partitioned log from being rewritten: an `ADD COLUMN`
 * at the end of the row is instant on both 8.4.11 and 9.7.2. The clause is stated rather than left to
 * the server's choice so that a future engine that would silently fall back to a rebuild fails the
 * statement instead.
 *
 * No `_grants` companion: `access_log`'s grants are table-level and already in place from `0034`.
 */
import { sql } from 'kysely';

import { columnExists } from '../src/db/migration-helpers.ts';
import type { MigrationDb } from '../src/db/migration-types.ts';

export async function up(db: MigrationDb): Promise<void> {
  if (await columnExists(db, 'access_log', 'oauth_client_id')) return;
  await sql`ALTER TABLE access_log ADD COLUMN oauth_client_id BINARY(16) NULL, ALGORITHM=INSTANT`.execute(
    db,
  );
}

export async function down(db: MigrationDb): Promise<void> {
  if (!(await columnExists(db, 'access_log', 'oauth_client_id'))) return;
  await sql`ALTER TABLE access_log DROP COLUMN oauth_client_id`.execute(db);
}
