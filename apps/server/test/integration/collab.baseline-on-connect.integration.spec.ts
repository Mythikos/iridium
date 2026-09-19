import { dominates, stateVector } from '@iridium/crdt';
import { describe, expect, it } from 'vitest';

import { expectConverged, startCollab } from '../support/collab-harness.ts';

describe('collab.baseline-on-connect.integration [hp:HP-2]', () => {
  it('answers an unedited attachment and every reconnect from the last committed vector', async () => {
    const harness = await startCollab();
    try {
      const cast = await harness.server.seed.kernel();
      const editor = await harness.open(cast.editorA, cast.note.id);
      await editor.waitFor('saved');
      expect(editor.text.toJSON()).toBe(cast.note.markdown);
      expect(
        editor.stateless
          .filter((message) => message.t === 'persisted')
          .map((message) => message.seq),
      ).toContain(1);
      await editor.disconnectSocket();
      const other = await harness.open(cast.editorB, cast.note.id);
      await other.waitFor('saved');
      const marker = other.marker('missed-ack');
      const durable = await expectConverged(harness, cast.note.id, [other]);
      expect(
        editor.stateless.some(
          (message) => message.t === 'persisted' && message.seq === durable.head,
        ),
      ).toBe(false);
      await editor.reconnectSocket();
      await editor.waitFor('saved');
      expect(editor.text.toJSON()).toContain(marker);
      expect(dominates(durable.sv, stateVector(editor.ydoc))).toBe(true);
      expect(
        editor.stateless.some(
          (message) => message.t === 'persisted' && message.seq === durable.head,
        ),
      ).toBe(true);
      await expectConverged(harness, cast.note.id, [editor, other]);
    } finally {
      await harness.close();
    }
  });
});
