/** Real binary capture, worker preparation and SQL publication, including deliberately late work. */
import { NoteId, type JobProgress } from '@iridium/contracts';
import { PIPELINE_VERSION } from '@iridium/markdown';
import { describe, expect, it } from 'vitest';

import { idBytes } from '../../src/auth/ids.ts';
import { lockNoteParents } from '../../src/notes/lock-parents.ts';
import { contentHash } from '../../src/projection/hash.ts';
import { lockProjectionVault } from '../../src/projection/lock-vault.ts';
import { ReindexService, type ReindexContext } from '../../src/projection/reindex.ts';
import { upsertProjection } from '../../src/projection/write.ts';
import { startCollab } from '../support/collab-harness.ts';

describe('projection.monotonic.integration [area:projection]', () => {
  it('publishes all derived rows atomically, refuses a late older job, and advances the watermark only after publication', async () => {
    const harness = await startCollab({ collab: { debounceMs: 60_000, maxDebounceMs: 60_000 } });
    try {
      const admin = await harness.server.seed.admin();
      const vault = await harness.server.seed.vault({ name: 'Projection ordering' });
      const target = await harness.server.seed.note({
        vault,
        name: 'Target',
        markdown: 'Destination',
      });
      const note = await harness.server.seed.note({
        vault,
        name: 'Source',
        markdown: '# Source\n',
      });
      const client = await harness.open(admin, note.id);
      await client.waitFor('saved');
      client.typeAt(client.text.length, '[first](Target.md)\n');
      await client.waitFor('saved');
      const older = await harness.committed(note.id);
      const app = harness.application();
      const db = app.database.dbApp;
      if (db === null) throw new Error('Expected the real application database');
      const owner = app.collab.ownerLease.captureFence();
      const progress: JobProgress[] = [];
      const context: ReindexContext = {
        ownerFence: owner,
        progress: null,
        assertActive: async () => owner.assertActive(),
        checkpoint: async (value) => {
          progress.push(value);
        },
      };
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const delayed = new ReindexService({
        searchIndex: app.searchIndex,
        database: () => db,
        clock: app.clock,
        ratePerSecond: 20,
        drainAccepted: async (id) => {
          await app.collab.persistence.writerOf(id)?.drainAccepted();
        },
        projected: () => {},
        prepare: async (markdown) => {
          entered.resolve();
          await release.promise;
          return app.notes.prepare(markdown);
        },
      });
      const late = delayed.run({ noteIds: [note.id] }, context);
      await entered.promise;
      client.typeAt(client.text.length, '[second](Target.md)\n');
      await client.waitFor('saved');
      const current = await harness.committed(note.id);
      expect(current.head).toBeGreaterThan(older.head);
      expect(current.projected).toBeLessThan(current.head);
      try {
        await app.reindexService.run({ noteIds: [note.id] }, context);
      } finally {
        release.resolve();
      }
      expect(await late).toMatchObject({ rebuilt: 0, skipped: 1 });
      const read = () =>
        db
          .transaction()
          .setIsolationLevel('repeatable read')
          .execute(async (trx) => ({
            projection: await trx
              .selectFrom('note_projections')
              .selectAll()
              .where('note_id', '=', idBytes(note.id))
              .executeTakeFirstOrThrow(),
            search: await trx
              .selectFrom('note_search')
              .selectAll()
              .where('note_id', '=', idBytes(note.id))
              .executeTakeFirstOrThrow(),
            links: await trx
              .selectFrom('note_links')
              .selectAll()
              .where('from_note_id', '=', idBytes(note.id))
              .orderBy('ordinal')
              .execute(),
            head: await trx
              .selectFrom('note_docs')
              .select(['head_seq', 'projected_seq'])
              .where('note_id', '=', idBytes(note.id))
              .executeTakeFirstOrThrow(),
          }));
      const committed = await read();
      expect(committed.projection).toMatchObject({
        revision: current.head,
        markdown: current.text,
        heading_title: 'Source',
        status: 'ok',
      });
      expect(committed.projection.content_hash).toEqual(contentHash(current.text));
      expect(committed.search).toMatchObject({ revision: current.head, title: 'Source' });
      expect(committed.links).toHaveLength(2);
      expect(
        committed.links.every(
          (link) =>
            link.revision === current.head && link.resolved_node_id?.equals(idBytes(target.id)),
        ),
      ).toBe(true);
      expect(committed.head.projected_seq).toBe(current.head);
      expect(progress.every((value) => value.done === 1)).toBe(true);

      client.typeAt(client.text.length, '[third](Target.md)\n');
      await client.waitFor('saved');
      const next = await harness.committed(note.id);
      const prepared = await app.notes.prepare(next.text);
      const staged = Promise.withResolvers<void>();
      const rollback = Promise.withResolvers<void>();
      const failure = new Error('projection rollback proof');
      const publication = db
        .transaction()
        .execute(async (trx) => {
          await owner.assertCurrent(trx);
          await lockProjectionVault(trx, idBytes(vault.id));
          await lockNoteParents(trx, idBytes(note.id));
          await trx
            .selectFrom('note_docs')
            .select('head_seq')
            .where('note_id', '=', idBytes(note.id))
            .forUpdate()
            .execute();
          await upsertProjection(
            trx,
            {
              noteId: idBytes(note.id),
              revision: next.head,
              markdown: next.text,
              contentHash: contentHash(next.text),
              pipelineVersion: PIPELINE_VERSION,
              prepared,
              now: app.clock.date(),
              strict: true,
            },
            app.searchIndex,
          );
          staged.resolve();
          await rollback.promise;
          throw failure;
        })
        .then(
          () => null,
          (error: unknown) => error,
        );
      await staged.promise;
      try {
        const invisible = await read();
        expect(invisible.projection).toEqual(committed.projection);
        expect(invisible.search).toEqual(committed.search);
        expect(invisible.links).toEqual(committed.links);
        expect(invisible.head.projected_seq).toBe(current.head);
      } finally {
        rollback.resolve();
      }
      expect(await publication).toBe(failure);
      expect((await read()).projection).toEqual(committed.projection);
      await app.reindexService.run({ noteIds: [note.id] }, context);
      const rebuilt = await read();
      expect(rebuilt.head.projected_seq).toBe(next.head);
      expect(rebuilt.links).toHaveLength(3);
      expect(rebuilt.search.revision).toBe(rebuilt.projection.revision);
      expect(client.text.toJSON()).toBe(next.text);
      expect(app.collab.persistence.writerOf(NoteId.parse(note.id))?.lastCommittedSeq).toBe(
        next.head,
      );
    } finally {
      await harness.close();
    }
  });
});
