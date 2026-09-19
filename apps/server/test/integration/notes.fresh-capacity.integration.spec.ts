import { describe, expect, it } from 'vitest';

import { startCollab } from '../support/collab-harness.ts';
import { registerRecordingOpenApiMatcher } from '../support/openapi-coverage.ts';

registerRecordingOpenApiMatcher();

describe('notes.fresh-capacity.integration [area:contracts]', () => {
  it('refuses a fresh projection at capacity while committed Markdown remains readable', async () => {
    const harness = await startCollab({
      mode: 'child',
      limits: { maxLoadedDocs: 1 },
      collab: { debounceMs: 60_000, maxDebounceMs: 60_000 },
    });
    try {
      const admin = await harness.server.seed.admin();
      const vault = await harness.server.seed.vault({ name: 'Fresh capacity' });
      const stale = await harness.server.seed.note({
        vault,
        name: 'Stale',
        markdown: 'committed\n',
      });
      const occupied = await harness.server.seed.note({
        vault,
        name: 'Occupied',
        markdown: 'other\n',
      });
      const writer = await harness.open(admin, stale.id, { role: 'manager' });
      await writer.waitFor('saved');
      writer.marker('durable-unprojected');
      await writer.waitFor('saved');
      const before = await harness.committed(stale.id);
      expect(before.projected).toBeLessThan(before.head);
      await harness.server.kill('SIGKILL');
      await writer.close();
      await harness.server.restart();
      const blocker = await harness.open(admin, occupied.id, { role: 'manager' });
      await blocker.waitFor('saved');
      const rest = await harness.server.loginAs(admin);
      const committed = await rest.get(`/notes/${stale.id}/markdown`);
      expect(committed.status).toBe(200);
      expect(committed.body).toBe('committed\n');
      await expect(committed).toMatchOpenApi('notes.getMarkdown', 200);
      const fresh = await rest.get(`/notes/${stale.id}/markdown?fresh=true`);
      expect(fresh.status, JSON.stringify(fresh.body)).toBe(503);
      expect(fresh.body).toMatchObject({ code: 'capacity' });
      await expect(fresh).toMatchOpenApi('notes.getMarkdown', 503);
      expect((await harness.committed(stale.id)).projected).toBe(before.projected);
      expect(blocker.closes).toEqual([]);
    } finally {
      await harness.close();
    }
  }, 60_000);
});
