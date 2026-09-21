/** The shipped CLI submits real intents while serving, and executes under its own lease offline. */
import { Job, JobPage } from '@iridium/contracts';
import { buildServerEnv, runIridiumCli, workerSchemaName, type CliResult } from '@iridium/testkit';
import { describe, expect, inject, it } from 'vitest';
import { z } from 'zod';

import { appDb } from '../../src/rest/handler-context.ts';
import { startCollab } from '../support/collab-harness.ts';
import { ManualClock } from '../support/manual-clock.ts';

function expectCode(result: CliResult, code = 0): void {
  expect({ code: result.code, error: result.code === code ? '' : result.stderr }).toEqual({
    code,
    error: '',
  });
}
function cliEnv(origin = 'http://127.0.0.1:4000'): Record<string, string> {
  const mysql = inject('iridiumMysql');
  return buildServerEnv({
    host: mysql.host,
    port: mysql.port,
    schema: workerSchemaName(process.env['VITEST_WORKER_ID'] ?? '1'),
    publicOrigin: origin,
    extraEnv: { JOBS_ENABLED: 'false' },
  });
}
describe('cli.maintenance.integration [area:ops]', () => {
  it('executes CLI jobs through the live owner with scheduling disabled, and audits every new command path', async () => {
    const harness = await startCollab({ extraEnv: { JOBS_ENABLED: 'false' } });
    try {
      const cast = await harness.server.seed.kernel();
      const app = harness.application();
      const generation = app.collab.ownerLease.captureGeneration();
      const commands = [
        ['jobs', 'run', 'update_log_prune', '--json'],
        ['reindex', '--vault', cast.vault.id, '--stale', '--json'],
        ['trash', 'purge', '--vault', cast.vault.id, '--json'],
        ['audit', 'archive', '--dry-run', '--json'],
      ];
      const ids: string[] = [];
      for (const argv of commands) {
        // eslint-disable-next-line no-await-in-loop -- each real CLI invocation must observe its own committed outcome
        const result = await harness.server.cli(argv);
        expectCode(result);
        const completed = Job.parse(JSON.parse(result.stdout));
        expect(completed.status).toBe('succeeded');
        expect(completed.attempts).toBe(1);
        ids.push(completed.id);
      }
      expect(app.collab.ownerLease.captureGeneration()).toBe(generation);
      const listed = await harness.server.cli(['jobs', 'list', '--json']);
      expectCode(listed);
      const page = JobPage.parse(JSON.parse(listed.stdout));
      expect(page.items.map((job) => job.id)).toEqual(expect.arrayContaining(ids));
      const triggered = await appDb(app)
        .selectFrom('audit_events')
        .select(['credential_type', 'context'])
        .where('action', '=', 'admin.job.triggered')
        .execute();
      for (const row of triggered) {
        expect(row.credential_type).toBe('cli');
        expect(row.context).toHaveProperty('request_id');
        expect(row.context).toHaveProperty('argv_shape');
        expect(z.object({ argv_shape: z.string() }).parse(row.context).argv_shape).not.toContain(
          cast.vault.id,
        );
      }
      expect(triggered).toHaveLength(commands.length);
      const exported = await harness.server.cli([
        'audit',
        'export',
        '--format',
        'jsonl',
        '--include-archive',
        '--actor',
        cast.admin.email,
      ]);
      expectCode(exported);
      const rows = exported.stdout
        .trim()
        .split('\n')
        .map((line) => z.record(z.string(), z.unknown()).parse(JSON.parse(line)));
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0]?.['hash']).toMatch(/^[a-f\d]{64}$/);
      expect(rows[0]?.['prev_hash']).toMatch(/^[a-f\d]{64}$/);
      expect(rows[0]?.['key_version']).toBeTypeOf('number');
      expect(
        await appDb(app)
          .selectFrom('audit_events')
          .select('credential_type')
          .where('action', '=', 'admin.audit.exported')
          .execute(),
      ).toEqual([{ credential_type: 'cli' }]);
    } finally {
      await harness.close();
    }
  });
  it('acquires the real owner lease and executes app and DDL jobs when no server owns the schema', async () => {
    const env = cliEnv();
    const ddl = await runIridiumCli(['jobs', 'run', 'access_log_partitions', '--json'], {
      env,
      timeoutMs: 30_000,
    });
    expectCode(ddl);
    expect(Job.parse(JSON.parse(ddl.stdout))).toMatchObject({ status: 'succeeded', attempts: 1 });
    const reindex = await runIridiumCli(['reindex', '--stale', '--json'], {
      env,
      timeoutMs: 30_000,
    });
    expectCode(reindex);
    expect(Job.parse(JSON.parse(reindex.stdout)).status).toBe('succeeded');
    const verify = await runIridiumCli(['audit', 'verify-chain', '--json'], {
      env,
      timeoutMs: 30_000,
    });
    expectCode(verify);
    expect(z.object({ ok: z.boolean() }).parse(JSON.parse(verify.stdout)).ok).toBe(true);
  });
  it('reports exit 3 when the active owner lacks the DDL credential even if the CLI holds it', async () => {
    const harness = await startCollab({
      extraEnv: { JOBS_ENABLED: 'false', DATABASE_MIGRATE_URL: '', DATABASE_MIGRATE_PASSWORD: '' },
    });
    try {
      const result = await runIridiumCli(['audit', 'archive', '--json'], {
        env: cliEnv(harness.server.origin),
        timeoutMs: 30_000,
      });
      expectCode(result, 3);
      expect(Job.parse(JSON.parse(result.stdout)).result?.['status']).toBe(
        'skipped_no_ddl_credential',
      );
      expect(result.stderr).toContain('DATABASE_MIGRATE_URL');
    } finally {
      await harness.close();
    }
  });
  it('audits queued cancellation through the CLI without taking the serving lease', async () => {
    const clock = new ManualClock(Date.now());
    const harness = await startCollab({ clock, extraEnv: { JOBS_ENABLED: 'false' } });
    try {
      const app = harness.application();
      const generation = app.collab.ownerLease.captureGeneration();
      const queued = await app.jobs.scheduler.enqueue(
        'revision_thinning',
        {},
        { ownerFence: app.collab.ownerLease.captureFence() },
      );
      const result = await harness.server.cli(['jobs', 'cancel', '--id', queued.id, '--json']);
      expectCode(result);
      expect(Job.parse(JSON.parse(result.stdout)).status).toBe('cancelled');
      expect(app.collab.ownerLease.captureGeneration()).toBe(generation);
      expect(
        await appDb(app)
          .selectFrom('audit_events')
          .select('credential_type')
          .where('action', '=', 'admin.job.cancelled')
          .execute(),
      ).toEqual([{ credential_type: 'cli' }]);
    } finally {
      await harness.close();
    }
  });
  it('stops a running DDL job at its next real checkpoint after CLI cancellation', async () => {
    const clock = new ManualClock(Date.now());
    const cleanupTime = clock.now();
    const harness = await startCollab({ clock, extraEnv: { JOBS_ENABLED: 'false' } });
    const app = harness.application();
    const locked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const held = appDb(app)
      .transaction()
      .execute(async (trx) => {
        // This real read transaction holds MySQL's table metadata lock, so the production ALTER
        // waits without a mocked executor or a fabricated running jobs row.
        await trx.selectFrom('access_log').select('id').limit(1).execute();
        locked.resolve();
        await release.promise;
      });
    let work: Promise<void> | null = null;
    try {
      await locked.promise;
      clock.jump(clock.now() + 400 * 86_400_000);
      const job = await app.jobs.scheduler.enqueue(
        'access_log_partitions',
        {},
        { ownerFence: app.collab.ownerLease.captureFence() },
      );
      work = app.jobs.scheduler.runQueuedOnce();
      await expect.poll(async () => (await app.jobs.scheduler.get(job.id)).status).toBe('running');
      const cancelled = await harness.server.cli(['jobs', 'cancel', '--id', job.id, '--json']);
      expectCode(cancelled);
      expect(Job.parse(JSON.parse(cancelled.stdout)).status).toBe('cancelled');
      release.resolve();
      await held;
      await work;
      expect(await app.jobs.scheduler.get(job.id)).toMatchObject({
        status: 'cancelled',
        attempts: 1,
      });
      expect(harness.logs.some((line) => line.includes('job.cancelled'))).toBe(true);
    } finally {
      release.resolve();
      await held;
      await work;
      clock.jump(cleanupTime);
      await harness.close();
    }
  });
});
