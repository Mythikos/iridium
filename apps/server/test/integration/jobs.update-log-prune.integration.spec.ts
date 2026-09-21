import { getContent, projectMarkdown } from '@iridium/crdt';
import { describe, expect, it } from 'vitest';

import { connectionOrigin } from '../../src/collab/persistence/testing/fake-document.ts';
import { startDatabaseModel } from '../support/persistence-model.ts';
import { pruneUpdateLog } from '../support/prune-updates.ts';

describe('jobs.update-log-prune.integration [area:jobs]', () => {
  it('consumes the configured retention, excludes concurrent invocations, and keeps a bounded recoverable tail', async () => {
    const fixture = await startDatabaseModel({ extraEnv: { UPDATE_LOG_RETENTION_DAYS: '2' } });
    const real = await fixture.create('seed');
    try {
      real.document.transact(
        () => getContent(real.document).insert(0, 'covered'),
        connectionOrigin(real.connections[0]),
      );
      await real.writer.drain();
      await real.persistence.compactNow(real.noteId, { trigger: 'flush' });
      real.document.transact(
        () => getContent(real.document).insert(0, 'tail'),
        connectionOrigin(real.connections[0]),
      );
      await real.writer.drain();
      fixture.context.clock.jump(fixture.context.clock.now() + 2 * 86_400_000);
      expect(await fixture.context.app.jobs.run('update_log_prune')).toEqual({
        status: 'complete',
        removed: 0,
      });
      fixture.context.clock.jump(fixture.context.clock.now() + 1);
      // One transaction and one row proves the complete invocation's bound independently of LIMIT.
      expect(
        await pruneUpdateLog({
          db: fixture.context.db,
          now: fixture.context.clock.date(),
          retentionDays: 2,
          noteId: real.noteId,
          batchSize: 1,
          maxBatches: 1,
        }),
      ).toBe(1);
      expect((await real.view()).updates.map((row) => row.seq)).toEqual([2, 3]);
      const outcomes = await Promise.all([
        fixture.context.app.jobs.run('update_log_prune'),
        fixture.context.app.jobs.run('update_log_prune'),
      ]);
      expect(outcomes).toEqual([
        { status: 'complete', removed: 1 },
        { status: 'already-running', removed: 0 },
      ]);
      expect(await fixture.context.app.jobs.run('update_log_prune')).toEqual({
        status: 'complete',
        removed: 0,
      });
      expect((await real.view()).updates.map((row) => row.seq)).toEqual([3]);
      await real.reopen();
      expect(projectMarkdown(real.document)).toBe('tailcoveredseed');
    } finally {
      real.dispose();
      await fixture.stop();
    }
  });
});
