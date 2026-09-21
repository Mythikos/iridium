/** The shipped CLI rebuild keeps committed search readable and preserves incremental index bytes. */
import { idFromBytes, Job, SearchPage } from '@iridium/contracts';
import { describe, expect, it } from 'vitest';

import { idBytes } from '../../src/auth/ids.ts';
import { appDb } from '../../src/rest/handler-context.ts';
import { startCollab } from '../support/collab-harness.ts';
import { reindexClaimant } from '../support/reindex-claimant.ts';

describe('search.rebuild.integration [area:search]', () => {
  it('rebuilds through the real CLI without emptying the served index and matches incremental content byte for byte', async () => {
    const harness = await startCollab({
      extraEnv: { JOBS_ENABLED: 'false', REINDEX_RATE_PER_SECOND: '1' },
    });
    const successor = reindexClaimant(harness.application(), 'cli-rebuild-successor');
    const locked = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    let held: Promise<void> | undefined, command: ReturnType<typeof harness.server.cli> | undefined;
    try {
      const cast = await harness.server.seed.kernel(),
        app = harness.application(),
        db = appDb(app);
      const admin = await harness.server.loginAs(cast.admin);
      const ids: string[] = [];
      for (const name of ['One', 'Two', 'Three']) {
        // eslint-disable-next-line no-await-in-loop -- committed product writes define the independent incremental baseline
        const note = await harness.server.seed.note({
          vault: cast.vault,
          name,
          markdown: `---\naliases: ["${name} alias"]\n---\n# ${name} 😀\nrebuildneedle **source** ${name}\nline two`,
        });
        ids.push(note.id);
      }
      const read = () =>
        db
          .selectFrom('note_search')
          .selectAll()
          .where('vault_id', '=', idBytes(cast.vault.id))
          .orderBy('note_id')
          .execute();
      const incremental = await read();
      const search = async () =>
        SearchPage.parse(
          (await admin.get(`/vaults/${cast.vault.id}/search`, { query: { q: 'rebuildneedle' } }))
            .body,
        );
      const before = await search();
      expect(new Set(before.results.map((row) => row.noteId))).toEqual(new Set(ids));
      const first = ids.toSorted()[0];
      if (first === undefined) throw new Error('The rebuild fixture requires its first note.');
      held = db.transaction().execute(async (trx) => {
        await trx
          .selectFrom('note_projections')
          .select('note_id')
          .where('note_id', '=', idBytes(first))
          .forUpdate()
          .executeTakeFirstOrThrow();
        locked.resolve();
        await release.promise;
      });
      await locked.promise;
      command = harness.server.cli(['reindex', '--vault', cast.vault.id, '--json']);
      await expect
        .poll(
          async () =>
            await db
              .selectFrom('jobs')
              .select(['status', 'error', 'attempts'])
              .where('type', '=', 'reindex')
              .executeTakeFirst(),
          // Includes startup of the actual CLI process and the documented scheduler poll cadence.
          { timeout: 10_000 },
        )
        .toMatchObject({ status: 'running' });
      await expect
        .poll(
          async () =>
            (
              await db
                .selectFrom('jobs')
                .select('progress')
                .where('type', '=', 'reindex')
                .executeTakeFirst()
            )?.progress?.done,
        )
        .toBe(1);
      expect(await read()).toEqual(incremental);
      expect((await search()).results).toEqual(before.results);
      // Stop the real producer while the next unit is behind the SQL lock. Its durable cursor
      // survives, and a fresh claimant drives the same CLI request to completion.
      const stopping = app.jobs.scheduler.stop();
      release.resolve();
      await held;
      await stopping;
      const interrupted = await db
        .selectFrom('jobs')
        .select(['id', 'status', 'progress'])
        .where('type', '=', 'reindex')
        .executeTakeFirstOrThrow();
      expect(interrupted).toMatchObject({ status: 'queued', progress: { done: 1 } });
      expect(await read()).toEqual(incremental);
      expect((await successor.runUntilSettled(idFromBytes(interrupted.id))).status).toBe(
        'succeeded',
      );
      const completed = await command;
      expect({ code: completed.code, error: completed.code === 0 ? '' : completed.stderr }).toEqual(
        { code: 0, error: '' },
      );
      expect(Job.parse(JSON.parse(completed.stdout))).toMatchObject({
        status: 'succeeded',
        result: { rebuilt: incremental.length - 1, processed: incremental.length },
      });
      expect(await read()).toEqual(incremental);
      expect((await search()).results).toEqual(before.results);
    } finally {
      release.resolve();
      await held;
      await successor.stop();
      await harness.close();
      await command;
    }
  });
});
