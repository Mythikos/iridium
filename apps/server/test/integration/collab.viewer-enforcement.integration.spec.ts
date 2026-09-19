/** Real-wire viewer enforcement, durable-state refusal, and the matching REST policy. */
import { FRAME_TYPE, peekFrame } from '@iridium/crdt';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startCollab, type CollabHarness } from '../support/collab-harness.ts';

let harness: CollabHarness;
beforeEach(async () => {
  harness = await startCollab();
  await harness.server.waitReady();
});
afterEach(async () => {
  await harness.close();
});

describe('collab.viewer-enforcement.integration [area:collab]', () => {
  it('answers a real viewer update with SyncStatus(false), audits the rejection, and writes no update', async () => {
    const seeded = await harness.server.seed.kernel();
    const [editor, viewer] = await Promise.all([
      harness.open(seeded.editorA, seeded.note.id),
      harness.open(seeded.viewer, seeded.note.id, { role: 'viewer' }),
    ]);
    await Promise.all([editor.waitFor('saved'), viewer.waitFor('read-only')]);
    const before = await harness.committed(seeded.note.id);
    const statuses: number[] = [];
    const provider = viewer.provider;
    if (provider === null) throw new Error('A synchronized viewer must have a provider.');
    provider.on('message', ({ event }: { event: { data: ArrayBuffer } }) => {
      const bytes = new Uint8Array(event.data);
      const header = peekFrame(bytes);
      if (header?.type === FRAME_TYPE.syncStatus && header.documentName === viewer.documentName) {
        statuses.push(...bytes.subarray(header.bodyOffset));
      }
    });
    const marker = viewer.marker('viewer-must-not-persist');
    await expect.poll(() => statuses).toContain(0);
    await viewer.waitFor('rejected');
    expect(viewer.session.input.unsynced).toBeGreaterThan(0);
    const db = harness.application().database.dbApp;
    if (db === null) throw new Error('The integration database is required.');
    await expect
      .poll(async () => {
        const rows = await db
          .selectFrom('audit_events')
          .select('action')
          .where('action', '=', 'collab.write.rejected')
          .execute();
        return rows.length;
      })
      .toBe(1);
    const acknowledgement = editor.waitForAck();
    editor.sendStateless({ v: 1, t: 'baseline' });
    await acknowledgement;
    const after = await harness.committed(seeded.note.id);
    expect(after.head).toBe(before.head);
    expect(after.updates).toEqual(before.updates);
    expect(after.text).toBe(before.text);
    expect(editor.text.toJSON()).not.toContain(marker);
    expect(viewer.text.toJSON()).toContain(marker);

    const rest = await harness.server.loginAs(seeded.viewer);
    const refused = await rest.post(`/vaults/${seeded.vault.id}/nodes`, {
      json: { parentId: seeded.vault.rootNodeId, kind: 'note', name: 'Viewer write refused' },
    });
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ code: 'forbidden' });
    const nodes = await db
      .selectFrom('nodes')
      .select('id')
      .where('name', '=', 'Viewer write refused')
      .execute();
    expect(nodes).toEqual([]);
  });
});
