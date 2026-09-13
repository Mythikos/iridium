/**
 * 0038_oauth_consents_uq_live
 *
 * `UNIQUE KEY uq_oauth_consents_live (live_consent_key)` on `oauth_consents` (03-data-model.md
 * section 4A).
 *
 * Its own file for the reason `0011_nodes_uq_sibling` is its own file: a unique key over a generated
 * column is a distinct schema object with its own failure mode -- a pre-existing duplicate -- and must
 * be individually re-runnable. With it in place the consent service upserts under `revoked_at IS NULL`
 * and never has to read-then-write to decide whether a grant already exists.
 */
import { sql } from 'kysely';

import { indexExists } from '../src/db/migration-helpers.ts';
import type { MigrationDb } from '../src/db/migration-types.ts';

export async function up(db: MigrationDb): Promise<void> {
  if (await indexExists(db, 'oauth_consents', 'uq_oauth_consents_live')) return;
  await sql`ALTER TABLE oauth_consents ADD UNIQUE KEY uq_oauth_consents_live (live_consent_key)`.execute(
    db,
  );
}

export async function down(db: MigrationDb): Promise<void> {
  if (!(await indexExists(db, 'oauth_consents', 'uq_oauth_consents_live'))) return;
  await sql`ALTER TABLE oauth_consents DROP INDEX uq_oauth_consents_live`.execute(db);
}
