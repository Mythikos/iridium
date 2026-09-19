/**
 * The `system.migration.applied` events of a migration run (11-operations-and-deployment.md, the
 * `Audit` bullet of "Applying migrations"; 12-milestones.md §5.2, which lists the action among the M1
 * mutations that must be audited).
 *
 * 11 is precise about the shape and about why it is not part of the migration's own transaction:
 * *"after a run, one `system.migration.applied {name, batch, duration_ms}` audit event per applied
 * migration is written on chain `server` with `credential_type='cli'`, `context.os_user` = the
 * invoking OS user, once the audit tables exist (migrations `0026`–`0028` are audited retroactively in
 * the same run). If the process dies between applying a migration and writing its event, the next
 * `migrate` run backfills the missing event (it compares `kysely_migration` rows with
 * `audit_events WHERE action='system.migration.applied'`)."*
 *
 * Three consequences of that sentence are the whole design here:
 *
 *  - **The write is reconciliation, not bookkeeping.** Every run writes the events `kysely_migration`
 *    has and the chain does not, so a crash between the two leaves a gap the next run closes. That is
 *    also why a fresh database gets events for `0026`–`0028` themselves: they created the tables the
 *    event needs, and the reconciliation runs once they exist.
 *  - **It runs under the migration lock.** The read and the write are not one statement, so two
 *    concurrent `migrate up` runs could otherwise both decide the same event is missing. The lock is
 *    taken again after the run rather than held across it, because `withMigrationLock` opens a
 *    connection of its own and a nested acquisition would wait on itself.
 *  - **It writes on the migrator connection.** `iridium_migrator` holds `INSERT` on the whole schema
 *    (`infra/docker/mysql/init/01_roles.sh`), and the serving process is not running during an
 *    upgrade, so there is no app pool to borrow.
 *
 * `duration_ms` is recorded as `null`: Kysely's `Migrator` reports a result per migration but no
 * timing, and a number invented from the run's total would be a measurement that is not one.
 */
import { sql, type Kysely } from 'kysely';

import { AuditWriter, type AuditEventContext } from '../audit/chain.ts';
import { createAuditKeys, readPromotedAuditKeyVersion } from '../audit/keys.ts';
import type { Keyring } from '../config/env.ts';
import type { Database, MysqlConnectionTarget } from '../db/index.ts';
import { migrationStatus, withMigrationLock } from '../db/migrator.ts';
import type { Clock } from '../ops/clock.ts';
import type { CliActor } from './attribution.ts';

/**
 * The two migrations that create `audit_events` and `audit_chain_heads`. Until both are applied there
 * is nowhere to write, which is the "once the audit tables exist" clause.
 */
const AUDIT_TABLE_MIGRATIONS: readonly string[] = Object.freeze([
  '0026_audit_events',
  '0027_audit_chain_heads',
]);

/** What the reconciliation did. */
export interface MigrationAuditOutcome {
  /** Migration names that gained an event in this run, in apply order. */
  readonly written: readonly string[];
  /** Why nothing was written, or `null` when the reconciliation ran. */
  readonly skipped: 'audit_tables_absent' | null;
}

/** What `auditAppliedMigrations` needs. */
export interface MigrationAuditOptions {
  readonly db: Kysely<Database>;
  /** Where `withMigrationLock` opens its own connection. */
  readonly target: MysqlConnectionTarget;
  readonly auditHmac: Keyring;
  readonly clock: Clock;
  readonly actor: CliActor;
  readonly context: AuditEventContext;
  /** The run's correlation id, recorded as `metadata.batch`. */
  readonly batch: string;
}

/**
 * Writes one `system.migration.applied` event for every applied migration that has none.
 *
 * It is idempotent by construction: the set it writes is `kysely_migration` minus the names already
 * on the chain, so a second call in the same run writes nothing.
 */
export async function auditAppliedMigrations(
  options: MigrationAuditOptions,
): Promise<MigrationAuditOutcome> {
  const { db } = options;
  const status = await migrationStatus(db);
  if (!AUDIT_TABLE_MIGRATIONS.every((name) => status.applied.includes(name))) {
    return { written: [], skipped: 'audit_tables_absent' };
  }

  const keys = createAuditKeys({
    keyring: options.auditHmac,
    signingVersion: await readPromotedAuditKeyVersion(db),
  });
  const writer = new AuditWriter({ keys, clock: options.clock });

  return withMigrationLock(options.target, async () => {
    const recorded = await auditedMigrationNames(db);
    const missing = status.applied.filter((name) => !recorded.has(name));
    if (missing.length === 0) return { written: [], skipped: null };

    await db.transaction().execute(async (trx) => {
      for (const name of missing) {
        // Sequential by design: every event on one chain locks the same head row, so concurrency
        // here would serialise on that lock anyway and lose the apply order the chain records.
        // eslint-disable-next-line no-await-in-loop -- one chained event at a time, in apply order
        await writer.record(trx, {
          action: 'system.migration.applied',
          actorType: options.actor.actorType,
          actorId: options.actor.actorId,
          actorDisplay: options.actor.actorDisplay,
          credentialType: 'cli',
          outcome: 'success',
          context: options.context,
          metadata: { name, batch: options.batch, duration_ms: null },
        });
      }
    });
    return { written: missing, skipped: null };
  });
}

/** The migration names the chain already carries, read out of each event's `metadata.name`. */
async function auditedMigrationNames(db: Kysely<Database>): Promise<ReadonlySet<string>> {
  const rows = await db
    .selectFrom('audit_events')
    .select(sql<string | null>`json_unquote(json_extract(metadata, '$.name'))`.as('name'))
    .where('action', '=', 'system.migration.applied')
    .execute();
  return new Set(rows.flatMap((row) => (row.name === null ? [] : [row.name])));
}
