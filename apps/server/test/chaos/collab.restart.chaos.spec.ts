import { describe, expect, it } from 'vitest';

import { expectConverged, startCollab } from '../support/collab-harness.ts';

describe('collab.restart.chaos [hp:HP-2] [spec:initialization-reconnection]', () => {
  it('reloads a committed V2 snapshot plus its V1 tail after SIGKILL with every client absent', async () => {
    const harness = await startCollab({
      mode: 'child',
    });
    try {
      await harness.server.waitReady();
      const cast = await harness.server.seed.kernel();
      const editor = await harness.open(cast.editorA, cast.note.id);
      await editor.waitFor('saved');
      const compacted = editor.marker('snapshot-prefix');
      await expectConverged(harness, cast.note.id, [editor]);
      const projected = editor.waitForStateless('projected');
      editor.sendStateless({ v: 1, t: 'flush' });
      const checkpoint = await projected;
      const tail = editor.marker('v1-tail');
      const before = await expectConverged(harness, cast.note.id, [editor]);
      expect(before.head).toBeGreaterThan(checkpoint.seq);
      expect(before.snapshotThrough).toBe(checkpoint.seq);
      await harness.server.kill('SIGKILL');
      await editor.close();
      await harness.server.restart();
      const fresh = await harness.open(cast.editorB, cast.note.id);
      const after = await expectConverged(harness, cast.note.id, [fresh]);
      expect(after.head).toBe(before.head);
      expect(after.text).toBe(before.text);
      for (const marker of ['⟦IMPORT-MARK⟧', compacted, tail])
        expect(after.text.split(marker)).toHaveLength(2);
    } finally {
      await harness.close();
    }
  }, 60_000);
});
