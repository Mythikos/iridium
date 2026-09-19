/** Real forward migration, DBA-managed grants and effective readiness under the shipped role split. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildServerEnv,
  corruptDeliberately,
  inspectGrantCriticalState,
  inspectMigrationHistory,
  TEST_DB_PASSWORDS,
} from '@iridium/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.ts';
import { AppGrantVerifier } from '../../src/db/grants-readiness.ts';
import {
  applyGrants,
  GRANT_MATRIX,
  readGrantProvenance,
  renderGrants,
  SCHEMA_GRANTS,
} from '../../src/db/grants.ts';
import { createDb, parseDatabaseUrl } from '../../src/db/index.ts';
import {
  createMaintDb,
  migrateTo,
  migrateToLatest,
  migrationStatus,
} from '../../src/db/migrator.ts';
import type { ReadyzBody } from '../../src/ops/readiness.ts';
import { startIridiumMysql, type IridiumMysql } from '../db-mysql-container.ts';

let mysql: IridiumMysql;
let admin: ReturnType<typeof createMaintDb>;
const LEGACY_HEAD = '0053_collab_owner_fence_grants';

beforeAll(async () => {
  mysql = await startIridiumMysql();
  admin = createMaintDb(mysql.rootUrl());
  await migrateToLatest({ db: admin.db, target: admin.target });
}, 600_000);

afterAll(async () => {
  await admin?.db.destroy();
  await mysql?.stop();
});

async function criticalState(database: ReturnType<typeof createMaintDb>['db']): Promise<unknown> {
  const result = await inspectGrantCriticalState(database);
  return result.rows;
}

describe('db.grants-provenance.integration [area:db]', () => {
  it('upgrades legacy grant history through a new migration and probes without creating business rows', async () => {
    const schema = 'iridium_grants_upgrade';
    await corruptDeliberately(admin.db, { kind: 'create-schema', schema });
    const upgrade = createMaintDb(mysql.rootUrl(schema));
    try {
      await migrateTo({ db: upgrade.db, target: upgrade.target }, LEGACY_HEAD, 'test');
      const history = await inspectMigrationHistory(upgrade.db, LEGACY_HEAD);
      await corruptDeliberately(upgrade.db, { kind: 'remove-grant-provenance' });
      await migrateToLatest({ db: upgrade.db, target: upgrade.target });
      expect((await migrationStatus(upgrade.db)).status).toBe('current');
      expect((await inspectMigrationHistory(upgrade.db, LEGACY_HEAD)).rows).toEqual(history.rows);
      expect(await readGrantProvenance(upgrade.db)).toEqual({ unverified: [], skipped: [] });
      const before = await criticalState(upgrade.db);
      const app = createDb(parseDatabaseUrl(mysql.appUrl(schema)), 1);
      try {
        expect((await new AppGrantVerifier().check(app.db)).status).toBe('ok');
      } finally {
        await app.db.destroy();
      }
      expect(await criticalState(upgrade.db)).toEqual(before);
    } finally {
      await upgrade.db.destroy();
      await corruptDeliberately(admin.db, { kind: 'drop-schema', schema });
    }
  });

  it.each([
    ['INSERT', 'audit_events'],
    ['INSERT', 'session_revocation_commands'],
    ['UPDATE (result, delivered_at)', 'session_revocation_commands'],
    ['SELECT', 'collab_owner_fence'],
    ['UPDATE (generation)', 'collab_owner_fence'],
  ] as const)(
    'fails missing %s on %s and recovers on the same verifier after DBA repair',
    async (privilege, table) => {
      await migrateToLatest({ db: admin.db, target: admin.target });
      await corruptDeliberately(admin.db, {
        kind: 'revoke-app-privilege',
        schema: 'iridium',
        table,
        privilege,
      });
      const app = createDb(parseDatabaseUrl(mysql.appUrl()), 1);
      const verifier = new AppGrantVerifier();
      try {
        expect(await verifier.check(app.db)).toEqual({
          status: 'fail',
          detail: expect.stringContaining(table),
        });
        await applyGrants(admin.db, [table]);
        expect((await verifier.check(app.db)).status).toBe('ok');
      } finally {
        await applyGrants(admin.db, [table]);
        await app.db.destroy();
      }
    },
  );

  it('persists the missing application account as skipped instead of inventing grant success', async () => {
    await corruptDeliberately(admin.db, { kind: 'drop-account', account: 'iridium_app' });
    try {
      expect(
        await applyGrants(
          admin.db,
          GRANT_MATRIX.map((row) => row.table),
        ),
      ).toMatchObject({ applied: false, skipped: 'missing_accounts' });
      expect((await readGrantProvenance(admin.db)).skipped).toEqual(
        GRANT_MATRIX.map((row) => ({ table: row.table, reason: 'missing_accounts' })),
      );
    } finally {
      await corruptDeliberately(admin.db, {
        kind: 'create-account',
        account: 'iridium_app',
        password: TEST_DB_PASSWORDS.app,
      });
      await applyGrants(
        admin.db,
        GRANT_MATRIX.map((row) => row.table),
      );
    }
  });

  it('supports a DBA withholding GRANT OPTION, persists skips, and serves an honest warning after manual grants', async () => {
    const schema = 'iridium_dba_grants';
    const account = 'iridium_dba_migrator';
    const password = 'grant-provenance-fixture-not-a-real-secret';
    await corruptDeliberately(admin.db, { kind: 'create-schema', schema });
    await corruptDeliberately(admin.db, { kind: 'create-account', account, password });
    await corruptDeliberately(admin.db, {
      kind: 'grant-schema',
      schema,
      account,
      privileges: SCHEMA_GRANTS.migrator,
    });
    const migrationUrl = new URL(mysql.migratorUrl(schema));
    migrationUrl.username = account;
    migrationUrl.password = password;
    const migrator = createMaintDb(migrationUrl.toString());
    const appDb = createDb(parseDatabaseUrl(mysql.appUrl(schema)), 1);
    const scratch = await mkdtemp(join(tmpdir(), 'iridium-db-grants-'));
    try {
      await migrateToLatest({ db: migrator.db, target: migrator.target });
      expect((await migrationStatus(migrator.db)).status).toBe('current');
      const provenance = await readGrantProvenance(migrator.db);
      expect(provenance.unverified).toEqual([]);
      expect(provenance.skipped).toEqual(
        GRANT_MATRIX.map((row) => ({ table: row.table, reason: 'no_grant_option' })),
      );
      // Let the app reach the schema before the DBA supplies writes: the missing audit INSERT fails.
      await corruptDeliberately(admin.db, {
        kind: 'grant-schema',
        schema,
        account: 'iridium_app',
        privileges: ['SELECT'],
      });
      const verifier = new AppGrantVerifier();
      expect(await verifier.check(appDb.db)).toEqual({
        status: 'fail',
        detail: expect.stringContaining('audit_events'),
      });
      for (const statement of renderGrants(
        schema,
        GRANT_MATRIX.map((row) => row.table),
      )) {
        // eslint-disable-next-line no-await-in-loop -- this is the shipped DBA script's ordered application
        await corruptDeliberately(admin.db, { kind: 'apply-dba-grants', statements: [statement] });
      }
      expect((await verifier.check(appDb.db)).status).toBe('warn');
      const app = await buildApp({
        mode: 'in-process',
        env: buildServerEnv({
          host: mysql.host,
          port: mysql.port,
          schema,
          publicOrigin: 'http://127.0.0.1:4000',
          attachmentsDir: scratch,
          extraEnv: { LOG_LEVEL: 'error' },
        }),
      });
      try {
        await app.ready();
        const response = await app.inject({ method: 'GET', url: '/readyz' });
        expect(response.statusCode).toBe(200);
        expect(
          response.json<ReadyzBody>().checks.find((check) => check.name === 'grants'),
        ).toMatchObject({ status: 'warn', detail: expect.stringContaining('no_grant_option') });
      } finally {
        await app.close();
      }
      // The DBA's manual action did not fabricate a successful historical migration outcome.
      expect((await readGrantProvenance(migrator.db)).skipped).toHaveLength(GRANT_MATRIX.length);
    } finally {
      await Promise.all([migrator.db.destroy(), appDb.db.destroy()]);
      await corruptDeliberately(admin.db, { kind: 'drop-schema', schema });
      await corruptDeliberately(admin.db, { kind: 'drop-account', account });
      await rm(scratch, { recursive: true, force: true });
    }
  }, 120_000);
});
