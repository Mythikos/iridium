import { LIMITS, NoteId } from '@iridium/contracts';
import { describe, expect, it } from 'vitest';

import { startCollab } from '../support/collab-harness.ts';

describe('collab.flush.integration [area:collab]', () => {
  it('compacts six requests per connection and answers excess with the current projection without work or failure', async () => {
    const harness = await startCollab({ collab: { debounceMs: 60_000, maxDebounceMs: 60_000 } });
    try {
      const cast = await harness.server.seed.kernel();
      const client = await harness.open(cast.editorA, cast.note.id);
      await client.waitFor('saved');
      const writer = harness.application().collab.persistence.writerOf(NoteId.parse(cast.note.id));
      if (writer === undefined) throw new Error('The connected note must own a writer.');
      for (let request = 0; request < LIMITS.FLUSH_PER_MINUTE; request++) {
        const acknowledgement = client.waitForAck();
        client.marker(`flush-${String(request)}`);
        // eslint-disable-next-line no-await-in-loop -- each distinct committed head needs its own flush request
        const ack = await acknowledgement;
        const projected = client.waitForStateless('projected');
        client.sendStateless({ v: 1, t: 'flush' });
        // eslint-disable-next-line no-await-in-loop -- serialize the rate requests and verify each actual compaction
        expect((await projected).seq).toBe(ack.seq);
      }
      const metric = 'iridium_compactions_total{status="ok",trigger="flush"}';
      const beforeMetrics = await harness.server.metrics();
      expect(beforeMetrics[metric]).toBe(LIMITS.FLUSH_PER_MINUTE);
      const before = await harness.committed(cast.note.id);
      const lastProjected = writer.lastProjectedSeq;
      const failures = client.stateless.filter((message) => message.t === 'persist-failed').length;
      const refused = client.waitForStateless('projected');
      client.sendStateless({ v: 1, t: 'flush' });
      expect((await refused).seq).toBe(lastProjected);
      expect((await harness.server.metrics())[metric]).toBe(beforeMetrics[metric]);
      expect(writer.pendingCompactions).toBe(0);
      expect((await harness.committed(cast.note.id)).head).toBe(before.head);
      expect(client.stateless.filter((message) => message.t === 'persist-failed')).toHaveLength(
        failures,
      );
      expect(client.closes).toEqual([]);
      const peer = await harness.open(cast.editorA, cast.note.id);
      await peer.waitFor('saved');
      const ownBudget = peer.waitForStateless('projected');
      peer.sendStateless({ v: 1, t: 'flush' });
      await ownBudget;
      expect((await harness.server.metrics())[metric]).toBe((beforeMetrics[metric] ?? 0) + 1);
    } finally {
      await harness.close();
    }
  });
});
