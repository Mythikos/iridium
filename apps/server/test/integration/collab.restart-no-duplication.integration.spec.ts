import type { KernelSeed } from '@iridium/testkit';
import { describe, expect, it } from 'vitest';

import { expectConverged, startCollab, type CollabHarness } from '../support/collab-harness.ts';

describe('collab.restart-no-duplication.integration [hp:HP-1]', () => {
  it('preserves the seed and every marker exactly once across twenty in-process boots', async () => {
    let harness: CollabHarness | null = null;
    let cast: KernelSeed | null = null;
    const markers: string[] = [];
    try {
      for (let restart = 0; restart < 20; restart++) {
        // eslint-disable-next-line no-await-in-loop -- each new process observes the preceding committed state
        harness = await startCollab();
        // eslint-disable-next-line no-await-in-loop -- seed only the first boot through the product
        cast ??= await harness.server.seed.kernel();
        const boot = harness;
        const seeded = cast;
        // eslint-disable-next-line no-await-in-loop -- both peers connect to this boot before editing
        const clients = await Promise.all(
          [seeded.editorA, seeded.editorB].map((user) => boot.open(user, seeded.note.id)),
        );
        const first = clients[0];
        const second = clients[1];
        if (first === undefined || second === undefined)
          throw new Error('Both restart editors must be connected.');
        // eslint-disable-next-line no-await-in-loop -- inspect recovery before adding this iteration's marker
        await Promise.all([first.waitFor('saved'), second.waitFor('saved')]);
        expect(first.text.toJSON().split('⟦IMPORT-MARK⟧')).toHaveLength(2);
        for (const marker of markers) expect(first.text.toJSON().split(marker)).toHaveLength(2);
        markers.push(first.marker(`a-${String(restart)}`), second.marker(`b-${String(restart)}`));
        // eslint-disable-next-line no-await-in-loop -- durability is the restart barrier
        await expectConverged(harness, cast.note.id, [first, second]);
        // eslint-disable-next-line no-await-in-loop -- the old owner drains before the next boot acquires its schema lease
        await harness.close();
        harness = null;
      }
    } finally {
      await harness?.close();
    }
  }, 180_000);

  it('keeps both clients and their unsent state across five real child restarts', async () => {
    const harness = await startCollab({ mode: 'child' });
    try {
      await harness.server.waitReady();
      const cast = await harness.server.seed.kernel();
      const clients = await Promise.all(
        [cast.editorA, cast.editorB].map((user) => harness.open(user, cast.note.id)),
      );
      await Promise.all(clients.map((client) => client.waitFor('saved')));
      const ids = clients.map((client) => client.clientId);
      const markers: string[] = [];
      for (let restart = 0; restart < 5; restart++) {
        markers.push(
          ...clients.map((client, actor) =>
            client.marker(`child-${String(actor)}-${String(restart)}`),
          ),
        );
        // eslint-disable-next-line no-await-in-loop -- only acknowledged content is used as the crash oracle
        await expectConverged(harness, cast.note.id, clients);
        // eslint-disable-next-line no-await-in-loop -- each iteration is a complete real kill and boot
        await harness.server.restart();
        // eslint-disable-next-line no-await-in-loop -- reconnect baseline must re-establish saved before inspection
        await expectConverged(harness, cast.note.id, clients);
        expect(clients.map((client) => client.clientId)).toEqual(ids);
        for (const client of clients) {
          expect(client.text.toJSON().split('⟦IMPORT-MARK⟧')).toHaveLength(2);
          for (const marker of markers) expect(client.text.toJSON().split(marker)).toHaveLength(2);
        }
      }
    } finally {
      await harness.close();
    }
  }, 120_000);
});
