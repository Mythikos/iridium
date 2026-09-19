import { describe, expect, it } from 'vitest';

import { expectConverged, startCollab } from '../support/collab-harness.ts';

describe('collab.convergence.integration [hp:HP-1]', () => {
  it('converges after 500 overlapping random operations from each of three real editors', async () => {
    const harness = await startCollab();
    try {
      const cast = await harness.server.seed.kernel();
      const clients = await Promise.all(
        [cast.editorA, cast.editorB, cast.editorC].map((user) =>
          harness.open(user, cast.note.id, { flushDelayMs: 10 }),
        ),
      );
      await Promise.all(clients.map((client) => client.waitFor('saved')));
      let randomState = 0x17_09_26;
      const random = (): number => {
        randomState = (Math.imul(randomState, 1_664_525) + 1_013_904_223) >>> 0;
        return randomState / 0x1_0000_0000;
      };
      for (let batch = 0; batch < 20; batch++) {
        for (let operation = 0; operation < 25; operation++) {
          for (const [actor, client] of clients.entries()) {
            const position = Math.floor(random() * (client.text.length + 1));
            if (random() < 0.35 && position < client.text.length) client.deleteAt(position, 1);
            else client.typeAt(position, String.fromCharCode(97 + actor));
          }
        }
        // Each batch overlaps on the wire; waiting for its commit keeps the real 200/10s frame cap intact.
        // eslint-disable-next-line no-await-in-loop -- batches deliberately interleave editing with observed commits
        await expectConverged(harness, cast.note.id, clients);
      }
      const durable = await expectConverged(harness, cast.note.id, clients);
      expect(
        durable.updates.some(
          (row) => row.actorId.toLowerCase() === cast.editorA.id.replaceAll('-', ''),
        ),
      ).toBe(true);
      expect(
        durable.updates.some(
          (row) => row.actorId.toLowerCase() === cast.editorB.id.replaceAll('-', ''),
        ),
      ).toBe(true);
      expect(
        durable.updates.some(
          (row) => row.actorId.toLowerCase() === cast.editorC.id.replaceAll('-', ''),
        ),
      ).toBe(true);
    } finally {
      await harness.close();
    }
  }, 90_000);
});
