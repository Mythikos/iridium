/**
 * `GRANT_MATRIX`: the one rendered source of the grant matrix (03-data-model.md section 2, D03-16;
 * 11-operations-and-deployment.md "Grant matrix applied by 0034_grants").
 *
 * The matrix is not written twice. Migration `0034_grants`, every later `NNNN_<table>_grants` and
 * `iridium migrate ensure-guards` execute it; `pnpm gen` renders `docs/ops/db-grants.sql` and the
 * committed `db-grants.snapshot.sql` fixture from the same rows, so `pnpm gen && git diff
 * --exit-code` fails on any drift between the code, the DBA script, the fixture and the plan.
 *
 * `iridium_app`'s DML is narrowed below a blanket "DML on all tables" on four tables, and each
 * removed privilege closes a tamper route the application has no code path for:
 *
 *   `note_updates`       no `UPDATE` -- the durability log is append-only; rows leave only through
 *                        `update_log_prune`
 *   `note_revisions`     `UPDATE (id)` only -- a column-scoped grant, exactly what keeps the
 *                        idempotent checkpoint insert (`... ON DUPLICATE KEY UPDATE id = id`) legal
 *                        while leaving `markdown`, `snapshot`, `content_hash`, `size_chars`, `kind`,
 *                        `seq`, `label` and `actor_id` physically unwritable
 *   `audit_chain_heads`  no `DELETE` -- deleting a head and re-inserting a genesis row would restart
 *                        a chain that `verify-chain` would then accept
 *   `access_log`         no `UPDATE`/`DELETE` -- rows leave only by partition drop, under the
 *                        migrator role
 *
 * The `iridium_migrator` and `iridium_backup` columns of the plan's matrix are **schema-level and
 * global** grants issued once by `infra/docker/mysql/init/01_roles.sh`, not per-table grants issued
 * by a migration: a `GRANT ... ON iridium.*` produces no `information_schema.TABLE_PRIVILEGES` rows
 * at all. They are declared below as data so `doctor --db-roles`, the rendered DBA script and the
 * `db-grants.snapshot.sql` fixture read one module, and the per-table `backup` column is recorded
 * beside each row for the same reason -- but no migration issues it, because the schema-level grant
 * already covers it.
 */
import { createHash } from 'node:crypto';

import { sql, type Kysely } from 'kysely';
import { z } from 'zod';

import { currentSchema } from './migration-helpers.ts';
import type { DbLogger } from './version-floor.ts';

/** A privilege, optionally scoped to a column list (`UPDATE (id)`). */
export interface Privilege {
  readonly name: string;
  readonly columns?: readonly string[];
}

export interface GrantRow {
  readonly table: string;
  /** What migration `0034_grants` or the table's `_grants` companion issues. */
  readonly app: readonly Privilege[];
  /** The plan's `iridium_backup` column, covered by the schema-level grant; recorded, never issued. */
  readonly backup: readonly Privilege[];
}

const p = (name: string, columns?: readonly string[]): Privilege =>
  columns === undefined ? { name } : { name, columns };

const DML: readonly Privilege[] = [p('SELECT'), p('INSERT'), p('UPDATE'), p('DELETE')];
const BACKUP_TABLE: readonly Privilege[] = [
  p('SELECT'),
  p('LOCK TABLES'),
  p('TRIGGER'),
  p('SHOW VIEW'),
];
const BACKUP_AUDIT: readonly Privilege[] = [p('SELECT'), p('LOCK TABLES'), p('TRIGGER')];
const BACKUP_READ: readonly Privilege[] = [p('SELECT'), p('LOCK TABLES')];

const dml = (table: string): GrantRow => ({ table, app: DML, backup: BACKUP_TABLE });

/** Table -> role -> privilege list. The order is the order the statements are issued in. */
export const GRANT_MATRIX: readonly GrantRow[] = Object.freeze([
  dml('users'),
  dml('user_credentials'),
  dml('password_setup_tokens'),
  dml('sessions'),
  {
    table: 'session_revocation_commands',
    app: [p('SELECT'), p('INSERT'), p('UPDATE', ['result', 'delivered_at'])],
    backup: BACKUP_TABLE,
  },
  dml('login_throttle'),
  dml('access_tokens'),
  dml('access_token_vaults'),
  dml('oauth_clients'),
  dml('oauth_consents'),
  dml('oauth_consent_vaults'),
  dml('oauth_authorization_codes'),
  dml('oauth_refresh_tokens'),
  dml('vaults'),
  dml('vault_members'),
  dml('nodes'),
  dml('trash_entries'),
  dml('notes'),
  {
    table: 'collab_owner_fence',
    app: [p('SELECT'), p('UPDATE', ['generation'])],
    backup: BACKUP_TABLE,
  },
  dml('note_docs'),
  dml('note_projections'),
  dml('note_search'),
  dml('note_links'),
  dml('attachments'),
  dml('jobs'),
  dml('import_jobs'),
  dml('export_jobs'),
  dml('server_settings'),
  dml('schema_meta'),
  dml('desktop_releases'),
  { table: 'note_updates', app: [p('SELECT'), p('INSERT'), p('DELETE')], backup: BACKUP_TABLE },
  {
    table: 'note_revisions',
    app: [p('SELECT'), p('INSERT'), p('DELETE'), p('UPDATE', ['id'])],
    backup: BACKUP_TABLE,
  },
  {
    table: 'audit_chain_heads',
    app: [p('SELECT'), p('INSERT'), p('UPDATE')],
    backup: BACKUP_TABLE,
  },
  { table: 'audit_events', app: [p('SELECT'), p('INSERT')], backup: BACKUP_AUDIT },
  { table: 'audit_events_archive', app: [p('SELECT'), p('INSERT')], backup: BACKUP_AUDIT },
  { table: 'access_log', app: [p('SELECT'), p('INSERT')], backup: BACKUP_READ },
  { table: 'kysely_migration', app: [p('SELECT')], backup: BACKUP_READ },
  { table: 'kysely_migration_lock', app: [p('SELECT')], backup: BACKUP_READ },
]);

/** The three roles `infra/docker/mysql/init/01_roles.sh` creates. */
export const DB_ROLES = Object.freeze({
  app: Object.freeze({ user: 'iridium_app', host: '%' }),
  migrator: Object.freeze({ user: 'iridium_migrator', host: '%' }),
  backup: Object.freeze({ user: 'iridium_backup', host: '%' }),
});

/**
 * `GRANT ... ON iridium.* TO ...`, issued by `init/01_roles.sh`, recorded here as one source.
 *
 * No migration issues these, for the reason the header gives: a schema-level grant produces no
 * `information_schema.TABLE_PRIVILEGES` rows at all. So the reader today is `migrations.integration`,
 * which compares the rows below with `SHOW GRANTS FOR 'iridium_migrator'@'%'` and proves the init
 * script and this module still agree; `doctor --db-roles` and the rendered DBA script join it at the
 * milestones that add them (11-operations-and-deployment.md OPS-11).
 *
 * @internal
 */
export const SCHEMA_GRANTS: Readonly<Record<'migrator' | 'backup', readonly string[]>> =
  Object.freeze({
    migrator: Object.freeze([
      'SELECT',
      'INSERT',
      'UPDATE',
      'DELETE',
      'CREATE',
      'DROP',
      'ALTER',
      'INDEX',
      'REFERENCES',
      'TRIGGER',
      'EVENT',
      'CREATE VIEW',
      'SHOW VIEW',
      'LOCK TABLES',
      'CREATE TEMPORARY TABLES',
    ]),
    backup: Object.freeze(['SELECT', 'LOCK TABLES', 'SHOW VIEW', 'TRIGGER', 'EVENT']),
  });

/**
 * `GRANT ... ON *.* TO ...`, issued by `init/01_roles.sh`. `iridium_app` holds `USAGE` and nothing
 * else.
 *
 * Recorded rather than issued, like `SCHEMA_GRANTS`, and read by the same consumer:
 * `migrations.integration` asserts the backup role really holds every global privilege a
 * `mysqldump --single-transaction --hex-blob --routines --events` needs, which is the assertion that
 * makes A47's backup procedure a tested claim instead of a documented hope.
 *
 * @internal
 */
export const GLOBAL_GRANTS: Readonly<Record<'app' | 'backup', readonly string[]>> = Object.freeze({
  app: Object.freeze(['USAGE']),
  backup: Object.freeze([
    'RELOAD',
    'PROCESS',
    'REPLICATION CLIENT',
    'REPLICATION SLAVE',
    'BACKUP_ADMIN',
    'SHOW_ROUTINE',
  ]),
});

/**
 * The canonical dump options whose privilege requirements the M1 shipped-client compatibility gate
 * verifies against both supported MySQL lines (OPS-26). The M7 backup CLI consumes this same contract
 * when that command lands; today the reader is `db-grants.integration`.
 *
 * @internal
 */
export const MYSQLDUMP_ARGV: readonly string[] = Object.freeze([
  '--single-transaction',
  '--hex-blob',
  '--max-allowed-packet=1G',
  '--routines',
  '--events',
  '--skip-triggers',
  '--set-gtid-purged=OFF',
  '--source-data=2',
  '--default-character-set=utf8mb4',
  '--databases',
  'iridium',
]);
/** The tables migration `0034_grants` covers: everything that exists when it runs. */
export const GRANTS_0034_TABLES: readonly string[] = Object.freeze(
  GRANT_MATRIX.map((row) => row.table).filter(
    (table) =>
      !table.startsWith('oauth_') &&
      table !== 'session_revocation_commands' &&
      table !== 'collab_owner_fence',
  ),
);

function quoteIdentifier(name: string): string {
  return `\`${name.replaceAll('`', '``')}\``;
}

function renderPrivilege(privilege: Privilege): string {
  return privilege.columns === undefined
    ? privilege.name
    : `${privilege.name} (${privilege.columns.map(quoteIdentifier).join(', ')})`;
}

/** The `GRANT` statement for one table, exactly as the migration executes it. */
export function renderGrant(schema: string, row: GrantRow): string {
  const privileges = row.app.map(renderPrivilege).join(', ');
  const target = `${quoteIdentifier(schema)}.${quoteIdentifier(row.table)}`;
  return `GRANT ${privileges} ON ${target} TO '${DB_ROLES.app.user}'@'${DB_ROLES.app.host}'`;
}

/**
 * Every `GRANT` statement for the named tables, in matrix order. This is what `pnpm gen` renders
 * into `docs/ops/db-grants.sql` for a DBA without `GRANT OPTION` and what `iridium migrate grants
 * --print` emits.
 */
export function renderGrants(schema: string, tables: readonly string[]): string[] {
  const wanted = new Set(tables);
  return GRANT_MATRIX.filter((row) => wanted.has(row.table)).map((row) => renderGrant(schema, row));
}

/** What `applyGrants` did, so the migration can log it and the audit event can record it. */
export type GrantApplication =
  | { readonly applied: true; readonly statements: number }
  | { readonly applied: false; readonly skipped: 'no_grant_option' }
  | {
      readonly applied: false;
      readonly skipped: 'missing_accounts';
      readonly missing: readonly string[];
    };

const GRANT_PROVENANCE = z.discriminatedUnion('applied', [
  z.object({ applied: z.literal(true), fingerprint: z.string() }),
  z.object({
    applied: z.literal(false),
    fingerprint: z.string(),
    skipped: z.enum(['no_grant_option', 'missing_accounts']),
  }),
]);

function provenanceKey(row: GrantRow): string {
  // The longest matrix table name plus this prefix fits schema_meta's VARCHAR(32) key.
  return `acl.${row.table}`;
}

function grantFingerprint(row: GrantRow): string {
  // The schema is deliberately omitted: a copied database keeps the same grant requirements.
  return createHash('sha256').update(renderGrant('', row)).digest('hex');
}

async function recordApplication<DB>(
  db: Kysely<DB>,
  rows: readonly GrantRow[],
  result: GrantApplication,
): Promise<GrantApplication> {
  if (rows.length === 0) return result;
  const values = rows.map((row) => {
    const metadata = result.applied
      ? { applied: true, fingerprint: grantFingerprint(row) }
      : { applied: false, skipped: result.skipped, fingerprint: grantFingerprint(row) };
    return sql`(${provenanceKey(row)}, ${JSON.stringify(metadata)})`;
  });
  await sql`
    INSERT INTO schema_meta (\`key\`, value) VALUES ${sql.join(values)} AS incoming
    ON DUPLICATE KEY UPDATE value = incoming.value
  `.execute(db);
  return result;
}

/** Durable application evidence, distinct from Kysely's record that a migration completed. */
export interface GrantProvenanceStatus {
  readonly unverified: readonly string[];
  readonly skipped: readonly { readonly table: string; readonly reason: string }[];
}

/** Reads only canonical table records; missing, malformed or obsolete evidence is never verified. */
export async function readGrantProvenance<DB>(db: Kysely<DB>): Promise<GrantProvenanceStatus> {
  const records = await sql<{ key: string; value: string }>`
    SELECT \`key\`, value FROM schema_meta
    WHERE \`key\` IN (${sql.join(GRANT_MATRIX.map((row) => provenanceKey(row)))})
  `.execute(db);
  const indexed = new Map(records.rows.map((row) => [row.key, row.value]));
  const unverified: string[] = [];
  const skipped: { table: string; reason: string }[] = [];
  for (const row of GRANT_MATRIX) {
    const serialized = indexed.get(provenanceKey(row));
    let decoded: unknown = null;
    if (serialized !== undefined) {
      try {
        decoded = JSON.parse(serialized);
      } catch {
        // Operator-editable metadata is a boundary: malformed evidence means unverified.
      }
    }
    const parsed = GRANT_PROVENANCE.safeParse(decoded);
    if (!parsed.success || parsed.data.fingerprint !== grantFingerprint(row)) {
      unverified.push(row.table);
    } else if (!parsed.data.applied) {
      skipped.push({ table: row.table, reason: parsed.data.skipped });
    }
  }
  return { unverified, skipped };
}

/**
 * MySQL 8's answer to a `GRANT` naming an account that does not exist: `GRANT` stopped creating
 * accounts in 8.0, and the statement fails with `ER_CANT_CREATE_USER_WITH_GRANT` (1410) before it
 * touches anything. It is detected by error code rather than by probing `mysql.user` first, because
 * the migrator role holds no `SELECT` on the `mysql` schema and `information_schema.USER_PRIVILEGES`
 * shows such an account only itself (03-data-model.md section 2).
 */
const ER_CANT_CREATE_USER_WITH_GRANT = 1410;

function isMissingAccountError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'errno' in error &&
    (error as { errno?: unknown }).errno === ER_CANT_CREATE_USER_WITH_GRANT
  );
}

/** True when the connected account may pass its own privileges on. */
export async function hasGrantOption<DB>(db: Kysely<DB>): Promise<boolean> {
  const result = await sql<Record<string, string>>`SHOW GRANTS FOR CURRENT_USER()`.execute(db);
  return result.rows.some((row) =>
    Object.values(row).some(
      (value) => typeof value === 'string' && value.includes('WITH GRANT OPTION'),
    ),
  );
}

/**
 * Issues the `iridium_app` grants for the named tables against the current schema.
 *
 * `GRANT` is idempotent, so a re-run of an interrupted migration is a no-op rather than an error.
 * Two conditions make the migration record itself as applied with a logged warning instead of
 * issuing the statements. The DBA applies the generated `docs/ops/db-grants.sql` once the condition
 * is gone. Readiness probes the effective critical privileges and retains `grants: unverified` for
 * historical skip metadata; a completed schema migration is not proof of grant application.
 * The migrating account lacks `GRANT OPTION`, or the roles
 * `init/01_roles.sh` creates do not exist yet on this server (a database provisioned without the
 * init script — the CI end-to-end lanes connect as root to a bare service container and are the
 * standing example). Failing the migration instead would make the schema's readiness depend on an
 * account provisioning step that is deliberately outside the migrator's authority.
 */
export async function applyGrants<DB>(
  db: Kysely<DB>,
  tables: readonly string[],
  logger?: DbLogger,
): Promise<GrantApplication> {
  const wanted = new Set(tables);
  const rows = GRANT_MATRIX.filter((row) => wanted.has(row.table));
  if (!(await hasGrantOption(db))) {
    logger?.warn(
      { skipped: 'no_grant_option', tables: tables.length },
      'grants skipped: the migrating account holds no GRANT OPTION. Apply docs/ops/db-grants.sql as a DBA; readiness retains the skipped grant provenance.',
    );
    return recordApplication(db, rows, { applied: false, skipped: 'no_grant_option' });
  }

  const schema = await currentSchema(db);

  const statements = renderGrants(schema, tables);
  for (const statement of statements) {
    // Sequential on purpose: the statements are issued in matrix order so a failure names the first
    // table that could not be granted, and concurrent GRANTs on one account contend on the grant
    // tables for no gain.
    try {
      // eslint-disable-next-line no-await-in-loop -- see above
      await sql.raw(statement).execute(db);
    } catch (error) {
      // GRANT OPTION on an unrelated schema is not authority for this schema.
      if (
        typeof error === 'object' &&
        error !== null &&
        'errno' in error &&
        (error.errno === 1044 || error.errno === 1142 || error.errno === 1227)
      ) {
        logger?.warn(
          { skipped: 'no_grant_option', tables: tables.length },
          'grants skipped: the migrating account cannot grant these table privileges; apply docs/ops/db-grants.sql as a DBA.',
        );
        return recordApplication(db, rows, { applied: false, skipped: 'no_grant_option' });
      }
      if (!isMissingAccountError(error)) throw error;
      // Every statement targets the same account, so the first refusal is the whole answer.
      const missing = [`'${DB_ROLES.app.user}'@'${DB_ROLES.app.host}'`];
      logger?.warn(
        { skipped: 'missing_accounts', missing, tables: tables.length },
        'grants skipped: the account they target does not exist on this server. Create the roles with ' +
          'infra/docker/mysql/init/01_roles.sh (or as a DBA), then apply docs/ops/db-grants.sql. Readiness retains the skipped grant provenance.',
      );
      return recordApplication(db, rows, { applied: false, skipped: 'missing_accounts', missing });
    }
  }
  // No `FLUSH PRIVILEGES`: `GRANT` updates the in-memory grant tables itself, and the statement
  // needs `RELOAD`, which the migrator role deliberately does not hold (03-data-model.md section 2).
  // Only `init/01_roles.sh` flushes, and it runs as root.
  return recordApplication(db, rows, { applied: true, statements: statements.length });
}
