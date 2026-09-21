/** Real REST restore over three product collaboration sessions, preserving anchors and local undo. */
import { Node, NoteId, NoteRevision, RestoredRevision } from '@iridium/contracts';
import { relativePositionAt, resolveRelativePosition } from '@iridium/crdt';
import { describe, expect, it } from 'vitest';

import { idBytes } from '../../src/auth/ids.ts';
import { appDb } from '../../src/rest/handler-context.ts';
import { startCollab } from '../support/collab-harness.ts';
import { ManualClock } from '../support/manual-clock.ts';
import { registerRecordingOpenApiMatcher } from '../support/openapi-coverage.ts';

registerRecordingOpenApiMatcher();

describe('revisions.restore.integration [area:revisions] [hp:HP-2]', () => {
  it('refuses unloaded restore at real document capacity without evicting an editor and admits it after release', async () => {
    const harness = await startCollab({ limits: { maxLoadedDocs: 1 } });
    try {
      const cast = await harness.server.seed.kernel();
      const targetId = NoteId.parse(cast.note.id);
      const path = `/notes/${targetId}/revisions`;
      const checkpoint = await cast.admin.client.post(path, { json: { label: 'Capacity target' } });
      const revision = NoteRevision.parse(checkpoint.body);
      const occupied = await harness.server.seed.note({
        vault: cast.vault,
        name: 'Active editor',
        markdown: 'kept open\n',
      });
      const blocker = await harness.open(cast.admin, occupied.id, { role: 'manager' });
      await blocker.waitFor('saved');
      const app = harness.application();
      expect(app.collab.server.loadedDocuments()).toHaveLength(1);
      expect(app.collab.persistence.writerOf(targetId)).toBeUndefined();
      const before = await harness.committed(targetId);
      const response = await cast.admin.client.post(`${path}/${revision.id}/restore`, {
        json: { confirm: true },
      });
      expect(response.status, JSON.stringify(response.body)).toBe(503);
      expect(response.body).toMatchObject({ code: 'capacity' });
      await expect(response).toMatchOpenApi('revisions.restore', 503);
      expect(app.collab.server.loadedDocuments()).toHaveLength(1);
      expect(app.collab.persistence.writerOf(targetId)).toBeUndefined();
      expect(blocker.closes).toEqual([]);
      const refused = await harness.committed(targetId);
      expect(refused.text).toBe(before.text);
      expect(refused.head).toBe(before.head);
      expect(
        await appDb(app)
          .selectFrom('note_revisions')
          .select('id')
          .where('note_id', '=', idBytes(targetId))
          .where('kind', 'in', ['pre_restore', 'restore'])
          .execute(),
      ).toEqual([]);
      await blocker.close();
      await expect.poll(() => app.collab.server.loadedDocuments()).toHaveLength(0);
      const admitted = await cast.admin.client.post(`${path}/${revision.id}/restore`, {
        json: { confirm: true },
      });
      await expect(admitted).toMatchOpenApi('revisions.restore', 200);
      expect(RestoredRevision.parse(admitted.body)).toMatchObject({
        changed: false,
        revision: before.head,
      });
      expect((await harness.committed(targetId)).text).toBe(before.text);
    } finally {
      await harness.close();
    }
  });

  it('restores through the live document with two observers, surviving cursors, untouched undo and a reversible checkpoint', async () => {
    const harness = await startCollab();
    try {
      const cast = await harness.server.seed.kernel();
      const target = 'prefix 👋 original suffix\n';
      const created = await cast.admin.client.post(`/vaults/${cast.vault.id}/nodes`, {
        json: {
          kind: 'note',
          parentId: cast.vault.rootNodeId,
          name: 'Restorable',
          markdown: target,
        },
      });
      expect(created.status).toBe(201);
      const note = Node.parse(created.body);
      const noteId = NoteId.parse(note.id);
      const path = `/notes/${noteId}/revisions`;
      const named = await cast.admin.client.post(path, { json: { label: 'Original' } });
      expect(named.status).toBe(201);
      const revision = NoteRevision.parse(named.body);
      expect(named.headers.get('location')).toBe(`/api/v1${path}/${String(revision.id)}`);
      expect((await cast.admin.client.get(`${path}/${String(revision.id)}`)).status).toBe(200);
      const [restorer, observerA, observerB] = await Promise.all([
        harness.open(cast.admin, noteId),
        harness.open(cast.editorA, noteId),
        harness.open(cast.editorB, noteId),
      ]);
      await Promise.all([
        restorer.waitFor('saved'),
        observerA.waitFor('saved'),
        observerB.waitFor('saved'),
      ]);
      const start = target.indexOf('original');
      restorer.deleteAt(start, 'original'.length);
      restorer.typeAt(start, 'different middle');
      const replaced = restorer.text.toJSON();
      await expect.poll(async () => (await harness.committed(noteId)).text).toBe(replaced);
      await expect
        .poll(() => [observerA.text.toJSON(), observerB.text.toJSON()])
        .toEqual([replaced, replaced]);
      const prefixAnchor = relativePositionAt(observerA.text, 2);
      const suffixAnchor = relativePositionAt(observerB.text, replaced.length - 3);
      observerA.publishPresence({ cursor: { anchor: [...prefixAnchor], head: [...prefixAnchor] } });
      observerB.publishPresence({ cursor: { anchor: [...suffixAnchor], head: [...suffixAnchor] } });
      await expect
        .poll(() => restorer.provider?.awareness?.getStates().has(observerA.clientId))
        .toBe(true);
      await expect
        .poll(() => restorer.provider?.awareness?.getStates().has(observerB.clientId))
        .toBe(true);
      for (const client of [restorer, observerA, observerB]) client.undo.clear();
      const beforeHead = (await harness.committed(noteId)).head;
      const restoredResponse = await cast.admin.client.post(`${path}/${revision.id}/restore`, {
        json: { confirm: true },
      });
      await expect(restoredResponse).toMatchOpenApi('revisions.restore', 200);
      const restored = RestoredRevision.parse(restoredResponse.body);
      expect(restored.changed).toBe(true);
      if (!restored.changed) throw new Error('The different live text must produce a restore.');
      expect(restored.revision).toBeGreaterThan(beforeHead);
      expect(restored.restored).toMatchObject({
        kind: 'restore',
        restoredFromRevisionId: revision.id,
        revision: restored.revision,
      });
      expect(restored.preRestore).toMatchObject({ kind: 'pre_restore', revision: beforeHead });
      await expect
        .poll(() => [restorer.text.toJSON(), observerA.text.toJSON(), observerB.text.toJSON()])
        .toEqual([target, target, target]);
      await Promise.all([
        restorer.waitFor('saved'),
        observerA.waitFor('saved'),
        observerB.waitFor('saved'),
      ]);
      expect(resolveRelativePosition(observerA.ydoc, prefixAnchor)?.index).toBe(2);
      expect(resolveRelativePosition(observerB.ydoc, suffixAnchor)?.index).toBe(target.length - 3);
      expect(restorer.undo.undoStack).toHaveLength(0);
      expect(restorer.undo.undo()).toBeNull();
      expect(observerA.undo.undoStack).toHaveLength(0);
      expect(observerB.undo.undoStack).toHaveLength(0);
      expect(restorer.text.toJSON()).toBe(target);
      const db = appDb(harness.application());
      const before = await db
        .selectFrom('note_revisions')
        .select(['markdown', 'content_hash'])
        .where('id', '=', restored.preRestore.id)
        .executeTakeFirstOrThrow();
      expect(before.markdown).toBe(replaced);
      const persisted = await harness.committed(noteId);
      expect(persisted.text).toBe(target);
      expect(persisted.head).toBe(restored.revision);
      expect(persisted.updates.at(-1)?.origin).toBe('restore');
      expect(persisted.updates.at(-1)?.actorId).toBe(
        idBytes(cast.admin.id).toString('hex').toUpperCase(),
      );
      for (const client of [restorer, observerA, observerB]) {
        // eslint-disable-next-line no-await-in-loop -- each independent socket must observe the committed restore announcement
        await expect
          .poll(
            () =>
              client.stateless.filter(
                (message) => message.t === 'checkpoint' && message.kind === 'restore',
              ).length,
          )
          .toBe(1);
      }
      const countBeforeNoop = await db
        .selectFrom('note_revisions')
        .select('id')
        .where('note_id', '=', idBytes(noteId))
        .execute();
      const noChange = await cast.admin.client.post(`${path}/${revision.id}/restore`, {
        json: { confirm: true },
      });
      await expect(noChange).toMatchOpenApi('revisions.restore', 200);
      expect(noChange.body).toEqual({
        changed: false,
        revision: restored.revision,
        contentHash: restored.contentHash,
      });
      expect(
        await db
          .selectFrom('note_revisions')
          .select('id')
          .where('note_id', '=', idBytes(noteId))
          .execute(),
      ).toEqual(countBeforeNoop);
      const reversedResponse = await cast.admin.client.post(
        `${path}/${restored.preRestore.id}/restore`,
        { json: { confirm: true } },
      );
      const reversed = RestoredRevision.parse(reversedResponse.body);
      expect(reversed.changed).toBe(true);
      await expect
        .poll(() => [restorer.text.toJSON(), observerA.text.toJSON(), observerB.text.toJSON()])
        .toEqual([replaced, replaced, replaced]);
      expect((await harness.committed(noteId)).text).toBe(replaced);
      const audits = await db
        .selectFrom('audit_events')
        .select('id')
        .where('action', '=', 'note.revision.restored')
        .where('target_id', '=', idBytes(noteId))
        .execute();
      expect(audits).toHaveLength(2);
    } finally {
      await harness.close();
    }
  });

  it('requires manager confirmation and recent authentication before changing content', async () => {
    const clock = new ManualClock(Date.now());
    const harness = await startCollab({ clock });
    try {
      const cast = await harness.server.seed.kernel();
      const named = await cast.admin.client.post(`/notes/${cast.note.id}/revisions`, {
        json: { label: 'Permission checkpoint' },
      });
      const revision = NoteRevision.parse(named.body);
      const path = `/notes/${cast.note.id}/revisions/${revision.id}/restore`;
      const editor = await harness.server.loginAs(cast.editorA);
      const denied = await editor.post(path, { json: { confirm: true } });
      await expect(denied).toMatchOpenApi('revisions.restore', 403);
      expect(denied.body).toMatchObject({ code: 'forbidden' });
      const unconfirmed = await cast.admin.client.post(path, { json: { confirm: false } });
      await expect(unconfirmed).toMatchOpenApi('revisions.restore', 422);
      clock.jump(clock.now() + 11 * 60_000);
      const stale = await cast.admin.client.post(path, { json: { confirm: true } });
      await expect(stale).toMatchOpenApi('revisions.restore', 403);
      expect(stale.body).toMatchObject({ code: 'step_up_required' });
      expect((await harness.committed(cast.note.id)).head).toBe(1);
      expect(
        await appDb(harness.application())
          .selectFrom('note_revisions')
          .select('id')
          .where('note_id', '=', idBytes(cast.note.id))
          .where('kind', 'in', ['pre_restore', 'restore'])
          .execute(),
      ).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it('restores an unloaded document and leaves an exact recoverable checkpoint at its new head', async () => {
    const harness = await startCollab();
    try {
      const cast = await harness.server.seed.kernel();
      const noteId = NoteId.parse(cast.note.id);
      const target = (await harness.committed(noteId)).text;
      const path = `/notes/${noteId}/revisions`;
      const named = NoteRevision.parse(
        (await cast.admin.client.post(path, { json: { label: 'Unloaded original' } })).body,
      );
      const app = harness.application();
      const db = appDb(app);
      const initialized = await db
        .selectFrom('notes')
        .select('initialized_at')
        .where('node_id', '=', idBytes(noteId))
        .executeTakeFirstOrThrow();
      const client = await harness.open(cast.editorA, noteId);
      await client.waitFor('saved');
      const ack = client.waitForAck();
      client.typeAt(client.text.length, ' later content');
      await ack;
      const replaced = client.text.toJSON();
      await client.close();
      await expect
        .poll(() => app.collab.persistence.writerOf(noteId), { timeout: 15_000 })
        .toBeUndefined();
      const response = await cast.admin.client.post(`${path}/${String(named.id)}/restore`, {
        json: { confirm: true },
      });
      await expect(response).toMatchOpenApi('revisions.restore', 200);
      const restored = RestoredRevision.parse(response.body);
      if (!restored.changed)
        throw new Error('The unloaded content differs from the retained revision.');
      expect((await harness.committed(noteId)).text).toBe(target);
      const before = await db
        .selectFrom('note_revisions')
        .select('markdown')
        .where('id', '=', restored.preRestore.id)
        .executeTakeFirstOrThrow();
      expect(before.markdown).toBe(replaced);
      await expect
        .poll(() => app.collab.persistence.writerOf(noteId), { timeout: 15_000 })
        .toBeUndefined();
      expect(
        await db
          .selectFrom('notes')
          .select('initialized_at')
          .where('node_id', '=', idBytes(noteId))
          .executeTakeFirstOrThrow(),
      ).toEqual(initialized);
      expect(
        await db
          .selectFrom('note_revisions')
          .select('id')
          .where('note_id', '=', idBytes(noteId))
          .where('seq', '=', restored.revision)
          .execute(),
      ).not.toHaveLength(0);
      const reopened = await harness.open(cast.editorB, noteId);
      await reopened.waitFor('saved');
      expect(reopened.text.toJSON()).toBe(target);
    } finally {
      await harness.close();
    }
  });

  it('captures concurrent edits already applied while the restore waits behind a real SQL commit', async () => {
    const harness = await startCollab({ collab: { debounceMs: 60_000, maxDebounceMs: 60_000 } });
    try {
      const cast = await harness.server.seed.kernel();
      const noteId = NoteId.parse(cast.note.id);
      const target = (await harness.committed(noteId)).text;
      const path = `/notes/${noteId}/revisions`;
      const named = NoteRevision.parse(
        (await cast.admin.client.post(path, { json: { label: 'Before concurrent edits' } })).body,
      );
      const [first, second] = await Promise.all([
        harness.open(cast.editorA, noteId),
        harness.open(cast.editorB, noteId),
      ]);
      await Promise.all([first.waitFor('saved'), second.waitFor('saved')]);
      const app = harness.application();
      const writer = app.collab.persistence.writerOf(noteId);
      if (writer === undefined) throw new Error('The connected note must own a writer.');
      const beforeHead = writer.lastCommittedSeq;
      app.faults.arm({ point: 'store.hold-before-commit' });
      first.typeAt(0, 'earlier ');
      await expect
        .poll(() =>
          harness.logs.some(
            (line) => line.includes('fault.fired') && line.includes('store.hold-before-commit'),
          ),
        )
        .toBe(true);
      const restoring = cast.admin.client.post(`${path}/${String(named.id)}/restore`, {
        json: { confirm: true },
      });
      await expect.poll(() => writer.pendingJobs).toBeGreaterThan(0);
      await expect.poll(() => second.text.toJSON()).toBe(`earlier ${target}`);
      second.typeAt(0, 'later ');
      const replaced = `later earlier ${target}`;
      await expect.poll(() => first.text.toJSON()).toBe(replaced);
      expect((await harness.committed(noteId)).head).toBe(beforeHead);
      const db = appDb(app);
      expect(
        await db
          .selectFrom('note_revisions')
          .select('id')
          .where('note_id', '=', idBytes(noteId))
          .where('kind', 'in', ['pre_restore', 'restore'])
          .execute(),
      ).toEqual([]);
      app.faults.arm({ point: 'store.hold-before-commit', count: 0 });
      const response = await restoring;
      await expect(response).toMatchOpenApi('revisions.restore', 200);
      const restored = RestoredRevision.parse(response.body);
      if (!restored.changed) throw new Error('Concurrent edits must produce a restore.');
      const before = await db
        .selectFrom('note_revisions')
        .select(['seq', 'markdown'])
        .where('id', '=', restored.preRestore.id)
        .executeTakeFirstOrThrow();
      expect(before).toEqual({ seq: beforeHead + 2, markdown: replaced });
      expect(restored.revision).toBe(before.seq + 1);
      await expect
        .poll(() => [first.text.toJSON(), second.text.toJSON()])
        .toEqual([target, target]);
      expect((await harness.committed(noteId)).text).toBe(target);
    } finally {
      harness.application().faults.arm({ point: 'store.hold-before-commit', count: 0 });
      await harness.close();
    }
  });
});
