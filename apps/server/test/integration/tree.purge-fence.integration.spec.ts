/** Purge waits for real writers outside the structural lock, then revalidates the admitted trash. */
import { NoteId, type Node } from '@iridium/contracts';
import { FAULT } from '@iridium/testkit';
import { describe, expect, it } from 'vitest';

import { idBytes } from '../../src/auth/ids.ts';
import { CLOSING_GRACE_MS } from '../../src/collab/gateway.ts';
import { BACKOFF_CEILING_MS } from '../../src/collab/persistence/backoff.ts';
import { waitFault } from '../support/collab-chaos.ts';
import { startCollab } from '../support/collab-harness.ts';
import { ManualClock } from '../support/manual-clock.ts';

describe('tree.purge-fence.integration [area:tree] [spec:structural-concurrency]', () => {
  it('synchronously stops a queued pre-trash writer before a concurrent restore can revive it', async () => {
    const clock = new ManualClock();
    const harness = await startCollab({
      clock,
      extraEnv: { JOBS_ENABLED: 'false' },
      collab: { debounceMs: 60_000, maxDebounceMs: 60_000 },
    });
    const app = harness.application();
    const close = app.notes.closeNote.bind(app.notes);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let releaseTrash: (() => Promise<void>) | undefined;
    let pendingTrash: Promise<unknown> | undefined;
    let pendingPurge: Promise<unknown> | undefined;
    try {
      const cast = await harness.server.seed.kernel();
      const noteId = NoteId.parse(cast.note.id);
      const client = await harness.open(cast.editorA, noteId);
      await client.waitFor('saved');
      const writer = app.collab.persistence.writerOf(noteId);
      if (writer === undefined) throw new Error('The connected note must own a real writer.');
      const before = await harness.committed(noteId);
      app.faults.arm({ point: 'store.throw', count: 1 });
      const pendingMarker = client.marker('queued-before-missed-trash-delivery');
      await expect.poll(() => writer.state).toBe('retrying');
      expect(writer.queueLength).toBe(1);
      expect((await harness.committed(noteId)).text).toBe(before.text);
      const withheld = await harness.server.faults.arm(FAULT.treeHoldAfterCommitBeforeNotify);
      releaseTrash = () => withheld.disarm();
      const offset = harness.logs.length;
      const trash = cast.admin.client.post(`/nodes/${noteId}/trash`, { ifMatch: 1, json: {} });
      pendingTrash = trash;
      await waitFault(harness, FAULT.treeHoldAfterCommitBeforeNotify, offset);
      expect(writer.state).toBe('retrying');
      expect(writer.queueLength).toBe(1);
      expect(client.stateless.filter((message) => message.t === 'closing')).toEqual([]);
      // Hold only the close notification, after the synchronous admission fence must have run.
      // The retry queue, structural transactions and subsequent close all remain product code.
      app.notes.closeNote = async (id, reason) => {
        entered.resolve();
        await release.promise;
        await close(id, reason);
      };
      const purge = cast.admin.client.del(`/nodes/${noteId}?purge=true`, { ifMatch: 2 });
      pendingPurge = purge;
      await entered.promise;
      expect(writer.state).toBe('disposed');
      expect(writer.queueLength).toBe(0);
      const restored = await cast.admin.client.post(`/nodes/${noteId}/restore`, {
        ifMatch: 2,
        json: {},
      });
      expect(restored.status).toBe(200);
      await clock.advance(BACKOFF_CEILING_MS);
      expect(await harness.committed(noteId)).toEqual(before);
      expect(client.text.toJSON()).toContain(pendingMarker);
      const closed = client.waitClosed();
      release.resolve();
      expect((await closed).collabReason).toBe('note-closing');
      expect((await purge).status).toBe(409);
      await releaseTrash();
      releaseTrash = undefined;
      expect((await trash).status).toBe(200);
      expect(app.collab.gateway.isClosing(noteId)).toBe(false);
      const reopened = await harness.open(cast.editorB, noteId);
      await reopened.waitFor('saved');
      expect(reopened.text.toJSON()).toBe(before.text);
      expect(reopened.text.toJSON()).not.toContain(pendingMarker);
    } finally {
      release.resolve();
      await releaseTrash?.();
      await clock.advance(CLOSING_GRACE_MS);
      app.notes.closeNote = close;
      await harness.close();
      await Promise.allSettled([pendingPurge, pendingTrash]);
    }
  });

  it.each(['create', 'restore'] as const)(
    'permits a concurrent %s during writer disposal and applies the final validator',
    async (operation) => {
      const harness = await startCollab({ extraEnv: { JOBS_ENABLED: 'false' } });
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let pending: Promise<unknown> | undefined;
      const app = harness.application();
      const fence = app.collab.persistence.fenceNotes.bind(app.collab.persistence);
      let marked: NoteId | undefined;
      try {
        const cast = await harness.server.seed.kernel();
        const noteId = NoteId.parse(cast.note.id);
        const db = app.database.dbApp;
        if (db === null)
          throw new Error('The purge fixture requires its real application database.');
        const trashed = await cast.admin.client.post(`/nodes/${noteId}/trash`, {
          ifMatch: 1,
          json: {},
        });
        expect(trashed.status).toBe(200);
        const before = await harness.committed(noteId);
        // This gate surrounds the real disposal method; no writer or database response is replaced.
        app.collab.persistence.fenceNotes = async (noteIds) => {
          entered.resolve();
          await release.promise;
          await fence(noteIds);
        };
        app.collab.gateway.markClosing(noteId);
        marked = noteId;
        const purge = cast.admin.client.del(`/nodes/${noteId}?purge=true`, { ifMatch: 2 });
        pending = purge;
        await entered.promise;
        expect(app.collab.gateway.isClosing(noteId)).toBe(true);
        const concurrent =
          operation === 'restore'
            ? await cast.admin.client.post(`/nodes/${noteId}/restore`, { ifMatch: 2, json: {} })
            : await cast.admin.client.post<Node>(`/vaults/${cast.vault.id}/nodes`, {
                json: {
                  kind: 'category',
                  parentId: cast.vault.rootNodeId,
                  name: 'During disposal',
                },
              });
        expect(concurrent.status).toBe(operation === 'restore' ? 200 : 201);
        release.resolve();
        const result = await purge;
        expect(result.status).toBe(operation === 'restore' ? 409 : 204);
        // Purge releases its own closing owner even on a stale final validator.
        expect(app.collab.gateway.isClosing(noteId)).toBe(true);
        app.collab.gateway.clearClosing(noteId);
        marked = undefined;
        expect(app.collab.gateway.isClosing(noteId)).toBe(false);
        const row = await db
          .selectFrom('nodes')
          .select(['id', 'version', 'deleted_at'])
          .where('id', '=', idBytes(noteId))
          .executeTakeFirst();
        expect(row).toEqual(
          operation === 'restore'
            ? { id: idBytes(noteId), version: 3, deleted_at: null }
            : undefined,
        );
        const audit = await db
          .selectFrom('audit_events')
          .select('id')
          .where('action', '=', 'node.purged')
          .where('target_id', '=', idBytes(noteId))
          .execute();
        expect(audit).toHaveLength(operation === 'restore' ? 0 : 1);
        if (operation === 'restore') {
          const reopened = await harness.open(cast.editorA, noteId);
          await reopened.waitFor('saved');
          // oxlint-disable-next-line vitest/no-conditional-expect -- only the restored case still has a document to load
          expect(reopened.text.toJSON()).toBe(before.text);
          // oxlint-disable-next-line vitest/no-conditional-expect -- restoration must preserve the exact acknowledged head
          expect(await harness.committed(noteId)).toEqual(before);
        }
      } finally {
        release.resolve();
        await pending;
        app.collab.persistence.fenceNotes = fence;
        if (marked !== undefined) app.collab.gateway.clearClosing(marked);
        await harness.close();
      }
    },
  );
});
