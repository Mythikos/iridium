/** The M1 kernel gate: real clients, the built server, MySQL, and recovery after SIGKILL. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chainIdForVault, NoteId, SERVER_CHAIN_ID } from '@iridium/contracts';
import { FRAME_TYPE, peekFrame } from '@iridium/crdt';
import {
  formatMarker,
  MARKER_IMPORT,
  mysqlAdminByContainerId,
  startServer,
  workerSchemaName,
  type NoteClient,
  type SeededUser,
} from '@iridium/testkit';
import { describe, expect, inject, it } from 'vitest';

const EDITOR_A_MARKER = formatMarker('editor-a', 1);
const EDITOR_B_MARKER = formatMarker('editor-b', 1);
const VIEWER_MARKER = formatMarker('viewer-refused', 1);

function expectOneOfEachMarker(text: string): void {
  for (const marker of [MARKER_IMPORT, EDITOR_A_MARKER, EDITOR_B_MARKER]) {
    expect(text.split(marker)).toHaveLength(2);
  }
  expect(text).not.toContain(VIEWER_MARKER);
}

describe('kernel.smoke.integration [area:kernel]', () => {
  it('persists concurrent edits, rejects a viewer write, and recovers only committed content after a kill', async () => {
    const mysql = inject('iridiumMysql');
    const schema = workerSchemaName(process.env['VITEST_WORKER_ID'] ?? '1');
    const scratch = mkdtempSync(join(tmpdir(), 'iridium-kernel-'));
    const clients: NoteClient[] = [];
    const server = await startServer({
      mode: 'child',
      db: { ...mysql, schema },
      attachmentsDir: scratch,
    }).catch((error: unknown) => {
      rmSync(scratch, { recursive: true, force: true });
      throw error;
    });
    try {
      await server.waitReady({ timeoutMs: 8_000 });
      const seeded = await server.seed.kernel();
      const open = async (user: SeededUser): Promise<NoteClient> => {
        const client = await server.client(user, seeded.note.id);
        clients.push(client);
        await client.waitSynced();
        return client;
      };
      const [editorA, editorB] = await Promise.all([open(seeded.editorA), open(seeded.editorB)]);
      expect(editorA.text.toJSON()).toBe(seeded.note.markdown);
      expect(editorB.text.toJSON()).toBe(seeded.note.markdown);

      // No await between inserts: both clients edit the same position before either sees its peer.
      editorA.typeAt(0, EDITOR_A_MARKER);
      editorB.typeAt(0, EDITOR_B_MARKER);
      await expect.poll(() => editorA.text.toJSON() === editorB.text.toJSON()).toBe(true);
      await Promise.all([editorA.waitFor('saved'), editorB.waitFor('saved')]);
      const converged = editorA.text.toJSON();
      expect(editorB.text.toJSON()).toBe(converged);
      expectOneOfEachMarker(converged);
      const viewer = await open(seeded.viewer);
      expect(viewer.session.input.role).toBe('viewer');
      await viewer.waitFor('read-only');
      expect(viewer.text.toJSON()).toBe(converged);
      // Bypass the editor UI: a hostile viewer still cannot write through the actual provider.
      const refusedFrames: number[] = [];
      const provider = viewer.provider;
      if (provider === null) throw new Error('the synced viewer has no provider');
      provider.on('message', ({ event }: { event: { data: ArrayBuffer } }) => {
        const bytes = new Uint8Array(event.data);
        const header = peekFrame(bytes);
        if (header?.type === FRAME_TYPE.syncStatus && header.documentName === viewer.documentName) {
          refusedFrames.push(...bytes.subarray(header.bodyOffset));
        }
      });
      viewer.typeAt(0, VIEWER_MARKER);
      await expect.poll(() => refusedFrames).toContain(0); // SyncStatus(applied=false)
      await viewer.waitFor('rejected');
      expect(viewer.session.input.unsynced).toBeGreaterThan(0);
      expect(editorA.text.toJSON()).toBe(converged);
      expect(editorB.text.toJSON()).toBe(converged);
      const acknowledgement = editorA.waitForAck();
      editorA.sendStateless({ v: 1, t: 'baseline' });
      const acknowledged = await acknowledgement;
      expect(acknowledged.seq).toBeGreaterThan(1);
      await editorA.waitFor('saved');
      await server.kill();

      // Fresh documents must recover from MySQL before any old client can resubmit its memory.
      await Promise.all(clients.map((client) => client.close()));
      clients.length = 0;
      await server.restart();
      const recovered = await open(seeded.editorA);
      await recovered.waitFor('saved');
      expect(recovered.text.toJSON()).toBe(converged);
      expectOneOfEachMarker(recovered.text.toJSON());
      expect(recovered.session.input.persisted?.seq).toBeGreaterThanOrEqual(acknowledged.seq);

      const database = await mysqlAdminByContainerId(mysql.containerId);
      const noteHex = NoteId.parse(seeded.note.id).replaceAll('-', '');
      const rows = await database.rows(
        `SELECT d.head_seq, GREATEST(d.snapshot_through_seq, COALESCE(MAX(u.seq), 0))
         FROM ${schema}.note_docs d
         LEFT JOIN ${schema}.note_updates u ON u.note_id = d.note_id
         WHERE d.note_id = UNHEX('${noteHex}')
         GROUP BY d.note_id, d.head_seq, d.snapshot_through_seq`,
      );
      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row?.[0]).toBe(row?.[1]);
      expect(Number(row?.[0])).toBeGreaterThanOrEqual(acknowledged.seq);
      const verified = await Promise.all(
        [SERVER_CHAIN_ID, chainIdForVault(seeded.vault.id)].map(async (chain) => {
          const result = await server.cli(['audit', 'verify-chain', '--chain', chain, '--json']);
          expect(result.code, result.stderr).toBe(0);
          const summary: { chains: { rows: number }[] } = JSON.parse(result.stdout);
          expect(summary).toMatchObject({
            ok: true,
            chains: [{ chainId: chain, ok: true, rows: expect.any(Number) }],
          });
          expect(summary.chains[0]?.rows).toBeGreaterThan(0);
          return result;
        }),
      );
      expect(verified).toHaveLength(2);
    } finally {
      try {
        await Promise.all(clients.map((client) => client.close()));
      } finally {
        await server.stop();
        rmSync(scratch, { recursive: true, force: true });
      }
    }
  });
});
