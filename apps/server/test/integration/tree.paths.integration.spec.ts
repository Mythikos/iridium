import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { idFromBytes, NodeId, SessionId, UserId, VaultId, type NodePage } from '@iridium/contracts';
import {
  IRIDIUM_FIXTURE_VERSION,
  seedStructure,
  type RestClient,
  type StructureNode,
} from '@iridium/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { idBytes } from '../../src/auth/ids.ts';
import { derivePath } from '../../src/tree/paths.ts';
import { derivePaths } from '../../src/tree/queries.ts';
import { createNode } from '../../src/tree/service.ts';
import { startAuthServer, webClient, type AuthTestServer } from '../support/auth-app.ts';
import { createStructureWriter } from '../support/seed-structure.ts';
import { seedUser, signInWeb } from '../support/seed.ts';
import { createTreeVault } from './tree-test-helpers.ts';
let context: AuthTestServer;
let client: RestClient;
beforeAll(async () => {
  context = await startAuthServer({ structureWriter: createStructureWriter });
});
afterAll(async () => {
  await context.stop();
});

async function pathFixture(size: 10_000 | 20_000): Promise<{
  readonly vaultId: string;
  readonly nodes: readonly StructureNode[];
  readonly client: RestClient;
}> {
  if (size === 20_000) {
    const fixture = await context.server.seed.structure({
      progress: (created) =>
        process.stdout.write(`[tree-20000] ${String(created)} committed nodes\n`),
    });
    return { vaultId: fixture.vault.id, nodes: fixture.nodes, client: fixture.admin.client };
  }
  const admin = await seedUser(context, {
    email: 'paths-10000@example.test',
    isServerAdmin: true,
  });
  const fixtureClient = webClient(context, await signInWeb(context, admin));
  const vault = await createTreeVault(context, fixtureClient, 'tree-10000');
  const session = await context.db
    .selectFrom('sessions')
    .select('id')
    .where('user_id', '=', idBytes(admin.id))
    .executeTakeFirstOrThrow();
  const actor = {
    userId: UserId.parse(admin.id),
    sessionId: SessionId.parse(idFromBytes(session.id)),
    displayName: 'Tree fixture',
  };
  const deps = {
    db: context.db,
    audit: context.app.audit,
    clock: context.clock,
    notes: context.app.notes,
    searchIndex: context.app.searchIndex,
    ownerFence: context.app.collab.ownerLease.captureFence(),
  };
  const nodes = await seedStructure({
    rootId: vault.rootNodeId,
    size: size - 1,
    create: async (input) =>
      (
        await createNode(deps, {
          ...input,
          vaultId: VaultId.parse(vault.id),
          actor,
          context: { client: 'tree-fixture' },
        })
      ).node,
    progress: (created) =>
      process.stdout.write(`[tree-10000] ${String(created)} committed categories\n`),
  });
  return { vaultId: vault.id, nodes, client: fixtureClient };
}
describe('tree.paths.integration [area:tree] [spec:structural-concurrency]', () => {
  it.each([10_000, 20_000] as const)(
    'derives the generated tree-%i paths and records the normative latency',
    async (size) => {
      const fixture = await pathFixture(size);
      client = fixture.client;
      const expected = fixture.nodes;
      const paths = await derivePaths(context.db, idBytes(fixture.vaultId));
      expect(paths).toHaveLength(expected.length);
      const byId = new Map(paths.map((row) => [idFromBytes(row.id), row.path]));
      for (const node of expected) expect(byId.get(node.id)).toBe(node.path);
      const target = expected.at(-1);
      if (target === undefined) throw new Error('A nonempty generated tree has a final node.');
      await derivePath(context.db, idBytes(NodeId.parse(target.id)));
      const started = performance.now();
      const path = await derivePath(context.db, idBytes(NodeId.parse(target.id)));
      const pathMs = performance.now() - started;
      expect(path.path).toBe(target.path);
      // oxlint-disable-next-line vitest/no-conditional-expect -- both fixture sizes run, and the specification gives each size its own measured assertion
      if (size === 10_000) expect(pathMs).toBeLessThan(50);
      const timings: number[] = [];
      if (size === 20_000) {
        for (let run = 0; run < 32; run += 1) {
          const requestStarted = performance.now();
          // eslint-disable-next-line no-await-in-loop -- measure individual requests, with two warm-up requests
          const page = await client.get<NodePage>(`/vaults/${fixture.vaultId}/nodes?limit=500`);
          const elapsed = performance.now() - requestStarted;
          // oxlint-disable-next-line vitest/no-conditional-expect -- both fixture sizes run, and the specification gives each size its own measured assertion
          expect(page.status).toBe(200);
          // oxlint-disable-next-line vitest/no-conditional-expect -- both fixture sizes run, and the specification gives each size its own measured assertion
          expect(page.body.items).toHaveLength(500);
          if (run >= 2) timings.push(elapsed);
        }
      }
      const sorted = timings.toSorted((left, right) => left - right);
      const p95Ms = sorted.length === 0 ? null : sorted[Math.ceil(sorted.length * 0.95) - 1];
      const record = {
        suite: 'tree.paths.integration',
        fixture: size === 10_000 ? 'tree-10k' : 'tree-20k',
        fixtureVersion: IRIDIUM_FIXTURE_VERSION,
        mysqlImage: process.env['IRIDIUM_MYSQL_IMAGE'] ?? 'mysql:8.4.11',
        nodeCount: size,
        listedNodeCount: expected.length,
        storedNodeCount: expected.length + 1,
        pathMs,
        samples: timings.length,
        listP95Ms: p95Ms,
        pathCacheTriggerExceeded: p95Ms !== null && p95Ms !== undefined && p95Ms > 200,
      };
      const directory = join(process.cwd(), 'reports', 'perf');
      await mkdir(directory, { recursive: true });
      await appendFile(join(directory, 'tree-paths.jsonl'), `${JSON.stringify(record)}\n`);
      process.stdout.write(`${JSON.stringify(record)}\n`);
    },
    900_000,
  );
});
