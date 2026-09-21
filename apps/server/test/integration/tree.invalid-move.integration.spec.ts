import {
  INVALID_MOVE_REASONS,
  LIMITS,
  type InvalidMoveReason,
  type Node,
  type ProblemDetails,
  type TrashNodeResult,
  type Vault,
} from '@iridium/contracts';
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
  const admin = await seedUser(context, {
    email: 'invalid-move@example.test',
    isServerAdmin: true,
  });
  client = webClient(context, await signInWeb(context, admin));
});
afterAll(async () => {
  await context.stop();
});

interface MoveCase {
  readonly target: Node;
  readonly parent: string;
  readonly vault: Vault;
}
const CASES = {
  cycle: async (vault: Vault, target: Node): Promise<string> =>
    (await createTreeNode(context, client, vault, { name: 'Child', parentId: target.id })).id,
  cross_vault: async (): Promise<string> =>
    (await createTreeVault(context, client, 'Other')).rootNodeId,
  parent_not_category: async (vault: Vault): Promise<string> =>
    (await createTreeNode(context, client, vault, { name: 'Parent note', kind: 'note' })).id,
  depth: async (vault: Vault): Promise<string> => {
    let parent = vault.rootNodeId;
    for (let depth = 0; depth < LIMITS.TREE_MAX_DEPTH; depth += 1) {
      // eslint-disable-next-line no-await-in-loop -- each category depends on its parent's committed identifier
      const child = await createTreeNode(context, client, vault, {
        name: `Level ${String(depth)}`,
        parentId: parent,
      });
      parent = child.id;
    }
    return parent;
  },
} satisfies Record<InvalidMoveReason, (vault: Vault, target: Node) => Promise<string>>;

async function fixture(reason: InvalidMoveReason): Promise<MoveCase> {
  const vault = await createTreeVault(context, client, `Invalid ${reason}`);
  const target = await createTreeNode(context, client, vault, { name: 'Target' });
  const parent = await CASES[reason](vault, target);
  return { target, parent, vault };
}

describe('tree.invalid-move.integration [spec:structural-concurrency]', () => {
  it.each(INVALID_MOVE_REASONS)(
    'refuses %s identically for PATCH and restore, including both previews',
    async (reason) => {
      const { target, parent, vault } = await fixture(reason);
      const before = await context.db
        .selectFrom('nodes')
        .selectAll()
        .where('vault_id', '=', idBytes(vault.id))
        .orderBy('id')
        .execute();
      for (const dryRun of [true, false]) {
        // eslint-disable-next-line no-await-in-loop -- preview and write must prove the same refusal against unchanged rows
        const response = await client.patch<ProblemDetails>(`/nodes/${target.id}`, {
          json: { parentId: parent, dryRun },
          headers: treeHeaders(context, target.version),
        });
        expect(response.status).toBe(409);
        expect(response.body).toMatchObject({ code: 'invalid_move', errors: [{ code: reason }] });
      }
      expect(
        await context.db
          .selectFrom('nodes')
          .selectAll()
          .where('vault_id', '=', idBytes(vault.id))
          .orderBy('id')
          .execute(),
      ).toEqual(before);
      const trashed = await client.post<TrashNodeResult>(`/nodes/${target.id}/trash`, {
        json: { recursive: true },
        headers: treeHeaders(context, target.version),
      });
      expect(trashed.status).toBe(200);
      for (const dryRun of [true, false]) {
        // eslint-disable-next-line no-await-in-loop -- every refusal must leave this same tombstone version available
        const response = await client.post<ProblemDetails>(`/nodes/${target.id}/restore`, {
          json: { newParentId: parent, dryRun },
          headers: treeHeaders(context, trashed.body.trashEntry.version),
        });
        expect(response.status).toBe(409);
        expect(response.body).toMatchObject({ code: 'invalid_move', errors: [{ code: reason }] });
      }
      const unchanged = await context.db
        .selectFrom('nodes')
        .select(['vault_id', 'version'])
        .where('id', '=', idBytes(target.id))
        .executeTakeFirstOrThrow();
      expect(unchanged.vault_id).toEqual(idBytes(vault.id));
      expect(unchanged.version).toBe(2);
    },
  );
});
