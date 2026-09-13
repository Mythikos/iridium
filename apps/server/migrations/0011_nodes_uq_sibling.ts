/**
 * 0011_nodes_uq_sibling
 *
 * `UNIQUE KEY uq_sibling (parent_id, name, live)` on `nodes` (03-data-model.md section 6.1).
 *
 * Its own file because a unique key over a virtual generated column is a distinct schema object with
 * its own failure mode -- a pre-existing duplicate -- and must be individually re-runnable. `live` is
 * `NULL` for a trashed row and MySQL treats `NULL`s in a unique index as distinct, so a trashed row
 * leaves the index and its name becomes reusable immediately.
 *
 * There is no `ADD UNIQUE KEY IF NOT EXISTS`, so the guard is an `information_schema.STATISTICS`
 * probe.
 */
import { sql } from 'kysely';

import { indexExists } from '../src/db/migration-helpers.ts';
import type { MigrationDb } from '../src/db/migration-types.ts';

export async function up(db: MigrationDb): Promise<void> {
  if (await indexExists(db, 'nodes', 'uq_sibling')) return;
  await sql`ALTER TABLE nodes ADD UNIQUE KEY uq_sibling (parent_id, name, live)`.execute(db);
}

export async function down(db: MigrationDb): Promise<void> {
  if (!(await indexExists(db, 'nodes', 'uq_sibling'))) return;
  await sql`ALTER TABLE nodes DROP INDEX uq_sibling`.execute(db);
}
