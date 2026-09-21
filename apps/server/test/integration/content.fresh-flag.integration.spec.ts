/** Connected content reads remain tied to the durable projection, including validators and search. */
import { LIMITS, NoteId, type SearchPage } from '@iridium/contracts';
import { describe, expect, it } from 'vitest';

import { startCollab } from '../support/collab-harness.ts';

describe('content.fresh-flag.integration [area:content]', () => {
  it('flushes on explicit request, clears search staleness, and keeps the per-note budget separate from reads', async () => {
    const harness = await startCollab({ collab: { debounceMs: 60_000, maxDebounceMs: 60_000 } });
    try {
      const cast = await harness.server.seed.kernel();
      const client = await harness.open(cast.editorA, cast.note.id);
      await client.waitFor('saved');
      const marker = client.marker('fresh-content');
      await client.waitFor('saved');
      const initial = await harness.committed(cast.note.id);
      expect(initial.projected).toBeLessThan(initial.head);
      const fresh = await cast.admin.client.get<string>(
        `/notes/${cast.note.id}/markdown?fresh=true`,
      );
      expect(fresh.status, JSON.stringify(fresh.body)).toBe(200);
      expect(fresh.body).toContain(marker);
      const after = await harness.committed(cast.note.id);
      expect(after.projected).toBe(after.head);
      const search = await cast.admin.client.get<SearchPage>('/search?q=kernel');
      expect(search.body.results[0]?.stale).toBe(false);
      for (let index = 1; index < LIMITS.FLUSH_PER_MINUTE; index += 1) {
        // eslint-disable-next-line no-await-in-loop -- one principal and note consume their actual shared bucket
        const response = await cast.admin.client.get(`/notes/${cast.note.id}/markdown?fresh=true`);
        expect(response.status).toBe(200);
      }
      expect(
        (await cast.admin.client.get(`/notes/${cast.note.id}/markdown?fresh=true`)).status,
      ).toBe(429);
      expect((await cast.admin.client.get(`/notes/${cast.note.id}/markdown`)).status).toBe(200);
      expect(
        harness.application().collab.persistence.writerOf(NoteId.parse(cast.note.id))
          ?.lastProjectedSeq,
      ).toBe(after.head);
    } finally {
      await harness.close();
    }
  });
});
