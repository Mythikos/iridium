/** A durable trash can be reconciled even while its ordinary post-COMMIT delivery is withheld. */
import { NoteId, noteDocName } from '@iridium/contracts';
import { FAULT } from '@iridium/testkit';
import { describe, expect, it } from 'vitest';

import { idBytes } from '../../src/auth/ids.ts';
import { CLOSING_GRACE_MS } from '../../src/collab/gateway.ts';
import { waitFault } from '../support/collab-chaos.ts';
import { startCollab } from '../support/collab-harness.ts';
import { ManualClock } from '../support/manual-clock.ts';

describe('collab.lifecycle-reconciliation.integration [area:collab]', () => {
  it('closes an actually loaded tombstone after COMMIT without relying on the withheld notification', async () => {
    const clock = new ManualClock();
    const harness = await startCollab({ clock, extraEnv: { JOBS_ENABLED: 'false' } });
    let release: (() => Promise<void>) | undefined;
    let request: Promise<unknown> | undefined;
    try {
      const cast = await harness.server.seed.kernel();
      const noteId = NoteId.parse(cast.note.id);
      const client = await harness.open(cast.editorA, noteId);
      await client.waitFor('saved');
      const app = harness.application();
      const db = app.database.dbApp;
      if (db === null) throw new Error('The loaded document must have its database.');
      const before = await harness.committed(noteId);
      const fault = await harness.server.faults.arm(FAULT.treeHoldAfterCommitBeforeNotify);
      release = () => fault.disarm();
      const offset = harness.logs.length;
      request = cast.admin.client.post(`/nodes/${noteId}/trash`, { ifMatch: 1, json: {} });
      await waitFault(harness, FAULT.treeHoldAfterCommitBeforeNotify, offset);
      expect(
        await db
          .selectFrom('nodes')
          .select(['version', 'deleted_at'])
          .where('id', '=', idBytes(noteId))
          .executeTakeFirstOrThrow(),
      ).toEqual({ version: 2, deleted_at: clock.date() });
      expect(app.collab.server.loadedDocuments().map((document) => document.name)).toContain(
        noteDocName(noteId),
      );
      expect(client.stateless.filter((message) => message.t === 'closing')).toEqual([]);
      const closed = client.waitClosed();
      const sweeping = app.collab.gateway.sweepTrashedOnBoot();
      await expect
        .poll(() => client.stateless.find((message) => message.t === 'closing'))
        .toMatchObject({ reason: 'note-trashed' });
      await clock.advance(CLOSING_GRACE_MS);
      await sweeping;
      expect((await closed).collabReason).toBe('note-trashed');
      await expect
        .poll(() => app.collab.server.loadedDocuments().map((document) => document.name))
        .not.toContain(noteDocName(noteId));
      expect((await harness.committed(noteId)).text).toBe(before.text);
      await release();
      release = undefined;
      expect(await request).toMatchObject({ status: 200 });
      expect(app.collab.gateway.isClosing(noteId)).toBe(false);
    } finally {
      await release?.();
      await request;
      await harness.close();
    }
  });
});
