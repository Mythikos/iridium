import { NoteId } from '@iridium/contracts';
import { describe, expect, it } from 'vitest';

import { startCollab } from '../support/collab-harness.ts';

describe('collab.participants.integration [area:collab]', () => {
  it('uses database identity and authenticated roles, collapses tabs, and removes only the final connection', async () => {
    const harness = await startCollab();
    try {
      const cast = await harness.server.seed.kernel();
      const first = await harness.open(cast.editorA, cast.note.id);
      await first.waitFor('saved');
      const second = await harness.open(cast.editorA, cast.note.id);
      const viewer = await harness.open(cast.viewer, cast.note.id, { role: 'viewer' });
      await Promise.all([second.waitFor('saved'), viewer.waitFor('read-only')]);
      const gateway = harness.application().collab.gateway;
      await expect.poll(() => gateway.participants(NoteId.parse(cast.note.id)).length).toBe(2);
      const expected = await harness.sql.rows(
        `SELECT HEX(id), display_name, color_hue FROM ${harness.server.schema}.users WHERE id IN (UNHEX('${cast.editorA.id.replaceAll('-', '')}'),UNHEX('${cast.viewer.id.replaceAll('-', '')}'));`,
      );
      for (const participant of gateway.participants(NoteId.parse(cast.note.id))) {
        const row = expected.find(
          (record) => record[0]?.toLowerCase() === participant.id.replaceAll('-', ''),
        );
        expect(participant.name).toBe(row?.[1]);
        expect(participant.colorHue).toBe(Number(row?.[2]));
        expect(participant.role).toBe(participant.id === cast.viewer.id ? 'viewer' : 'editor');
        expect(participant.connections).toBe(participant.id === cast.viewer.id ? 1 : 2);
      }
      first.publishPresence({ mode: 'reading' });
      await expect
        .poll(
          () =>
            gateway
              .participants(NoteId.parse(cast.note.id))
              .find((user) => user.id === cast.editorA.id)?.mode,
        )
        .toBe('reading');
      const message = first.stateless.findLast((entry) => entry.t === 'participants');
      expect(message?.t === 'participants' && message.users).toHaveLength(2);
      await second.close();
      await expect
        .poll(
          () =>
            gateway
              .participants(NoteId.parse(cast.note.id))
              .find((user) => user.id === cast.editorA.id)?.connections,
        )
        .toBe(1);
      await first.close();
      await expect
        .poll(() => gateway.participants(NoteId.parse(cast.note.id)).map((user) => user.id))
        .toEqual([cast.viewer.id]);
      expect(viewer.closes).toEqual([]);
    } finally {
      await harness.close();
    }
  });
});
