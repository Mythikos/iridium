import { LIMITS } from '@iridium/contracts';
import { describe, expect, it } from 'vitest';

import { queryAwarenessFrame, updateFrame } from '../../src/collab/testing/frames.ts';
import { startCollab } from '../support/collab-harness.ts';

describe('collab.limits.integration [area:collab]', () => {
  it.each(['frame', 'update', 'rate'] as const)(
    'refuses an excessive %s at its documented boundary',
    async (limit) => {
      const harness = await startCollab();
      try {
        const admin = await harness.server.seed.admin();
        const vault = await harness.server.seed.vault({ name: 'Limits' });
        const note = await harness.server.seed.note({
          vault,
          name: 'Limited',
          markdown: 'unchanged\n',
        });
        const client = await harness.open(admin, note.id, { role: 'manager' });
        await client.waitFor('saved');
        const closed = client.waitClosed();
        if (limit === 'frame')
          client.sendRaw(new Uint8Array(LIMITS.WS_MAX_PAYLOAD_BYTES + LIMITS.YJS_UPDATE_MAX_BYTES));
        else if (limit === 'update')
          client.sendRaw(
            updateFrame(
              client.documentName,
              new Uint8Array(LIMITS.YJS_UPDATE_MAX_BYTES + LIMITS.YJS_UPDATE_MAX_BYTES / 2),
            ),
          );
        else
          for (let index = 0; index <= LIMITS.YJS_MESSAGES_PER_WINDOW; index++)
            client.sendRaw(queryAwarenessFrame(client.documentName));
        const close = await closed;
        expect(close).toMatchObject(
          limit === 'frame'
            ? { code: 1009 }
            : { reason: limit === 'update' ? 'too-large' : 'rate-limited' },
        );
        const durable = await harness.committed(note.id);
        expect(durable.head).toBe(1);
        expect(durable.text).toBe(note.markdown);
      } finally {
        await harness.close();
      }
    },
  );

  it('refuses the twenty-first logical connection for one user while the first twenty stay open', async () => {
    const harness = await startCollab();
    try {
      const admin = await harness.server.seed.admin();
      const vault = await harness.server.seed.vault({ name: 'Connection cap' });
      const note = await harness.server.seed.note({
        vault,
        name: 'Twenty',
        markdown: 'connected\n',
      });
      const clients = await Promise.all(
        Array.from({ length: LIMITS.CONNECTIONS_PER_USER }, () =>
          harness.open(admin, note.id, { role: 'manager' }),
        ),
      );
      await Promise.all(clients.map((client) => client.waitFor('saved')));
      const refused = await harness.open(admin, note.id, { role: 'manager' });
      expect((await refused.waitClosed()).reason).toBe('rate-limited');
      expect(clients.every((client) => client.closes.length === 0)).toBe(true);
      expect(harness.application().collab.server.loadedDocuments()[0]?.connections).toBe(
        LIMITS.CONNECTIONS_PER_USER,
      );
    } finally {
      await harness.close();
    }
  }, 60_000);
});
