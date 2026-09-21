/** Expiration uses the same product purge as a user, with a system actor and an owner fence. */
import { NodeId, VaultId, type TrashNodeResult } from '@iridium/contracts';
import { describe, expect, it } from 'vitest';

import { idBytes } from '../../src/auth/ids.ts';
import { startAuthServer, webClient } from '../support/auth-app.ts';
import { seedUser, signInWeb } from '../support/seed.ts';
import { createTreeNode, createTreeVault, treeHeaders } from './tree-test-helpers.ts';

describe('tree.trash-retention.integration [area:tree]', () => {
  it('preserves every row before expiry, skips stale and member candidates, and purges at expires_at', async () => {
    const context = await startAuthServer({ extraEnv: { JOBS_ENABLED: 'false' } });
    try {
      const admin = await seedUser(context, {
        email: 'trash-retention@example.test',
        isServerAdmin: true,
      });
      const client = webClient(context, await signInWeb(context, admin));
      const vault = await createTreeVault(context, client, 'Retained trash');
      const category = await createTreeNode(context, client, vault, { name: 'Category' });
      const note = await createTreeNode(context, client, vault, {
        name: 'Child',
        kind: 'note',
        parentId: category.id,
        markdown: '---\ntags: [retention]\naliases: [retained-note]\n---\nretained until expiry',
      });
      const trashed = await client.post<TrashNodeResult>(`/nodes/${category.id}/trash`, {
        json: { recursive: true },
        headers: treeHeaders(context, category.version),
      });
      expect(trashed.status).toBe(200);
      const expiry = new Date(trashed.body.trashEntry.expiresAt);
      const snapshot = (): Promise<readonly unknown[]> =>
        Promise.all(
          (
            [
              'nodes',
              'vaults',
              'trash_entries',
              'note_docs',
              'note_updates',
              'note_revisions',
              'note_projections',
              'note_projection_terms',
              'note_search',
              'audit_events',
              'audit_chain_heads',
            ] as const
          ).map((table) => context.db.selectFrom(table).selectAll().execute()),
        );
      const before = await snapshot();
      expect(
        await context.db
          .selectFrom('note_projection_terms')
          .selectAll()
          .where('note_id', '=', idBytes(note.id))
          .execute(),
      ).toHaveLength(2);
      const purge = (nodeId: string, version: number, at: Date) =>
        context.app.purgeExpiredTrash({
          vaultId: VaultId.parse(vault.id),
          nodeId: NodeId.parse(nodeId),
          version,
          expiresBefore: at,
          ownerFence: context.app.collab.ownerLease.captureFence(),
          context: { client: 'job' },
        });
      context.clock.jump(expiry.getTime() - 1);
      expect(await purge(category.id, 2, context.clock.date())).toEqual({
        status: 'skipped',
        reason: 'not_expired',
      });
      expect(await purge(category.id, 1, expiry)).toEqual({ status: 'skipped', reason: 'changed' });
      expect(await purge(note.id, 2, expiry)).toEqual({ status: 'skipped', reason: 'not_root' });
      expect(await snapshot()).toEqual(before);
      context.clock.jump(expiry.getTime());
      const purged = await purge(category.id, 2, context.clock.date());
      expect(purged.status).toBe('purged');
      if (purged.status !== 'purged') throw new Error('The expiry boundary must purge.');
      expect(purged.treeVersion).toBe(trashed.body.treeVersion + 1);
      expect(purged.nodes.map((node) => node.id).toSorted()).toEqual(
        [category.id, note.id].toSorted(),
      );
      expect(
        await context.db
          .selectFrom('nodes')
          .select('id')
          .where('id', 'in', [idBytes(category.id), idBytes(note.id)])
          .execute(),
      ).toEqual([]);
      expect(
        await context.db
          .selectFrom('trash_entries')
          .select('node_id')
          .where('vault_id', '=', idBytes(vault.id))
          .execute(),
      ).toEqual([]);
      for (const table of [
        'note_docs',
        'note_updates',
        'note_revisions',
        'note_projections',
        'note_projection_terms',
        'note_search',
      ] as const) {
        expect(
          // eslint-disable-next-line no-await-in-loop -- prove every content-dependent table was removed by the one committed purge
          await context.db
            .selectFrom(table)
            .select('note_id')
            .where('note_id', '=', idBytes(note.id))
            .execute(),
        ).toEqual([]);
      }
      const audit = await context.db
        .selectFrom('audit_events')
        .select(['actor_type', 'actor_id', 'metadata'])
        .where('action', '=', 'node.purged')
        .where('vault_id', '=', idBytes(vault.id))
        .execute();
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actor_type: 'system', actor_id: null });
      expect(await purge(category.id, 2, context.clock.date())).toEqual({
        status: 'skipped',
        reason: 'missing',
      });
      expect(
        await context.db
          .selectFrom('audit_events')
          .select('id')
          .where('action', '=', 'node.purged')
          .where('vault_id', '=', idBytes(vault.id))
          .execute(),
      ).toHaveLength(1);
    } finally {
      await context.stop();
    }
  });
});
