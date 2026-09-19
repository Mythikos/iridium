/**
 * `iridium migrate status | up | to <name>` (A7; 11-operations-and-deployment.md, "Schema").
 *
 * The bodies are the database stream's: `apps/server/src/db/migrator.ts` owns
 * `GET_LOCK('iridium_migrate', 60)`, the per-migration transaction mode and the forward-only refusal.
 * This module adds the role check, the rendering, the exit code and the `system.migration.applied`
 * reconciliation, because two code paths that apply migrations would eventually differ.
 *
 * `migrate` is one of the three commands that does **not** boot the application: it holds
 * `DATABASE_MIGRATE_URL`, the `iridium_migrator` role, which the serving process deliberately never
 * has (A7, A8, ARCH-20). Booting to run a migration would put the DDL credential in a process that
 * also carries the app pool.
 *
 * **A failed audit reconciliation does not fail the command.** The migrations are applied and
 * committed by then; answering non-zero would tell a deployment script the schema change failed when
 * it did not. The gap is printed, the next `migrate` run backfills it, and `iridium doctor` reports it
 * meanwhile — which is exactly the recovery 11 specifies.
 */
import type { AuditEventContext } from '../audit/chain.ts';
import type { LoadedConfig } from '../config/env.ts';
import {
  createMaintDb,
  migrateTo,
  migrateToLatest,
  migrationStatus,
  MigrationDirectionRefusedError,
  MigrationLockedError,
} from '../db/migrator.ts';
import type { Clock } from '../ops/clock.ts';
import type { CliArgs } from './args.ts';
import { resolveCliActor, type CliActor } from './attribution.ts';
import { EXIT } from './exit.ts';
import { auditAppliedMigrations } from './migration-audit.ts';
import { renderJson, type CliIo } from './output.ts';

/** The subcommands this build carries. */
export type MigrateSubcommand = 'status' | 'up' | 'to';

/** What `runMigrate` needs after the flags are parsed. */
export interface MigrateInput {
  readonly io: CliIo;
  readonly loaded: LoadedConfig;
  readonly subcommand: MigrateSubcommand;
  readonly args: CliArgs;
  /** `--actor <email>`; resolved on the migrator connection, since nothing else is open. */
  readonly actorEmail: string | undefined;
  readonly auditContext: AuditEventContext;
  /** The invocation's correlation id, recorded as `metadata.batch`. */
  readonly batch: string;
  readonly clock: Clock;
}

/** Runs one `iridium migrate` subcommand. */
export async function runMigrate(input: MigrateInput): Promise<number> {
  const { io, loaded, subcommand, args } = input;

  // `to` is the one subcommand that takes an argument. Resolving it before anything connects keeps a
  // missing name a usage error rather than a failure that has already opened a migrator connection.
  const name = args.positionals[0] ?? '';
  if (subcommand === 'to' && (name === '' || name.startsWith('-'))) {
    io.err(
      'iridium migrate to: expected a migration name, for example `iridium migrate to 0034_grants`. ' +
        '`iridium migrate status` lists the names this build carries.',
    );
    return EXIT.usage;
  }

  const { config } = loaded;
  if (config.db.migrateUrl === null) {
    io.err(
      'iridium migrate requires DATABASE_MIGRATE_URL (the iridium_migrator role). The serving ' +
        'process deliberately does not hold the DDL credential (A7, A8, ARCH-20).',
    );
    return EXIT.usage;
  }

  const maint = createMaintDb(config.db.migrateUrl, config.db.connectTimeoutMs);
  try {
    if (subcommand === 'status') {
      const status = await migrationStatus(maint.db);
      io.out(
        renderJson({
          status: status.status,
          applied: status.applied.length,
          pending: status.pending,
          unknown: status.unknown,
        }),
      );
      return EXIT.success;
    }

    const actor = await resolveCliActor(maint.db, input.actorEmail);
    if (!actor.ok) {
      io.err(`iridium migrate ${subcommand}: ${actor.message}`);
      return EXIT.refused;
    }

    const outcome =
      subcommand === 'to'
        ? await migrateTo({ db: maint.db, target: maint.target }, name, config.env)
        : await migrateToLatest({ db: maint.db, target: maint.target });
    const applied = outcome.results.filter((result) => result.status === 'Success');
    io.out(renderJson({ applied: applied.map((result) => result.migrationName) }));

    await reconcileAudit(input, maint, actor.actor);
    return EXIT.success;
  } catch (error) {
    if (error instanceof MigrationLockedError || error instanceof MigrationDirectionRefusedError) {
      io.err(error.message);
      return EXIT.refused;
    }
    io.err(error instanceof Error ? error.message : String(error));
    return EXIT.internal;
  } finally {
    await maint.db.destroy();
  }
}

/** Writes the events `kysely_migration` has and the chain does not; never fails the command. */
async function reconcileAudit(
  input: MigrateInput,
  maint: ReturnType<typeof createMaintDb>,
  actor: CliActor,
): Promise<void> {
  try {
    const audited = await auditAppliedMigrations({
      db: maint.db,
      target: maint.target,
      auditHmac: input.loaded.config.keys.auditHmac,
      clock: input.clock,
      actor,
      context: input.auditContext,
      batch: input.batch,
    });
    if (audited.skipped === 'audit_tables_absent') {
      input.io.err(
        'the audit tables do not exist on this schema yet, so no system.migration.applied event was ' +
          'written; the next `iridium migrate` run after 0026 and 0027 backfills them.',
      );
      return;
    }
    if (audited.written.length > 0) {
      input.io.err(
        `wrote ${String(audited.written.length)} system.migration.applied event(s) on chain server.`,
      );
    }
  } catch (error) {
    input.io.err(
      'the migrations are applied and committed, but their system.migration.applied events could ' +
        `not be written: ${error instanceof Error ? error.message : String(error)}. The next ` +
        '`iridium migrate` run backfills them and `iridium doctor` reports the gap meanwhile.',
    );
  }
}
