import {
  NoteId,
  type Node,
  type NodePatchResult,
  type RestoreNodeResult,
  type TrashNodeResult,
} from '@iridium/contracts';
import {
  createCollabSocket,
  createVaultClient,
  noteClientWebSocket,
  restTicketSource,
  type VaultClient,
} from '@iridium/testkit';
import { describe, expect, it } from 'vitest';

import { idBytes } from '../../src/auth/ids.ts';
import { startCollab } from '../support/collab-harness.ts';

describe('collab.vault-channel.integration [area:collab] [spec:structural-concurrency]', () => {
  it('announces every structural commit once, stays silent before commit and keeps renamed note sessions open', async () => {
    const harness = await startCollab();
    const socket = createCollabSocket({
      url: harness.server.wsUrl,
      webSocketPolyfill: noteClientWebSocket({ defaultOrigin: harness.server.origin }),
    });
    let channel: VaultClient | undefined;
    const release = Promise.withResolvers<void>();
    let held: Promise<void> | undefined;
    try {
      const cast = await harness.server.seed.kernel();
      const app = harness.application();
      const db = app.database.dbApp;
      if (db === null) throw new Error('The running application must own its database.');
      const rest = await harness.server.loginAs(cast.editorA);
      const note = await harness.open(cast.editorA, cast.note.id, { socket });
      channel = createVaultClient({
        socket,
        vaultId: cast.vault.id,
        tickets: restTicketSource(rest),
      });
      await Promise.all([channel.waitConnected(), note.waitFor('saved')]);
      const channelBefore = channel;
      const originalSocket = socket.webSocket;
      const treeEvents = () =>
        channelBefore.messages.filter((message) => message.t === 'tree-changed');
      const assertCommit = async (version: number, op: string, id: string): Promise<void> => {
        await expect
          .poll(() => treeEvents().at(-1))
          .toMatchObject({
            treeVersion: version,
            changes: expect.arrayContaining([expect.objectContaining({ nodeId: id, op })]),
          });
        expect(treeEvents()).toHaveLength(version - 1);
        const durable = await db
          .selectFrom('vaults')
          .select('tree_version')
          .where('id', '=', idBytes(cast.vault.id))
          .executeTakeFirstOrThrow();
        expect(durable.tree_version).toBe(version);
      };
      const category = await cast.admin.client.post<Node>(`/vaults/${cast.vault.id}/nodes`, {
        json: { parentId: cast.vault.rootNodeId, kind: 'category', name: 'Category' },
      });
      expect(category.status).toBe(201);
      await assertCommit(2, 'created', category.body.id);
      const renamed = await cast.admin.client.patch<NodePatchResult>(`/nodes/${cast.note.id}`, {
        json: { name: 'Renamed' },
        headers: { 'if-match': '"1"' },
      });
      expect(renamed.status).toBe(200);
      await assertCommit(3, 'renamed', cast.note.id);
      expect(note.closes).toEqual([]);
      expect(socket.webSocket).toBe(originalSocket);
      const marker = note.marker('rename-session-undisturbed');
      await note.waitFor('saved');
      expect((await harness.committed(cast.note.id)).text).toContain(marker);

      const victim = await cast.admin.client.post<Node>(`/vaults/${cast.vault.id}/nodes`, {
        json: {
          parentId: category.body.id,
          kind: 'note',
          name: 'Victim',
          markdown: 'keep until purge',
        },
      });
      expect(victim.status).toBe(201);
      await assertCommit(4, 'created', victim.body.id);
      const locked = Promise.withResolvers<void>();
      held = db.transaction().execute(async (trx) => {
        await trx
          .selectFrom('vaults')
          .select('id')
          .where('id', '=', idBytes(cast.vault.id))
          .forUpdate()
          .executeTakeFirstOrThrow();
        locked.resolve();
        await release.promise;
      });
      await locked.promise;
      const trashPromise = cast.admin.client.post<TrashNodeResult>(
        `/nodes/${category.body.id}/trash`,
        { json: { recursive: true }, headers: { 'if-match': '"1"' } },
      );
      await expect
        .poll(() => app.collab.gateway.isClosing(NoteId.parse(victim.body.id)))
        .toBe(true);
      expect(treeEvents()).toHaveLength(3);
      expect(
        (
          await db
            .selectFrom('nodes')
            .select('deleted_at')
            .where('id', '=', idBytes(victim.body.id))
            .executeTakeFirstOrThrow()
        ).deleted_at,
      ).toBeNull();
      release.resolve();
      await held;
      expect((await trashPromise).status).toBe(200);
      await assertCommit(5, 'trashed', category.body.id);
      const restored = await cast.admin.client.post<RestoreNodeResult>(
        `/nodes/${category.body.id}/restore`,
        { json: {}, headers: { 'if-match': '"2"' } },
      );
      expect(restored.status).toBe(200);
      await assertCommit(6, 'restored', category.body.id);
      const moved = await cast.admin.client.patch<NodePatchResult>(`/nodes/${victim.body.id}`, {
        json: { parentId: cast.vault.rootNodeId },
        headers: { 'if-match': '"3"' },
      });
      expect(moved.status).toBe(200);
      await assertCommit(7, 'moved', victim.body.id);
      expect(
        (
          await cast.admin.client.post(`/nodes/${victim.body.id}/trash`, {
            json: {},
            headers: { 'if-match': '"4"' },
          })
        ).status,
      ).toBe(200);
      await assertCommit(8, 'trashed', victim.body.id);
      expect(
        (
          await cast.admin.client.del(`/nodes/${victim.body.id}?purge=true`, {
            headers: { 'if-match': '"5"' },
          })
        ).status,
      ).toBe(204);
      await assertCommit(9, 'purged', victim.body.id);
      expect(note.closes).toEqual([]);
      expect(channel.closes).toEqual([]);
      expect(
        await db
          .selectFrom('note_docs')
          .select('note_id')
          .where('note_id', '=', idBytes(cast.vault.id))
          .execute(),
      ).toEqual([]);
      expect(
        await db
          .selectFrom('note_updates')
          .select('note_id')
          .where('note_id', '=', idBytes(cast.vault.id))
          .execute(),
      ).toEqual([]);
    } finally {
      release.resolve();
      await held;
      channel?.close();
      await harness.close();
      socket.destroy();
    }
  });

  it('refuses an authenticated nonmember without loading or persisting the vault channel', async () => {
    const harness = await startCollab();
    const socket = createCollabSocket({
      url: harness.server.wsUrl,
      webSocketPolyfill: noteClientWebSocket({ defaultOrigin: harness.server.origin }),
    });
    let channel: VaultClient | undefined;
    try {
      const cast = await harness.server.seed.kernel();
      const rest = await harness.server.loginAs(cast.outsider);
      channel = createVaultClient({
        socket,
        vaultId: cast.vault.id,
        tickets: restTicketSource(rest),
      });
      expect(await channel.waitClosed()).toMatchObject({ code: 4401, reason: 'unauthorized' });
      expect(channel.messages).toEqual([]);
      expect(harness.application().collab.server.loadedDocuments()).toEqual([]);
      expect((await harness.committed(cast.note.id)).head).toBe(1);
    } finally {
      channel?.close();
      await harness.close();
      socket.destroy();
    }
  });
});
