import { FAULT } from '@iridium/testkit';
import { describe, expect, it } from 'vitest';

import { ROUTINE_ITERATIONS, waitFault } from '../support/collab-chaos.ts';
import { expectConverged, startCollab } from '../support/collab-harness.ts';

describe('collab.compaction-failure.chaos [hp:HP-1] [hp:HP-2] [area:content]', () => {
  it.each(Array.from({ length: ROUTINE_ITERATIONS }, (_, index) => index))(
    'keeps acknowledged edits saved while the projection recovers: iteration %i',
    async (iteration) => {
      const harness = await startCollab({
        mode: 'child',
      });
      try {
        await harness.server.waitReady();
        const cast = await harness.server.seed.kernel();
        const reader = await harness.server.loginAs(cast.editorA);
        const editor = await harness.open(cast.editorA, cast.note.id);
        await editor.waitFor('saved');
        const before = await reader.api('GET', `/notes/${cast.note.id}/markdown`);
        const fault = await harness.server.faults.arm(FAULT.compactThrow);
        const logStart = harness.logs.length;
        const marker = editor.marker(`compaction-${String(iteration)}`);
        const committed = await expectConverged(harness, cast.note.id, [editor]);
        await waitFault(harness, FAULT.compactThrow, logStart);
        expect(editor.saveState).toBe('saved');
        const stale = await reader.api('GET', `/notes/${cast.note.id}/markdown`);
        expect(stale.status).toBe(200);
        expect(stale.headers.get('etag')).toBe(before.headers.get('etag'));
        expect(stale.body).toEqual(before.body);
        expect(committed.text).toContain(marker);
        expect((await harness.server.rest().request('GET', '/readyz')).status).toBe(200);
        await fault.disarm();
        const projected = editor.waitForStateless('projected');
        editor.sendStateless({ v: 1, t: 'flush' });
        expect((await projected).seq).toBe(committed.head);
        const current = await reader.api('GET', `/notes/${cast.note.id}/markdown`);
        expect(current.body).toContain(marker);
        expect(current.headers.get('etag')).not.toBe(before.headers.get('etag'));
      } finally {
        await harness.close();
      }
    },
    90_000,
  );
});
