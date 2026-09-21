import type { Node, NodePage, TreePage } from '@iridium/contracts';
import type { RestClient } from '@iridium/testkit';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { idBytes } from '../../src/auth/ids.ts';
import { startAuthServer, webClient, type AuthTestServer } from '../support/auth-app.ts';
import { seedUser, signInWeb } from '../support/seed.ts';
import { createTreeNode, createTreeVault, treeHeaders } from './tree-test-helpers.ts';

let context: AuthTestServer;
let client: RestClient;
beforeAll(async () => {
  context = await startAuthServer();
});
beforeEach(async () => {
  const admin = await seedUser(context, { email: 'root-row@example.test', isServerAdmin: true });
  client = webClient(context, await signInWeb(context, admin));
});
afterAll(async () => {
  await context.stop();
});

describe('tree.root-row.integration [spec:structural-concurrency]', () => {
  it('has one self-parented root, excludes it from children and forbids every lifecycle mutation', async () => {
    const vault = await createTreeVault(context, client, 'Root convention');
    const child = await createTreeNode(context, client, vault, { name: 'Child' });
    const root = await client.get<Node>(`/nodes/${vault.rootNodeId}`);
    expect(root.body).toMatchObject({
      path: '',
      parentId: vault.rootNodeId,
      name: '',
      kind: 'category',
    });
    const roots = await context.db
      .selectFrom('nodes')
      .select('id')
      .where('vault_id', '=', idBytes(vault.id))
      .whereRef('id', '=', 'parent_id')
      .execute();
    expect(roots).toHaveLength(1);
    const responses = await Promise.all([
      client.patch(`/nodes/${vault.rootNodeId}`, {
        json: { name: 'Renamed' },
        headers: treeHeaders(context, root.body.version),
      }),
      client.patch(`/nodes/${vault.rootNodeId}`, {
        json: { parentId: child.id },
        headers: treeHeaders(context, root.body.version),
      }),
      client.post(`/nodes/${vault.rootNodeId}/trash`, {
        json: { recursive: true },
        headers: treeHeaders(context, root.body.version),
      }),
      client.post(`/nodes/${vault.rootNodeId}/restore`, {
        json: {},
        headers: treeHeaders(context, root.body.version),
      }),
      client.del(`/nodes/${vault.rootNodeId}?purge=true`, {
        headers: treeHeaders(context, root.body.version),
      }),
    ]);
    expect(responses.every((response) => response.status === 409)).toBe(true);
    const children = await client.get<TreePage>(`/vaults/${vault.id}/tree`);
    const flat = await client.get<NodePage>(`/vaults/${vault.id}/nodes`);
    expect(children.body.parent.id).toBe(vault.rootNodeId);
    expect(children.body.items.map((node) => node.id)).toEqual([child.id]);
    expect(flat.body.items.map((node) => node.path)).toEqual(['/Child']);
    expect(flat.body.treeVersion).toBe(1);
  });
});
