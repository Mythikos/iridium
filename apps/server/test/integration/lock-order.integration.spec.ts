/** Eight real transports contend on one vault while the server publishes content and audit rows. */
import { createHash } from 'node:crypto';

import {
  NoteId,
  type Node,
  type NodePatchResult,
  type RestoreNodeResult,
  type TrashNodeResult,
  type Vault,
} from '@iridium/contracts';
import { attachmentClient, type RestClient } from '@iridium/testkit';
import { describe, expect, it } from 'vitest';

import { idBytes } from '../../src/auth/ids.ts';
import { VaultLockOrderError, withVaultLock } from '../../src/db/withVaultLock.ts';
import { startCollab } from '../support/collab-harness.ts';

async function rename(client: RestClient, id: string, name: string): Promise<void> {
  const current = await client.get<Node>(`/nodes/${id}`);
  expect(current.status).toBe(200);
  const response = await client.patch<NodePatchResult>(`/nodes/${id}`, {
    json: { name },
    headers: { 'if-match': `"${current.body.version}"` },
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
}

describe('lock-order.integration [spec:structural-concurrency]', () => {
  it('runs eight workers for thirty seconds without an InnoDB deadlock or an unclassified response', async () => {
    const harness = await startCollab();
    try {
      await harness.server.seed.admin();
      const users = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          harness.server.seed.user({
            email: `lock-worker-${index}@iridium.test`,
            isServerAdmin: true,
          }),
        ),
      );
      const sessions = await Promise.all(users.map((user) => harness.server.seed.signIn(user)));
      const clients = sessions.map((session) => session.client);
      const first = users[0];
      if (first === undefined) throw new Error('Expected worker user');
      const vault = await harness.server.seed.vault({ name: 'Mixed lock traffic' });
      const target = await harness.server.seed.note({
        vault,
        name: 'Target',
        markdown: 'Target source',
      });
      const note = await harness.server.seed.note({
        vault,
        name: 'Live',
        markdown: '[reference](Target.md)\n',
      });
      const disposable = await harness.server.seed.note({
        vault,
        name: 'Trash cycle',
        markdown: 'Retain me',
      });
      const editor = await harness.open(first, note.id);
      await editor.waitFor('saved');
      const app = harness.application();
      const db = app.database.dbApp;
      if (db === null) throw new Error('Expected database');
      const deadlocks = async () =>
        Number(
          (
            await harness.sql.rows(
              "SELECT `COUNT` FROM information_schema.INNODB_METRICS WHERE NAME = 'lock_deadlocks'",
            )
          )[0]?.[0] ?? -1,
        );
      const before = await deadlocks();
      expect(before).toBeGreaterThanOrEqual(0);
      const counts = Array.from({ length: 8 }, () => 0);
      const deadline = performance.now() + 30_000;
      const owner = app.collab.ownerLease.captureFence();
      const operations: readonly ((client: RestClient, iteration: number) => Promise<void>)[] = [
        (client, index) => rename(client, note.id, `Live ${index % 2}`),
        async () => {
          editor.marker('mixed-lock');
          await editor.waitFor('saved');
          await app.collab.persistence.compactNow(NoteId.parse(note.id), { trigger: 'flush' });
        },
        async (client) => {
          const current = await client.get<Node>(`/nodes/${disposable.id}`);
          expect(current.status).toBe(200);
          const trash = await client.post<TrashNodeResult>(`/nodes/${disposable.id}/trash`, {
            json: {},
            headers: { 'if-match': `"${current.body.version}"` },
          });
          expect(trash.status, JSON.stringify(trash.body)).toBe(200);
          const row = trash.body.nodes[0];
          if (row === undefined) throw new Error('Expected trashed row');
          const restored = await client.post<RestoreNodeResult>(`/nodes/${disposable.id}/restore`, {
            json: {},
            headers: { 'if-match': `"${row.version}"` },
          });
          expect(restored.status, JSON.stringify(restored.body)).toBe(200);
        },
        (client, index) => rename(client, target.id, `Target ${index % 2}`),
        async (client, index) => {
          const response = await attachmentClient(client).upload({
            vaultId: vault.id,
            filename: `lock-${index}.txt`,
            declaredMime: 'text/plain',
            bytes: new TextEncoder().encode(`lock attachment ${index}`),
          });
          expect(response.status, JSON.stringify(response.body)).toBe(201);
        },
        async (client, index) => {
          const current = await client.get<Vault>(`/vaults/${vault.id}`);
          expect(current.status).toBe(200);
          const result = await client.patch(`/vaults/${vault.id}`, {
            json: { description: `audit change ${index}` },
            headers: { 'if-match': `"${current.body.version}"` },
          });
          expect(result.status, JSON.stringify(result.body)).toBe(200);
        },
        async (client, index) => {
          const result = await client.post('/admin/users', {
            json: { email: `lock-created-${index}@iridium.test`, displayName: `Audited ${index}` },
          });
          expect(result.status, JSON.stringify(result.body)).toBe(201);
        },
        async () => {
          await app.reindexService.run(
            { noteIds: [note.id] },
            {
              ownerFence: owner,
              progress: null,
              checkpoint: async () => {},
              assertActive: async () => owner.assertActive(),
            },
          );
        },
      ];
      const outcomes = await Promise.allSettled(
        operations.map(async (operation, index) => {
          const client = clients[index];
          if (client === undefined) throw new Error('Expected authenticated worker');
          let failure: unknown;
          // Polling supplies a bounded arrival rate beneath the real per-principal and upload budgets.
          await expect
            .poll(
              async () => {
                if (failure !== undefined || performance.now() >= deadline) return true;
                try {
                  await operation(client, counts[index] ?? 0);
                  counts[index] = (counts[index] ?? 0) + 1;
                } catch (error) {
                  failure = error;
                  return true;
                }
                return false;
              },
              { interval: 650, timeout: 45_000 },
            )
            .toBe(true);
          if (failure !== undefined) throw failure;
        }),
      );
      expect(outcomes.filter((result) => result.status === 'rejected')).toEqual([]);
      expect(
        counts.every((count) => count >= 10),
        JSON.stringify(counts),
      ).toBe(true);
      expect(await deadlocks()).toBe(before);
      expect(harness.logs.filter((line) => /ER_LOCK_DEADLOCK|"errno":1213/.test(line))).toEqual([]);
      const durable = await harness.committed(note.id);
      expect(durable.head).toBeGreaterThan(10);
      expect(durable.text).toContain('mixed-lock');
      const audit = await db
        .selectFrom('audit_events')
        .select(['action'])
        .where('vault_id', '=', idBytes(vault.id))
        .execute();
      expect(audit.some((row) => row.action === 'vault.settings.changed')).toBe(true);
      expect(audit.some((row) => row.action === 'node.trashed')).toBe(true);
      // Flush may intentionally skip a revision before its checkpoint interval. A subsequent
      // unload veto must create that checkpoint and finish unloading without the shutdown drain.
      await editor.close();
      await expect
        .poll(() => app.collab.persistence.writerOf(NoteId.parse(note.id)), { timeout: 15_000 })
        .toBeUndefined();
      const unloaded = await harness.committed(note.id);
      expect(unloaded.head).toBe(durable.head);
      expect(unloaded.text).toBe(durable.text);
      const retained = await db
        .selectFrom('note_revisions')
        .select(['seq', 'markdown', 'content_hash'])
        .where('note_id', '=', idBytes(note.id))
        .where('seq', '=', unloaded.head)
        .execute();
      expect(retained.length).toBeGreaterThan(0);
      for (const revision of retained) {
        expect(revision.seq).toBe(unloaded.head);
        expect(revision.markdown).toBe(unloaded.text);
        expect(revision.content_hash).toEqual(createHash('sha256').update(unloaded.text).digest());
      }
    } finally {
      await harness.close();
    }
  }, 60_000);

  it('refuses a structural lock entered after a child transaction has already started', async () => {
    const harness = await startCollab();
    try {
      await harness.server.seed.admin();
      const vault = await harness.server.seed.vault({ name: 'Reversed lock proof' });
      const note = await harness.server.seed.note({ vault, name: 'Locked child' });
      const app = harness.application();
      const db = app.database.dbApp;
      if (db === null) throw new Error('Expected database');
      const before = await db
        .selectFrom('vaults')
        .select('tree_version')
        .where('id', '=', idBytes(vault.id))
        .executeTakeFirstOrThrow();
      await db.transaction().execute(async (trx) => {
        await trx
          .selectFrom('note_docs')
          .select('note_id')
          .where('note_id', '=', idBytes(note.id))
          .forUpdate()
          .execute();
        await expect(
          withVaultLock(
            {
              db: trx,
              clock: app.clock,
              vaultId: vault.id,
              ownerFence: app.collab.ownerLease.captureFence(),
            },
            async (context) => context.bumpTreeVersion(),
          ),
        ).rejects.toBeInstanceOf(VaultLockOrderError);
      });
      expect(
        await db
          .selectFrom('vaults')
          .select('tree_version')
          .where('id', '=', idBytes(vault.id))
          .executeTakeFirstOrThrow(),
      ).toEqual(before);
    } finally {
      await harness.close();
    }
  });
});
