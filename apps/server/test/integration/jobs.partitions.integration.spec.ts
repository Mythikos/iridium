/** Real partition DDL and retention, including role refusal and a second no-op pass. */
import type { ReadyzBody } from '@iridium/contracts';
import { corruptDeliberately, inspectAccessLogPartitions } from '@iridium/testkit';
import { describe, expect, it } from 'vitest';

import { idBytes } from '../../src/auth/ids.ts';
import { createMaintDb } from '../../src/db/migrator.ts';
import { appDb } from '../../src/rest/handler-context.ts';
import { startCollab, type CollabHarness } from '../support/collab-harness.ts';
import { ManualClock } from '../support/manual-clock.ts';

const DAY_MS = 86_400_000;

async function partitionReadiness(harness: CollabHarness): Promise<ReadyzBody['checks'][number]> {
  const response = await harness.server.rest().request<ReadyzBody>('GET', '/readyz');
  const check = response.body.checks.find((row) => row.name === 'access_log_partitions');
  if (check === undefined)
    throw new Error('The real readiness response omitted its partition check.');
  return check;
}

function latestBoundary(rows: readonly { name: string; boundary: string }[]): number {
  return Math.max(
    ...rows
      .filter((row) => row.name !== 'p_overflow')
      .map((row) => Date.parse(row.boundary.replaceAll("'", '').replace(' ', 'T') + 'Z')),
  );
}

async function execute(harness: CollabHarness) {
  const app = harness.application();
  const job = await app.jobs.scheduler.enqueue(
    'access_log_partitions',
    {},
    { ownerFence: app.collab.ownerLease.captureFence() },
  );
  return app.jobs.scheduler.runUntilSettled(job.id);
}

describe('jobs.partitions.integration [area:jobs]', () => {
  it('creates future UTC partitions, drops only wholly expired months, and is idempotent', async () => {
    const clock = new ManualClock(Date.now());
    const cleanupTime = clock.now();
    const harness = await startCollab({
      clock,
      extraEnv: { JOBS_ENABLED: 'false', ACCESS_LOG_PARTITION_LEAD_MONTHS: '6' },
    });
    try {
      const app = harness.application();
      const db = appDb(app);
      const inventory = () => inspectAccessLogPartitions(db);
      const before = await inventory();
      expect(before.rows.some((row) => row.name === 'p_overflow')).toBe(true);
      const newest = latestBoundary(before.rows);
      clock.jump(newest - 30 * DAY_MS);
      expect((await partitionReadiness(harness)).status).toBe('ok');
      clock.jump(clock.now() + 1);
      expect((await partitionReadiness(harness)).status).toBe('warn');
      clock.jump(newest + 400 * DAY_MS);
      const expired = await partitionReadiness(harness);
      expect(expired.status).toBe('warn');
      expect(expired.detail).toContain('p_overflow empty');
      expect(expired.detail).toContain('configured lead=6');
      expect(expired.detail).toContain('scheduled maintenance disabled');
      const first = await execute(harness);
      expect(first.status).toBe('succeeded');
      expect(first.result?.['created']).toBeGreaterThan(0);
      expect(first.result?.['dropped']).toBeGreaterThan(0);
      const after = await inventory();
      const cutoff = clock.now() - app.iridiumConfig.retention.accessLogDays * DAY_MS;
      for (const row of after.rows) {
        if (row.name === 'p_overflow') continue;
        expect(
          Date.parse(row.boundary.replaceAll("'", '').replace(' ', 'T') + 'Z'),
        ).toBeGreaterThan(cutoff);
      }
      expect(latestBoundary(after.rows)).toBe(
        Date.UTC(clock.date().getUTCFullYear(), clock.date().getUTCMonth() + 7, 1),
      );
      const maintained = await partitionReadiness(harness);
      expect(maintained.status).toBe('ok');
      expect(maintained.detail).toContain('p_overflow empty');
      expect(maintained.detail).toContain('(met)');
      expect(maintained.detail).toContain('last run=succeeded');
      expect((await execute(harness)).result).toEqual({ created: 0, dropped: 0 });
      expect((await inventory()).rows).toEqual(after.rows);
    } finally {
      clock.jump(cleanupTime);
      await harness.close();
    }
  });
  it('records a skip without a DDL credential and recovers after restart with one', async () => {
    const clock = new ManualClock(Date.now());
    const cleanupTime = clock.now();
    const harness = await startCollab({
      clock,
      extraEnv: { JOBS_ENABLED: 'false', DATABASE_MIGRATE_URL: '', DATABASE_MIGRATE_PASSWORD: '' },
    });
    let originalClosed = false;
    let restarted: CollabHarness | undefined;
    try {
      const app = harness.application();
      const before = await inspectAccessLogPartitions(appDb(app));
      clock.jump(latestBoundary(before.rows) - 30 * DAY_MS);
      const unneeded = await partitionReadiness(harness);
      expect(unneeded.status).toBe('ok');
      expect(unneeded.detail).toContain('DDL credential absent');
      const done = await execute(harness);
      expect(done.status).toBe('succeeded');
      expect(done.result).toEqual({ status: 'skipped_no_ddl_credential', created: 0, dropped: 0 });
      expect((await inspectAccessLogPartitions(appDb(app))).rows).toEqual(before.rows);
      const skipped = await partitionReadiness(harness);
      expect(skipped.status).toBe('warn');
      expect(skipped.detail).toContain('last run=skipped_no_ddl_credential');
      expect(skipped.detail).toContain('with DATABASE_MIGRATE_URL');
      const skippedAt = clock.now();
      // Boot readiness also compares with MySQL's real clock. Resume the partition observation's
      // test instant after that independent boot check, keeping the durable job timestamps ordered.
      clock.jump(cleanupTime);
      await harness.close();
      originalClosed = true;
      restarted = await startCollab({ clock, extraEnv: { JOBS_ENABLED: 'false' } });
      clock.jump(skippedAt);
      const persisted = await partitionReadiness(restarted);
      expect(persisted.status).toBe('warn');
      expect(persisted.detail).toContain('last run=skipped_no_ddl_credential');
      const metrics = await restarted.server.rest().request<string>('GET', '/metrics', {
        headers: { authorization: 'Bearer collab-fixture-not-a-secret' },
      });
      expect(metrics.status).toBe(200);
      expect(metrics.body).toMatch(
        /^iridium_job_last_success_timestamp\{type="access_log_partitions"\} 0$/m,
      );
      clock.jump(clock.now() + 1);
      expect((await execute(restarted)).status).toBe('succeeded');
      const repaired = await partitionReadiness(restarted);
      expect(repaired.status).toBe('ok');
      expect(repaired.detail).toContain('last run=succeeded');
    } finally {
      clock.jump(cleanupTime);
      await restarted?.close();
      if (!originalClosed) await harness.close();
    }
  });

  it('observes actual catch-all rows and recovers after maintenance moves them into a finite month', async () => {
    const clock = new ManualClock(Date.now());
    const cleanupTime = clock.now();
    const harness = await startCollab({ clock, extraEnv: { JOBS_ENABLED: 'false' } });
    try {
      const app = harness.application();
      const db = appDb(app);
      const user = await harness.server.seed.admin();
      const before = await inspectAccessLogPartitions(db);
      const occurredAt = new Date(latestBoundary(before.rows) + DAY_MS);
      await corruptDeliberately(db, {
        kind: 'access-log-overflow-row',
        occurredAt,
        userId: idBytes(user.id),
      });
      const overflow = await partitionReadiness(harness);
      expect(overflow.status).toBe('warn');
      expect(overflow.detail).toContain('p_overflow contains rows');
      clock.jump(occurredAt.getTime());
      const maintained = await execute(harness);
      expect(maintained.status).toBe('succeeded');
      expect(maintained.result?.['created']).toBeGreaterThan(0);
      const recovered = await partitionReadiness(harness);
      expect(recovered.status).toBe('ok');
      expect(recovered.detail).toContain('p_overflow empty');
      expect(
        await db
          .selectFrom('access_log')
          .select(['occurred_at', 'user_id'])
          .where('user_id', '=', idBytes(user.id))
          .execute(),
      ).toEqual([{ occurred_at: occurredAt, user_id: idBytes(user.id) }]);
    } finally {
      clock.jump(cleanupTime);
      await harness.close();
    }
  });

  it('warns for a missing catch-all while preserving the serving role prohibition on DDL', async () => {
    const clock = new ManualClock(Date.now());
    const harness = await startCollab({ clock, extraEnv: { JOBS_ENABLED: 'false' } });
    const app = harness.application();
    const url = app.iridiumConfig.db.migrateUrl;
    if (url === null)
      throw new Error('The partition fixture requires its normal migrator credential.');
    const maint = createMaintDb(url, app.iridiumConfig.db.connectTimeoutMs);
    let removed = false;
    try {
      const before = await inspectAccessLogPartitions(appDb(app));
      const originalReadiness = await partitionReadiness(harness);
      await expect(
        corruptDeliberately(appDb(app), { kind: 'access-log-catch-all', present: false }),
      ).rejects.toMatchObject({ code: 'ER_TABLEACCESS_DENIED_ERROR' });
      expect((await inspectAccessLogPartitions(appDb(app))).rows).toEqual(before.rows);
      await corruptDeliberately(maint.db, { kind: 'access-log-catch-all', present: false });
      removed = true;
      const missing = await partitionReadiness(harness);
      expect(missing.status).toBe('warn');
      expect(missing.detail).toContain('p_overflow MAXVALUE catch-all is missing');
      expect((await harness.server.rest().request('GET', '/healthz')).status).toBe(200);
      await corruptDeliberately(maint.db, { kind: 'access-log-catch-all', present: true });
      removed = false;
      expect((await inspectAccessLogPartitions(appDb(app))).rows).toEqual(before.rows);
      expect((await partitionReadiness(harness)).status).toBe(originalReadiness.status);
    } finally {
      if (removed)
        await corruptDeliberately(maint.db, { kind: 'access-log-catch-all', present: true });
      await maint.db.destroy();
      await harness.close();
    }
  });
});
