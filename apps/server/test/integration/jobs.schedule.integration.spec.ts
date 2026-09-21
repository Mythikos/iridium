/** Durable schedule discovery uses the production plugin and real owner lease. */
import { idFromBytes } from '@iridium/contracts';
import { PIPELINE_VERSION } from '@iridium/markdown';
import { describe, expect, it } from 'vitest';

import { JOB_SCHEDULE } from '../../src/jobs/schedule.ts';
import { appDb } from '../../src/rest/handler-context.ts';
import { startCollab } from '../support/collab-harness.ts';
import { ManualClock } from '../support/manual-clock.ts';

describe('jobs.schedule.integration [area:jobs]', () => {
  it('discovers each due job once and enqueues stale reindex again on the next UTC hour', async () => {
    const clock = new ManualClock(Date.now());
    const cleanupTime = clock.now();
    const harness = await startCollab({ clock, extraEnv: { JOBS_ENABLED: 'true' } });
    try {
      const app = harness.application();
      const db = appDb(app);
      const marker = await db
        .selectFrom('schema_meta')
        .select('value')
        .where('key', '=', 'pipeline_version')
        .executeTakeFirstOrThrow();
      await app.jobs.tick();
      const initial = await db.selectFrom('jobs').select(['id', 'type', 'payload']).execute();
      expect(initial.map((row) => row.type).toSorted()).toEqual(
        JOB_SCHEDULE.map((row) => row.type).toSorted(),
      );
      const reindex = initial.find((row) => row.type === 'reindex');
      expect(reindex?.payload).toEqual(
        Number(marker.value) < PIPELINE_VERSION ? { pipelineVersion: true } : { stale: true },
      );
      if (reindex === undefined) throw new Error('The due reindex job was not discovered.');
      expect((await app.jobs.scheduler.runUntilSettled(idFromBytes(reindex.id))).status).toBe(
        'succeeded',
      );
      await app.jobs.tick();
      expect(
        await db.selectFrom('jobs').select('id').where('type', '=', 'reindex').execute(),
      ).toHaveLength(1);
      clock.jump(clock.now() + 3_600_000);
      await app.jobs.tick();
      const next = await db
        .selectFrom('jobs')
        .select(['id', 'payload'])
        .where('type', '=', 'reindex')
        .execute();
      expect(next).toHaveLength(2);
      expect(next.filter((row) => !row.id.equals(reindex.id)).map((row) => row.payload)).toEqual([
        { stale: true },
      ]);
    } finally {
      clock.jump(cleanupTime);
      await harness.close();
    }
  });
});
