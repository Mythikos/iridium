/** Real compiled grant/metadata statements with only the database transport scripted. */
import { createHash } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import { fakeDatabase, type FakeDatabase } from '../../test/support/fake-driver.ts';
import { applyGrants, GRANT_MATRIX, readGrantProvenance, renderGrant } from './grants.ts';

const opened: FakeDatabase[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((entry) => entry.db.destroy()));
});

function fixture(
  options: {
    grantOption?: boolean;
    grantError?: Error;
    metadataError?: Error;
    installedTables?: readonly string[];
  } = {},
): {
  database: FakeDatabase;
  records: Map<string, string>;
} {
  const records = new Map<string, string>();
  const database = fakeDatabase({
    script: (query) => {
      if (query.sql.includes('information_schema.TABLES')) {
        return {
          rows: (options.installedTables ?? GRANT_MATRIX.map((row) => row.table)).map(
            (table_name) => ({ table_name }),
          ),
        };
      }
      if (query.sql.startsWith('SHOW GRANTS'))
        return {
          rows: [
            {
              Grants:
                options.grantOption === false
                  ? 'GRANT SELECT ON db.* TO user'
                  : 'GRANT ALL PRIVILEGES ON db.* TO user WITH GRANT OPTION',
            },
          ],
        };
      if (query.sql.includes('DATABASE()')) return { rows: [{ schema_name: 'iridium' }] };
      if (query.sql.startsWith('GRANT'))
        return options.grantError === undefined ? { rows: [] } : { throws: options.grantError };
      if (query.sql.includes('INSERT INTO schema_meta')) {
        if (options.metadataError !== undefined) return { throws: options.metadataError };
        for (let index = 0; index < query.parameters.length; index += 2) {
          const key = query.parameters[index];
          const value = query.parameters[index + 1];
          if (typeof key !== 'string' || typeof value !== 'string')
            throw new Error('Invalid grant metadata binding');
          records.set(key, value);
        }
        return { numAffectedRows: BigInt(records.size) };
      }
      if (query.sql.includes('FROM schema_meta'))
        return { rows: [...records].map(([key, value]) => ({ key, value })) };
      throw new Error(`Unexpected SQL: ${query.sql}`);
    },
  });
  opened.push(database);
  return { database, records };
}

describe('db.grants-provenance.unit [area:db]', () => {
  it('does not grant or certify future tables while replaying a historical migration', async () => {
    const { database, records } = fixture({ installedTables: ['users', 'schema_meta'] });
    expect(
      await applyGrants(database.db, ['users', 'schema_meta', 'note_projection_terms']),
    ).toEqual({ applied: true, statements: 2 });
    expect([...records.keys()].toSorted()).toEqual(['acl.schema_meta', 'acl.users']);
    const grants = database.executed.filter((query) => query.sql.startsWith('GRANT'));
    expect(grants.map((query) => query.sql).join('\n')).not.toContain('note_projection_terms');
    expect((await readGrantProvenance(database.db)).unverified).toContain('note_projection_terms');
  });
  it('records the actual complete matrix only after all GRANT statements succeed', async () => {
    const { database, records } = fixture();
    expect(
      await applyGrants(
        database.db,
        GRANT_MATRIX.map((row) => row.table),
      ),
    ).toEqual({ applied: true, statements: GRANT_MATRIX.length });
    expect(records.size).toBe(GRANT_MATRIX.length);
    expect([...records.keys()].every((key) => key.length <= 32)).toBe(true);
    expect([...records.values()].every((value) => value.length <= 255)).toBe(true);
    for (const row of GRANT_MATRIX) {
      expect(JSON.parse(records.get(`acl.${row.table}`) ?? 'null')).toEqual({
        applied: true,
        fingerprint: createHash('sha256').update(renderGrant('', row)).digest('hex'),
      });
    }
    expect(database.executed.at(-1)?.sql).toContain(
      'ON DUPLICATE KEY UPDATE value = incoming.value',
    );
    expect(await readGrantProvenance(database.db)).toEqual({ unverified: [], skipped: [] });
  });

  it.each(['no_grant_option', 'missing_accounts'] as const)(
    'persists %s rather than treating migration completion as grant success',
    async (reason) => {
      const { database, records } = fixture(
        reason === 'no_grant_option'
          ? { grantOption: false }
          : { grantError: Object.assign(new Error('missing account'), { errno: 1410 }) },
      );
      expect(await applyGrants(database.db, ['audit_events'])).toMatchObject({
        applied: false,
        skipped: reason,
      });
      expect(records.size).toBe(1);
      expect(JSON.parse(records.get('acl.audit_events') ?? 'null')).toMatchObject({
        applied: false,
        skipped: reason,
      });
      const observed = await readGrantProvenance(database.db);
      expect(observed.skipped).toEqual([{ table: 'audit_events', reason }]);
      expect(observed.unverified).not.toContain('audit_events');
      expect(database.executed.filter((query) => query.sql.startsWith('GRANT')).length).toBe(
        reason === 'no_grant_option' ? 0 : 1,
      );
    },
  );

  it.each([1044, 1142, 1227])(
    'records a schema-scoped grant refusal %s even with GRANT OPTION elsewhere',
    async (errno) => {
      const { database, records } = fixture({
        grantError: Object.assign(new Error('not authorized here'), { errno }),
      });
      expect(await applyGrants(database.db, ['audit_events'])).toEqual({
        applied: false,
        skipped: 'no_grant_option',
      });
      expect(JSON.parse(records.get('acl.audit_events') ?? 'null')).toMatchObject({
        applied: false,
        skipped: 'no_grant_option',
      });
    },
  );

  it('does not fabricate application evidence after an unrelated GRANT failure', async () => {
    const failure = Object.assign(new Error('grant transport failed'), { errno: 2013 });
    const { database, records } = fixture({ grantError: failure });
    await expect(applyGrants(database.db, ['audit_events'])).rejects.toBe(failure);
    expect(records.size).toBe(0);
  });

  it('propagates a metadata write failure rather than completing a migration without evidence', async () => {
    const failure = new Error('metadata connection lost');
    const { database } = fixture({ metadataError: failure });
    await expect(applyGrants(database.db, ['audit_events'])).rejects.toBe(failure);
  });

  it('keeps absent, malformed, wrong-shape and stale grant evidence unverified', async () => {
    const { database, records } = fixture();
    records.set('acl.users', 'not JSON');
    records.set('acl.sessions', JSON.stringify({ applied: true }));
    records.set('acl.audit_events', JSON.stringify({ applied: true, fingerprint: 'obsolete' }));
    records.set('acl.foreign_table', JSON.stringify({ applied: true, fingerprint: 'unrelated' }));
    const result = await readGrantProvenance(database.db);
    expect(result.unverified).toEqual(GRANT_MATRIX.map((row) => row.table));
    expect(result.skipped).toEqual([]);
  });

  it('replaces earlier skipped evidence when an authorized replay really applies the grants', async () => {
    const { database, records } = fixture();
    records.set(
      'acl.audit_events',
      '{"applied":false,"skipped":"no_grant_option","fingerprint":"old"}',
    );
    await applyGrants(database.db, ['audit_events']);
    expect(JSON.parse(records.get('acl.audit_events') ?? 'null')).toMatchObject({ applied: true });
    expect((await readGrantProvenance(database.db)).unverified).not.toContain('audit_events');
  });

  it('does not write metadata for an empty table selection', async () => {
    const { database, records } = fixture();
    expect(await applyGrants(database.db, [])).toEqual({ applied: true, statements: 0 });
    expect(records.size).toBe(0);
  });
});
