/** Real binary capture, worker preparation and SQL publication, including deliberately late work. */
import { type Node, type NodePatchResult } from '@iridium/contracts';
import { describe, expect, it } from 'vitest';

import { idBytes } from '../../src/auth/ids.ts';
import { startCollab } from '../support/collab-harness.ts';

describe('projection.title-after-rename.integration [area:projection]', () => {
  it('updates filename titles atomically while preserving the projected H1 and source bytes', async () => {
    const harness = await startCollab();
    try {
      const admin = await harness.server.seed.admin();
      const vault = await harness.server.seed.vault({ name: 'Search titles' });
      for (const [name, markdown, title] of [
        ['Plain', 'body without heading', 'Renamed Plain'],
        ['Heading', '# Authoritative\nbody', 'Authoritative'],
      ] as const) {
        // eslint-disable-next-line no-await-in-loop -- both cases use their own complete structural transaction
        const note = await harness.server.seed.note({ vault, name, markdown });
        // eslint-disable-next-line no-await-in-loop -- obtain the real CAS validator before its mutation
        const before = await admin.client.get<Node>(`/nodes/${note.id}`);
        // eslint-disable-next-line no-await-in-loop -- preserve case-specific H1 and filename assertions
        const renamed = await admin.client.patch<NodePatchResult>(`/nodes/${note.id}`, {
          json: { name: `Renamed ${name}` },
          headers: { 'if-match': `"${before.body.version}"` },
        });
        expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
        const db = harness.application().database.dbApp;
        if (db === null) throw new Error('Expected database');
        // eslint-disable-next-line no-await-in-loop -- inspect the committed search row for this specific note
        const search = await db
          .selectFrom('note_search')
          .select('title')
          .where('note_id', '=', idBytes(note.id))
          .executeTakeFirstOrThrow();
        expect(search.title).toBe(title);
        // eslint-disable-next-line no-await-in-loop -- a filename mutation must not change note source
        expect((await admin.client.get<string>(`/notes/${note.id}/markdown`)).body).toBe(markdown);
      }
    } finally {
      await harness.close();
    }
  });
});
