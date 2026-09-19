import { LIMITS } from '@iridium/contracts';
import { FAULT } from '@iridium/testkit';
import { describe, expect, it } from 'vitest';

import { ROUTINE_ITERATIONS } from '../support/collab-chaos.ts';
import { expectConverged, startCollab } from '../support/collab-harness.ts';

describe.each(Array.from({ length: ROUTINE_ITERATIONS }, (_, index) => index))(
  'collab.oversize.chaos [hp:HP-5] iteration %i',
  () => {
    it('latches a soft-limit document read-only while refusing a hard-limit creation before any note rows exist', async () => {
      const harness = await startCollab({
        mode: 'child',
      });
      try {
        await harness.server.waitReady();
        const cast = await harness.server.seed.kernel();
        const editor = await harness.open(cast.editorA, cast.note.id);
        await editor.waitFor('saved');
        const oversized = editor.waitForStateless('size-exceeded');
        editor.typeAt(editor.text.length, 'x'.repeat(LIMITS.NOTE_SOFT_MAX_UTF16 + 1));
        await oversized;
        const durable = await harness.committed(cast.note.id);
        expect(durable.oversize).toBe(true);
        expect(durable.text.length).toBeGreaterThan(LIMITS.NOTE_SOFT_MAX_UTF16);
        const before = await harness.sql.rows(
          `SELECT COUNT(*) FROM ${harness.server.schema}.notes;`,
        );
        const refused = await cast.admin.client.api('POST', `/vaults/${cast.vault.id}/nodes`, {
          json: {
            kind: 'note',
            parentId: cast.vault.rootNodeId,
            name: 'Hard refusal',
            markdown: 'x'.repeat(LIMITS.NOTE_HARD_MAX_UTF16 + 1),
          },
        });
        expect(refused.status).toBe(413);
        expect(refused.body).toMatchObject({ code: 'payload_too_large' });
        expect(
          await harness.sql.rows(`SELECT COUNT(*) FROM ${harness.server.schema}.notes;`),
        ).toEqual(before);
        const fresh = await harness.open(cast.editorB, cast.note.id);
        await fresh.waitSynced();
        expect(fresh.text.toJSON()).toBe(durable.text);
        const marker = fresh.marker('must-refuse');
        await expect.poll(() => fresh.provider?.unsyncedChanges).toBeGreaterThan(0);
        const baseline = fresh.waitForAck(durable.head);
        fresh.sendStateless({ v: 1, t: 'baseline' });
        expect((await baseline).seq).toBe(durable.head);
        expect((await harness.committed(cast.note.id)).text).not.toContain(marker);
        // The fixed JSON body cap refuses large REST bodies before note construction. Exercise the
        // independent note hard cap through the real operator repair path after hostile wire input.
        const huge = await harness.server.seed.note({
          vault: cast.vault,
          name: 'Hostile hard cap',
          markdown: '',
        });
        const tooBig = await harness.open(cast.editorA, huge.id, { flushDelayMs: false });
        await tooBig.waitFor('saved');
        const compaction = await harness.server.faults.arm(FAULT.compactThrow);
        for (let offset = 0; offset < LIMITS.NOTE_HARD_MAX_UTF16 + 1; offset += 64_000) {
          tooBig.typeAt(
            tooBig.text.length,
            'y'.repeat(Math.min(64_000, LIMITS.NOTE_HARD_MAX_UTF16 + 1 - offset)),
          );
        }
        // Direct hostile wire input must preserve CR rather than the normal editor's LF normalization.
        tooBig.text.insert(tooBig.text.length, '\r');
        await expectConverged(harness, huge.id, [tooBig]);
        await compaction.disarm();
        const invalid = tooBig.waitForStateless('content-invalid');
        tooBig.sendStateless({ v: 1, t: 'flush' });
        await invalid;
        const beforeRepair = await harness.committed(huge.id);
        await Promise.all([editor.close(), fresh.close(), tooBig.close()]);
        await harness.server.stop();
        const refusedRepair = await harness.server.cli([
          'doctor',
          '--repair-content',
          huge.id,
          '--yes',
          '--json',
        ]);
        expect(refusedRepair.code).not.toBe(0);
        expect(refusedRepair.stderr).toContain('above the hard cap');
        const afterRepair = await harness.committed(huge.id);
        expect(afterRepair.head).toBe(beforeRepair.head);
        expect(afterRepair.contentInvalid).toBe(true);
        expect(afterRepair.updates.some((update) => update.origin === 'repair')).toBe(false);
      } finally {
        await harness.close();
      }
    }, 90_000);

    it('clears the real soft-size latch when audited content repair reduces the note below the cap', async () => {
      const harness = await startCollab({ mode: 'child' });
      try {
        await harness.server.waitReady();
        const cast = await harness.server.seed.kernel();
        const note = await harness.server.seed.note({
          vault: cast.vault,
          name: 'Oversize normalization',
          markdown: '',
        });
        const editor = await harness.open(cast.editorA, note.id, { flushDelayMs: false });
        await editor.waitFor('saved');
        const fault = await harness.server.faults.arm(FAULT.compactThrow);
        const raw = '\r\n'.repeat(Math.floor(LIMITS.NOTE_SOFT_MAX_UTF16 / 2) + 1);
        for (let offset = 0; offset < raw.length; offset += 64_000)
          editor.text.insert(editor.text.length, raw.slice(offset, offset + 64_000));
        await expectConverged(harness, note.id, [editor]);
        await fault.disarm();
        const invalid = editor.waitForStateless('content-invalid');
        const oversized = editor.waitForStateless('size-exceeded');
        editor.sendStateless({ v: 1, t: 'flush' });
        await Promise.all([invalid, oversized]);
        const beforeRepair = await harness.committed(note.id);
        expect(beforeRepair.oversize).toBe(true);
        expect(beforeRepair.contentInvalid).toBe(true);
        expect(beforeRepair.text.length).toBeGreaterThan(LIMITS.NOTE_SOFT_MAX_UTF16);
        await editor.close();
        await harness.server.stop();
        const repaired = await harness.server.cli([
          'doctor',
          '--repair-content',
          note.id,
          '--yes',
          '--json',
        ]);
        expect(repaired.code).toBe(0);
        const afterRepair = await harness.committed(note.id);
        const repairRows = afterRepair.updates.filter((row) => row.seq > beforeRepair.head);
        expect(repairRows.length).toBeGreaterThan(0);
        expect(repairRows.map((row) => row.seq)).toEqual(
          Array.from({ length: repairRows.length }, (_, index) => beforeRepair.head + index + 1),
        );
        expect(afterRepair.head).toBe(beforeRepair.head + repairRows.length);
        expect(afterRepair.projected).toBe(afterRepair.head);
        expect(afterRepair.updates.filter((row) => row.seq <= beforeRepair.head)).toEqual(
          beforeRepair.updates,
        );
        for (const row of repairRows) {
          expect(row.origin).toBe('repair');
          expect(row.actorId).toBe('');
          expect(row.bytes).toBeGreaterThan(0);
          expect(row.bytes).toBeLessThanOrEqual(LIMITS.YJS_UPDATE_MAX_BYTES);
        }
        expect(afterRepair.oversize).toBe(false);
        expect(afterRepair.contentInvalid).toBe(false);
        expect(afterRepair.text).toBe(raw.replaceAll('\r\n', '\n'));
        expect(afterRepair.text.length).toBeLessThan(LIMITS.NOTE_SOFT_MAX_UTF16);
        const noteHex = note.id.replaceAll('-', '');
        const attribution = await harness.sql.rows(
          `SELECT seq, actor_type, COALESCE(HEX(actor_id), ''), COALESCE(HEX(session_id), '')
            FROM ${harness.server.schema}.note_updates
            WHERE note_id=UNHEX('${noteHex}') AND seq>${String(beforeRepair.head)} ORDER BY seq;`,
        );
        expect(attribution).toEqual(repairRows.map((row) => [String(row.seq), 'system', '', '']));
        const audit = await harness.sql.rows(
          `SELECT actor_type, COALESCE(HEX(actor_id), ''), credential_type, reason, outcome,
            target_type, HEX(vault_id), JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.chars_before')),
            JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.chars_after'))
            FROM ${harness.server.schema}.audit_events
            WHERE target_id=UNHEX('${noteHex}') AND action='note.content.repaired';`,
        );
        expect(audit).toEqual([
          [
            'system',
            '',
            'cli',
            'cr',
            'success',
            'note',
            cast.vault.id.replaceAll('-', '').toUpperCase(),
            String(beforeRepair.text.length),
            String(afterRepair.text.length),
          ],
        ]);
        await harness.server.restart();
        const fresh = await harness.open(cast.editorB, note.id);
        await fresh.waitFor('saved');
        expect(fresh.session.input.oversize).toBe(false);
        expect(fresh.session.input.contentInvalid).toBe(false);
        const marker = fresh.marker('write-after-size-recovery');
        const writable = await expectConverged(harness, note.id, [fresh]);
        expect(writable.text.split(marker)).toHaveLength(2);
        expect(writable.oversize).toBe(false);
      } finally {
        await harness.close();
      }
    }, 120_000);
  },
);
