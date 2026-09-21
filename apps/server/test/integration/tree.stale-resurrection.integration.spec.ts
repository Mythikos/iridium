import {
  idFromBytes,
  NoteId,
  type Node,
  type ProblemDetails,
  type RestoreNodeResult,
  type TrashNodeResult,
} from '@iridium/contracts';
import { describe, expect, it } from 'vitest';

import { idBytes } from '../../src/auth/ids.ts';
import { startCollab } from '../support/collab-harness.ts';
describe('tree.stale-resurrection.integration [spec:structural-concurrency] [hp:HP-2]', () => {
  it.each(['restore', 'purge'] as const)(
    'refuses a queued update and preserves the acknowledged head through %s',
    async (operation) => {
      const harness = await startCollab();
      let phase = 'seed';
      try {
        const cast = await harness.server.seed.kernel();
        const app = harness.application();
        const db = app.database.dbApp;
        if (db === null) throw new Error('The real application must own its database.');
        const noteId = NoteId.parse(cast.note.id);
        const client = await harness.open(cast.editorA, noteId, { flushDelayMs: 60_000 });
        await client.waitFor('saved');
        const before = await harness.committed(noteId);
        const projection = await db
          .selectFrom('note_projections')
          .select('content_hash')
          .where('note_id', '=', idBytes(noteId))
          .executeTakeFirstOrThrow();
        const pending = client.marker('queued-before-trash');
        const closing = client.waitForStateless('closing', { timeoutMs: 5_000 });
        const closed = client.waitClosed({ timeoutMs: 5_000 });
        const trashRequest = cast.admin.client.post<TrashNodeResult>(`/nodes/${noteId}/trash`, {
          headers: { 'if-match': '"1"' },
          json: {},
        });
        try {
          expect(await closing).toMatchObject({ reason: 'note-trashed' });
        } catch (error) {
          process.stderr.write(
            `${JSON.stringify({
              phase: 'waiting-for-trash-close',
              messages: client.stateless,
              closes: client.closes,
              recentLogs: harness.logs.slice(-12),
            })}\n`,
          );
          throw error;
        }
        // The server's closing fence is now observable. Send the queued bytes over the real provider
        // during its grace period, rather than merely disconnecting a client with unsent local text.
        client.provider?.flushPendingUpdates();
        phase = 'client-close';
        expect((await closed).reason).toBe('note-trashed');
        phase = 'trash-response';
        const trash = await trashRequest;
        expect(trash.status).toBe(200);
        expect(trash.body.nodes[0]?.version).toBe(2);
        expect(app.collab.gateway.isClosing(noteId)).toBe(false);
        const checkpoint = await db
          .selectFrom('note_revisions')
          .select(['seq', 'content_hash', 'markdown'])
          .where('note_id', '=', idBytes(noteId))
          .where('kind', '=', 'trash')
          .executeTakeFirstOrThrow();
        expect(checkpoint.seq).toBe(before.head);
        expect(checkpoint.content_hash).toEqual(projection.content_hash);
        expect(checkpoint.markdown).toBe(before.text);
        const after = await harness.committed(noteId);
        expect(after.head).toBe(before.head);
        expect(after.text).toBe(before.text);
        expect(after.text).not.toContain(pending);
        const rejected = await harness.open(cast.editorA, noteId);
        phase = 'reopen-refused';
        expect((await rejected.waitClosed()).reason).toBe('note-trashed');
        if (operation === 'restore') {
          const restored = await cast.admin.client.post<RestoreNodeResult>(
            `/nodes/${noteId}/restore`,
            {
              headers: { 'if-match': '"2"' },
              json: {},
            },
          );
          // oxlint-disable-next-line vitest/no-conditional-expect -- both enumerated lifecycle cases run with their distinct postconditions
          expect(restored.status).toBe(200);
          // oxlint-disable-next-line vitest/no-conditional-expect -- both enumerated lifecycle cases run with their distinct postconditions
          expect(restored.body.nodes[0]?.note?.contentHash).toBe(
            checkpoint.content_hash.toString('hex'),
          );
          const reopened = await harness.open(cast.editorB, noteId);
          phase = 'restored-reopen';
          await reopened.waitFor('saved');
          // oxlint-disable-next-line vitest/no-conditional-expect -- both enumerated lifecycle cases run with their distinct postconditions
          expect(reopened.text.toJSON()).toBe(before.text);
        } else {
          const purged = await cast.admin.client.del(`/nodes/${noteId}?purge=true`, {
            headers: { 'if-match': '"2"' },
          });
          // oxlint-disable-next-line vitest/no-conditional-expect -- both enumerated lifecycle cases run with their distinct postconditions
          expect(purged.status).toBe(204);
          // oxlint-disable-next-line vitest/no-conditional-expect -- both enumerated lifecycle cases run with their distinct postconditions
          expect(
            (
              await cast.admin.client.post(`/nodes/${noteId}/restore`, {
                headers: { 'if-match': '"2"' },
                json: {},
              })
            ).status,
          ).toBe(404);
          for (const table of [
            'note_updates',
            'note_docs',
            'note_projections',
            'note_projection_terms',
            'note_search',
            'note_revisions',
          ] as const) {
            // oxlint-disable-next-line vitest/no-conditional-expect -- both enumerated lifecycle cases run with their distinct postconditions
            expect(
              // eslint-disable-next-line no-await-in-loop -- inspect every dependent table by its shared note key
              await db
                .selectFrom(table)
                .select('note_id')
                .where('note_id', '=', idBytes(noteId))
                .execute(),
            ).toEqual([]);
          }
          // oxlint-disable-next-line vitest/no-conditional-expect -- both enumerated lifecycle cases run with their distinct postconditions
          expect(
            await db
              .selectFrom('note_links')
              .select('id')
              .where('from_note_id', '=', idBytes(noteId))
              .execute(),
          ).toEqual([]);
          // oxlint-disable-next-line vitest/no-conditional-expect -- both enumerated lifecycle cases run with their distinct postconditions
          expect(app.collab.persistence.writerOf(noteId)).toBeUndefined();
          const reopened = await harness.open(cast.editorB, noteId);
          // oxlint-disable-next-line vitest/no-conditional-expect -- both enumerated lifecycle cases run with their distinct postconditions
          expect((await reopened.waitClosed()).reason).toBe('note-not-found');
        }
      } catch (error) {
        process.stderr.write(
          `${JSON.stringify({ phase, recentLogs: harness.logs.slice(-20), error: String(error) })}\n`,
        );
        throw error;
      } finally {
        await harness.close();
      }
    },
  );
  it('refuses a pre-trash validator on rename, move and restore into a live position', async () => {
    const harness = await startCollab();
    try {
      const cast = await harness.server.seed.kernel();
      const app = harness.application();
      const db = app.database.dbApp;
      if (db === null) throw new Error('The real application must own its database.');
      const noteId = NoteId.parse(cast.note.id);
      const destination = await cast.admin.client.post<Node>(`/vaults/${cast.vault.id}/nodes`, {
        json: { kind: 'category', parentId: cast.vault.rootNodeId, name: 'Live destination' },
      });
      expect(destination.status).toBe(201);
      const before = await cast.admin.client.get<Node>(`/nodes/${noteId}`);
      expect(before.status).toBe(200);
      // The validator a client is holding while the node is still live. Every write below replays
      // exactly this one after the trash has committed (12-milestones.md §6.4, this file's row).
      const preTrash = before.body.version;
      const trashed = await cast.admin.client.post<TrashNodeResult>(`/nodes/${noteId}/trash`, {
        headers: { 'if-match': `"${String(preTrash)}"` },
        json: {},
      });
      expect(trashed.status).toBe(200);
      expect(trashed.body.nodes[0]?.version).toBe(preTrash + 1);
      const stale = { 'if-match': `"${String(preTrash)}"` };
      const rename = await cast.admin.client.patch<ProblemDetails>(`/nodes/${noteId}`, {
        headers: stale,
        json: { name: 'Resurrected' },
      });
      const move = await cast.admin.client.patch<ProblemDetails>(`/nodes/${noteId}`, {
        headers: stale,
        json: { parentId: destination.body.id },
      });
      const restore = await cast.admin.client.post<ProblemDetails>(`/nodes/${noteId}/restore`, {
        headers: stale,
        json: { newParentId: destination.body.id },
      });
      // `mutationNode` compares the validator before it looks at `deleted_at`, so all three answer
      // the same `409 stale_version` (apps/server/src/tree/mutations.ts).
      for (const [operationId, response] of [
        ['nodes.update', rename],
        ['nodes.update', move],
        ['nodes.restore', restore],
      ] as const) {
        expect(response.status).toBe(409);
        expect(response.body).toMatchObject({ code: 'stale_version' });
        // eslint-disable-next-line no-await-in-loop -- each refusal is checked against its own documented shape
        await expect(response).toMatchOpenApi(operationId, 409);
      }
      const row = await db
        .selectFrom('nodes')
        .select(['parent_id', 'name', 'version', 'deleted_at'])
        .where('id', '=', idBytes(noteId))
        .executeTakeFirstOrThrow();
      expect({
        parent: idFromBytes(row.parent_id),
        name: row.name,
        version: row.version,
        trashed: row.deleted_at !== null,
      }).toEqual({
        parent: cast.vault.rootNodeId,
        name: cast.note.name,
        version: preTrash + 1,
        trashed: true,
      });
      expect(
        await db
          .selectFrom('trash_entries')
          .select('node_id')
          .where('node_id', '=', idBytes(noteId))
          .execute(),
      ).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });
});
