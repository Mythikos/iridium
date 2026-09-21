/** Retention is driven by product writes and the injected clock, never pre-aged SQL fixtures. */
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Node } from '@iridium/contracts';
import { describe, expect, it } from 'vitest';

import { idBytes } from '../../src/auth/ids.ts';
import { appDb } from '../../src/rest/handler-context.ts';
import { startCollab } from '../support/collab-harness.ts';
import { ManualClock } from '../support/manual-clock.ts';

describe('jobs.retention.integration [area:jobs]', () => {
  it('preserves distinct actual flushed states and the protected create revision across thinning', async () => {
    const clock = new ManualClock(Date.now());
    const cleanupTime = clock.now();
    const harness = await startCollab({ clock, extraEnv: { JOBS_ENABLED: 'false' } });
    try {
      const cast = await harness.server.seed.kernel();
      const editor = await harness.server.loginAs(cast.editorA);
      const created = await editor.post(`/vaults/${cast.vault.id}/nodes`, {
        json: {
          kind: 'note',
          parentId: cast.vault.rootNodeId,
          name: 'Retention',
          markdown: 'seed',
        },
      });
      expect(created.status).toBe(201);
      const note = Node.parse(created.body);
      const client = await harness.open(cast.editorA, note.id);
      await client.waitSynced();
      const app = harness.application();
      const db = appDb(app);
      for (let index = 0; index < 3; index += 1) {
        clock.jump(clock.now() + 10 * 60_000);
        const acknowledged = client.waitForAck();
        client.typeAt(client.text.length, ` checkpoint${String(index)}`);
        // eslint-disable-next-line no-await-in-loop -- the next revision must follow the preceding durable checkpoint
        await acknowledged;
        const projected = client.waitForStateless('projected');
        client.sendStateless({ v: 1, t: 'flush' });
        // eslint-disable-next-line no-await-in-loop -- the next revision must follow the preceding durable checkpoint
        await projected;
      }
      const before = await db
        .selectFrom('note_revisions')
        .select(['id', 'kind', 'seq'])
        .where('note_id', '=', idBytes(note.id))
        .orderBy('id')
        .execute();
      const newest = before.findLast((row) => row.kind === 'checkpoint');
      expect(newest).toBeDefined();
      expect(before.filter((row) => row.kind === 'checkpoint')).toHaveLength(3);
      clock.jump(clock.now() + 31 * 86_400_000);
      const job = await app.jobs.scheduler.enqueue(
        'revision_thinning',
        {},
        { ownerFence: app.collab.ownerLease.captureFence() },
      );
      const done = await app.jobs.scheduler.runUntilSettled(job.id);
      expect(done.status).toBe('succeeded');
      expect(done.result?.['removed']).toBe(0);
      const after = await db
        .selectFrom('note_revisions')
        .select(['id', 'kind', 'seq'])
        .where('note_id', '=', idBytes(note.id))
        .orderBy('id')
        .execute();
      expect(after.filter((row) => row.kind === 'checkpoint')).toEqual(
        before.filter((row) => row.kind === 'checkpoint'),
      );
      expect(after.filter((row) => row.kind === 'create')).toEqual(
        before.filter((row) => row.kind === 'create'),
      );
      const repeat = await app.jobs.scheduler.enqueue(
        'revision_thinning',
        {},
        { ownerFence: app.collab.ownerLease.captureFence() },
      );
      expect((await app.jobs.scheduler.runUntilSettled(repeat.id)).result?.['removed']).toBe(0);
    } finally {
      // Return to the timer epoch before draining; the age jump intentionally did not run timers.
      clock.jump(cleanupTime);
      await harness.close();
    }
  });
  it('expires credential rows and only aged temporary files while retaining immutable attachment content', async () => {
    const clock = new ManualClock(Date.now());
    const cleanupTime = clock.now();
    const directory = await mkdtemp(join(tmpdir(), 'iridium-retention-proof-'));
    const harness = await startCollab({
      clock,
      attachmentsDir: directory,
      extraEnv: { JOBS_ENABLED: 'false' },
    });
    try {
      await harness.server.seed.kernel();
      const app = harness.application();
      const db = appDb(app);
      const sessions = await db.selectFrom('sessions').select('id').execute();
      expect(sessions.length).toBeGreaterThan(0);
      await mkdir(join(directory, '.tmp'));
      await writeFile(join(directory, '.tmp', 'expired'), 'old');
      await writeFile(join(directory, '.tmp', 'current'), 'new');
      await writeFile(join(directory, 'immutable-proof'), 'retain');
      await utimes(
        join(directory, '.tmp', 'expired'),
        new Date(clock.now() - 3_600_001),
        new Date(clock.now() - 3_600_001),
      );
      await utimes(join(directory, '.tmp', 'current'), clock.date(), clock.date());
      const cleanup = await app.jobs.scheduler.enqueue(
        'transfer_cleanup',
        {},
        { ownerFence: app.collab.ownerLease.captureFence() },
      );
      const cleaned = await app.jobs.scheduler.runUntilSettled(cleanup.id);
      expect(cleaned.status).toBe('succeeded');
      expect(cleaned.result?.['temporary']).toBe(1);
      expect(await readFile(join(directory, '.tmp', 'current'), 'utf8')).toBe('new');
      expect(await readFile(join(directory, 'immutable-proof'), 'utf8')).toBe('retain');
      await expect(readFile(join(directory, '.tmp', 'expired'))).rejects.toHaveProperty(
        'code',
        'ENOENT',
      );
      clock.jump(clock.now() + 366 * 86_400_000);
      const sweep = await app.jobs.scheduler.enqueue(
        'session_ticket_sweep',
        {},
        { ownerFence: app.collab.ownerLease.captureFence() },
      );
      const swept = await app.jobs.scheduler.runUntilSettled(sweep.id);
      expect(swept.status).toBe('succeeded');
      expect(swept.result?.['sessions']).toBe(sessions.length);
      expect(
        await db
          .selectFrom('sessions')
          .select('id')
          .where(
            'id',
            'in',
            sessions.map((row) => row.id),
          )
          .execute(),
      ).toEqual([]);
    } finally {
      clock.jump(cleanupTime);
      await harness.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
