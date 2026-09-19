/** The wired in-process drain owns pending writers through unload and lease release. */
import { NoteId } from '@iridium/contracts';
import { describe, expect, it } from 'vitest';

import { idBytes } from '../../src/auth/ids.ts';
import { startCollab } from '../support/collab-harness.ts';

describe('shutdown.drain.integration [area:ops]', () => {
  it('fences admission, commits pending edits, unloads at the head and then releases its lease', async () => {
    const harness = await startCollab({ collab: { debounceMs: 60_000, maxDebounceMs: 60_000 } });
    const release = Promise.withResolvers<void>();
    let locked: Promise<void> | undefined;
    let drained: Promise<void> | undefined;
    try {
      const cast = await harness.server.seed.kernel();
      const client = await harness.open(cast.editorA, cast.note.id);
      await client.waitFor('saved');
      const app = harness.application();
      const db = app.database.dbApp;
      if (db === null) throw new Error('Drain requires the real database.');
      const acquired = Promise.withResolvers<void>();
      locked = db.transaction().execute(async (trx) => {
        await trx
          .selectFrom('note_docs')
          .select('head_seq')
          .where('note_id', '=', idBytes(cast.note.id))
          .forUpdate()
          .executeTakeFirstOrThrow();
        acquired.resolve();
        await release.promise;
      });
      await acquired.promise;
      const writer = app.collab.persistence.writerOf(NoteId.parse(cast.note.id));
      const closing = client.waitForStateless('closing');
      const marker = client.marker('pending-at-drain');
      await expect.poll(() => writer?.queueLength ?? 0).toBeGreaterThan(0);
      drained = app.drain();
      expect(await closing).toMatchObject({ reason: 'shutdown' });
      expect((await harness.server.rest().request('GET', '/readyz')).status).toBe(503);
      expect((await harness.server.rest().get('/meta')).status).toBe(503);
      expect(app.collab.ownerLease.held).toBe(true);
      expect(await harness.committed(cast.note.id)).not.toMatchObject({
        text: expect.stringContaining(marker),
      });
      release.resolve();
      await locked;
      await drained;
      const durable = await harness.committed(cast.note.id);
      expect(durable.text).toContain(marker);
      expect(durable.projected).toBe(durable.head);
      expect(app.collab.server.loadedDocuments()).toEqual([]);
      expect(app.collab.persistence.writerOf(NoteId.parse(cast.note.id))).toBeUndefined();
      expect(app.collab.ownerLease.held).toBe(false);
      expect(
        await db
          .selectFrom('note_revisions')
          .select('seq')
          .where('note_id', '=', idBytes(cast.note.id))
          .where('seq', '=', durable.head)
          .execute(),
      ).toHaveLength(1);
      await expect(app.drain()).resolves.toBeUndefined();
    } finally {
      release.resolve();
      await locked;
      await drained;
      await harness.close();
    }
  });
});
