/** The scheduled purge uses the real tree lifecycle and never shortens an expiry. */
import type { TrashNodeResult } from '@iridium/contracts';
import { describe, expect, it } from 'vitest';

import { idBytes } from '../../src/auth/ids.ts';
import { startAuthServer, webClient } from '../support/auth-app.ts';
import { seedUser, signInWeb } from '../support/seed.ts';
import { createTreeNode, createTreeVault, treeHeaders } from './tree-test-helpers.ts';

describe('jobs.trash-purge.integration [area:jobs]', () => {
  it('preserves nonexpired and dry-run roots, then purges the expired subtree exactly once', async () => {
    const context = await startAuthServer({ extraEnv: { JOBS_ENABLED: 'false' } });
    try {
      const admin = await seedUser(context, {
        email: 'job-purge@example.test',
        isServerAdmin: true,
      });
      const client = webClient(context, await signInWeb(context, admin));
      const vault = await createTreeVault(context, client, 'Job purge');
      const parent = await createTreeNode(context, client, vault, { name: 'Expired parent' });
      const child = await createTreeNode(context, client, vault, {
        name: 'Retained child',
        kind: 'note',
        parentId: parent.id,
        markdown: 'retained history',
      });
      const trashed = await client.post<TrashNodeResult>(`/nodes/${parent.id}/trash`, {
        json: { recursive: true },
        headers: treeHeaders(context, parent.version),
      });
      expect(trashed.status).toBe(200);
      const execute = async (dryRun: boolean) => {
        const job = await context.app.jobs.scheduler.enqueue(
          'trash_purge',
          { vaultId: vault.id, dryRun },
          { ownerFence: context.app.collab.ownerLease.captureFence() },
        );
        const completed = await context.app.jobs.scheduler.runUntilSettled(job.id);
        expect(completed.status).toBe('succeeded');
        return completed.result;
      };
      expect((await execute(false))?.['removed']).toBe(0);
      context.clock.jump(Date.parse(trashed.body.trashEntry.expiresAt));
      expect(await execute(true)).toMatchObject({ removed: 0, examined: 1, dryRun: true });
      expect(
        await context.db
          .selectFrom('nodes')
          .select('id')
          .where('id', '=', idBytes(child.id))
          .executeTakeFirst(),
      ).toBeDefined();
      expect(await execute(false)).toMatchObject({ removed: 2, examined: 1, dryRun: false });
      expect(
        await context.db
          .selectFrom('nodes')
          .select('id')
          .where('id', 'in', [idBytes(parent.id), idBytes(child.id)])
          .execute(),
      ).toEqual([]);
      expect((await execute(false))?.['removed']).toBe(0);
      expect(
        await context.db
          .selectFrom('audit_events')
          .select('actor_type')
          .where('action', '=', 'node.purged')
          .where('vault_id', '=', idBytes(vault.id))
          .execute(),
      ).toEqual([{ actor_type: 'system' }]);
    } finally {
      await context.stop();
    }
  });
});
