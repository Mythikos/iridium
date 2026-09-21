/** Named checkpoints are durable content reads, including the unloaded fast path. */
import { Node, NoteId, NoteRevision, RevisionContent, RevisionPage } from '@iridium/contracts';
import { describe, expect, it } from 'vitest';

import { idBytes } from '../../src/auth/ids.ts';
import { appDb } from '../../src/rest/handler-context.ts';
import { startCollab } from '../support/collab-harness.ts';
import { ManualClock } from '../support/manual-clock.ts';
import { registerRecordingOpenApiMatcher } from '../support/openapi-coverage.ts';

registerRecordingOpenApiMatcher();

describe('revisions.named.integration [area:revisions]', () => {
  it('returns unavailable when a real loaded writer cannot reach its checkpoint deadline and permits retry', async () => {
    const clock = new ManualClock(Date.now());
    const deadlineMs = 1_000;
    const harness = await startCollab({
      clock,
      collab: { debounceMs: 60_000, maxDebounceMs: 60_000, compactionAwaitTimeoutMs: deadlineMs },
    });
    const locked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let held: Promise<void> | undefined;
    try {
      const cast = await harness.server.seed.kernel();
      const noteId = NoteId.parse(cast.note.id);
      const live = await harness.open(cast.editorA, noteId);
      await live.waitFor('saved');
      const app = harness.application();
      const db = appDb(app);
      const writer = app.collab.persistence.writerOf(noteId);
      if (writer === undefined)
        throw new Error('The synchronized document must have a real writer.');
      const before = await harness.committed(noteId);
      held = db.transaction().execute(async (trx) => {
        await trx
          .selectFrom('note_docs')
          .select('head_seq')
          .where('note_id', '=', idBytes(noteId))
          .forUpdate()
          .executeTakeFirstOrThrow();
        locked.resolve();
        await release.promise;
      });
      await locked.promise;
      const responsePromise = cast.admin.client.post(`/notes/${noteId}/revisions`, {
        json: { label: 'Delayed checkpoint' },
      });
      await expect.poll(() => writer.inFlight).toBe(true);
      await clock.advance(deadlineMs);
      const unavailable = await responsePromise;
      expect(unavailable.status, JSON.stringify(unavailable.body)).toBe(503);
      expect(unavailable.body).toMatchObject({ code: 'unavailable', retryAfterMs: 1_000 });
      expect(unavailable.headers.get('retry-after')).toBe('1');
      await expect(unavailable).toMatchOpenApi('revisions.create', 503);
      expect(
        await db
          .selectFrom('note_revisions')
          .select('id')
          .where('note_id', '=', idBytes(noteId))
          .where('kind', '=', 'named')
          .execute(),
      ).toEqual([]);
      expect(live.closes).toEqual([]);
      release.resolve();
      await held;
      await expect.poll(() => writer.inFlight).toBe(false);
      const retried = await cast.admin.client.post(`/notes/${noteId}/revisions`, {
        json: { label: 'Delayed checkpoint' },
      });
      await expect(retried).toMatchOpenApi('revisions.create', 201);
      expect(NoteRevision.parse(retried.body)).toMatchObject({
        revision: before.head,
        label: 'Delayed checkpoint',
      });
      const after = await harness.committed(noteId);
      expect(after.text).toBe(before.text);
      expect(after.head).toBe(before.head);
    } finally {
      release.resolve();
      await held;
      await harness.close();
    }
  });

  it('names unloaded and live heads, preserves immutable labels, and pages and negotiates retained content', async () => {
    const harness = await startCollab();
    try {
      const cast = await harness.server.seed.kernel();
      const created = await cast.admin.client.post(`/vaults/${cast.vault.id}/nodes`, {
        json: {
          kind: 'note',
          parentId: cast.vault.rootNodeId,
          name: 'Named history',
          markdown: 'first\n',
        },
      });
      expect(created.status).toBe(201);
      const note = Node.parse(created.body);
      const noteId = NoteId.parse(note.id);
      const path = `/notes/${noteId}/revisions`;
      const app = harness.application();
      const db = appDb(app);
      expect(app.collab.persistence.writerOf(noteId)).toBeUndefined();
      const firstResponse = await cast.admin.client.post(path, {
        json: { label: 'First retained' },
      });
      expect(firstResponse.status).toBe(201);
      await expect(firstResponse).toMatchOpenApi('revisions.create', 201);
      const first = NoteRevision.parse(firstResponse.body);
      expect(first).toMatchObject({
        kind: 'named',
        label: 'First retained',
        revision: 1,
        hasSnapshot: true,
      });
      expect(app.collab.persistence.writerOf(noteId)).toBeUndefined();

      const live = await harness.open(cast.editorA, noteId);
      await live.waitFor('saved');
      live.typeAt(live.text.length, 'second\n');
      await expect.poll(async () => (await harness.committed(noteId)).text).toBe('first\nsecond\n');
      const editor = await harness.server.loginAs(cast.editorA);
      const namedMessage = live.waitForStateless('checkpoint');
      const secondResponse = await editor.post(path, { json: { label: 'Current live head' } });
      expect(secondResponse.status).toBe(201);
      await expect(secondResponse).toMatchOpenApi('revisions.create', 201);
      const second = NoteRevision.parse(secondResponse.body);
      expect(second.revision).toBe((await harness.committed(noteId)).head);
      expect(second.revision).toBeGreaterThan(first.revision);
      await namedMessage;
      await expect
        .poll(
          () =>
            live.stateless.filter(
              (message) => message.t === 'checkpoint' && message.kind === 'named',
            ).length,
        )
        .toBe(1);
      const repeated = await editor.post(path, { json: { label: 'Labels are immutable' } });
      expect(repeated.status).toBe(201);
      expect(repeated.body).toEqual(second);
      const audits = await db
        .selectFrom('audit_events')
        .select('id')
        .where('action', '=', 'note.revision.named')
        .where('target_id', '=', idBytes(noteId))
        .execute();
      expect(audits).toHaveLength(2);

      const pageResponse = await editor.get(path, { query: { kinds: 'named', limit: 1 } });
      await expect(pageResponse).toMatchOpenApi('revisions.list', 200);
      const page = RevisionPage.parse(pageResponse.body);
      expect(page.items).toEqual([second]);
      expect(page.retention.neverThinned).toContain('named');
      expect(page.nextCursor).toBeDefined();
      const lastResponse = await editor.get(path, {
        query: { kinds: 'named', limit: 1, cursor: page.nextCursor },
      });
      expect(RevisionPage.parse(lastResponse.body).items).toEqual([first]);
      const getResponse = await editor.get(`${path}/${first.id}`);
      await expect(getResponse).toMatchOpenApi('revisions.get', 200);
      expect(RevisionContent.parse(getResponse.body).markdown).toBe('first\n');
      expect(getResponse.headers.get('etag')).toBe(`"${first.id}"`);
      expect(getResponse.headers.get('cache-control')).toBe('private, max-age=86400, immutable');
      expect(getResponse.headers.get('vary')).toBe('Accept');
      const markdown = await editor.get(`${path}/${second.id}`, {
        headers: { accept: 'text/markdown' },
      });
      await expect(markdown).toMatchOpenApi('revisions.get', 200);
      expect(markdown.body).toBe('first\nsecond\n');
      const cached = await editor.get(`${path}/${first.id}`, {
        headers: { 'if-none-match': `W/"${first.id}"` },
      });
      await expect(cached).toMatchOpenApi('revisions.get', 304);
      expect(cached.body).toBeUndefined();
      const missing = await editor.get(`${path}/9007199254740991`);
      await expect(missing).toMatchOpenApi('revisions.get', 404);
      expect(missing.body).toMatchObject({ code: 'not_found' });
      expect(missing.body).toMatchObject({
        detail: expect.stringContaining(`Nearest retained revisions: ${String(second.id)}`),
      });
    } finally {
      await harness.close();
    }
  });

  it('enforces the per-note naming budget and refuses viewer and invalid-content mutations', async () => {
    const harness = await startCollab();
    try {
      const cast = await harness.server.seed.kernel();
      const path = `/notes/${cast.note.id}/revisions`;
      const viewer = await harness.server.loginAs(cast.viewer);
      const denied = await viewer.post(path, { json: { label: 'Forbidden' } });
      await expect(denied).toMatchOpenApi('revisions.create', 403);
      for (let request = 0; request < 6; request += 1) {
        // eslint-disable-next-line no-await-in-loop -- the seventh request must exhaust this principal and note's actual bucket
        const response = await cast.admin.client.post(path, { json: { label: 'Retained' } });
        expect(response.status).toBe(201);
      }
      const limited = await cast.admin.client.post(path, { json: { label: 'Over budget' } });
      await expect(limited).toMatchOpenApi('revisions.create', 429);
      expect(limited.headers.get('retry-after')).not.toBeNull();
      const editor = await harness.server.loginAs(cast.editorA);
      const live = await harness.open(cast.editorA, cast.note.id);
      await live.waitFor('saved');
      live.typeAt(0, '\r');
      await expect
        .poll(async () => (await harness.committed(cast.note.id)).text.startsWith('\r'))
        .toBe(true);
      const invalid = await editor.post(path, { json: { label: 'Hostile content' } });
      await expect(invalid).toMatchOpenApi('revisions.create', 409);
      expect(invalid.body).toMatchObject({ code: 'content_invalid' });
    } finally {
      await harness.close();
    }
  });
});
