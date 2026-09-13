/**
 * 0028_audit_events_triggers
 *
 * The `BEFORE UPDATE` and `BEFORE DELETE` triggers on `audit_events` (03-data-model.md section 12.3).
 *
 * Immutability has three independent mechanisms because each fails differently: grants (an application
 * bug cannot express an update), these triggers (they bind even the migrator, so an operator mistake
 * is caught too) and the HMAC chain (anything that circumvents both still fails `verify-chain`). The
 * trigger lives in a migration rather than in the dump because dumps are taken `--skip-triggers` and
 * `iridium migrate ensure-guards` re-establishes it after a restore (A47).
 *
 * `CREATE TRIGGER IF NOT EXISTS` is MySQL 8.0.29+, inside the 8.4.11 floor and outside the 8.0.13
 * subset earlier drafts assumed -- one of the reasons the floor is stated as a supported release.
 *
 * `BEFORE UPDATE` refuses unconditionally. `BEFORE DELETE` refuses unless the session has set
 * `@iridium_audit_archive`, which is the one sanctioned deletion path: `iridium audit archive` copies a
 * range into `audit_events_archive`, verifies the copy and then deletes the originals under the
 * migrator role. 03-data-model.md section 12.4 describes that path as dropping and re-creating the
 * trigger; 11-operations-and-deployment.md describes it as the session variable, and the session
 * variable is implemented here because it leaves no window in which the table is unprotected. Dropping
 * and re-creating still works for an operator who follows the other text, so neither document is
 * contradicted.
 *
 * Two triggers cannot be one statement, and section 14.1 assigns both to this file.
 */
import { sql } from 'kysely';

import type { MigrationDb } from '../src/db/migration-types.ts';

export async function up(db: MigrationDb): Promise<void> {
  await sql`
    CREATE TRIGGER IF NOT EXISTS audit_events_bu BEFORE UPDATE ON audit_events
    FOR EACH ROW
    BEGIN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_events is append-only';
    END
  `.execute(db);

  await sql`
    CREATE TRIGGER IF NOT EXISTS audit_events_bd BEFORE DELETE ON audit_events
    FOR EACH ROW
    BEGIN
      IF @iridium_audit_archive IS NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_events is append-only';
      END IF;
    END
  `.execute(db);
}

export async function down(db: MigrationDb): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS audit_events_bd`.execute(db);
  await sql`DROP TRIGGER IF EXISTS audit_events_bu`.execute(db);
}
