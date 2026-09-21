/** Real full-text ranking, scope filtering and keyset boundaries over public content writes. */
import { LIMITS, SearchPage, VaultId } from '@iridium/contracts';
import { searchClient, type RestClient } from '@iridium/testkit';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { idBytes } from '../../src/auth/ids.ts';
import { startAuthServer, webClient, type AuthTestServer } from '../support/auth-app.ts';
import { insertMembership, seedUser, signInWeb } from '../support/seed.ts';
import { createTreeNode, createTreeVault, treeHeaders } from './tree-test-helpers.ts';

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

describe('search.acl.integration [area:search]', () => {
  it('shares the real principal budget across both search routes and recovers after its window', async () => {
    const vault = await createTreeVault(context, admin, 'Search budget');
    const note = await createTreeNode(context, admin, vault, {
      kind: 'note',
      name: 'Budget result',
      markdown: 'searchbudgetneedle\n',
    });
    const routes = ['/search', `/vaults/${vault.id}/search`] as const;
    // Start a fresh real limiter window after fixture creation without advancing background jobs.
    context.clock.jump(context.clock.now() + 60_000);
    for (let request = 0; request < LIMITS.REST_AUTHENTICATED_PER_MINUTE; request += 1) {
      const path = routes[request % routes.length] ?? routes[0];
      // eslint-disable-next-line no-await-in-loop -- exact sequential consumption proves the real shared bucket boundary
      const response = await admin.get(path, { query: { q: 'searchbudgetneedle' } });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.headers.get('x-ratelimit-remaining')).toBe(
        String(LIMITS.REST_AUTHENTICATED_PER_MINUTE - request - 1),
      );
      expect(SearchPage.parse(response.body).results.map((hit) => hit.noteId)).toEqual([note.id]);
    }
    for (const [index, path] of routes.entries()) {
      // eslint-disable-next-line no-await-in-loop -- both real route responses must observe the exhausted shared bucket
      const response = await admin.get(path, { query: { q: 'searchbudgetneedle' } });
      expect(response.status).toBe(429);
      expect(response.body).toMatchObject({ code: 'rate_limited', retryAfterMs: 60_000 });
      expect(response.headers.get('retry-after')).toBe('60');
      expect(response.headers.get('x-ratelimit-remaining')).toBe('0');
      // eslint-disable-next-line no-await-in-loop -- record each observed HTTP status under its own operation id
      await expect(response).toMatchOpenApi(index === 0 ? 'search.all' : 'search.vault', 429);
    }
    context.clock.jump(context.clock.now() + 60_000);
    for (const [index, path] of routes.entries()) {
      // eslint-disable-next-line no-await-in-loop -- recovery on both routes must consume the newly opened window
      const response = await admin.get(path, { query: { q: 'searchbudgetneedle' } });
      expect(response.status).toBe(200);
      expect(SearchPage.parse(response.body).results.map((hit) => hit.noteId)).toEqual([note.id]);
      // eslint-disable-next-line no-await-in-loop -- validate and record the actual recovery responses
      await expect(response).toMatchOpenApi(index === 0 ? 'search.all' : 'search.vault', 200);
    }
  });

  it('filters inaccessible vaults before LIMIT, omits trashed content, and rechecks membership on continuation', async () => {
    const visible = await createTreeVault(context, admin, 'Visible corpus');
    const hidden = await createTreeVault(context, admin, 'Hidden corpus');
    const first = await createTreeNode(context, admin, visible, {
      kind: 'note',
      name: 'A visible',
      markdown: '# release checklist\nrelease checklist in the visible source\n',
    });
    await createTreeNode(context, admin, visible, {
      kind: 'note',
      name: 'B visible',
      markdown: '# release checklist\nrelease checklist in the visible source\n',
    });
    await createTreeNode(context, admin, hidden, {
      kind: 'note',
      name: 'Secret title',
      markdown: '# release checklist\nrelease checklist SECRET-BYTES release checklist\n',
    });
    const viewer = await seedUser(context, { email: 'search-viewer@example.test' });
    await insertMembership(
      context.db,
      {
        vaultId: VaultId.parse(visible.id),
        userId: viewer.id,
        role: 'viewer',
        grantedBy: viewer.id,
      },
      context.clock.now(),
    );
    const client = webClient(context, await signInWeb(context, viewer));
    const search = searchClient(client);
    const page = await search.query('"release checklist"', { limit: 1 });
    expect(page.status, JSON.stringify(page.body)).toBe(200);
    expect(page.body.results).toHaveLength(1);
    expect(page.body.results[0]?.vaultId).toBe(visible.id);
    expect(page.body.nextCursor).toBeDefined();
    expect(JSON.stringify(page.body)).not.toContain('SECRET-BYTES');
    expect((await search.query('release', { vaultId: hidden.id })).status).toBe(404);
    const continued = await search.query('"release checklist"', {
      limit: 1,
      cursor: page.body.nextCursor,
    });
    expect(continued.body.results).toHaveLength(1);
    expect(continued.body.results[0]?.noteId).not.toBe(page.body.results[0]?.noteId);
    const trashed = await admin.post(`/nodes/${first.id}/trash`, {
      json: {},
      headers: treeHeaders(context, first.version),
    });
    expect(trashed.status).toBe(200);
    const remaining = await search.query('release');
    expect(remaining.body.results.map((hit) => hit.noteId)).not.toContain(first.id);
    await context.db
      .deleteFrom('vault_members')
      .where('vault_id', '=', idBytes(visible.id))
      .where('user_id', '=', idBytes(viewer.id))
      .execute();
    const revoked = await search.query('"release checklist"', {
      limit: 1,
      cursor: page.body.nextCursor,
    });
    expect(revoked.status).toBe(422);
    expect((await search.query('release')).body.results).toEqual([]);
    expect(JSON.stringify(revoked.body)).not.toContain(first.id);
  });
});
