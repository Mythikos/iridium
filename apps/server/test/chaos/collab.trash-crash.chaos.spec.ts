/** Crash at the exact committed-tombstone boundary, before any gateway or vault notification. */
import { Node, NoteId, noteDocName } from '@iridium/contracts';
import {
  createCollabSocket,
  createVaultClient,
  FAULT,
  noteClientWebSocket,
  restTicketSource,
  type VaultClient,
} from '@iridium/testkit';
import { describe, expect, inject, it } from 'vitest';

import { idBytes } from '../../src/auth/ids.ts';
import { createMaintDb } from '../../src/db/migrator.ts';
import { expectIndependentAuditChains } from '../support/audit-chain-oracle.ts';
import { CHAOS_RECONNECT, CRASH_ITERATIONS, waitCrashFault } from '../support/collab-chaos.ts';
import { expectConverged, startCollab } from '../support/collab-harness.ts';

describe('collab.trash-crash.chaos [area:collab] [hp:HP-2]', () => {
  it.for(Array.from({ length: CRASH_ITERATIONS }, (_, iteration) => iteration))(
    'recovers committed trash before notification in kill iteration %i',
    { timeout: 90_000 },
    async (iteration) => {
      const harness = await startCollab({ mode: 'child', extraEnv: { JOBS_ENABLED: 'false' } });
      const rootUrl = new URL(inject('iridiumMysql').rootUri);
      rootUrl.pathname = `/${harness.server.schema}`;
      const admin = createMaintDb(rootUrl.toString());
      const socket = createCollabSocket({
        url: harness.server.wsUrl,
        webSocketPolyfill: noteClientWebSocket({ defaultOrigin: harness.server.origin }),
      });
      let channel: VaultClient | undefined;
      try {
        await harness.server.waitReady();
        const cast = await harness.server.seed.kernel();
        const categoryResult = await cast.admin.client.post(`/vaults/${cast.vault.id}/nodes`, {
          json: { kind: 'category', parentId: cast.vault.rootNodeId, name: 'Crash subtree' },
        });
        expect(categoryResult.status).toBe(201);
        const category = Node.parse(categoryResult.body);
        const noteResult = await cast.admin.client.post(`/vaults/${cast.vault.id}/nodes`, {
          json: {
            kind: 'note',
            parentId: category.id,
            name: 'Crash subject',
            markdown: '# Durable before trash\n',
          },
        });
        expect(noteResult.status).toBe(201);
        const note = Node.parse(noteResult.body);
        const editor = await harness.open(cast.editorA, note.id);
        const observer = await harness.open(cast.editorB, note.id);
        await expectConverged(harness, note.id, [editor, observer]);
        const marker = editor.marker(`accepted-before-trash-${String(iteration)}`);
        const committed = await expectConverged(harness, note.id, [editor, observer]);
        expect(committed.text).toContain(marker);
        const rest = await harness.server.loginAs(cast.editorB);
        channel = createVaultClient({
          socket,
          vaultId: cast.vault.id,
          tickets: restTicketSource(rest),
        });
        await channel.waitConnected();
        const treeBefore = channel.messages.filter((message) => message.t === 'tree-changed');
        const nodeBefore = await admin.db
          .selectFrom('vaults')
          .select('tree_version')
          .where('id', '=', idBytes(cast.vault.id))
          .executeTakeFirstOrThrow();
        await harness.server.faults.arm(FAULT.treeCrashAfterCommitBeforeNotify);
        const offset = harness.logs.length;
        const request = cast.admin.client
          .post(`/nodes/${category.id}/trash`, { ifMatch: 1, json: { recursive: true } })
          .then(
            (response) => ({ response }),
            (error: unknown) => ({ error }),
          );
        // The kill is the evidence: the log line `crash()` writes races its own `SIGKILL`.
        await waitCrashFault(harness, FAULT.treeCrashAfterCommitBeforeNotify, offset);
        await expect.poll(() => harness.server.lastExit).not.toBeNull();
        expect(harness.server.lastExit?.code).not.toBe(0);
        expect(await request).toHaveProperty('error');
        await Promise.all([editor.disconnectSocket(), observer.disconnectSocket()]);
        socket.disconnect();
        expect(channel.messages.filter((message) => message.t === 'tree-changed')).toEqual(
          treeBefore,
        );
        expect(editor.stateless.filter((message) => message.t === 'closing')).toEqual([]);
        expect(observer.stateless.filter((message) => message.t === 'closing')).toEqual([]);
        const tombstones = await admin.db
          .selectFrom('nodes')
          .select(['id', 'version', 'deleted_at'])
          .where('id', 'in', [idBytes(category.id), idBytes(note.id)])
          .execute();
        expect(tombstones).toHaveLength(2);
        expect(tombstones.every((row) => row.deleted_at !== null && row.version === 2)).toBe(true);
        expect(
          await admin.db
            .selectFrom('trash_entries')
            .select('node_id')
            .where('cascade_root_id', '=', idBytes(category.id))
            .execute(),
        ).toHaveLength(2);
        expect(
          await admin.db
            .selectFrom('vaults')
            .select('tree_version')
            .where('id', '=', idBytes(cast.vault.id))
            .executeTakeFirstOrThrow(),
        ).toEqual({ tree_version: nodeBefore.tree_version + 1 });
        const revision = await admin.db
          .selectFrom('note_revisions')
          .select(['seq', 'markdown', 'snapshot'])
          .where('note_id', '=', idBytes(note.id))
          .where('kind', '=', 'trash')
          .executeTakeFirstOrThrow();
        expect(revision.seq).toBe(committed.head);
        expect(revision.markdown).toBe(committed.text);
        expect(revision.snapshot?.byteLength).toBeGreaterThan(0);
        expect(
          await admin.db
            .selectFrom('audit_events')
            .select('id')
            .where('target_id', '=', idBytes(category.id))
            .where('action', '=', 'node.trashed')
            .execute(),
        ).toHaveLength(1);
        expect(await expectIndependentAuditChains(admin.db)).toBeGreaterThanOrEqual(2);
        const pendingMarker = editor.marker(`offline-after-trash-${String(iteration)}`);
        await harness.server.restart();
        const fresh = await harness.open(cast.editorB, note.id);
        expect((await fresh.waitClosed()).collabReason).toBe('note-trashed');
        const priorCloses = editor.closes.length;
        await editor.reconnectSocket(CHAOS_RECONNECT);
        // A cached ticket from the killed process is first refused as unauthorized. The client must
        // invalidate that batch, acquire a fresh ticket and reach the durable tombstone refusal.
        await expect
          .poll(() => editor.closes.slice(priorCloses).map((close) => close.collabReason), {
            timeout: 10_000,
          })
          .toContain('note-trashed');
        expect(editor.text.toJSON()).toContain(pendingMarker);
        const recovered = await harness.committed(note.id);
        expect(recovered.head).toBe(committed.head);
        expect(recovered.text).toBe(committed.text);
        expect(recovered.text).not.toContain(pendingMarker);
        // Fresh independent content still loads: restart did not latch the whole vault closed.
        const unaffected = await harness.open(cast.editorA, cast.note.id);
        await unaffected.waitFor('saved');
        expect(unaffected.text.toJSON()).toContain('⟦IMPORT-MARK⟧');
        expect(
          harness.logs.some(
            (line) =>
              line.includes('collab.connection.rejected') &&
              line.includes(noteDocName(NoteId.parse(note.id))),
          ),
        ).toBe(true);
        expect(await expectIndependentAuditChains(admin.db)).toBeGreaterThanOrEqual(2);
      } finally {
        channel?.close();
        socket.destroy();
        await admin.db.destroy();
        await harness.close();
      }
    },
  );
});
