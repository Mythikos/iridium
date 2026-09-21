/** Real full-text ranking, scope filtering and keyset boundaries over public content writes. */
import { type SearchPage } from '@iridium/contracts';
import { searchClient, type RestClient } from '@iridium/testkit';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { startAuthServer, webClient, type AuthTestServer } from '../support/auth-app.ts';
import { seedUser, signInWeb } from '../support/seed.ts';
import { createTreeNode, createTreeVault } from './tree-test-helpers.ts';

let context: AuthTestServer;
let admin: RestClient;
beforeAll(async () => {
  context = await startAuthServer();
});
beforeEach(async () => {
  const user = await seedUser(context, { email: 'search-admin@example.test', isServerAdmin: true });
  admin = webClient(context, await signInWeb(context, user));
});
afterAll(async () => {
  await context.stop();
});

describe('search.snippets.integration [area:search]', () => {
  it('uses source lines, short title terms, escaped path/file predicates and explicit parser errors', async () => {
    const vault = await createTreeVault(context, admin, 'Search syntax');
    const folder = await createTreeNode(context, admin, vault, { name: '100% plans' });
    const note = await createTreeNode(context, admin, vault, {
      kind: 'note',
      name: 'PlanA',
      parentId: folder.id,
      markdown:
        '---\naliases: [hiddenmetadata]\n---\n# X launch\n\nrelease **checklist** is ready\n',
    });
    await createTreeNode(context, admin, vault, {
      kind: 'note',
      name: 'PlanB',
      markdown: '# unrelated\nrelease checklist delayed\n',
    });
    const search = searchClient(admin);
    const filtered = await search.query('release -delayed file:PlanA', {
      vaultId: vault.id,
      pathPrefix: '/100% plans',
    });
    expect(filtered.status, JSON.stringify(filtered.body)).toBe(200);
    expect(filtered.body.results.map((hit) => hit.noteId)).toEqual([note.id]);
    expect(filtered.body.results[0]?.snippets).toContainEqual(
      expect.objectContaining({ line: 6, text: 'release **checklist** is ready' }),
    );
    const short = await search.query('X', { vaultId: vault.id });
    expect(short.status).toBe(200);
    expect(short.body.results.map((hit) => hit.noteId)).toEqual([note.id]);
    const metadata = await search.query('hiddenmetadata', { vaultId: vault.id });
    expect(metadata.body.results).toEqual([]);
    expect(
      (await search.query('-delayed', { vaultId: vault.id })).body.results.map((hit) => hit.noteId),
    ).toEqual([note.id]);
    for (const q of ['tag:release', 'line:3', '***']) {
      // eslint-disable-next-line no-await-in-loop -- each grammar refusal is an independent public request
      const response = await admin.get<SearchPage>(`/search?q=${encodeURIComponent(q)}`);
      expect(response.status, q).toBe(422);
    }
  });
});
