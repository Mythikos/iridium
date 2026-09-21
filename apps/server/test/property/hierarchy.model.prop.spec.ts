/** Independent adjacency model driven exclusively through real REST and observed through MySQL. */
import { it } from '@fast-check/vitest';
import {
  chainIdForVault,
  idFromBytes,
  LIMITS,
  Node,
  type NodePatchResult,
  type RestoreNodeResult,
  type TrashNodeResult,
  type Vault,
} from '@iridium/contracts';
import { keepSchema, PROP_DB, type RestClient } from '@iridium/testkit';
import * as fc from 'fast-check';
import { afterAll, beforeAll, describe, expect } from 'vitest';

import { verifyChain, type AuditKeys } from '../../src/audit/chain.ts';
import { createAuditKeys, readPromotedAuditKeyVersion } from '../../src/audit/keys.ts';
import { idBytes } from '../../src/auth/ids.ts';
import { derivePaths } from '../../src/tree/queries.ts';
import { createTreeNode, createTreeVault, treeHeaders } from '../integration/tree-test-helpers.ts';
import { startAuthServer, webClient, type AuthTestServer } from '../support/auth-app.ts';
import { seedUser, signInWeb, type SeededUser } from '../support/seed.ts';
interface ModelNode {
  readonly id: string;
  readonly kind: 'category' | 'note';
  parent: string;
  name: string;
  version: number;
  trash: { readonly root: string; readonly parent: string; readonly path: string } | null;
}
interface Model {
  readonly nodes: Map<string, ModelNode>;
  readonly rootId: string;
  treeVersion: number;
}
interface Real {
  readonly client: RestClient;
  readonly vault: Vault;
}
type Operation =
  | 'CreateCategory'
  | 'CreateNote'
  | 'Rename'
  | 'Move'
  | 'Trash'
  | 'Restore'
  | 'Purge';
/** The vault that stands at the depth ceiling; the commands never touch it, so it stays valid. */
interface Ceiling {
  readonly vault: Vault;
  /** The category at exactly `LIMITS.TREE_MAX_DEPTH` levels below the root. */
  readonly deepest: string;
  /** A live category at level 1, still at version 1 because every move onto `deepest` is refused. */
  readonly mover: string;
}
keepSchema();
let context: AuthTestServer;
let admin: SeededUser;
let keys: AuditKeys;
let ceiling: Ceiling;
let example = 0;
beforeAll(async () => {
  context = await startAuthServer();
  admin = await seedUser(context, { email: 'hierarchy-model@example.test', isServerAdmin: true });
  keys = createAuditKeys({
    keyring: context.app.iridiumConfig.keys.auditHmac,
    signingVersion: await readPromotedAuditKeyVersion(context.db),
  });
  const client = webClient(context, await signInWeb(context, admin));
  const vault = await createTreeVault(context, client, 'Ceiling');
  let deepest = vault.rootNodeId;
  for (let level = 1; level <= LIMITS.TREE_MAX_DEPTH; level += 1) {
    // eslint-disable-next-line no-await-in-loop -- each level needs its parent's committed identifier
    const created = await createTreeNode(context, client, vault, {
      name: `Deep ${String(level)}`,
      parentId: deepest,
    });
    deepest = created.id;
  }
  const mover = await createTreeNode(context, client, vault, { name: 'Mover' });
  ceiling = { vault, deepest, mover: mover.id };
});
afterAll(async () => {
  await context.stop();
});
function childrenOf(model: Model, id: string): readonly ModelNode[] {
  const result: ModelNode[] = [];
  const frontier = [id];
  while (frontier.length > 0) {
    const current = frontier.shift();
    for (const node of model.nodes.values())
      if (node.parent === current) {
        result.push(node);
        frontier.push(node.id);
      }
  }
  return result;
}
function pathOf(model: Model, node: ModelNode): string {
  if (node.trash !== null) return node.trash.path;
  const parent = model.nodes.get(node.parent);
  return `${parent === undefined ? '' : pathOf(model, parent)}/${node.name}`;
}
/**
 * Levels below the vault root, counted from the model's own adjacency.
 *
 * The depth is modelled rather than read back because `pathsCte` stops recursing at
 * `parent.depth < TREE_MAX_DEPTH` (apps/server/src/tree/queries.ts), so a depth the query reports
 * can never exceed the ceiling and asserting `<= 64` against it would prove nothing. The model is
 * the independent oracle the §6.4 clause "depth never exceeds 64" needs.
 */
function depthOf(model: Model, node: ModelNode): number {
  const parent = model.nodes.get(node.parent);
  return parent === undefined ? 1 : depthOf(model, parent) + 1;
}
/** The depth a prospective parent sits at; the root row is level `0` as `parentDepth` counts it. */
function parentDepthOf(model: Model, id: string): number {
  const node = model.nodes.get(id);
  return node === undefined ? 0 : depthOf(model, node);
}
/** Levels below a node, counting trashed descendants exactly as `subtreeRows(.., true)` does. */
function heightOf(model: Model, node: ModelNode): number {
  const base = depthOf(model, node);
  return Math.max(0, ...childrenOf(model, node.id).map((child) => depthOf(model, child) - base));
}
function collision(model: Model, parent: string, name: string, except?: string): boolean {
  return [...model.nodes.values()].some(
    (node) =>
      node.id !== except &&
      node.trash === null &&
      node.parent === parent &&
      node.name.toLowerCase() === name.toLowerCase(),
  );
}
function targets(model: Model, operation: Operation): readonly ModelNode[] {
  const trashed = operation === 'Restore' || operation === 'Purge';
  return [...model.nodes.values()].filter((node) => (node.trash !== null) === trashed);
}
async function assertModel(model: Model, real: Real): Promise<void> {
  const rows = await context.db
    .selectFrom('nodes')
    .select(['id', 'parent_id', 'name', 'kind', 'version', 'deleted_at'])
    .where('vault_id', '=', idBytes(real.vault.id))
    .execute();
  expect(rows).toHaveLength(model.nodes.size + 1);
  const paths = await derivePaths(context.db, idBytes(real.vault.id), true);
  expect(paths).toHaveLength(model.nodes.size);
  expect(new Set(paths.map((row) => row.id.toString('hex'))).size).toBe(model.nodes.size);
  const derived = new Map(
    paths.map((row) => [idFromBytes(row.id), { path: row.path, depth: row.depth }]),
  );
  for (const row of rows) {
    const id = idFromBytes(row.id);
    if (id === model.rootId) {
      expect(row.id).toEqual(row.parent_id);
      continue;
    }
    const node = model.nodes.get(id);
    expect(node).toBeDefined();
    if (node === undefined)
      throw new Error('Every actual node must have an independent model row.');
    expect({
      parent: idFromBytes(row.parent_id),
      name: row.name,
      kind: row.kind,
      version: row.version,
      trashed: row.deleted_at !== null,
    }).toEqual({
      parent: node.parent,
      name: node.name,
      kind: node.kind,
      version: node.version,
      trashed: node.trash !== null,
    });
    expect(derived.get(id)).toEqual({ path: pathOf(model, node), depth: depthOf(model, node) });
  }
  const entries = await context.db
    .selectFrom('trash_entries')
    .select(['node_id', 'cascade_root_id', 'original_path', 'expires_at', 'deleted_at'])
    .where('vault_id', '=', idBytes(real.vault.id))
    .execute();
  expect(entries).toHaveLength(
    [...model.nodes.values()].filter((node) => node.trash !== null).length,
  );
  for (const entry of entries) {
    const expected = model.nodes.get(idFromBytes(entry.node_id))?.trash;
    expect(expected).toMatchObject({
      root: idFromBytes(entry.cascade_root_id),
      path: entry.original_path,
    });
    expect(entry.expires_at.getTime() - entry.deleted_at.getTime()).toBe(30 * 86_400_000);
  }
  const actual = await context.db
    .selectFrom('vaults')
    .select('tree_version')
    .where('id', '=', idBytes(real.vault.id))
    .executeTakeFirstOrThrow();
  expect(actual.tree_version).toBe(model.treeVersion);
  const audits = await context.db
    .selectFrom('audit_events')
    .select('id')
    .where('vault_id', '=', idBytes(real.vault.id))
    .where('action', 'like', 'node.%')
    .execute();
  expect(audits).toHaveLength(model.treeVersion);
}
/**
 * The ceiling refuses rather than clamps.
 *
 * A create under the deepest level and a move of a live node onto it are both `409 invalid_move`
 * with `reason: 'depth'`, and the walk still reports the same deepest level afterwards. The fixture
 * is built once, in `beforeAll`: `PROP_DB.maxCommands` is 60 on a pull request and each command's
 * parent is chosen at random, so a 64-level branch is unreachable from the commands themselves,
 * while rebuilding one inside every example would cost 64 structural writes per run and prove
 * nothing the one chain does not.
 */
async function assertCeilingRefusals(client: RestClient): Promise<void> {
  const created = await client.post(`/vaults/${ceiling.vault.id}/nodes`, {
    json: { kind: 'category', name: 'Overflow', parentId: ceiling.deepest },
    headers: { origin: context.origin },
  });
  expect(created.status).toBe(409);
  expect(created.body).toMatchObject({ code: 'invalid_move', errors: [{ code: 'depth' }] });
  const moved = await client.patch(`/nodes/${ceiling.mover}`, {
    json: { parentId: ceiling.deepest },
    headers: treeHeaders(context, 1),
  });
  expect(moved.status).toBe(409);
  expect(moved.body).toMatchObject({ code: 'invalid_move', errors: [{ code: 'depth' }] });
  const paths = await derivePaths(context.db, idBytes(ceiling.vault.id), true);
  expect(paths).toHaveLength(LIMITS.TREE_MAX_DEPTH + 1);
  expect(Math.max(...paths.map((row) => row.depth))).toBe(LIMITS.TREE_MAX_DEPTH);
}
class HierarchyCommand implements fc.AsyncCommand<Model, Real> {
  readonly operation: Operation;
  readonly selector: number;
  readonly parentSelector: number;
  readonly name: string;
  readonly stale: boolean;
  readonly recursive: boolean;
  constructor(input: {
    operation: Operation;
    selector: number;
    parentSelector: number;
    name: string;
    stale: boolean;
    recursive: boolean;
  }) {
    this.operation = input.operation;
    this.selector = input.selector;
    this.parentSelector = input.parentSelector;
    this.name = input.name;
    this.stale = input.stale;
    this.recursive = input.recursive;
  }
  check(model: Readonly<Model>): boolean {
    return this.operation.startsWith('Create') || targets(model, this.operation).length > 0;
  }
  async run(model: Model, real: Real): Promise<void> {
    const categories = [
      model.rootId,
      ...[...model.nodes.values()]
        .filter((node) => node.kind === 'category' && node.trash === null)
        .map((node) => node.id),
    ];
    const parent = categories[this.parentSelector % categories.length];
    if (parent === undefined) throw new Error('The model always has a root category.');
    if (this.operation === 'CreateCategory' || this.operation === 'CreateNote') {
      const kind = this.operation === 'CreateCategory' ? 'category' : 'note';
      // `createNode` checks the ceiling before it inserts, so depth is decided ahead of the
      // `uq_sibling` collision the insert would raise (apps/server/src/tree/service.ts).
      const tooDeep = parentDepthOf(model, parent) + 1 > LIMITS.TREE_MAX_DEPTH;
      const conflict = collision(model, parent, this.name);
      const response = await real.client.post(`/vaults/${real.vault.id}/nodes`, {
        json: {
          kind,
          name: this.name,
          parentId: parent,
          ...(kind === 'note' ? { markdown: 'model content' } : {}),
        },
        headers: { origin: context.origin },
      });
      // oxlint-disable-next-line vitest/no-standalone-expect -- fast-check invokes this model command or invariant from inside the declared property test
      expect(response.status).toBe(tooDeep || conflict ? 409 : 201);
      if (tooDeep) {
        // oxlint-disable-next-line vitest/no-standalone-expect -- fast-check invokes this model command or invariant from inside the declared property test
        expect(response.body).toMatchObject({ code: 'invalid_move', errors: [{ code: 'depth' }] });
      }
      if (!tooDeep && !conflict) {
        const created = Node.parse(response.body);
        model.nodes.set(created.id, {
          id: created.id,
          parent,
          name: this.name,
          kind,
          version: 1,
          trash: null,
        });
        model.treeVersion += 1;
      }
      await assertModel(model, real);
      return;
    }
    const eligible = targets(model, this.operation);
    const node = eligible[this.selector % eligible.length];
    if (node === undefined) throw new Error('A checked command must have a target.');
    const headers = treeHeaders(context, node.version + (this.stale ? 1 : 0));
    const descendants = childrenOf(model, node.id);
    let refused = this.stale;
    let depthRefused = false;
    let accepted: () => void;
    let response: { readonly status: number; readonly body: unknown };
    switch (this.operation) {
      case 'Rename': {
        refused ||= collision(model, node.parent, this.name, node.id);
        response = await real.client.patch<NodePatchResult>(`/nodes/${node.id}`, {
          json: { name: this.name },
          headers,
        });
        accepted = () => {
          node.name = this.name;
          node.version += 1;
        };
        break;
      }
      case 'Move': {
        const cycle = parent === node.id || descendants.some((child) => child.id === parent);
        // `validateParent` checks the cycle first, then the ceiling, and only then does
        // `assertSiblingAvailable` collate the name (apps/server/src/tree/mutations.ts), so a move
        // that is neither stale nor cyclic and would land below level 64 reports `depth`.
        depthRefused =
          !refused &&
          !cycle &&
          parentDepthOf(model, parent) + 1 + heightOf(model, node) > LIMITS.TREE_MAX_DEPTH;
        refused ||= cycle || depthRefused || collision(model, parent, node.name, node.id);
        response = await real.client.patch<NodePatchResult>(`/nodes/${node.id}`, {
          json: { parentId: parent },
          headers,
        });
        accepted = () => {
          node.parent = parent;
          node.version += 1;
        };
        break;
      }
      case 'Trash': {
        const affected = [node, ...descendants.filter((child) => child.trash === null)];
        refused ||= !this.recursive && affected.length > 1;
        const previous = affected.map((child) => ({ node: child, path: pathOf(model, child) }));
        response = await real.client.post<TrashNodeResult>(`/nodes/${node.id}/trash`, {
          json: { recursive: this.recursive },
          headers,
        });
        accepted = () => {
          for (const child of previous) {
            child.node.trash = { root: node.id, parent: child.node.parent, path: child.path };
            child.node.version += 1;
          }
        };
        break;
      }
      case 'Restore': {
        const group =
          node.trash?.root === node.id
            ? [...model.nodes.values()].filter((child) => child.trash?.root === node.id)
            : [node];
        const restoredName = `Restored ${node.id} ${String(node.version)}`;
        response = await real.client.post<RestoreNodeResult>(`/nodes/${node.id}/restore`, {
          json: { newParentId: model.rootId, newName: restoredName },
          headers,
        });
        accepted = () => {
          for (const child of group) {
            child.parent =
              child.id === node.id ? model.rootId : (child.trash?.parent ?? child.parent);
            child.trash = null;
            child.version += 1;
          }
          node.name = restoredName;
        };
        break;
      }
      case 'Purge': {
        response = await real.client.del(`/nodes/${node.id}?purge=true`, { headers });
        accepted = () => {
          for (const child of [node, ...descendants]) model.nodes.delete(child.id);
        };
        break;
      }
    }
    // oxlint-disable-next-line vitest/no-standalone-expect -- fast-check invokes this model command or invariant from inside the declared property test
    expect(response.status).toBe(refused ? 409 : this.operation === 'Purge' ? 204 : 200);
    if (refused) {
      // oxlint-disable-next-line vitest/no-standalone-expect -- fast-check invokes this model command or invariant from inside the declared property test
      expect(response.body).toHaveProperty('code');
      if (depthRefused) {
        // oxlint-disable-next-line vitest/no-standalone-expect -- fast-check invokes this model command or invariant from inside the declared property test
        expect(response.body).toMatchObject({ code: 'invalid_move', errors: [{ code: 'depth' }] });
      }
    } else {
      accepted();
      model.treeVersion += 1;
    }
    await assertModel(model, real);
  }
  toString(): string {
    return `${this.operation}(${String(this.selector)},parent=${String(this.parentSelector)},name=${this.name},stale=${String(this.stale)},recursive=${String(this.recursive)})`;
  }
}
const command = fc
  .record({
    operation: fc.constantFrom<Operation>(
      'CreateCategory',
      'CreateNote',
      'Rename',
      'Move',
      'Trash',
      'Restore',
      'Purge',
    ),
    selector: fc.nat(100),
    parentSelector: fc.nat(100),
    name: fc.integer({ min: 0, max: 12 }).map((id) => `Name ${String(id)}`),
    stale: fc.boolean(),
    recursive: fc.boolean(),
  })
  .map((input) => new HierarchyCommand(input));
describe('hierarchy.model.prop [area:tree] [spec:structural-concurrency]', () => {
  it.prop([fc.commands([command], { maxCommands: PROP_DB.maxCommands })], PROP_DB)(
    'keeps the adjacency model, lifecycle rows, paths, validators and audit chain in agreement',
    async (commands) => {
      example += 1;
      context.clock.jump(context.clock.now() + 61_000);
      const client = webClient(context, await signInWeb(context, admin));
      const vault = await createTreeVault(context, client, `Model ${String(example)}`);
      const model: Model = { nodes: new Map(), rootId: vault.rootNodeId, treeVersion: 0 };
      const real = { client, vault };
      await assertCeilingRefusals(client);
      await fc.asyncModelRun(() => ({ model, real }), commands);
      await assertModel(model, real);
      // oxlint-disable-next-line vitest/no-standalone-expect -- fast-check invokes this model command or invariant from inside the declared property test
      expect((await verifyChain(context.db, chainIdForVault(vault.id), keys)).ok).toBe(true);
    },
  );
});
