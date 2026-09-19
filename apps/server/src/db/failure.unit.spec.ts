/**
 * `db.failure-mapping.unit` — 03-data-model.md §7.4's table and the SQL redaction of 11's logging rules.
 *
 * Both are pure functions over a driver error, and both are security- or correctness-relevant in a way a
 * reader cannot verify by inspection: a constraint name that maps to the wrong code turns a `409` into a
 * `500`, and a literal the redaction misses is note content on a log line.
 *
 * There is no inventory row for this name yet; the platform stream's report asks for one.
 */
import { describe, expect, it } from 'vitest';

import { ProblemError } from '../security/problem.ts';
import { classifyDatabaseFailure, isRetryableDeadlock, MYSQL_ERRNO, toProblem } from './failure.ts';
import { redactDatabaseError, redactSqlText } from './redact-sql.ts';

/** A mysql2-shaped error: `errno`, `code`, `sqlState` and `sql` are own enumerable properties. */
function mysqlError(fields: {
  errno: number;
  code: string;
  message: string;
  sqlState?: string;
  sql?: string;
}): Error {
  return Object.assign(new Error(fields.message), {
    errno: fields.errno,
    code: fields.code,
    sqlState: fields.sqlState ?? 'HY000',
    ...(fields.sql === undefined ? {} : { sql: fields.sql }),
  });
}

function duplicate(keyName: string): Error {
  return mysqlError({
    errno: MYSQL_ERRNO.duplicateEntry,
    code: 'ER_DUP_ENTRY',
    message: `Duplicate entry 'abc-Readme' for key 'nodes.${keyName}'`,
  });
}

describe('db.failure-mapping.unit [area:db]', () => {
  describe('classification', () => {
    it('reads the constraint name out of an ER_DUP_ENTRY message, with or without a table prefix', () => {
      expect(classifyDatabaseFailure(duplicate('uq_sibling'))).toEqual({
        kind: 'duplicate_entry',
        constraint: 'uq_sibling',
      });
      expect(
        classifyDatabaseFailure(
          mysqlError({
            errno: MYSQL_ERRNO.duplicateEntry,
            code: 'ER_DUP_ENTRY',
            message: "Duplicate entry 'x' for key 'uq_vaults_slug'",
          }),
        ),
      ).toEqual({ kind: 'duplicate_entry', constraint: 'uq_vaults_slug' });
    });

    it('names the lock-wait timeout, the deadlock and the append-only trigger', () => {
      expect(
        classifyDatabaseFailure(
          mysqlError({
            errno: MYSQL_ERRNO.lockWaitTimeout,
            code: 'ER_LOCK_WAIT_TIMEOUT',
            message: 'x',
          }),
        ).kind,
      ).toBe('lock_wait_timeout');
      expect(
        classifyDatabaseFailure(
          mysqlError({ errno: MYSQL_ERRNO.deadlock, code: 'ER_LOCK_DEADLOCK', message: 'x' }),
        ).kind,
      ).toBe('deadlock');
      expect(
        classifyDatabaseFailure(
          mysqlError({
            errno: MYSQL_ERRNO.signalException,
            code: 'ER_SIGNAL_EXCEPTION',
            message: 'audit_events is append-only',
            sqlState: '45000',
          }),
        ).kind,
      ).toBe('append_only_violation');
    });

    it('classifies anything else, including a non-error, as other', () => {
      expect(classifyDatabaseFailure(new Error('boom')).kind).toBe('other');
      expect(classifyDatabaseFailure('boom').kind).toBe('other');
      expect(classifyDatabaseFailure(null).kind).toBe('other');
    });

    it('retries only a deadlock', () => {
      expect(
        isRetryableDeadlock(mysqlError({ errno: 1213, code: 'ER_LOCK_DEADLOCK', message: 'x' })),
      ).toBe(true);
      expect(
        isRetryableDeadlock(
          mysqlError({ errno: 1205, code: 'ER_LOCK_WAIT_TIMEOUT', message: 'x' }),
        ),
      ).toBe(false);
    });
  });

  describe('the §7.4 mapping', () => {
    it.each([
      ['uq_sibling', 'name_conflict'],
      ['uq_vaults_name', 'name_conflict'],
      ['uq_vaults_slug', 'name_conflict'],
      ['uq_attachment_path', 'name_conflict'],
    ])('maps %s to %s', (keyName, code) => {
      const problem = toProblem(duplicate(keyName));
      expect(problem).toBeInstanceOf(ProblemError);
      expect(problem?.code).toBe(code);
    });

    it('maps the users email unique key to 409 without exposing the driver value', () => {
      const problem = toProblem(
        mysqlError({
          errno: MYSQL_ERRNO.duplicateEntry,
          code: 'ER_DUP_ENTRY',
          message:
            "Duplicate entry 'private-address@example.test' for key 'users.uq_users_email_key'",
        }),
      );
      expect(problem?.code).toBe('email_conflict');
      expect(problem?.status).toBe(409);
      expect(problem?.extensions.detail).toBe('An account with that email address already exists.');
      expect(JSON.stringify(problem)).not.toContain('private-address@example.test');
    });

    it('does not map uq_attachment_vault_sha, which is dedupe rather than a failure', () => {
      // §7.4: the existing row is returned (content-addressed dedupe, §10.3), so the caller handles it.
      expect(toProblem(duplicate('uq_attachment_vault_sha'))).toBeNull();
    });

    it('carries the caller’s payload on a name conflict', () => {
      const problem = toProblem(duplicate('uq_sibling'), {
        current: { parentId: 'p', name: 'Readme' },
      });
      expect(problem?.extensions.current).toEqual({ parentId: 'p', name: 'Readme' });
    });

    it('maps both lock failures to 503 busy with Retry-After: 1', () => {
      for (const errno of [MYSQL_ERRNO.lockWaitTimeout, MYSQL_ERRNO.deadlock]) {
        const problem = toProblem(mysqlError({ errno, code: 'ER_LOCK', message: 'x' }));
        expect(problem?.code).toBe('busy');
        expect(problem?.status).toBe(503);
      }
    });

    it.each([
      'ECONNREFUSED',
      'ECONNRESET',
      'ETIMEDOUT',
      'EPIPE',
      'EHOSTUNREACH',
      'ENOTFOUND',
      'PROTOCOL_CONNECTION_LOST',
      'PROTOCOL_SEQUENCE_TIMEOUT',
      'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR',
      'PROTOCOL_ENQUEUE_AFTER_QUIT',
      'ER_SERVER_SHUTDOWN',
      'ER_CON_COUNT_ERROR',
    ])('maps %s to503 without claiming an ambiguous write rolled back', (code) => {
      const error = Object.assign(new Error('COMMIT for secret-note-content'), { code });
      expect(classifyDatabaseFailure(error).kind).toBe('unavailable');
      const problem = toProblem(error);
      expect(problem?.code).toBe('unavailable');
      expect(problem?.status).toBe(503);
      expect(problem?.extensions.detail).not.toContain('secret-note-content');
      expect(problem?.extensions.detail).toContain('Check its current state');
      expect(isRetryableDeadlock(error)).toBe(false);
    });

    it.each(['Pool is closed.', 'Cannot add a command in closed state'])(
      'classifies the unnumbered driver closure %s as unavailable',
      (message) => {
        expect(classifyDatabaseFailure(new Error(message)).kind).toBe('unavailable');
      },
    );

    it('maps an append-only trigger to server_error with the redacted driver text', () => {
      const problem = toProblem(
        mysqlError({
          errno: MYSQL_ERRNO.signalException,
          code: 'ER_SIGNAL_EXCEPTION',
          message: "audit_events is append-only, row id 42 for 'secret-value'",
          sqlState: '45000',
        }),
      );
      expect(problem?.code).toBe('server_error');
      expect(problem?.extensions.detail).not.toContain('secret-value');
      expect(problem?.extensions.detail).toContain('append-only');
    });

    it('returns null for a failure the table does not name, so it propagates as server_error', () => {
      expect(toProblem(new Error('connection lost'))).toBeNull();
    });
  });

  describe('SQL redaction', () => {
    it('replaces quoted strings, numbers and hex literals, and keeps identifiers', () => {
      const redacted = redactSqlText(
        "UPDATE nodes SET name = 'Quarterly Plan', version = 7 WHERE id = 0xDEADBEEF",
      );
      expect(redacted).toBe('UPDATE nodes SET name = ?, version = ? WHERE id = ?');
    });

    it('consumes a string whole, including an escaped quote and a doubled quote', () => {
      expect(redactSqlText("INSERT INTO notes VALUES ('it\\'s here', 'don''t')")).toBe(
        'INSERT INTO notes VALUES (?, ?)',
      );
    });

    it('does not leak a number that lives inside a string', () => {
      expect(redactSqlText("SET markdown = 'version 7 of the plan'")).toBe('SET markdown = ?');
    });

    it('keeps the code, errno and sqlState and drops the interpolated statement', () => {
      const redacted = redactDatabaseError(
        mysqlError({
          errno: MYSQL_ERRNO.duplicateEntry,
          code: 'ER_DUP_ENTRY',
          message: "Duplicate entry 'IRIDIUM_SECRET_BODY_MARKER' for key 'nodes.uq_sibling'",
          sql: "INSERT INTO nodes (name) VALUES ('IRIDIUM_SECRET_BODY_MARKER')",
        }),
      );
      expect(redacted.code).toBe('ER_DUP_ENTRY');
      expect(redacted.errno).toBe(MYSQL_ERRNO.duplicateEntry);
      expect(redacted.sqlState).toBe('HY000');
      expect(redacted.message).not.toContain('IRIDIUM_SECRET_BODY_MARKER');
      expect(JSON.stringify(redacted)).not.toContain('INSERT INTO nodes');
      // MySQL quotes the key name too, so redaction removes it along with the value — which is why the
      // constraint reaches a log line as a structured field from `classifyDatabaseFailure` rather than by
      // being left inside free text. Keeping one quoted run and dropping the other is not a rule a
      // regular expression can hold.
      expect(classifyDatabaseFailure(duplicate('uq_sibling'))).toEqual({
        kind: 'duplicate_entry',
        constraint: 'uq_sibling',
      });
    });

    it('describes a non-error without throwing', () => {
      expect(redactDatabaseError(undefined)).toEqual({
        code: null,
        errno: null,
        sqlState: null,
        message: 'database error',
      });
    });
  });
});
