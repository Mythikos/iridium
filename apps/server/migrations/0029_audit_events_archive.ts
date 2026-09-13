/**
 * 0029_audit_events_archive
 *
 * `CREATE TABLE audit_events_archive LIKE audit_events` plus its own two triggers
 * (03-data-model.md sections 12.1 and 12.4).
 *
 * `LIKE` rather than a hand-written copy, because the archive must be **identical** DDL by
 * construction: a hand-written twin drifts the first time a column is added to `audit_events`, and a
 * chain that spans the archive boundary has to verify end to end in one ordered walk.
 *
 * The archive gets the same two triggers for the same reason the live table has them, and section 14.1
 * assigns all three statements to this file.
 */
import { sql } from 'kysely';

import type { MigrationDb } from '../src/db/migration-types.ts';

export async function up(db: MigrationDb): Promise<void> {
  await sql`CREATE TABLE IF NOT EXISTS audit_events_archive LIKE audit_events`.execute(db);

  await sql`
    CREATE TRIGGER IF NOT EXISTS audit_events_archive_bu BEFORE UPDATE ON audit_events_archive
    FOR EACH ROW
    BEGIN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_events_archive is append-only';
    END
  `.execute(db);

  await sql`
    CREATE TRIGGER IF NOT EXISTS audit_events_archive_bd BEFORE DELETE ON audit_events_archive
    FOR EACH ROW
    BEGIN
      IF @iridium_audit_archive IS NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_events_archive is append-only';
      END IF;
    END
  `.execute(db);
}

export async function down(db: MigrationDb): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS audit_events_archive_bd`.execute(db);
  await sql`DROP TRIGGER IF EXISTS audit_events_archive_bu`.execute(db);
  await sql`DROP TABLE IF EXISTS audit_events_archive`.execute(db);
}
