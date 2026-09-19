import { NoteId } from '@iridium/contracts';
import { describe, expect, it } from 'vitest';

import { expectConverged, startCollab } from '../support/collab-harness.ts';

describe('collab.unload-reopen.integration [spec:initialization-reconnection]', () => {
  it('disposes the last writer and reopens from its V2 snapshot without duplicating initialization', async () => {
    const harness = await startCollab();
    try {
      const cast = await harness.server.seed.kernel();
      const first = await harness.open(cast.editorA, cast.note.id);
      await first.waitFor('saved');
      const original = harness
        .application()
        .collab.persistence.writerOf(NoteId.parse(cast.note.id));
      const marker = first.marker('unload-reopen');
      await expectConverged(harness, cast.note.id, [first]);
      await first.close();
      await expect.poll(() => harness.application().collab.server.loadedDocuments().length).toBe(0);
      expect(original?.state).toBe('disposed');
      const before = await harness.committed(cast.note.id);
      expect(before.snapshotThrough).toBe(before.head);
      const reopened = await harness.open(cast.editorB, cast.note.id);
      const durable = await expectConverged(harness, cast.note.id, [reopened]);
      expect(durable.head).toBe(before.head);
      expect(reopened.text.toJSON().split('⟦IMPORT-MARK⟧')).toHaveLength(2);
      expect(reopened.text.toJSON().split(marker)).toHaveLength(2);
      expect(
        harness.application().collab.persistence.writerOf(NoteId.parse(cast.note.id)),
      ).not.toBe(original);
    } finally {
      await harness.close();
    }
  });
});
