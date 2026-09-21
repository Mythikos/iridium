/** Search only exposes the committed projection and tells the caller when its head is newer. */
import { type SearchPage } from '@iridium/contracts';
import { describe, expect, it } from 'vitest';

import { startCollab } from '../support/collab-harness.ts';

describe('search.staleness-hint.integration [area:search]', () => {
  it('keeps the indexed revision until a real flush publishes the acknowledged edit', async () => {
    const harness = await startCollab({ collab: { debounceMs: 60_000, maxDebounceMs: 60_000 } });
    try {
      const cast = await harness.server.seed.kernel();
      const client = await harness.open(cast.editorA, cast.note.id);
      await client.waitFor('saved');
      const indexed = await harness.committed(cast.note.id);
      const initial = await cast.admin.client.get<SearchPage>('/search?q=kernel');
      expect(initial.body.results.find((hit) => hit.noteId === cast.note.id)).toMatchObject({
        revision: indexed.projected,
        stale: false,
      });
      const acknowledged = client.waitForAck();
      client.typeAt(client.text.length, '\nquasarstalenessneedle\n');
      const ack = await acknowledged;
      expect(ack.seq).toBeGreaterThan(indexed.projected);
      const [crossVault, vaultOnly, newTerm] = await Promise.all([
        cast.admin.client.get<SearchPage>('/search?q=kernel'),
        cast.admin.client.get<SearchPage>(`/vaults/${cast.vault.id}/search?q=kernel`),
        cast.admin.client.get<SearchPage>('/search?q=quasarstalenessneedle'),
      ]);
      for (const page of [crossVault, vaultOnly]) {
        expect(page.status).toBe(200);
        expect(page.body.results.find((hit) => hit.noteId === cast.note.id)).toMatchObject({
          revision: indexed.projected,
          stale: true,
        });
      }
      expect(newTerm.body.results).toEqual([]);
      expect((await harness.committed(cast.note.id)).projected).toBe(indexed.projected);
      const published = client.waitForStateless('projected');
      client.sendStateless({ v: 1, t: 'flush' });
      expect((await published).seq).toBe(ack.seq);
      const fresh = await cast.admin.client.get<SearchPage>('/search?q=quasarstalenessneedle');
      expect(fresh.status).toBe(200);
      expect(fresh.body.results).toHaveLength(1);
      expect(fresh.body.results[0]).toMatchObject({
        noteId: cast.note.id,
        revision: ack.seq,
        stale: false,
      });
      expect(JSON.stringify(fresh.body.results[0]?.snippets)).toContain('quasarstalenessneedle');
      expect((await harness.committed(cast.note.id)).head).toBe(ack.seq);
    } finally {
      await harness.close();
    }
  });
});
