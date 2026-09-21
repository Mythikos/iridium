import {
  chainIdForVault,
  type Node,
  type NodePage,
  type NodePatchResult,
  type RestoreNodeResult,
  type TrashNodeResult,
} from '@iridium/contracts';
import type { RestClient } from '@iridium/testkit';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { verifyChain, type AuditKeys } from '../../src/audit/chain.ts';
import { createAuditKeys, readPromotedAuditKeyVersion } from '../../src/audit/keys.ts';
import { idBytes } from '../../src/auth/ids.ts';
import { derivePaths } from '../../src/tree/queries.ts';
import { startAuthServer, webClient, type AuthTestServer } from '../support/auth-app.ts';
import { seedUser, signInWeb } from '../support/seed.ts';
import { createTreeNode, createTreeVault, treeHeaders } from './tree-test-helpers.ts';
let context: AuthTestServer;
let client: RestClient;
let competitor: RestClient;
let auditKeys: AuditKeys;
beforeAll(async () => {
  context = await startAuthServer();
  auditKeys = createAuditKeys({
    keyring: context.app.iridiumConfig.keys.auditHmac,
    signingVersion: await readPromotedAuditKeyVersion(context.db),
  });
});
beforeEach(async () => {
  const admin = await seedUser(context, { email: 'structure@example.test', isServerAdmin: true });
  client = webClient(context, await signInWeb(context, admin));
  const other = await seedUser(context, {
    email: 'structure-competitor@example.test',
    isServerAdmin: true,
  });
  competitor = webClient(context, await signInWeb(context, other));
});
afterAll(async () => {
  await context.stop();
});
describe('tree.structural-concurrency.integration [spec:structural-concurrency]', () => {
  it.each([
    'same rename',
    'sibling rename',
    'same move',
    'move and trash',
    'trash and restore',
    'opposing moves',
    'same create',
    'purge and restore',
  ] as const)(
    'serializes %s from independent principals in 25 repetitions',
    async (pair) => {
      for (let repetition = 0; repetition < 25; repetition += 1) {
        // eslint-disable-next-line no-await-in-loop -- each repetition owns its own independently audited vault
        const vault = await createTreeVault(context, client, `${pair} ${String(repetition)}`);
        // eslint-disable-next-line no-await-in-loop -- both independently named parents must exist before the race
        const [a, b, x, y] = await Promise.all(
          ['A', 'B', 'X', 'Y'].map((name) => createTreeNode(context, client, vault, { name })),
        );
        if (a === undefined || b === undefined || x === undefined || y === undefined)
          throw new Error('The race fixture has four categories.');
        let version = 1;
        let beforeVersion = 4;
        if (pair === 'trash and restore' || pair === 'purge and restore') {
          // eslint-disable-next-line no-await-in-loop -- obtain the real tombstone version used by the restore race
          const trash = await client.post<TrashNodeResult>(`/nodes/${x.id}/trash`, {
            json: {},
            headers: treeHeaders(context, version),
          });
          // oxlint-disable-next-line vitest/no-conditional-expect -- every named race runs 25 times and this assertion covers its specific winner or invariant
          expect(trash.status).toBe(200);
          version = 2;
          beforeVersion += 1;
        }
        const patch = (actor: RestClient, node: Node, body: object) =>
          actor.patch(`/nodes/${node.id}`, {
            json: body,
            headers: treeHeaders(context, node.version),
          });
        let competing: readonly Promise<{ readonly status: number; readonly body: unknown }>[];
        switch (pair) {
          case 'same rename':
            competing = [
              patch(client, x, { name: 'First' }),
              patch(competitor, x, { name: 'Second' }),
            ];
            break;
          case 'sibling rename':
            competing = [
              patch(client, x, { name: 'Shared' }),
              patch(competitor, y, { name: 'Shared' }),
            ];
            break;
          case 'same move':
            competing = [
              patch(client, x, { parentId: a.id }),
              patch(competitor, x, { parentId: b.id }),
            ];
            break;
          case 'move and trash':
            competing = [
              patch(client, x, { parentId: a.id }),
              competitor.post(`/nodes/${x.id}/trash`, {
                json: {},
                headers: treeHeaders(context, version),
              }),
            ];
            break;
          case 'trash and restore':
            competing = [
              client.post(`/nodes/${x.id}/trash`, { json: {}, headers: treeHeaders(context, 1) }),
              competitor.post(`/nodes/${x.id}/restore`, {
                json: {},
                headers: treeHeaders(context, version),
              }),
            ];
            break;
          case 'opposing moves':
            competing = [
              patch(client, a, { parentId: b.id }),
              patch(competitor, b, { parentId: a.id }),
            ];
            break;
          case 'same create':
            competing = [client, competitor].map((actor) =>
              actor.post(`/vaults/${vault.id}/nodes`, {
                json: {
                  name: 'Same',
                  kind: 'note',
                  parentId: vault.rootNodeId,
                  markdown: 'exactly one initializer',
                },
                headers: { origin: context.origin },
              }),
            );
            break;
          case 'purge and restore':
            competing = [
              client.del(`/nodes/${x.id}?purge=true`, { headers: treeHeaders(context, version) }),
              competitor.post(`/nodes/${x.id}/restore`, {
                json: {},
                headers: treeHeaders(context, version),
              }),
            ];
            break;
        }
        // eslint-disable-next-line no-await-in-loop -- the two operations race, then the next isolated repetition starts
        const results = await Promise.all(competing);
        const success = results.filter((row) => row.status >= 200 && row.status < 300);
        expect(success).toHaveLength(1);
        const refused = results.find((row) => row.status >= 400);
        expect(refused?.status).toBe(
          pair === 'purge and restore' && success[0]?.status === 204 ? 404 : 409,
        );
        if (pair === 'same rename' || pair === 'same move' || pair === 'trash and restore')
          // oxlint-disable-next-line vitest/no-conditional-expect -- every named race runs 25 times and this assertion covers its specific winner or invariant
          expect(refused?.body).toMatchObject({ code: 'stale_version' });
        if (pair === 'sibling rename' || pair === 'same create')
          // oxlint-disable-next-line vitest/no-conditional-expect -- every named race runs 25 times and this assertion covers its specific winner or invariant
          expect(refused?.body).toMatchObject({ code: 'name_conflict' });
        if (pair === 'opposing moves')
          // oxlint-disable-next-line vitest/no-conditional-expect -- every named race runs 25 times and this assertion covers its specific winner or invariant
          expect(refused?.body).toMatchObject({ code: 'invalid_move' });
        // eslint-disable-next-line no-await-in-loop -- one CTE must reach every remaining nonroot row exactly once
        const walked = await derivePaths(context.db, idBytes(vault.id), true);
        // eslint-disable-next-line no-await-in-loop -- compare the walk with the independently read adjacency rows
        const rows = await context.db
          .selectFrom('nodes')
          .select(['id', 'parent_id', 'name', 'deleted_at'])
          .where('vault_id', '=', idBytes(vault.id))
          .execute();
        expect(walked).toHaveLength(rows.length - 1);
        expect(new Set(walked.map((row) => row.id.toString('hex'))).size).toBe(walked.length);
        const liveKeys = rows
          .filter((row) => row.deleted_at === null)
          .map(
            (row) =>
              `${row.parent_id.toString('hex')}:${row.name.normalize('NFC').toLocaleLowerCase('en-US')}`,
          );
        expect(new Set(liveKeys).size).toBe(liveKeys.length);
        // eslint-disable-next-line no-await-in-loop -- tree and audit count are compared after the winning commit
        const current = await context.db
          .selectFrom('vaults')
          .select('tree_version')
          .where('id', '=', idBytes(vault.id))
          .executeTakeFirstOrThrow();
        expect(current.tree_version).toBe(beforeVersion + 1);
        // eslint-disable-next-line no-await-in-loop -- every successful structural mutation must have exactly one audit row
        const events = await context.db
          .selectFrom('audit_events')
          .select('id')
          .where('vault_id', '=', idBytes(vault.id))
          .where('action', 'like', 'node.%')
          .execute();
        expect(events).toHaveLength(current.tree_version);
        // eslint-disable-next-line no-await-in-loop -- verify the real chain, not only its event count
        expect((await verifyChain(context.db, chainIdForVault(vault.id), auditKeys)).ok).toBe(true);
        if (pair === 'same create') {
          // eslint-disable-next-line no-await-in-loop -- the losing create must leave no initialized orphan
          const initialized = await context.db
            .selectFrom('note_docs')
            .innerJoin('nodes', 'nodes.id', 'note_docs.note_id')
            .select('note_docs.note_id')
            .where('nodes.vault_id', '=', idBytes(vault.id))
            .execute();
          // oxlint-disable-next-line vitest/no-conditional-expect -- every named race runs 25 times and this assertion covers its specific winner or invariant
          expect(initialized).toHaveLength(1);
        }
      }
    },
    120_000,
  );
  it('serializes competing rename and move versions, sibling collisions and opposing moves', async () => {
    const vault = await createTreeVault(context, client, 'Concurrent');
    const first = await createTreeNode(context, client, vault, { name: 'First' });
    const second = await createTreeNode(context, client, vault, { name: 'Second' });
    const note = await createTreeNode(context, client, vault, { kind: 'note', name: 'Note' });
    const updates = await Promise.all([
      client.patch<NodePatchResult>(`/nodes/${note.id}`, {
        json: { name: 'Changed' },
        headers: treeHeaders(context, note.version),
      }),
      client.patch<NodePatchResult>(`/nodes/${note.id}`, {
        json: { parentId: first.id },
        headers: treeHeaders(context, note.version),
      }),
    ]);
    expect(updates.map((row) => row.status).toSorted((left, right) => left - right)).toEqual([
      200, 409,
    ]);
    const cycle = await Promise.all([
      client.patch(`/nodes/${first.id}`, {
        json: { parentId: second.id },
        headers: treeHeaders(context, first.version),
      }),
      client.patch(`/nodes/${second.id}`, {
        json: { parentId: first.id },
        headers: treeHeaders(context, second.version),
      }),
    ]);
    expect(cycle.map((row) => row.status).toSorted((left, right) => left - right)).toEqual([
      200, 409,
    ]);
    expect(cycle.find((row) => row.status === 409)?.body).toMatchObject({ code: 'invalid_move' });
    const duplicate = await Promise.all([
      createTreeNode(context, client, vault, { name: 'Clash A' }),
      createTreeNode(context, client, vault, { name: 'Clash B' }),
    ]);
    const collisions = await Promise.all(
      duplicate.map((node) =>
        client.patch(`/nodes/${node.id}`, {
          json: { name: 'Shared' },
          headers: treeHeaders(context, node.version),
        }),
      ),
    );
    expect(collisions.map((row) => row.status).toSorted((left, right) => left - right)).toEqual([
      200, 409,
    ]);
    expect(collisions.find((row) => row.status === 409)?.body).toMatchObject({
      code: 'name_conflict',
    });
    const actual = await context.db
      .selectFrom('vaults')
      .select('tree_version')
      .where('id', '=', idBytes(vault.id))
      .executeTakeFirstOrThrow();
    expect(actual.tree_version).toBe(8);
    const page = await client.get<NodePage>(`/vaults/${vault.id}/nodes`);
    expect(page.status).toBe(200);
    expect(page.body.items).toHaveLength(5);
    expect(new Set(page.body.items.map((node) => node.path)).size).toBe(5);
  });
  it('preserves cascade membership, conflicts, per-node versions and FK-safe purge', async () => {
    const vault = await createTreeVault(context, client, 'Lifecycle');
    const category = await createTreeNode(context, client, vault, { name: 'Group' });
    const nested = await createTreeNode(context, client, vault, {
      name: 'Nested',
      parentId: category.id,
    });
    const note = await createTreeNode(context, client, vault, {
      name: 'Text',
      kind: 'note',
      parentId: nested.id,
      markdown: 'retain this\n',
    });
    const noRecursive = await client.post(`/nodes/${category.id}/trash`, {
      json: {},
      headers: treeHeaders(context, category.version),
    });
    expect(noRecursive.status).toBe(409);
    expect(noRecursive.body).toMatchObject({ code: 'category_not_empty' });
    const trashed = await client.post<TrashNodeResult>(`/nodes/${category.id}/trash`, {
      json: { recursive: true },
      headers: treeHeaders(context, category.version),
    });
    expect(trashed.status).toBe(200);
    expect(trashed.body.nodes.map((node) => node.id)).toEqual([category.id, nested.id, note.id]);
    expect(trashed.body.nodes.every((node) => node.version === 2 && node.deletedAt !== null)).toBe(
      true,
    );
    const cannotRestore = await client.post(`/nodes/${note.id}/restore`, {
      json: {},
      headers: treeHeaders(context, 2),
    });
    expect(cannotRestore.status).toBe(409);
    const member = await client.post<RestoreNodeResult>(`/nodes/${note.id}/restore`, {
      json: { newParentId: vault.rootNodeId },
      headers: treeHeaders(context, 2),
    });
    expect(member.status).toBe(200);
    expect(member.body.nodes.map((node) => node.id)).toEqual([note.id]);
    const restored = await client.post<RestoreNodeResult>(`/nodes/${category.id}/restore`, {
      json: {},
      headers: treeHeaders(context, 2),
    });
    expect(restored.status).toBe(200);
    expect(restored.body.nodes.map((node) => node.id)).toEqual([category.id, nested.id]);
    const intact = await client.get(`/notes/${note.id}/markdown`);
    expect(intact.status).toBe(200);
    expect(intact.body).toBe('retain this\n');
    const retrash = await client.post<TrashNodeResult>(`/nodes/${note.id}/trash`, {
      json: {},
      headers: treeHeaders(context, 3),
    });
    expect(retrash.status).toBe(200);
    const purge = await client.del(`/nodes/${note.id}?purge=true`, {
      headers: treeHeaders(context, 4),
    });
    expect(purge.status).toBe(204);
    expect((await client.get<Node>(`/nodes/${note.id}`)).status).toBe(404);
    expect(
      await context.db
        .selectFrom('note_docs')
        .select('note_id')
        .where('note_id', '=', idBytes(note.id))
        .execute(),
    ).toEqual([]);
  });
});
