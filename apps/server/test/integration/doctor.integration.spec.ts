/** Head diagnostics and repair operate on durable bookkeeping without replacing document identity. */
import { corruptDeliberately } from '@iridium/testkit';
import { describe, expect, it } from 'vitest';

import { idBytes } from '../../src/auth/ids.ts';
import { SYSTEM_ACTOR } from '../../src/cli/attribution.ts';
import { contentDoctorChecks, runRepairHeads } from '../../src/cli/doctor-content.ts';
import { BufferedIo } from '../../src/cli/output.ts';
import { startCollab } from '../support/collab-harness.ts';

describe('doctor.integration [area:ops]', () => {
  it('previews then audits a bookkeeping repair, preserves the binary rows, and refuses projected data ahead of the log', async () => {
    const harness = await startCollab();
    try {
      await harness.server.seed.admin();
      const vault = await harness.server.seed.vault({ name: 'Doctor heads' });
      const note = await harness.server.seed.note({
        vault,
        name: 'Durable source',
        markdown: '# Durable\nUnchanged bytes\n',
      });
      const app = harness.application();
      const db = app.database.dbApp;
      if (db === null) throw new Error('Expected database');
      const binary = await db
        .selectFrom('note_docs')
        .select(['snapshot', 'snapshot_sv', 'snapshot_through_seq'])
        .where('note_id', '=', idBytes(note.id))
        .executeTakeFirstOrThrow();
      const beforeAudit = await db
        .selectFrom('audit_events')
        .select((eb) => eb.fn.countAll<number>().as('total'))
        .executeTakeFirstOrThrow();
      await corruptDeliberately(db, {
        kind: 'note-head-sequence',
        noteId: idBytes(note.id),
        headSeq: 99,
      });
      expect(await contentDoctorChecks(app, { staleProjections: false, noteId: note.id })).toEqual([
        expect.objectContaining({
          name: 'heads',
          status: 'fail',
          detail: expect.stringContaining(note.id),
        }),
      ]);
      const base = {
        app,
        noteId: note.id,
        json: true,
        actor: SYSTEM_ACTOR,
        context: {
          os_user: 'fixture',
          host: 'integration',
          request_id: 'doctor-heads',
          argv_shape: 'doctor --repair-heads --note <value>',
        },
      };
      const preview = new BufferedIo();
      expect(await runRepairHeads({ ...base, io: preview, confirmed: false, dryRun: true })).toBe(
        0,
      );
      expect(JSON.parse(preview.stdout)).toEqual({
        results: [{ noteId: note.id, before: 99, after: 1, outcome: 'dry_run' }],
      });
      expect(
        (
          await db
            .selectFrom('note_docs')
            .select('head_seq')
            .where('note_id', '=', idBytes(note.id))
            .executeTakeFirstOrThrow()
        ).head_seq,
      ).toBe(99);
      expect(
        await db
          .selectFrom('audit_events')
          .select((eb) => eb.fn.countAll<number>().as('total'))
          .executeTakeFirstOrThrow(),
      ).toEqual(beforeAudit);
      const repaired = new BufferedIo();
      expect(await runRepairHeads({ ...base, io: repaired, confirmed: true, dryRun: false })).toBe(
        0,
      );
      expect(JSON.parse(repaired.stdout)).toEqual({
        results: [{ noteId: note.id, before: 99, after: 1, outcome: 'repaired' }],
      });
      expect(
        await db
          .selectFrom('note_docs')
          .select(['snapshot', 'snapshot_sv', 'snapshot_through_seq'])
          .where('note_id', '=', idBytes(note.id))
          .executeTakeFirstOrThrow(),
      ).toEqual(binary);
      expect(
        await db
          .selectFrom('audit_events')
          .select(['action', 'credential_type', 'metadata'])
          .where('action', '=', 'note.content.repaired')
          .executeTakeFirstOrThrow(),
      ).toMatchObject({
        action: 'note.content.repaired',
        credential_type: 'cli',
        metadata: { repair: 'heads', before: 99, after: 1 },
      });
      expect(await contentDoctorChecks(app, { staleProjections: false, noteId: note.id })).toEqual([
        expect.objectContaining({ status: 'ok' }),
      ]);
      expect(
        await runRepairHeads({ ...base, io: new BufferedIo(), confirmed: true, dryRun: false }),
      ).toBe(3);
      await corruptDeliberately(db, {
        kind: 'note-head-sequence',
        noteId: idBytes(note.id),
        headSeq: 99,
        projectedSeq: 99,
      });
      const unsafe = new BufferedIo();
      expect(await runRepairHeads({ ...base, io: unsafe, confirmed: true, dryRun: false })).toBe(3);
      expect(JSON.parse(unsafe.stdout)).toMatchObject({
        results: [{ outcome: 'refused_projection_ahead' }],
      });
      await corruptDeliberately(db, {
        kind: 'note-head-sequence',
        noteId: idBytes(note.id),
        headSeq: 1,
        projectedSeq: 1,
      });
    } finally {
      await harness.close();
    }
  });

  it('refuses a loaded document and reports stale projections without flushing the live writer', async () => {
    const harness = await startCollab({ collab: { debounceMs: 60_000, maxDebounceMs: 60_000 } });
    try {
      const cast = await harness.server.seed.kernel();
      const client = await harness.open(cast.editorA, cast.note.id);
      await client.waitFor('saved');
      client.marker('doctor-stale');
      await client.waitFor('saved');
      const head = await harness.committed(cast.note.id);
      const app = harness.application();
      const db = app.database.dbApp;
      if (db === null) throw new Error('Expected database');
      expect(await contentDoctorChecks(app, { heads: false, noteId: cast.note.id })).toEqual([
        expect.objectContaining({
          name: 'stale_projections',
          status: 'fail',
          detail: expect.stringContaining('1 stale projection'),
        }),
      ]);
      expect((await harness.committed(cast.note.id)).projected).toBe(head.projected);
      await corruptDeliberately(db, {
        kind: 'note-head-sequence',
        noteId: idBytes(cast.note.id),
        headSeq: 99,
      });
      try {
        const io = new BufferedIo();
        expect(
          await runRepairHeads({
            app,
            io,
            noteId: cast.note.id,
            confirmed: true,
            dryRun: false,
            json: true,
            actor: SYSTEM_ACTOR,
            context: {},
          }),
        ).toBe(3);
        expect(JSON.parse(io.stdout)).toMatchObject({ results: [{ outcome: 'refused_loaded' }] });
      } finally {
        await corruptDeliberately(db, {
          kind: 'note-head-sequence',
          noteId: idBytes(cast.note.id),
          headSeq: head.head,
        });
      }
    } finally {
      await harness.close();
    }
  });
});
