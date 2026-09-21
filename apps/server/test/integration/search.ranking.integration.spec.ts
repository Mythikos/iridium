/** Real full-text ranking, scope filtering and keyset boundaries over public content writes. */
import { type Node, type SearchHit } from '@iridium/contracts';
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

describe('search.ranking.integration [area:search]', () => {
  it('orders different scores before ids and recency, including keyset boundaries between score groups', async () => {
    const vault = await createTreeVault(context, admin, 'Score groups');
    const groups = [12, 12, 4, 4, 4, 1];
    const notes: Node[] = [];
    for (const [index, occurrences] of groups.entries()) {
      // eslint-disable-next-line no-await-in-loop -- timestamp order must precede the next structural commit
      await context.clock.advance(1000);
      // eslint-disable-next-line no-await-in-loop -- each group is committed at a distinct clock value
      const note = await createTreeNode(context, admin, vault, {
        kind: 'note',
        name: `Ranked ${index}`,
        markdown: '# Ranking fixture\n\n' + 'quasar '.repeat(occurrences) + '\n',
      });
      notes.push(note);
    }
    const search = searchClient(admin);
    const hits: SearchHit[] = [];
    let cursor: string | undefined;
    do {
      // eslint-disable-next-line no-await-in-loop -- consume the actual signed keyset across distinct scores
      const page = await search.query('quasar', {
        vaultId: vault.id,
        limit: 2,
        ...(cursor === undefined ? {} : { cursor }),
      });
      expect(page.status, JSON.stringify(page.body)).toBe(200);
      hits.push(...page.body.results);
      cursor = page.body.nextCursor;
    } while (cursor !== undefined);
    expect(hits.map((hit) => hit.noteId)).toEqual(notes.map((note) => note.id));
    expect(hits[0]!.score).toBeGreaterThan(hits[2]!.score);
    expect(hits[2]!.score).toBeGreaterThan(hits[5]!.score);
    expect(hits[0]!.score).toBe(hits[1]!.score);
    expect(hits[2]!.score).toBe(hits[4]!.score);
    expect(Date.parse(hits[5]!.updatedAt)).toBeGreaterThan(Date.parse(hits[0]!.updatedAt));
  });
  it('walks score ties exactly once in id order and binds the cursor to the query', async () => {
    const vault = await createTreeVault(context, admin, 'Score ties');
    const notes: Node[] = [];
    for (let index = 0; index < 7; index += 1) {
      // eslint-disable-next-line no-await-in-loop -- each creation uses the real structural transaction
      const note = await createTreeNode(context, admin, vault, {
        kind: 'note',
        name: `Rank ${index}`,
        markdown: '# identical score\nquasar repeated source\n',
      });
      notes.push(note);
    }
    const search = searchClient(admin);
    const ids: string[] = [];
    let cursor: string | undefined;
    let firstCursor: string | undefined;
    do {
      // eslint-disable-next-line no-await-in-loop -- the next keyset comes from the prior response
      const page = await search.query('quasar', {
        vaultId: vault.id,
        limit: 2,
        ...(cursor === undefined ? {} : { cursor }),
      });
      expect(page.status, JSON.stringify(page.body)).toBe(200);
      ids.push(...page.body.results.map((hit) => hit.noteId));
      expect(new Set(page.body.results.map((hit) => hit.score)).size).toBe(1);
      cursor = page.body.nextCursor;
      firstCursor ??= cursor;
    } while (cursor !== undefined);
    expect(ids).toEqual(notes.map((note) => note.id).toSorted());
    const changed = await search.query('different', {
      vaultId: vault.id,
      limit: 2,
      ...(firstCursor === undefined ? {} : { cursor: firstCursor }),
    });
    expect(changed.status).toBe(422);
  });
});
