import { describe, expect, it } from 'vitest';

import { startCollab } from '../support/collab-harness.ts';

describe('collab.admission-budget.integration [area:collab]', () => {
  it('refuses the ninth document, audits capacity, and admits it after one document unloads without eviction', async () => {
    const harness = await startCollab({ limits: { maxLoadedDocs: 8, maxStateBytesTotal: '2MiB' } });
    try {
      const admin = await harness.server.seed.admin();
      const vault = await harness.server.seed.vault({ name: 'Admission' });
      const notes = await Promise.all(
        Array.from({ length: 9 }, (_, index) =>
          harness.server.seed.note({ vault, name: `Note ${String(index)}`, markdown: 'budget\n' }),
        ),
      );
      const clients = await Promise.all(
        notes.slice(0, 8).map((note) => harness.open(admin, note.id, { role: 'manager' })),
      );
      await Promise.all(clients.map((client) => client.waitFor('saved')));
      const ninth = notes[8];
      const first = clients[0];
      if (ninth === undefined || first === undefined)
        throw new Error('The admission fixture must contain nine notes and eight clients.');
      expect(harness.application().collab.server.loadedDocuments()).toHaveLength(8);
      const refused = await harness.open(admin, ninth.id, { role: 'manager' });
      const close = await refused.waitClosed();
      expect(close.reason).toBe('capacity');
      expect(harness.application().collab.server.loadedDocuments()).toHaveLength(8);
      expect(
        (await harness.server.metrics())['iridium_collab_admission_refused_total{reason="docs"}'],
      ).toBe(1);
      await expect
        .poll(
          async () =>
            (
              await harness.sql.rows(
                `SELECT COUNT(*) FROM ${harness.server.schema}.audit_events WHERE action='collab.connection.rejected' AND reason='capacity_docs'`,
              )
            )[0]?.[0],
        )
        .toBe('1');
      expect(clients.every((client) => client.closes.length === 0)).toBe(true);
      await refused.close();
      await first.close();
      await expect.poll(() => harness.application().collab.server.loadedDocuments().length).toBe(7);
      const admitted = await harness.open(admin, ninth.id, { role: 'manager' });
      await admitted.waitFor('saved');
      expect(harness.application().collab.server.loadedDocuments()).toHaveLength(8);
    } finally {
      await harness.close();
    }
  }, 60_000);

  it('reserves measured binary state against the byte budget and never evicts open notes', async () => {
    const harness = await startCollab({ limits: { maxLoadedDocs: 8, maxStateBytesTotal: '2MiB' } });
    try {
      const admin = await harness.server.seed.admin();
      const vault = await harness.server.seed.vault({ name: 'Bytes' });
      const notes = await Promise.all(
        Array.from({ length: 3 }, (_, index) =>
          harness.server.seed.note({
            vault,
            name: `Large ${String(index)}`,
            markdown: 'a'.repeat(750_000),
          }),
        ),
      );
      const first = notes[0];
      const second = notes[1];
      const third = notes[2];
      if (first === undefined || second === undefined || third === undefined)
        throw new Error('The byte fixture requires three notes.');
      const clients = await Promise.all(
        [first, second].map((note) => harness.open(admin, note.id, { role: 'manager' })),
      );
      await Promise.all(clients.map((client) => client.waitFor('saved')));
      const rejected = await harness.open(admin, third.id, { role: 'manager' });
      expect((await rejected.waitClosed()).reason).toBe('capacity');
      expect(
        (await harness.server.metrics())['iridium_collab_admission_refused_total{reason="bytes"}'],
      ).toBe(1);
      expect(harness.application().collab.server.loadedDocuments()).toHaveLength(2);
      expect(clients.every((client) => client.closes.length === 0)).toBe(true);
    } finally {
      await harness.close();
    }
  }, 60_000);
});
