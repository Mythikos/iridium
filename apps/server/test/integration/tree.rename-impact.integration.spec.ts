import type {
  InboundLinksPage,
  NodePatchResult,
  RenameImpactResult,
  RestoreNodeResult,
  TrashNodeResult,
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
    email: 'rename-impact@example.test',
    isServerAdmin: true,
  });
  client = webClient(context, await signInWeb(context, admin));
});
afterAll(async () => {
  await context.stop();
});

async function snapshot(): Promise<readonly unknown[]> {
  const tables = [
    'nodes',
    'vaults',
    'trash_entries',
    'note_links',
    'note_docs',
    'note_updates',
    'note_projections',
    'audit_events',
    'audit_chain_heads',
  ] as const;
  return Promise.all(tables.map((table) => context.db.selectFrom(table).selectAll().execute()));
}

describe('tree.rename-impact.integration [area:links]', () => {
  it('aggregates a whole target subtree while sampling and paging references in binary path order', async () => {
    const vault = await createTreeVault(context, client, 'Bounded link warnings');
    const folder = await createTreeNode(context, client, vault, { name: 'Folder' });
    const firstTarget = await createTreeNode(context, client, vault, {
      name: 'First',
      kind: 'note',
      parentId: folder.id,
    });
    const secondTarget = await createTreeNode(context, client, vault, {
      name: 'Second',
      kind: 'note',
      parentId: folder.id,
    });
    await createTreeNode(context, client, vault, { name: 'Unrelated', kind: 'note' });
    const sourcePaths = new Map<string, string>();
    for (const name of ['é source', 'Z source', 'B source', '🪨 source']) {
      const markdown =
        Array.from(
          { length: 75 },
          (_, index) =>
            `[reference${String(index)}](Folder/${index % 2 === 0 ? 'First' : 'Second'}.md)`,
        ).join('\n') + '\n[outside](Unrelated.md)';
      // eslint-disable-next-line no-await-in-loop -- fixture writes use the real structural lock and projection service
      const source = await createTreeNode(context, client, vault, { name, kind: 'note', markdown });
      sourcePaths.set(source.id.replaceAll('-', ''), source.path);
    }
    const references = await context.db
      .selectFrom('note_links')
      .select(['id', 'from_note_id', 'line', 'raw_target'])
      .where('resolved_node_id', 'in', [idBytes(firstTarget.id), idBytes(secondTarget.id)])
      .execute();
    const expected = references
      .map((row) => ({
        id: row.id,
        fromPath: sourcePaths.get(row.from_note_id.toString('hex')) ?? '',
        line: row.line,
        rawTarget: row.raw_target,
      }))
      .toSorted(
        (left, right) =>
          Buffer.compare(Buffer.from(left.fromPath), Buffer.from(right.fromPath)) ||
          left.id - right.id,
      );
    expect(expected).toHaveLength(300);
    const preview = await client.patch<NodePatchResult>(`/nodes/${folder.id}`, {
      json: { name: 'Moved', dryRun: true },
      headers: treeHeaders(context, folder.version),
    });
    expect(preview.status).toBe(200);
    expect(preview.body.affectedLinks.total).toBe(300);
    expect(preview.body.affectedLinks.byStatus).toEqual({
      resolved: 300,
      ambiguous: 0,
      broken: 0,
      external: 0,
    });
    expect(
      preview.body.affectedLinks.samples.map(({ fromPath, line, rawTarget }) => ({
        fromPath,
        line,
        rawTarget,
      })),
    ).toEqual(
      expected.slice(0, 50).map(({ fromPath, line, rawTarget }) => ({ fromPath, line, rawTarget })),
    );
    const ids: number[] = [];
    let cursor: string | undefined;
    do {
      // eslint-disable-next-line no-await-in-loop -- each opaque cursor comes from the preceding actual SQL page
      const response = await client.get<InboundLinksPage>(`/nodes/${folder.id}/inbound-links`, {
        query: { limit: 17, status: 'resolved', cursor },
      });
      expect(response.status).toBe(200);
      expect(response.body.subtreeNodeIds).toBe(3);
      expect(response.body.items.length).toBeLessThanOrEqual(17);
      ids.push(...response.body.items.map((row) => row.id));
      cursor = response.body.nextCursor;
    } while (cursor !== undefined);
    expect(ids).toEqual(expected.map((row) => row.id));
    const empty = await client.get<InboundLinksPage>(`/nodes/${folder.id}/inbound-links`, {
      query: { status: 'broken' },
    });
    expect(empty.body.items).toEqual([]);
    expect(empty.body.subtreeNodeIds).toBe(3);
  });

  it('shares the exact target-side impact, previews without writes and preserves every linking note', async () => {
    const vault = await createTreeVault(context, client, 'Link warnings');
    const target = await createTreeNode(context, client, vault, { name: 'Target', kind: 'note' });
    const first = await createTreeNode(context, client, vault, {
      name: 'A source',
      kind: 'note',
      markdown: '[one](Target.md) [two](Target.md)\n',
    });
    const second = await createTreeNode(context, client, vault, {
      name: 'B source',
      kind: 'note',
      markdown: '[three](Target.md)\n',
    });
    const links = await context.db
      .selectFrom('note_links')
      .selectAll()
      .where('resolved_node_id', '=', idBytes(target.id))
      .orderBy('id')
      .execute();
    expect(links).toHaveLength(3);
    const before = await snapshot();
    const preview = await client.patch<NodePatchResult>(`/nodes/${target.id}`, {
      json: { name: 'Destination', dryRun: true },
      headers: treeHeaders(context, target.version),
    });
    expect(preview.status).toBe(200);
    expect(preview.body.node.name).toBe('Target');
    expect(preview.body.affectedLinks).toMatchObject({
      total: links.length,
      byStatus: { resolved: 3, ambiguous: 0, broken: 0, external: 0 },
    });
    expect(await snapshot()).toEqual(before);
    const readerPreview = await client.get<RenameImpactResult>(
      `/notes/${target.id}/rename-impact?name=Destination`,
    );
    expect(readerPreview.status).toBe(200);
    expect(readerPreview.body).toEqual({
      affectedLinks: preview.body.affectedLinks,
      wouldConflict: false,
      newPath: '/Destination',
    });
    const inbound = await client.get<InboundLinksPage>(`/nodes/${target.id}/inbound-links?limit=2`);
    expect(inbound.status).toBe(200);
    expect(inbound.body.items).toHaveLength(2);
    const next = await client.get<InboundLinksPage>(
      `/nodes/${target.id}/inbound-links?limit=2&cursor=${encodeURIComponent(inbound.body.nextCursor ?? '')}`,
    );
    expect(next.body.items).toHaveLength(1);
    expect(new Set([...inbound.body.items, ...next.body.items].map((row) => row.id))).toEqual(
      new Set(links.map((row) => row.id)),
    );
    const projections = await context.db
      .selectFrom('note_projections')
      .selectAll()
      .where('note_id', 'in', [idBytes(first.id), idBytes(second.id)])
      .orderBy('note_id')
      .execute();
    const accepted = await client.patch<NodePatchResult>(`/nodes/${target.id}`, {
      json: { name: 'Destination' },
      headers: treeHeaders(context, target.version),
    });
    expect(accepted.status).toBe(200);
    expect(accepted.body.affectedLinks).toEqual(preview.body.affectedLinks);
    expect(accepted.body.node.path).toBe('/Destination');
    expect(
      await context.db
        .selectFrom('note_projections')
        .selectAll()
        .where('note_id', 'in', [idBytes(first.id), idBytes(second.id)])
        .orderBy('note_id')
        .execute(),
    ).toEqual(projections);
  });

  it('checks database sibling collation on previews, writes and restores and preserves trash on a restore preview', async () => {
    const vault = await createTreeVault(context, client, 'Collation preview');
    const target = await createTreeNode(context, client, vault, { name: 'Target', kind: 'note' });
    await createTreeNode(context, client, vault, { name: 'Resume' });
    const preview = await client.get<RenameImpactResult>(
      `/notes/${target.id}/rename-impact?name=resume`,
    );
    expect(preview.body.wouldConflict).toBe(true);
    const accented = await client.get<RenameImpactResult>(
      `/notes/${target.id}/rename-impact?name=${encodeURIComponent('Résumé')}`,
    );
    expect(accented.body.wouldConflict).toBe(false);
    for (const dryRun of [true, false]) {
      // eslint-disable-next-line no-await-in-loop -- both requests must inspect the same untouched version
      const response = await client.patch(`/nodes/${target.id}`, {
        json: { name: 'resume', dryRun },
        headers: treeHeaders(context, 1),
      });
      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({ code: 'name_conflict' });
    }
    const trashed = await client.post<TrashNodeResult>(`/nodes/${target.id}/trash`, {
      json: {},
      headers: treeHeaders(context, 1),
    });
    expect(trashed.status).toBe(200);
    const before = await snapshot();
    const restorePreview = await client.post<RestoreNodeResult>(`/nodes/${target.id}/restore`, {
      json: { dryRun: true },
      headers: treeHeaders(context, 2),
    });
    expect(restorePreview.status).toBe(200);
    expect(restorePreview.body.dryRun).toBe(true);
    expect(restorePreview.body.nodes[0]?.deletedAt).not.toBeNull();
    expect(await snapshot()).toEqual(before);
    for (const dryRun of [true, false]) {
      // eslint-disable-next-line no-await-in-loop -- a refused preview and write must leave the same trash validator
      const response = await client.post(`/nodes/${target.id}/restore`, {
        json: { newName: 'resume', dryRun },
        headers: treeHeaders(context, 2),
      });
      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({ code: 'name_conflict' });
    }
  });
});
