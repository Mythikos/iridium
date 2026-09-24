/**
 * `tree.descent-plan.integration` — every descendant walk reads a node's children through
 * `ix_nodes_vault_parent` (03-data-model.md section 6.3).
 *
 * The optimizer costs a recursive member against a one-row estimate of its CTE, and in a flat vault
 * the parent index's rows-per-key is the whole vault. From a few thousand notes it therefore chose
 * `ix_nodes_vault_deleted` or `ix_nodes_vault_name`, re-reading every live node of the vault once
 * per node already reached: 15 s at 4,880 notes on both MySQL lines, which the nightly
 * `persistence.model.prop` met as a note create answering `503 unavailable`. Each walk now names the
 * index in its recursive member (`childLookupHint`), and this file plans the exact statements
 * production runs, through the builders production calls, and reads which index the member uses.
 *
 * The seeded tree is small, and at that size an unhinted walk mostly happens to choose `uq_sibling`.
 * The assertion is on the pinned index rather than on the absence of a slow one, so it holds at any
 * size; with the hint removed, all seven descendant cases fail on 8.4.11 and six on 9.7.2, whose
 * optimizer picks the parent index unaided for one of them at this size. The last case proves in-file
 * that the same reading reports a different index for a walk that uses one: the ancestor walk, which
 * climbs by primary key.
 */
import type { ParsedSearchQuery } from '@iridium/contracts';
import { inspectQueryPlan, keepSchema, type SeededVault } from '@iridium/testkit';
import type { RawBuilder } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { idBytes } from '../../src/auth/ids.ts';
import { vaultNotePaths } from '../../src/projection/index-snapshot.ts';
import { rankedSearchStatement } from '../../src/search/index.ts';
import {
  ancestorsStatement,
  derivedPathsStatement,
  subtreeStatement,
} from '../../src/tree/queries.ts';
import { affectedNodeCount } from '../../src/tree/rename-impact.ts';
import { startAuthServer, type AuthTestServer } from '../support/auth-app.ts';

const PARENT_INDEX = 'ix_nodes_vault_parent';

// Every case plans against the one tree `beforeAll` builds; a per-test reset would leave an empty
// schema, where the search statement's `vaults` join is a constant with no row and plans to nothing.
keepSchema();
let context: AuthTestServer;
let vault: SeededVault;
let categoryId: string;

/**
 * A small tree built through the product's routes: notes under the root and under one category, so
 * the walk has two levels to descend and more than one parent to look children up by.
 */
beforeAll(async () => {
  context = await startAuthServer();
  const admin = await context.server.seed.admin();
  vault = await context.server.seed.vault({ name: 'Descent plans', admin });
  const category = await admin.client.post<{ id: string }>(`/vaults/${vault.id}/nodes`, {
    json: { kind: 'category', name: 'Library', parentId: vault.rootNodeId },
  });
  if (category.status !== 201) throw new Error(`the category answered ${String(category.status)}`);
  categoryId = category.body.id;
  for (const [index, parentId] of [vault.rootNodeId, categoryId, categoryId].entries()) {
    // eslint-disable-next-line no-await-in-loop -- structural writes serialise on the vault lock anyway
    await context.server.seed.note({
      vault,
      admin,
      parentId,
      name: `Note ${String(index)}`,
      markdown: 'text',
    });
  }
});

afterAll(async () => {
  await context?.stop();
});

type PlanNode = Readonly<Record<string, unknown>>;

function planNodes(value: unknown): PlanNode[] {
  if (Array.isArray(value)) return value.flatMap(planNodes);
  if (value === null || typeof value !== 'object') return [];
  const node: PlanNode = Object.fromEntries(Object.entries(value));
  return [node, ...Object.values(node).flatMap(planNodes)];
}

/**
 * Whether a plan node is a recursive member, in either `EXPLAIN FORMAT=JSON` version the two lines
 * default to. Version 1 (8.4) marks the member's own query block `recursive: true`. Version 2 (9.7)
 * puts that mark on the materialization, which holds the anchor too, so there the member is the join
 * that scans the CTE's new records: the anchor never reads the CTE it defines.
 */
function isRecursiveMember(node: PlanNode): boolean {
  if (node['recursive'] === true && 'nested_loop' in node) return true;
  return (
    node['access_type'] === 'join' &&
    planNodes(node['inputs']).some((input) => input['access_type'] === 'scan_new_records')
  );
}

/**
 * Whether a plan node reads the base table `nodes` under `alias`. Version 1 names a table by its alias
 * alone, inside the member's own query block. Version 2 (every node carries an `operation`) gives a
 * base table both `alias` and `table_name` but a CTE only `table_name`, and a join enclosing the whole
 * materialization also contains a new-records scan, so there the base table is checked: the ranked
 * search query reuses the alias for its outer `tree_paths` join.
 */
function readsNodes(node: PlanNode, alias: string): boolean {
  if ('operation' in node) return node['alias'] === alias && node['table_name'] === 'nodes';
  return node['table_name'] === alias;
}

/** The indexes the recursive members of a plan read `nodes`, aliased `alias`, through. */
function recursiveMemberKeys(plan: unknown, alias: string): string[] {
  return planNodes(plan)
    .filter(isRecursiveMember)
    .flatMap(planNodes)
    .flatMap((node) => {
      const index = node['index_name'] ?? node['key'];
      return readsNodes(node, alias) && typeof index === 'string' ? [index] : [];
    });
}

async function childLookups(statement: RawBuilder<unknown>, alias: string): Promise<string[]> {
  const explained = (await inspectQueryPlan(context.db, statement)).rows[0]?.EXPLAIN;
  const plan: unknown = typeof explained === 'string' ? JSON.parse(explained) : explained;
  const keys = recursiveMemberKeys(plan, alias);
  expect(keys, JSON.stringify(plan)).not.toHaveLength(0);
  return keys;
}

describe('tree.descent-plan.integration [area:tree]', () => {
  const vaultId = (): Buffer => idBytes(vault.id);
  const category = (): Buffer => idBytes(categoryId);
  const search: ParsedSearchQuery = {
    raw: 'note',
    terms: ['note'],
    phrases: [],
    negations: [],
    operators: {},
  };
  const cases: ReadonlyArray<readonly [string, () => RawBuilder<unknown>, string]> = [
    ['derived paths', () => derivedPathsStatement(vaultId(), false), 'n'],
    ['derived paths with trashed history', () => derivedPathsStatement(vaultId(), true), 'n'],
    ['a live subtree', () => subtreeStatement(category(), false), 'n'],
    ['a subtree with trashed descendants', () => subtreeStatement(category(), true), 'n'],
    ['the rename-impact subtree', () => affectedNodeCount(vaultId(), category()), 'child'],
    [
      'the projection index snapshot',
      () => vaultNotePaths(idBytes(vault.rootNodeId), vaultId()),
      'n',
    ],
    [
      'search paths',
      () =>
        rankedSearchStatement({
          parsed: search,
          vaultIds: [vault.id],
          pathPrefix: undefined,
          limit: 20,
          after: null,
        }),
      'n',
    ],
  ];

  it.each(cases)('%s reads children through the parent index', async (_name, statement, alias) => {
    expect(new Set(await childLookups(statement(), alias))).toEqual(new Set([PARENT_INDEX]));
  });

  it('reads the ancestor walk as a different lookup, so the cases above cannot pass by default', async () => {
    const keys = await childLookups(ancestorsStatement(category(), idBytes(vault.rootNodeId)), 'n');
    expect(keys).toContain('PRIMARY');
    expect(keys).not.toContain(PARENT_INDEX);
  });
});
