import { UserId } from '@iridium/contracts';
import { describe, expect, it } from 'vitest';

import { startCollab } from '../support/collab-harness.ts';
import { ManualClock } from '../support/manual-clock.ts';

describe('collab.epoch-steady-state.integration [hp:HP-3] [area:collab]', () => {
  it.each(['editor', 'administrator without membership'] as const)(
    'performs zero app SQL across 200 updates for %s and exactly two reads for one stale epoch',
    async (actor) => {
      const clock = new ManualClock();
      const harness = await startCollab({
        clock,
        collab: { debounceMs: 60_000, maxDebounceMs: 60_000 },
      });
      try {
        const cast = await harness.server.seed.kernel();
        const user = actor === 'editor' ? cast.editorA : cast.admin;
        const client = await harness.open(user, cast.note.id, {
          role: actor === 'editor' ? 'editor' : 'manager',
          flushDelayMs: false,
        });
        await client.waitFor('saved');
        const app = harness.application();
        clock.jump(clock.now() + 10_001);
        const before = app.database.queryCounts();
        for (let update = 0; update < 200; update++) {
          if (update === 100) clock.jump(clock.now() + 10_001);
          const ack = client.waitForAck();
          client.typeAt(client.text.length, '.');
          // eslint-disable-next-line no-await-in-loop -- observe every wire update and committed acknowledgement separately
          await ack;
        }
        expect(app.database.queryCounts().app - before.app).toBe(0);
        expect(app.database.queryCounts().persist).toBeGreaterThan(before.persist);
        clock.jump(clock.now() + 10_001);
        const identity = UserId.parse(user.id);
        const epoch = app.authz.epochs.userEpoch(identity);
        if (epoch === undefined) throw new Error('A live connection must retain its epoch.');
        app.authz.epochs.user(identity, epoch + 1);
        const beforeStale = app.database.queryCounts().app;
        const refreshed = client.waitForAck();
        client.typeAt(client.text.length, '!');
        await refreshed;
        expect(app.database.queryCounts().app - beforeStale).toBe(2);
        const next = client.waitForAck();
        client.typeAt(client.text.length, '?');
        await next;
        expect(app.database.queryCounts().app - beforeStale).toBe(2);
        expect(client.closes).toEqual([]);
      } finally {
        await harness.close();
      }
    },
    90_000,
  );
});
