/** Archive actual signed rows and independently verify both compressed export and retained chain. */
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

import { inspectArchiveSession } from '@iridium/testkit';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { listChainIds, verifyChain } from '../../src/audit/chain.ts';
import { createAuditKeys, readPromotedAuditKeyVersion } from '../../src/audit/keys.ts';
import { createMaintDb } from '../../src/db/migrator.ts';
import { withArchiveConnection } from '../../src/jobs/archive.ts';
import { appDb } from '../../src/rest/handler-context.ts';
import { startCollab } from '../support/collab-harness.ts';
import { ManualClock } from '../support/manual-clock.ts';

describe('audit.archive.integration [area:audit]', () => {
  it('resets the session archive guard on the same reusable physical connection after failure', async () => {
    const harness = await startCollab({ extraEnv: { JOBS_ENABLED: 'false' } });
    const url = harness.application().iridiumConfig.db.migrateUrl;
    if (url === null) throw new Error('The fixture requires its actual migrator role.');
    const maintenance = createMaintDb(url);
    let connectionId = 0;
    try {
      await expect(
        withArchiveConnection(maintenance.pool, async (db) => {
          const during = await inspectArchiveSession(db);
          connectionId = during.rows[0]?.id ?? 0;
          expect(during.rows[0]?.flag).toBe(1);
          throw new Error('Deliberate export failure before archive mutation');
        }),
      ).rejects.toThrow('Deliberate export failure');
      const after = await inspectArchiveSession(maintenance.db);
      expect(after.rows[0]).toEqual({ id: connectionId, flag: 0 });
    } finally {
      await maintenance.db.destroy();
      await harness.close();
    }
  });
  it('exports before moving a signed prefix and leaves a verifiable archive boundary and idempotent rerun', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'iridium-archive-proof-'));
    const clock = new ManualClock(Date.now());
    const cleanupTime = clock.now();
    const harness = await startCollab({
      clock,
      extraEnv: { JOBS_ENABLED: 'false', AUDIT_ARCHIVE_EXPORT_DIR: directory },
    });
    try {
      await harness.server.seed.kernel();
      const app = harness.application();
      const db = appDb(app);
      const initial = await db
        .selectFrom('audit_events')
        .select((eb) => eb.fn.countAll<number | string>().as('count'))
        .executeTakeFirstOrThrow();
      expect(Number(initial.count)).toBeGreaterThan(0);
      clock.jump(clock.now() + 401 * 86_400_000);
      const job = await app.jobs.scheduler.enqueue(
        'audit_archive',
        {},
        {
          ownerFence: app.collab.ownerLease.captureFence(),
          actor: {
            userId: null,
            sessionId: null,
            displayName: 'archive proof',
            context: { client: 'cli' },
          },
        },
      );
      const completed = await app.jobs.scheduler.runUntilSettled(job.id);
      expect(completed.status).toBe('succeeded');
      expect(completed.result?.['rows']).toBe(Number(initial.count));
      const archive = await db
        .selectFrom('audit_events_archive')
        .select((eb) => eb.fn.countAll<number | string>().as('count'))
        .executeTakeFirstOrThrow();
      expect(Number(archive.count)).toBe(Number(initial.count));
      const events = await db
        .selectFrom('audit_events')
        .select(['metadata'])
        .where('action', '=', 'system.audit.archived')
        .execute();
      expect(events.length).toBeGreaterThan(0);
      for (const event of events) {
        const path = event.metadata?.['export_path'];
        const digest = event.metadata?.['export_sha256'];
        expect(typeof path).toBe('string');
        if (typeof path !== 'string') throw new Error('Archive event omitted its export path.');
        // eslint-disable-next-line no-await-in-loop -- verify one exported chain at a time with bounded database work
        const compressed = await readFile(path);
        expect(createHash('sha256').update(compressed).digest('hex')).toBe(digest);
        const exported = zstdDecompressSync(compressed)
          .toString('utf8')
          .trim()
          .split('\n')
          .map((line) => z.record(z.string(), z.unknown()).parse(JSON.parse(line)));
        expect(exported.length).toBeGreaterThan(0);
        expect(exported[0]).toHaveProperty('prev_hash');
        expect(exported[0]).toHaveProperty('hash');
        expect(exported[0]).toHaveProperty('id');
      }
      const keys = createAuditKeys({
        keyring: app.iridiumConfig.keys.auditHmac,
        signingVersion: await readPromotedAuditKeyVersion(db),
      });
      for (const chain of await listChainIds(db))
        // eslint-disable-next-line no-await-in-loop -- verify one exported chain at a time with bounded database work
        expect((await verifyChain(db, chain, keys)).ok).toBe(true);
      const again = await app.jobs.scheduler.enqueue(
        'audit_archive',
        {},
        { ownerFence: app.collab.ownerLease.captureFence() },
      );
      expect((await app.jobs.scheduler.runUntilSettled(again.id)).result?.['rows']).toBe(0);
    } finally {
      clock.jump(cleanupTime);
      await harness.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
