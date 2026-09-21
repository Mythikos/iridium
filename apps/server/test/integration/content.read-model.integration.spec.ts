/** Connected content reads remain tied to the durable projection, including validators and search. */
import { createHash } from 'node:crypto';

import { type NoteMeta, type SearchPage } from '@iridium/contracts';
import { describe, expect, it } from 'vitest';

import { idBytes } from '../../src/auth/ids.ts';
import { startCollab } from '../support/collab-harness.ts';

describe('content.read-model.integration [area:content]', () => {
  it('serves the same committed bytes with an unsent live tail and an acknowledged unprojected tail', async () => {
    const harness = await startCollab({ collab: { debounceMs: 60_000, maxDebounceMs: 60_000 } });
    try {
      const cast = await harness.server.seed.kernel();
      const client = await harness.open(cast.editorA, cast.note.id, { flushDelayMs: 60_000 });
      await client.waitFor('saved');
      const initial = await cast.admin.client.get<string>(`/notes/${cast.note.id}/markdown`);
      const marker = client.marker('private-live-tail');
      const dirty = await cast.admin.client.get<string>(`/notes/${cast.note.id}/markdown`);
      expect(dirty.body).toBe(initial.body);
      expect(dirty.body).not.toContain(marker);
      client.provider?.flushPendingUpdates();
      await client.waitFor('saved');
      const head = await harness.committed(cast.note.id);
      expect(head.head).toBeGreaterThan(head.projected);
      expect(head.text).toContain(marker);
      const [markdown, meta, search] = await Promise.all([
        cast.admin.client.get<string>(`/notes/${cast.note.id}/markdown`),
        cast.admin.client.get<NoteMeta>(`/notes/${cast.note.id}`),
        cast.admin.client.get<SearchPage>('/search?q=kernel'),
      ]);
      expect(markdown.body).toBe(initial.body);
      expect(meta.body).toMatchObject({
        revision: head.projected,
        headRevision: head.head,
        contentHash: createHash('sha256').update(initial.body).digest('hex'),
      });
      expect(search.body.results[0]).toMatchObject({
        noteId: cast.note.id,
        revision: head.projected,
        stale: true,
      });
      expect(JSON.stringify(search.body)).not.toContain(marker);
      const db = harness.application().database.dbApp;
      if (db === null) throw new Error('Expected real database');
      expect(
        (
          await db
            .selectFrom('note_projections')
            .select('markdown')
            .where('note_id', '=', idBytes(cast.note.id))
            .executeTakeFirstOrThrow()
        ).markdown,
      ).toBe(initial.body);
    } finally {
      await harness.close();
    }
  });
});
