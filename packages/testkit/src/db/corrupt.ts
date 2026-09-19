/**
 * Deliberate database mutations for test fixtures. Production setup still goes through the product.
 * Every operation has a closed name, records that name without credentials, and uses the caller's
 * executor so transaction ownership, lock lifetime, and native failures remain observable.
 */
import { sql, type QueryExecutorProvider, type QueryResult } from 'kysely';

import type { MysqlAdmin } from '../env/mysql.ts';
import type { DatabaseRole, ShippedMysqlClient } from '../env/shipped-mysql-client.ts';

/** Fixture accounts whose lifecycle or schema grants a privilege regression deliberately changes. */
type ProbeAccount = 'iridium_app' | 'iridium_migrator' | 'iridium_dba_migrator';

/** Only currently exercised invariant violations and administrative setup operations are exposed. */
export type DeliberateCorruption =
  | { readonly kind: 'create-schema'; readonly schema: string; readonly ifNotExists?: boolean }
  | { readonly kind: 'drop-schema'; readonly schema: string }
  | { readonly kind: 'create-account'; readonly account: ProbeAccount; readonly password: string }
  | { readonly kind: 'drop-account'; readonly account: ProbeAccount }
  | {
      readonly kind: 'grant-schema';
      readonly schema: string;
      readonly account: ProbeAccount;
      readonly privileges: readonly string[];
      readonly withGrantOption?: boolean;
    }
  | {
      readonly kind: 'revoke-app-privilege';
      readonly schema: string;
      readonly table: 'audit_events' | 'session_revocation_commands' | 'collab_owner_fence';
      readonly privilege:
        | 'INSERT'
        | 'SELECT'
        | 'UPDATE (result, delivered_at)'
        | 'UPDATE (generation)';
    }
  | { readonly kind: 'apply-dba-grants'; readonly statements: readonly string[] }
  | { readonly kind: 'remove-grant-provenance' }
  | { readonly kind: 'contend-install-row' }
  | { readonly kind: 'transport-insert'; readonly value: number };

const SCHEMA_PRIVILEGES: ReadonlySet<string> = new Set([
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
]);
const APP_PRIVILEGES: ReadonlySet<string> = new Set([
  'INSERT',
  'SELECT',
  'UPDATE (result, delivered_at)',
  'UPDATE (generation)',
]);
const ACCOUNTS: ReadonlySet<string> = new Set([
  'iridium_app',
  'iridium_migrator',
  'iridium_dba_migrator',
]);
// This accepts the product renderGrants grammar only: no statements, clauses or accounts beyond it.
const DBA_GRANT =
  /^GRANT (?:SELECT|INSERT|UPDATE|DELETE)(?: \(`[a-z0-9_]+`(?:, `[a-z0-9_]+`)*\))?(?:, (?:SELECT|INSERT|UPDATE|DELETE)(?: \(`[a-z0-9_]+`(?:, `[a-z0-9_]+`)*\))?)* ON `[a-z0-9_]+`\.`[a-z0-9_]+` TO 'iridium_app'@'%'$/u;

function identifier(value: string): string {
  if (!/^[a-z][a-z0-9_]*$/u.test(value)) throw new Error('Invalid fixture SQL identifier.');
  return value;
}

function account(value: ProbeAccount): ProbeAccount {
  if (!ACCOUNTS.has(value)) throw new Error('Unsupported fixture account.');
  return value;
}

function recordCorruption(kind: string): void {
  process.stderr.write(JSON.stringify({ event: 'test.db.corruption', operation: kind }) + '\n');
}

/**
 * Execute one named manipulation without opening or closing a connection/transaction.
 * The optional recorder is an I/O seam for unit verification; payloads and passwords are never logged.
 */
export async function corruptDeliberately(
  executor: QueryExecutorProvider,
  operation: DeliberateCorruption,
  record: (kind: DeliberateCorruption['kind']) => void = recordCorruption,
): Promise<QueryResult<unknown>> {
  record(operation.kind);
  switch (operation.kind) {
    case 'create-schema':
      return sql`CREATE DATABASE ${operation.ifNotExists ? sql`IF NOT EXISTS ` : sql``}${sql.id(identifier(operation.schema))} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`.execute(
        executor,
      );
    case 'drop-schema':
      return sql`DROP DATABASE ${sql.id(identifier(operation.schema))}`.execute(executor);
    case 'create-account':
      return sql`CREATE USER ${account(operation.account)}@'%' IDENTIFIED WITH caching_sha2_password BY ${operation.password}`.execute(
        executor,
      );
    case 'drop-account':
      return sql`DROP USER ${account(operation.account)}@'%'`.execute(executor);
    case 'grant-schema': {
      if (
        operation.privileges.length === 0 ||
        operation.privileges.some((privilege) => !SCHEMA_PRIVILEGES.has(privilege))
      ) {
        throw new Error('Unsupported fixture schema privilege.');
      }
      return sql`GRANT ${sql.join(operation.privileges.map((privilege) => sql.raw(privilege)))} ON ${sql.id(identifier(operation.schema))}.* TO ${account(operation.account)}@'%'${operation.withGrantOption ? sql` WITH GRANT OPTION` : sql``}`.execute(
        executor,
      );
    }
    case 'revoke-app-privilege':
      if (!APP_PRIVILEGES.has(operation.privilege))
        throw new Error('Unsupported fixture application privilege.');
      return sql`REVOKE ${sql.raw(operation.privilege)} ON ${sql.id(identifier(operation.schema), identifier(operation.table))} FROM 'iridium_app'@'%'`.execute(
        executor,
      );
    case 'apply-dba-grants': {
      if (
        operation.statements.length === 0 ||
        operation.statements.some((statement) => !DBA_GRANT.test(statement))
      ) {
        throw new Error('Expected the product-generated application GRANT script.');
      }
      let result: QueryResult<unknown> = { rows: [] };
      for (const statement of operation.statements) {
        // eslint-disable-next-line no-await-in-loop -- preserve the shipped DBA script's ordered effects
        result = await sql.raw(statement).execute(executor);
      }
      return result;
    }
    case 'remove-grant-provenance':
      return sql`DELETE FROM schema_meta WHERE ${sql.ref('key')} LIKE 'acl.%'`.execute(executor);
    case 'contend-install-row':
      return sql`UPDATE schema_meta SET value = value WHERE ${sql.ref('key')} = 'iridium_version'`.execute(
        executor,
      );
    case 'transport-insert':
      return sql`INSERT INTO note_updates VALUES (${operation.value})`.execute(executor);
  }
  throw new Error('Unsupported deliberate database operation.');
}

/** Named interventions carried over the real container mysql client rather than a new connection. */
export type AdminCorruption =
  | { readonly kind: 'kill-connection'; readonly connectionId: number }
  | {
      readonly kind: 'grant-app-schema-read';
      readonly schema: string;
      readonly flushPrivileges?: boolean;
    }
  | { readonly kind: 'audit-insert-privilege'; readonly schema: string; readonly granted: boolean }
  | {
      readonly kind: 'tamper-audit-reason' | 'delete-audit-chain';
      readonly schema: string;
      readonly chainId: string;
    };

function quotedIdentifier(value: string): string {
  return '`' + identifier(value) + '`';
}

/** Preserve MysqlAdmin's own execution, errors and session scope for each explicit intervention. */
export function corruptMysqlDeliberately(
  admin: Pick<MysqlAdmin, 'run'>,
  operation: AdminCorruption,
  record: (kind: AdminCorruption['kind']) => void = recordCorruption,
): Promise<string> {
  record(operation.kind);
  switch (operation.kind) {
    case 'kill-connection':
      if (!Number.isSafeInteger(operation.connectionId) || operation.connectionId < 1) {
        throw new Error('Invalid fixture connection identifier.');
      }
      return admin.run('KILL ' + String(operation.connectionId));
    case 'grant-app-schema-read':
      return admin.run(
        'GRANT SELECT ON ' +
          quotedIdentifier(operation.schema) +
          ".* TO 'iridium_app'@'%'" +
          (operation.flushPrivileges ? '; FLUSH PRIVILEGES' : ''),
      );
    case 'audit-insert-privilege':
      return admin.run(
        (operation.granted ? 'GRANT INSERT ON ' : 'REVOKE INSERT ON ') +
          quotedIdentifier(operation.schema) +
          '.audit_events ' +
          (operation.granted ? 'TO' : 'FROM') +
          " 'iridium_app'@'%';",
      );
    case 'tamper-audit-reason':
    case 'delete-audit-chain': {
      if (!/^[a-zA-Z0-9:_-]+$/u.test(operation.chainId))
        throw new Error('Invalid fixture audit chain identifier.');
      const target = quotedIdentifier(operation.schema) + '.audit_events';
      const statement =
        operation.kind === 'tamper-audit-reason'
          ? 'UPDATE ' + target + " SET reason = 'tampered'"
          : 'DELETE FROM ' + target;
      return admin.run(statement + " WHERE chain_id = '" + operation.chainId + "'");
    }
  }
  throw new Error('Unsupported deliberate mysql operation.');
}

const SHIPPED_WRITE_PROBES = {
  'flush-binlog': 'FLUSH BINARY LOGS',
  'backup-insert-schema-meta': 'INSERT INTO schema_meta SELECT * FROM schema_meta',
  'forge-audit-event': "UPDATE audit_events SET action='forged'",
  'delete-audit-event': 'DELETE FROM audit_events',
  'forge-audit-archive': "UPDATE audit_events_archive SET action='forged'",
  'delete-audit-archive': 'DELETE FROM audit_events_archive',
  'delete-audit-head': 'DELETE FROM audit_chain_heads',
  'forge-note-update': "UPDATE note_updates SET update_v1=X'00'",
  'forge-access-log': "UPDATE access_log SET action='forged'",
  'delete-access-log': 'DELETE FROM access_log',
  'alter-migration-ledger': 'UPDATE kysely_migration SET name=name',
  'delete-migration-lock': 'DELETE FROM kysely_migration_lock',
  'create-forbidden-table': 'CREATE TABLE forbidden_grant_probe (id INT PRIMARY KEY)',
  'drop-audit-trigger': 'DROP TRIGGER audit_events_bu',
  'alter-audit-table': 'ALTER TABLE audit_events ADD COLUMN forbidden_grant_probe INT',
  'reorganize-access-partition':
    "ALTER TABLE access_log REORGANIZE PARTITION p_overflow INTO (PARTITION p_probe VALUES LESS THAN ('2100-01-01'), PARTITION p_overflow VALUES LESS THAN (MAXVALUE))",
  'forge-note-revision': "UPDATE note_revisions SET markdown='forged'",
  'noop-note-revision':
    'INSERT INTO note_revisions SELECT * FROM note_revisions AS existing_revision ON DUPLICATE KEY UPDATE id=note_revisions.id',
  'rollback-delete-note-revisions': 'START TRANSACTION; DELETE FROM note_revisions; ROLLBACK',
  'rollback-delete-note-updates': 'START TRANSACTION; DELETE FROM note_updates; ROLLBACK',
  'copy-audit-archive': 'INSERT INTO audit_events_archive SELECT * FROM audit_events',
  'archive-delete-audit-event':
    'SET @iridium_audit_archive=1; START TRANSACTION; DELETE FROM audit_events; ROLLBACK',
  'archive-delete-audit-archive':
    'SET @iridium_audit_archive=1; START TRANSACTION; DELETE FROM audit_events_archive; ROLLBACK',
  'reorganize-and-drop-access-partition':
    "ALTER TABLE access_log REORGANIZE PARTITION p_overflow INTO (PARTITION p_probe VALUES LESS THAN ('2100-01-01'), PARTITION p_overflow VALUES LESS THAN (MAXVALUE)); ALTER TABLE access_log DROP PARTITION p_probe",
} as const;

/** The closed vocabulary of real privilege/trigger/session statements in the shipped-client proof. */
export type MysqlWriteProbe = keyof typeof SHIPPED_WRITE_PROBES;

function shippedStatement(probe: MysqlWriteProbe): string {
  if (!Object.hasOwn(SHIPPED_WRITE_PROBES, probe))
    throw new Error('Unsupported shipped mysql probe.');
  return SHIPPED_WRITE_PROBES[probe];
}

/** Return the unchanged client exit/stderr result so the spec independently asserts its denial code. */
export function probeShippedMysqlWrite(
  client: Pick<ShippedMysqlClient, 'execute'>,
  role: DatabaseRole,
  probe: MysqlWriteProbe,
): ReturnType<ShippedMysqlClient['execute']> {
  recordCorruption(probe);
  return client.execute(role, shippedStatement(probe));
}

/** Keep the shipped client's throwing success path and same-session multi-statement behavior. */
export function corruptShippedMysqlDeliberately(
  client: Pick<ShippedMysqlClient, 'query'>,
  role: DatabaseRole,
  probe: MysqlWriteProbe,
): Promise<string> {
  recordCorruption(probe);
  return client.query(role, shippedStatement(probe));
}

const CALLBACK_WRITE_PROBES = {
  'deadline-note-update': 'UPDATE notes SET body=?',
  'duplicate-user-insert': 'INSERT INTO users VALUES (?)',
  'expire-throttle-before-5': 'DELETE FROM \x60login_throttle\x60 WHERE expire < 5',
  'uncounted-throttle-delete': 'DELETE FROM \x60login_throttle\x60 WHERE 0',
  'no-callback-throttle-delete': 'DELETE FROM \x60login_throttle\x60 WHERE expire < 1',
} as const;

/** The fixed write statements used to verify callback-style database transport adapters. */
export type CallbackWriteProbe = keyof typeof CALLBACK_WRITE_PROBES;

/**
 * Pass a named statement to the caller's original callback transport without wrapping its callback.
 * Parameters, callback overload, native result and synchronous throw stay under the test's control.
 */
export function corruptCallbackDeliberately<Result>(
  execute: (statement: string) => Result,
  probe: CallbackWriteProbe,
  record: (kind: CallbackWriteProbe) => void = recordCorruption,
): Result {
  if (!Object.hasOwn(CALLBACK_WRITE_PROBES, probe)) {
    throw new Error('Unsupported callback database probe.');
  }
  record(probe);
  return execute(CALLBACK_WRITE_PROBES[probe]);
}
