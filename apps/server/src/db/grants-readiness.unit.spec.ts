/** Boot privilege probes execute real compiled SQL; only MySQL transport answers are scripted. */
import { createHash } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import { fakeDatabase, type FakeDatabase } from '../../test/support/fake-driver.ts';
import { AppGrantVerifier } from './grants-readiness.ts';
import { GRANT_MATRIX, renderGrant } from './grants.ts';

const opened: FakeDatabase[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((entry) => entry.db.destroy()));
});

function fixture(): {
  database: FakeDatabase;
  failures: Map<string, Error>;
  metadata: { skipped: boolean };
} {
  const failures = new Map<string, Error>();
  const metadata = { skipped: false };
  const database = fakeDatabase({
    script: (query) => {
      const failure = [...failures].find(([prefix]) => query.sql.startsWith(prefix))?.[1];
      if (failure !== undefined) return { throws: failure };
      if (query.sql.includes('FROM schema_meta'))
        return {
          rows: GRANT_MATRIX.map((row) => ({
            key: `acl.${row.table}`,
            value: JSON.stringify({
              applied: !metadata.skipped,
              ...(metadata.skipped ? { skipped: 'no_grant_option' } : {}),
              fingerprint: createHash('sha256').update(renderGrant('', row)).digest('hex'),
            }),
          })),
        };
      return { numAffectedRows: 0n };
    },
  });
  opened.push(database);
  return { database, failures, metadata };
}

describe('db.grants-readiness.unit [area:db]', () => {
  it('uses one pinned transaction and rolls back all zero-row probes before reporting verified grants', async () => {
    const { database } = fixture();
    const verifier = new AppGrantVerifier();
    expect((await verifier.check(database.db)).status).toBe('ok');
    expect(database.executed.map((query) => query.sql).slice(0, 7)).toEqual([
      'START TRANSACTION',
      'INSERT INTO audit_events SELECT * FROM audit_events WHERE FALSE',
      'INSERT INTO session_revocation_commands SELECT * FROM session_revocation_commands WHERE FALSE',
      'UPDATE session_revocation_commands SET result = result, delivered_at = delivered_at WHERE FALSE',
      'SELECT id, generation FROM collab_owner_fence WHERE FALSE',
      'UPDATE collab_owner_fence SET generation = generation WHERE FALSE',
      'ROLLBACK',
    ]);
    expect(database.lifecycle.slice(0, 2)).toEqual(['acquire', 'release']);
    await verifier.check(database.db);
    expect(database.executed.filter((query) => query.sql === 'START TRANSACTION')).toHaveLength(1);
    expect(database.executed.some((query) => query.sql === 'COMMIT')).toBe(false);
  });

  it.each([
    ['INSERT INTO audit_events', 'ER_TABLEACCESS_DENIED_ERROR', 'audit_events'],
    [
      'INSERT INTO session_revocation_commands',
      'ER_TABLEACCESS_DENIED_ERROR',
      'session_revocation_commands',
    ],
    ['UPDATE session_revocation_commands', 'ER_COLUMNACCESS_DENIED_ERROR', 'result, delivered_at'],
    ['SELECT id, generation', 'ER_TABLEACCESS_DENIED_ERROR', 'SELECT on collab_owner_fence'],
    ['UPDATE collab_owner_fence', 'ER_COLUMNACCESS_DENIED_ERROR', 'generation'],
  ])(
    'fails missing %s before skipped metadata can hide it and recovers after repair',
    async (statement, code, expected) => {
      const { database, failures, metadata } = fixture();
      metadata.skipped = true;
      failures.set(statement, Object.assign(new Error('denied'), { code }));
      const verifier = new AppGrantVerifier();
      expect(await verifier.check(database.db)).toEqual({
        status: 'fail',
        detail: expect.stringContaining(expected),
      });
      expect(database.executed.at(-1)?.sql).toBe('ROLLBACK');
      expect(database.executed.some((query) => query.sql.includes('FROM schema_meta'))).toBe(false);
      failures.clear();
      expect(await verifier.check(database.db)).toEqual({
        status: 'warn',
        detail: expect.stringContaining('no_grant_option'),
      });
      metadata.skipped = false;
      expect((await verifier.check(database.db)).status).toBe('ok');
    },
  );

  it('does not mistake FK, syntax or transport failures for proof of a missing privilege', async () => {
    const { database, failures } = fixture();
    const failure = Object.assign(new Error('connection lost'), {
      code: 'PROTOCOL_CONNECTION_LOST',
    });
    failures.set('INSERT INTO audit_events', failure);
    const verifier = new AppGrantVerifier();
    await expect(verifier.check(database.db)).rejects.toBe(failure);
    expect(database.executed.at(-1)?.sql).toBe('ROLLBACK');
    failures.clear();
    expect((await verifier.check(database.db)).status).toBe('ok');
  });

  it('does not cache a probe whose rollback could not be confirmed', async () => {
    const { database, failures } = fixture();
    const failure = new Error('rollback connection lost');
    failures.set('ROLLBACK', failure);
    const verifier = new AppGrantVerifier();
    await expect(verifier.check(database.db)).rejects.toBe(failure);
    failures.clear();
    await verifier.check(database.db);
    expect(database.executed.filter((query) => query.sql === 'START TRANSACTION')).toHaveLength(2);
  });
});
