import { describe, expect, it } from 'vitest';

import { startCollab } from '../support/collab-harness.ts';

describe('collab.isolation.integration [hp:HP-3]', () => {
  it('keeps a foreign note indistinguishable from a missing one and never loads or appends it', async () => {
    const harness = await startCollab();
    try {
      const cast = await harness.server.seed.kernel();
      const foreign = await harness.open(cast.outsider, cast.note.id);
      const foreignClose = await foreign.waitClosed();
      expect(foreignClose.reason).toBe('note-not-found');
      const missing = await harness.open(cast.outsider, '00000000-0000-7000-8000-000000000001');
      expect((await missing.waitClosed()).reason).toBe(foreignClose.reason);
      expect(harness.application().collab.server.loadedDocuments()).toEqual([]);
      expect((await harness.committed(cast.note.id)).head).toBe(1);
      expect(foreign.text.toJSON()).toBe('');
      expect(missing.text.toJSON()).toBe('');
      const legitimate = await harness.open(cast.editorA, cast.note.id);
      await legitimate.waitFor('saved');
      expect(legitimate.text.toJSON()).toContain('⟦IMPORT-MARK⟧');
    } finally {
      await harness.close();
    }
  });
});
