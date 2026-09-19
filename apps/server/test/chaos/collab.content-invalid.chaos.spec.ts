import { LIMITS } from '@iridium/contracts';
import {
  createNoteDoc,
  encodeState,
  getContent,
  loadState,
  LOAD_ORIGIN,
  scanHostileContent,
  stateVector,
} from '@iridium/crdt';
import { describe, expect, it } from 'vitest';

import { updateFrame } from '../../src/collab/testing/frames.ts';
import { ROUTINE_ITERATIONS } from '../support/collab-chaos.ts';
import { expectConverged, startCollab } from '../support/collab-harness.ts';
import { registerRecordingOpenApiMatcher } from '../support/openapi-coverage.ts';

registerRecordingOpenApiMatcher();

describe.each(Array.from({ length: ROUTINE_ITERATIONS }, (_, index) => index))(
  'collab.content-invalid.chaos [hp:HP-4] [area:collab] iteration %i',
  () => {
    it.each(['cr', 'attributes', 'embed'] as const)(
      'locks hostile %s and repairs it through the real operator CLI',
      async (kind) => {
        const harness = await startCollab({
          mode: 'child',
        });
        try {
          await harness.server.waitReady();
          const cast = await harness.server.seed.kernel();
          const clients = await Promise.all(
            [cast.editorA, cast.editorB].map((user) => harness.open(user, cast.note.id)),
          );
          await expectConverged(harness, cast.note.id, clients);
          const sender = clients[0];
          if (sender === undefined) throw new Error('A real editor is required.');
          const invalid = clients.map((client) => client.waitForStateless('content-invalid'));
          const hostile = createNoteDoc({ gc: true });
          try {
            loadState(hostile, encodeState(sender.ydoc, 2), 2, LOAD_ORIGIN);
            const content = getContent(hostile);
            if (kind === 'cr') content.insert(content.length, '\rhostile\r\ntext');
            else if (kind === 'attributes') content.format(0, 3, { bold: true });
            else content.insertEmbed(2, { image: 'fixture-only' });
            expect(scanHostileContent(hostile).ok).toBe(false);
            sender.sendRaw(
              updateFrame(sender.documentName, encodeState(hostile, 1, stateVector(sender.ydoc))),
            );
          } finally {
            hostile.destroy();
          }
          const notices = await Promise.all(invalid);
          expect(notices.map((message) => message.reason)).toEqual([
            kind === 'cr' ? 'cr' : 'attributes',
            kind === 'cr' ? 'cr' : 'attributes',
          ]);
          await expect
            .poll(async () => (await harness.committed(cast.note.id)).contentInvalid)
            .toBe(true);
          const invalidState = await harness.committed(cast.note.id);
          expect(invalidState.projected).toBeLessThan(invalidState.head);
          const reader = await harness.server.loginAs(cast.editorA);
          const projection = await reader.api('GET', `/notes/${cast.note.id}/markdown?fresh=true`);
          await expect(projection).toMatchOpenApi('notes.getMarkdown', 409);
          const head = invalidState.head;
          const expectedText = invalidState.text.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
          const refusals = clients.map((client) => client.waitForStateless('persist-failed'));
          clients.forEach((client, index) => client.marker(`refused-${String(index)}`));
          expect(
            (await Promise.all(refusals)).every((message) => message.reason === 'content_invalid'),
          ).toBe(true);
          expect((await harness.committed(cast.note.id)).head).toBe(head);
          await Promise.all(clients.map((client) => client.close()));
          await harness.server.stop();
          const dry = await harness.server.cli([
            'doctor',
            '--repair-content',
            cast.note.id,
            '--dry-run',
            '--json',
          ]);
          expect(dry.code, dry.stderr).toBe(0);
          expect(dry.stdout).toContain('dry-run');
          const afterDryRun = await harness.committed(cast.note.id);
          expect(afterDryRun.contentInvalid).toBe(true);
          expect(afterDryRun.head).toBe(head);
          expect(afterDryRun.updates).toEqual(invalidState.updates);
          const repaired = await harness.server.cli([
            'doctor',
            '--repair-content',
            cast.note.id,
            '--json',
            '--yes',
          ]);
          expect(repaired.code, repaired.stderr).toBe(0);
          expect(repaired.stdout).toContain('repaired');
          const durable = await harness.committed(cast.note.id);
          expect(durable.contentInvalid).toBe(false);
          expect(durable.projected).toBe(durable.head);
          const repairRows = durable.updates.filter((row) => row.seq > head);
          expect(repairRows.length).toBeGreaterThan(0);
          expect(repairRows.map((row) => row.seq)).toEqual(
            Array.from({ length: repairRows.length }, (_, index) => head + index + 1),
          );
          expect(durable.head).toBe(head + repairRows.length);
          expect(durable.updates.filter((row) => row.seq <= head)).toEqual(invalidState.updates);
          for (const row of repairRows) {
            expect(row.origin).toBe('repair');
            expect(row.actorId).toBe('');
            expect(row.bytes).toBeGreaterThan(0);
            expect(row.bytes).toBeLessThanOrEqual(LIMITS.YJS_UPDATE_MAX_BYTES);
          }
          expect(durable.text).toBe(expectedText);
          expect(durable.text).not.toContain('\r');
          expect(durable.text.split('⟦IMPORT-MARK⟧')).toHaveLength(2);
          const attribution = await harness.sql.rows(
            `SELECT seq, actor_type, COALESCE(HEX(actor_id), ''), COALESCE(HEX(session_id), '')
              FROM ${harness.server.schema}.note_updates
              WHERE note_id=UNHEX('${cast.note.id.replaceAll('-', '')}')
                AND seq>${String(head)} ORDER BY seq;`,
          );
          expect(attribution).toEqual(repairRows.map((row) => [String(row.seq), 'system', '', '']));
          const revisions = await harness.sql.rows(
            `SELECT label, kind FROM ${harness.server.schema}.note_revisions WHERE note_id=UNHEX('${cast.note.id.replaceAll('-', '')}') AND label='pre-repair';`,
          );
          expect(revisions.length).toBeGreaterThan(0);
          await harness.server.restart();
          const fresh = await harness.open(cast.editorC, cast.note.id);
          await fresh.waitFor('saved');
          expect(scanHostileContent(fresh.ydoc)).toEqual({ ok: true });
          expect(fresh.text.toJSON()).toBe(durable.text);
          const marker = fresh.marker('after-repair');
          expect((await expectConverged(harness, cast.note.id, [fresh])).text).toContain(marker);
          const audited = await harness.sql.rows(
            `SELECT action, actor_type, COALESCE(HEX(actor_id), ''), credential_type, reason,
              outcome, target_type, HEX(vault_id),
              JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.chars_before')),
              JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.chars_after'))
              FROM ${harness.server.schema}.audit_events
              WHERE target_id=UNHEX('${cast.note.id.replaceAll('-', '')}')
                AND action IN ('note.content.invalid','note.content.repaired') ORDER BY id;`,
          );
          expect(audited.map((row) => row[0])).toContain('note.content.invalid');
          expect(audited.filter((row) => row[0] === 'note.content.repaired')).toEqual([
            [
              'note.content.repaired',
              'system',
              '',
              'cli',
              kind === 'cr' ? 'cr' : 'attributes',
              'success',
              'note',
              cast.vault.id.replaceAll('-', '').toUpperCase(),
              String(invalidState.text.length),
              String(expectedText.length),
            ],
          ]);
        } finally {
          await harness.close();
        }
      },
      90_000,
    );
  },
);
