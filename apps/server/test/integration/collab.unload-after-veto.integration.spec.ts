import { NoteId } from '@iridium/contracts';
import { describe, expect, it } from 'vitest';

import { idBytes } from '../../src/auth/ids.ts';
import { startCollab } from '../support/collab-harness.ts';

describe('collab.unload-after-veto.integration [hp:HP-2]', () => {
  it('retains a disconnected document while its real write is blocked and completes the veto after COMMIT', async () => {
    const harness = await startCollab({
      collab: { debounceMs: 10, maxDebounceMs: 50, compactionAwaitTimeoutMs: 1_000 },
    });
    const release = Promise.withResolvers<void>();
    let lock: Promise<void> | null = null;
    try {
      const cast = await harness.server.seed.kernel();
      const client = await harness.open(cast.editorA, cast.note.id);
      await client.waitFor('saved');
      const app = harness.application();
      const db = app.database.dbApp;
      if (db === null) throw new Error('The real app database must be connected.');
      const acquired = Promise.withResolvers<void>();
      lock = db.transaction().execute(async (transaction) => {
        await transaction
          .selectFrom('note_docs')
          .select('head_seq')
          .where('note_id', '=', idBytes(cast.note.id))
          .forUpdate()
          .executeTakeFirstOrThrow();
        acquired.resolve();
        await release.promise;
      });
      await acquired.promise;
      const marker = client.marker('veto');
      const writer = app.collab.persistence.writerOf(NoteId.parse(cast.note.id));
      const document = app.collab.server.hocuspocus.documents.get(client.documentName);
      if (writer === undefined || document === undefined)
        throw new Error('A synced note must own its writer and document.');
      await expect.poll(() => writer.inFlight && writer.queueLength > 0).toBe(true);
      await client.close();
      await expect.poll(() => document.getConnectionsCount()).toBe(0);
      await expect(
        app.collab.server.hocuspocus.hooks('beforeUnloadDocument', {
          instance: app.collab.server.hocuspocus,
          documentName: client.documentName,
          document,
        }),
      ).rejects.toMatchObject({ name: 'UnloadVeto' });
      expect(writer.unloadRequested).toBe(true);
      expect(app.collab.server.hocuspocus.documents.has(client.documentName)).toBe(true);
      release.resolve();
      await lock;
      await expect
        .poll(() => app.collab.server.hocuspocus.documents.has(client.documentName), {
          timeout: 15_000,
        })
        .toBe(false);
      expect(writer.state).toBe('disposed');
      expect(app.collab.persistence.writerOf(NoteId.parse(cast.note.id))).toBeUndefined();
      const durable = await harness.committed(cast.note.id);
      expect(durable.text).toContain(marker);
      const checkpoint = await db
        .selectFrom('note_revisions')
        .select('seq')
        .where('note_id', '=', idBytes(cast.note.id))
        .where('seq', '=', durable.head)
        .execute();
      expect(checkpoint).toHaveLength(1);
    } finally {
      release.resolve();
      await lock;
      await harness.close();
    }
  });

  it('creates the missing head checkpoint before completing a revision veto', async () => {
    const harness = await startCollab({ collab: { debounceMs: 60_000, maxDebounceMs: 60_000 } });
    try {
      const cast = await harness.server.seed.kernel();
      const client = await harness.open(cast.editorA, cast.note.id);
      await client.waitFor('saved');
      client.marker('checkpoint-veto');
      await client.waitFor('saved');
      const app = harness.application();
      const writer = app.collab.persistence.writerOf(NoteId.parse(cast.note.id));
      if (writer === undefined) throw new Error('A synced note must own a writer.');
      expect(
        await app.collab.persistence.store.revisionExistsAt(
          NoteId.parse(cast.note.id),
          writer.lastCommittedSeq,
        ),
      ).toBe(false);
      expect(await writer.unloadVeto()).not.toBeNull();
      await client.close();
      await expect.poll(() => app.collab.server.loadedDocuments()).toEqual([]);
      expect(writer.state).toBe('disposed');
      expect(
        await app.collab.persistence.store.revisionExistsAt(
          NoteId.parse(cast.note.id),
          writer.lastCommittedSeq,
        ),
      ).toBe(true);
    } finally {
      await harness.close();
    }
  });
});
