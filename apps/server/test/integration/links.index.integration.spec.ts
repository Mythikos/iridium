/** Real binary capture, worker preparation and SQL publication, including deliberately late work. */
import { type LinkPage, type Node, type NoteLinks } from '@iridium/contracts';
import { describe, expect, it } from 'vitest';

import { startCollab } from '../support/collab-harness.ts';

describe('links.index.integration [area:links]', () => {
  it('serves ordinal outgoing rows and complete incoming keysets without rewriting sources after rename', async () => {
    const harness = await startCollab();
    try {
      const admin = await harness.server.seed.admin();
      const vault = await harness.server.seed.vault({ name: 'Link reads' });
      const target = await harness.server.seed.note({
        vault,
        name: 'Target',
        markdown: '# Target\n',
      });
      const source = await harness.server.seed.note({
        vault,
        name: 'Source',
        markdown:
          '[target](Target.md)\n# Local\n[anchor](#local) [bad](#missing) [web](https://example.test)\n',
      });
      const outgoing = await admin.client.get<NoteLinks>(`/notes/${source.id}/links`);
      expect(outgoing.status, JSON.stringify(outgoing.body)).toBe(200);
      expect(outgoing.body.revision).toBe(1);
      expect(outgoing.body.items.map((link) => [link.ordinal, link.status, link.line])).toEqual([
        [0, 'resolved', 1],
        [1, 'resolved', 3],
        [2, 'broken', 3],
        [3, 'external', 3],
      ]);
      expect(outgoing.body.items[1]?.resolvedNodeId).toBe(source.id);
      const second = await harness.server.seed.note({
        vault,
        name: 'Source Two',
        markdown: '[target](Target.md)\n',
      });
      const first = await admin.client.get<LinkPage>(`/notes/${target.id}/backlinks?limit=1`);
      const next = await admin.client.get<LinkPage>(
        `/notes/${target.id}/backlinks?limit=1&cursor=${encodeURIComponent(first.body.nextCursor ?? '')}`,
      );
      expect(
        new Set([...first.body.items, ...next.body.items].map((link) => link.fromNoteId)),
      ).toEqual(new Set([source.id, second.id]));
      expect(next.body.nextCursor).toBeUndefined();
      const metadata = await admin.client.get<Node>(`/nodes/${target.id}`);
      expect(
        (
          await admin.client.patch(`/nodes/${target.id}`, {
            json: { name: 'Destination' },
            headers: { 'if-match': `"${metadata.body.version}"` },
          })
        ).status,
      ).toBe(200);
      const after = await admin.client.get<NoteLinks>(`/notes/${source.id}/links`);
      expect(after.body).toEqual(outgoing.body);
      expect((await admin.client.get<string>(`/notes/${source.id}/markdown`)).body).toBe(
        '[target](Target.md)\n# Local\n[anchor](#local) [bad](#missing) [web](https://example.test)\n',
      );
    } finally {
      await harness.close();
    }
  });
});
