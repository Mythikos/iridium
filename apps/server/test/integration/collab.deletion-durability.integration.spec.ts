/** A deletion has no new Yjs struct clock, but still requires a durable acknowledgement. */
import { NoteId } from '@iridium/contracts';
import { stateVector } from '@iridium/crdt';
import { describe, expect, it } from 'vitest';

import { waitFault } from '../support/collab-chaos.ts';
import { startCollab } from '../support/collab-harness.ts';
import { ManualClock } from '../support/manual-clock.ts';

describe('collab.deletion-durability.integration [hp:HP-1]', () => {
  it.each(['local', 'relayed'] as const)(
    'keeps a %s pure deletion unsaved after transport acceptance until its real MySQL COMMIT',
    async (source) => {
      const clock = new ManualClock(Date.now());
      const harness = await startCollab({ clock });
      try {
        const cast = await harness.server.seed.kernel();
        const noteId = NoteId.parse(cast.note.id);
        const editor = await harness.open(cast.editorA, noteId, { flushDelayMs: false });
        await editor.waitFor('saved');
        const peer = await harness.open(cast.editorB, noteId, { flushDelayMs: false });
        await peer.waitFor('saved');
        const sender = source === 'local' ? editor : peer;
        const before = await harness.committed(noteId);
        expect(before.text.length).toBeGreaterThan(0);
        const vector = stateVector(editor.ydoc);
        const app = harness.application();
        const writer = app.collab.persistence.writerOf(noteId);
        if (writer === undefined) throw new Error('The real loaded writer is required.');
        const start = harness.logs.length;
        app.faults.arm({ point: 'store.slow', arg: 3_000 });
        sender.text.delete(0, sender.text.length);
        await waitFault(harness, 'store.slow', start);
        await expect.poll(() => sender.session.input.unsynced).toBe(0);
        await expect.poll(() => editor.text.length).toBe(0);
        await expect.poll(() => peer.text.length).toBe(0);
        expect(stateVector(editor.ydoc)).toEqual(vector);
        expect(writer.lastCommittedSeq).toBe(before.head);
        expect((await harness.committed(noteId)).text).toBe(before.text);
        expect(editor.saveState).toBe('syncing');
        expect(editor.session.snapshot.warnsBeforeUnload).toBe(true);
        expect(peer.saveState).toBe('syncing');
        expect(peer.session.snapshot.warnsBeforeUnload).toBe(true);
        app.faults.arm({ point: 'store.slow', count: 0 });
        await clock.advance(3_000);
        await editor.waitFor('saved');
        expect(editor.session.snapshot.warnsBeforeUnload).toBe(false);
        expect((await harness.committed(noteId)).text).toBe('');
        await peer.waitFor('saved');
        expect(peer.session.snapshot.warnsBeforeUnload).toBe(false);
        await editor.reconnectSocket();
        await editor.waitFor('saved');
        expect(editor.text.length).toBe(0);
        expect(editor.session.snapshot.warnsBeforeUnload).toBe(false);
      } finally {
        harness.application().faults.arm({ point: 'store.slow', count: 0 });
        await clock.advance(3_000);
        await harness.close();
      }
    },
  );
});
