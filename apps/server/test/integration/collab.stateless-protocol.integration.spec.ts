import { describe, expect, it } from 'vitest';

import { startCollab } from '../support/collab-harness.ts';

describe('collab.stateless-protocol.integration [area:collab] [hp:HP-5]', () => {
  it.each([
    ['unknown type', { v: 1, t: 'unknown' }],
    ['unknown version', { v: 2, t: 'baseline' }],
    ['invalid JSON', '{'],
    ['oversized payload', 'x'.repeat(4_097)],
    ['server-only payload', { v: 1, t: 'participants', users: [] }],
  ])(
    'closes malformed %s as a protocol error without applying data or leaking an unhandled rejection',
    async (_kind, payload) => {
      const harness = await startCollab();
      try {
        const cast = await harness.server.seed.kernel();
        const client = await harness.open(cast.editorA, cast.note.id);
        await client.waitFor('saved');
        const closed = client.waitClosed();
        client.sendStateless(payload);
        expect((await closed).reason).toBe('protocol-error');
        expect((await harness.committed(cast.note.id)).head).toBe(1);
        const metrics = await harness.server.metrics();
        expect(metrics['iridium_collab_hook_errors_total{hook="onStateless"}'] ?? 0).toBe(0);
        expect((await harness.server.rest().request('GET', '/healthz')).status).toBe(200);
      } finally {
        await harness.close();
      }
    },
  );
});
