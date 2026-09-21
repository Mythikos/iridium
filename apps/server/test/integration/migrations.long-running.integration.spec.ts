/** Operator admission is checked before any migration, including on the real serve boot path. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildServerEnv,
  inspectSchemaFingerprint,
  runIridiumCli,
  startServer,
  type TestServer,
} from '@iridium/testkit';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { MIGRATION_NAMES } from '../../src/db/migrations.ts';
import { createMaintDb } from '../../src/db/migrator.ts';
import type { ReadyzBody } from '../../src/ops/readiness.ts';
import { IRIDIUM_SCHEMA, startIridiumMysql } from '../db-mysql-container.ts';

const M1_HEAD = '0055_min_client_version';
const FIRST_REBUILD = '0056_projection_alias_lookup';
const BACKFILL = '0059_projection_terms_backfill';
const STATUS = z.object({
  status: z.enum(['current', 'pending', 'newer_schema']),
  applied: z.number().int().nonnegative(),
  pending: z.array(z.string()),
  pendingLongRunning: z.array(z.string()),
  unknown: z.array(z.string()),
});

/** Independent metadata and exact ledger/audit rows, without executing any fixture DDL. */
async function snapshot(maint: ReturnType<typeof createMaintDb>) {
  const observed = await inspectSchemaFingerprint(maint.db, IRIDIUM_SCHEMA, [
    'innodb_flush_log_at_trx_commit',
  ]);
  const tables = new Set(observed.tables.rows.map((row) => row['TABLE_NAME']));
  const groups: Readonly<Record<string, { readonly rows: readonly unknown[] }>> = {
    ...observed,
  };
  const schema = Object.fromEntries(
    Object.entries(groups).map(([name, result]) => [
      name,
      result.rows.map((row) => JSON.stringify(row)).toSorted(),
    ]),
  );
  const ledger = tables.has('kysely_migration')
    ? await maint.db.selectFrom('kysely_migration').selectAll().orderBy('name').execute()
    : [];
  const audit = tables.has('audit_events')
    ? await maint.db.selectFrom('audit_events').selectAll().orderBy('id').execute()
    : [];
  return { schema, ledger, audit };
}

describe('migrations.long-running.integration [area:ops]', () => {
  it('refuses before changing schema or ledger, keeps boot diagnostics available, and requires explicit operator admission', async () => {
    const mysql = await startIridiumMysql();
    const maint = createMaintDb(mysql.migratorUrl());
    const scratch = mkdtempSync(join(tmpdir(), 'iridium-long-running-'));
    let server: TestServer | undefined;
    const coordinates = { host: mysql.host, port: mysql.port, schema: IRIDIUM_SCHEMA };
    const env = buildServerEnv({
      ...coordinates,
      publicOrigin: 'http://127.0.0.1:4000',
      attachmentsDir: scratch,
      extraEnv: { JOBS_ENABLED: 'false' },
    });
    try {
      const pristine = await snapshot(maint);
      expect(pristine.ledger).toEqual([]);
      const refusedFresh = await runIridiumCli(['migrate', 'up'], { env });
      expect(refusedFresh.code, refusedFresh.stderr).toBe(3);
      expect(refusedFresh.stderr).toContain(`${FIRST_REBUILD} [long-running]`);
      expect(refusedFresh.stderr).toContain(`${BACKFILL} [long-running]`);
      expect(refusedFresh.stderr).toContain('--allow-long-running');
      expect(await snapshot(maint)).toEqual(pristine);

      const partial = await runIridiumCli(['migrate', 'to', M1_HEAD], { env });
      expect(partial.code, partial.stderr).toBe(0);
      const base = await snapshot(maint);
      expect(base.ledger.map((row) => row.name)).toEqual(MIGRATION_NAMES.slice(0, 55));
      expect(base.audit).toHaveLength(55);
      const status = await runIridiumCli(['migrate', 'status', '--json'], { env });
      expect(status.code, status.stderr).toBe(0);
      expect(STATUS.parse(JSON.parse(status.stdout))).toEqual({
        status: 'pending',
        applied: 55,
        pending: MIGRATION_NAMES.slice(55),
        pendingLongRunning: [FIRST_REBUILD, BACKFILL],
        unknown: [],
      });

      const refusedUpgrade = await runIridiumCli(['migrate', 'up'], { env });
      expect(refusedUpgrade.code, refusedUpgrade.stderr).toBe(3);
      expect(await snapshot(maint)).toEqual(base);
      const refusedTarget = await runIridiumCli(['migrate', 'to', '0058_projection_terms_grants'], {
        env,
      });
      expect(refusedTarget.code, refusedTarget.stderr).toBe(3);
      expect(refusedTarget.stderr).toContain(`${FIRST_REBUILD} [long-running]`);
      expect(refusedTarget.stderr).not.toContain(`${BACKFILL} [long-running]`);
      expect(await snapshot(maint)).toEqual(base);

      server = await startServer({
        mode: 'child',
        db: coordinates,
        attachmentsDir: scratch,
        extraEnv: {
          IRIDIUM_MIGRATE_ON_BOOT: 'true',
          JOBS_ENABLED: 'false',
          METRICS_TOKEN: 'long-running-migration-metrics-not-a-secret',
        },
      });
      const pending = await server.rest().request<ReadyzBody>('GET', '/readyz');
      expect(pending.status).toBe(503);
      expect(pending.body.checks.find((check) => check.name === 'migrations')).toEqual({
        name: 'migrations',
        status: 'fail',
        detail: `pending (operator action required): ${MIGRATION_NAMES.slice(55).join(', ')}`,
        durationMs: expect.any(Number),
      });
      expect((await server.rest().request('GET', '/healthz')).status).toBe(200);
      const application = await server.rest().get<{ code: string }>('/meta');
      expect(application.status).toBe(503);
      expect(application.body.code).toBe('not_ready');
      expect(await server.metrics()).toHaveProperty('iridium_migrations_pending', 4);
      expect(server.stdout.some((line) => line.includes('migration.pending'))).toBe(true);
      expect(await snapshot(maint)).toEqual(base);
      await server.stop();
      server = undefined;

      const explicitTarget = await runIridiumCli(
        ['migrate', 'to', FIRST_REBUILD, '--allow-long-running'],
        { env },
      );
      expect(explicitTarget.code, explicitTarget.stderr).toBe(0);
      const afterFirst = await snapshot(maint);
      expect(afterFirst.ledger.map((row) => row.name)).toEqual(MIGRATION_NAMES.slice(0, 56));
      // Pending ordinary 0057/0058 must also remain untouched when the later 0059 needs consent.
      const refusedBeforeBackfill = await runIridiumCli(['migrate', 'up'], { env });
      expect(refusedBeforeBackfill.code, refusedBeforeBackfill.stderr).toBe(3);
      expect(refusedBeforeBackfill.stderr).toContain(`${BACKFILL} [long-running]`);
      expect(await snapshot(maint)).toEqual(afterFirst);

      const admitted = await runIridiumCli(['migrate', 'up', '--allow-long-running'], { env });
      expect(admitted.code, admitted.stderr).toBe(0);
      const current = await snapshot(maint);
      expect(current.ledger.map((row) => row.name)).toEqual(MIGRATION_NAMES);
      expect(current.audit).toHaveLength(MIGRATION_NAMES.length);
      const idempotent = await runIridiumCli(['migrate', 'up'], { env });
      expect(idempotent.code, idempotent.stderr).toBe(0);
      expect(JSON.parse(idempotent.stdout)).toEqual({ applied: [] });
      expect(await snapshot(maint)).toEqual(current);
      const currentStatus = await runIridiumCli(['migrate', 'status', '--json'], { env });
      expect(currentStatus.code, currentStatus.stderr).toBe(0);
      expect(STATUS.parse(JSON.parse(currentStatus.stdout))).toEqual({
        status: 'current',
        applied: MIGRATION_NAMES.length,
        pending: [],
        pendingLongRunning: [],
        unknown: [],
      });
    } finally {
      await server?.stop();
      await maint.db.destroy();
      await mysql.stop();
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 180_000);
});
