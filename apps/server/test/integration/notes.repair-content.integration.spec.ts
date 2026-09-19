/** The operator repair service over real CRDT frames, MySQL, and audit transactions. */
import { LIMITS, NoteId, SessionId, UserId, type Principal } from '@iridium/contracts';
import {
  createNoteDoc,
  encodeState,
  getContent,
  loadState,
  LOAD_ORIGIN,
  scanHostileContent,
  sameDocumentState,
  projectMarkdown,
  stateVector,
  type NoteDoc,
} from '@iridium/crdt';
import { describe, expect, it } from 'vitest';

import { idBytes } from '../../src/auth/ids.ts';
import { updateFrame } from '../../src/collab/testing/frames.ts';
import { contentHash } from '../../src/projection/hash.ts';
import { startCollab } from '../support/collab-harness.ts';
import { registerRecordingOpenApiMatcher } from '../support/openapi-coverage.ts';

registerRecordingOpenApiMatcher();

const CASES = [
  {
    kind: 'cr',
    reason: 'cr',
    droppedEmbeds: 0,
    attributeRuns: 0,
    mutate: (doc: NoteDoc): void => {
      const text = getContent(doc);
      text.insert(text.length, '\rrepair\r\nme');
    },
  },
  {
    kind: 'attributes',
    reason: 'attributes',
    droppedEmbeds: 0,
    attributeRuns: 1,
    mutate: (doc: NoteDoc): void => {
      getContent(doc).format(0, 3, { bold: true, italic: true });
    },
  },
  {
    kind: 'embed',
    reason: 'attributes',
    droppedEmbeds: 1,
    attributeRuns: 0,
    mutate: (doc: NoteDoc): void => {
      getContent(doc).insertEmbed(2, { image: 'fixture-only' });
    },
  },
] as const;

describe('notes.repair-content.integration [area:collab]', () => {
  it('repairs a multi-frame Unicode replacement into bounded durable rows with trusted attribution', async () => {
    const harness = await startCollab();
    try {
      const cast = await harness.server.seed.kernel();
      const noteId = NoteId.parse(cast.note.id);
      const client = await harness.open(cast.editorA, noteId);
      await client.waitFor('saved');
      const app = harness.application();
      const actor: Principal = { kind: 'system', job: 'cli:doctor' };
      const edit = await app.collab.gateway.openServerEdit(noteId, {
        principal: actor,
        permission: 'note:write',
        reason: 'repair',
      });
      try {
        // CRs at both ends force the middle diff to replace > 1 MiB of valid Unicode too.
        edit.insertChunked(getContent(edit.document).length, '\r' + '漢😀'.repeat(180_000) + '\r');
        await app.collab.persistence.compactNow(noteId, { trigger: 'flush' });
      } finally {
        await edit.disconnect();
      }
      const before = await harness.committed(noteId);
      expect(before.contentInvalid).toBe(true);
      const expected = before.text.replaceAll('\r', '\n');
      expect(Buffer.byteLength(expected, 'utf8')).toBeGreaterThan(LIMITS.YJS_UPDATE_MAX_BYTES);
      const report = await app.notes.repairContent(noteId, { actor });
      expect(report.outcome).toBe('repaired');
      const after = await harness.committed(noteId);
      expect(after.text).toBe(expected);
      expect(after.contentInvalid).toBe(false);
      expect(after.projected).toBe(after.head);
      const rows = after.updates.filter((row) => row.seq > before.head);
      expect(rows.length).toBeGreaterThan(1);
      expect(after.head).toBe(before.head + rows.length);
      expect(
        rows.every((row) => row.origin === 'repair' && row.bytes <= LIMITS.YJS_UPDATE_MAX_BYTES),
      ).toBe(true);
      const db = app.database.dbApp;
      if (db === null) throw new Error('Repair needs the real database.');
      const attribution = await db
        .selectFrom('note_updates')
        .select(['actor_type', 'actor_id', 'session_id'])
        .where('note_id', '=', idBytes(noteId))
        .where('seq', '>', before.head)
        .execute();
      expect(attribution).toEqual(
        rows.map(() => ({ actor_type: 'system', actor_id: null, session_id: null })),
      );
    } finally {
      await harness.close();
    }
  }, 60_000);

  it.each(CASES)(
    'preserves a recoverable $kind checkpoint, repairs once, and resumes editing',
    async (fixture) => {
      const harness = await startCollab();
      try {
        const cast = await harness.server.seed.kernel();
        const app = harness.application();
        const noteId = NoteId.parse(cast.note.id);
        const db = app.database.dbApp;
        if (db === null) throw new Error('Repair requires the real application database.');
        const client = await harness.open(cast.editorA, noteId);
        await client.waitFor('saved');
        const session = await harness.server.sessions.current(cast.editorA);
        const actors: Readonly<Record<string, Principal>> = {
          cr: { kind: 'system', job: 'cli:doctor', onBehalfOf: UserId.parse(cast.editorA.id) },
          attributes: {
            kind: 'user',
            userId: UserId.parse(cast.editorA.id),
            sessionId: SessionId.parse(session.session.id),
            sessionKind: 'web',
            isServerAdmin: false,
            authzVersion: 1,
            lastAuthenticatedAt: new Date(),
          },
          embed: { kind: 'system', job: 'cli:doctor' },
        };
        const actor = actors[fixture.kind];
        if (actor === undefined) throw new Error('Each repair case needs an actor.');
        const clean = await app.notes.repairContent(noteId, { actor });
        expect(clean).toMatchObject({
          outcome: 'clean',
          reason: null,
          diff: null,
          preRepairRevisionId: null,
        });
        const invalid = client.waitForStateless('content-invalid');
        const hostile = createNoteDoc({ gc: true });
        try {
          loadState(hostile, encodeState(client.ydoc, 2), 2, LOAD_ORIGIN);
          fixture.mutate(hostile);
          client.sendRaw(
            updateFrame(client.documentName, encodeState(hostile, 1, stateVector(client.ydoc))),
          );
        } finally {
          hostile.destroy();
        }
        expect((await invalid).reason).toBe(fixture.reason);
        await expect.poll(async () => (await harness.committed(noteId)).contentInvalid).toBe(true);
        const before = await harness.committed(noteId);
        const rest = await harness.server.loginAs(cast.editorA);
        const refused = await rest.get(`/notes/${noteId}/markdown?fresh=true`);
        expect(refused.status).toBe(409);
        await expect(refused).toMatchOpenApi('notes.getMarkdown', 409);
        const dry = await app.notes.repairContent(noteId, { actor, dryRun: true });
        expect(dry).toMatchObject({
          outcome: 'dry-run',
          reason: fixture.reason,
          droppedEmbeds: fixture.droppedEmbeds,
          attributeRuns: fixture.attributeRuns,
        });
        expect(dry.preRepairRevisionId).toBeTypeOf('number');
        expect((await harness.committed(noteId)).head).toBe(before.head);
        expect((await harness.committed(noteId)).contentInvalid).toBe(true);
        const checkpoint = await db
          .selectFrom('note_revisions')
          .selectAll()
          .where('note_id', '=', idBytes(noteId))
          .where('id', '=', dry.preRepairRevisionId ?? -1)
          .executeTakeFirstOrThrow();
        expect(checkpoint).toMatchObject({
          label: 'pre-repair',
          kind: 'pre_restore',
          seq: before.head,
          snapshot_format: 2,
        });
        expect(checkpoint.snapshot).not.toBeNull();
        const recoverable = createNoteDoc({ gc: true });
        const replay = createNoteDoc({ gc: true });
        try {
          if (checkpoint.snapshot === null)
            throw new Error('Repair checkpoint must retain the hostile document.');
          loadState(recoverable, checkpoint.snapshot, 2, LOAD_ORIGIN);
          expect(scanHostileContent(recoverable).ok).toBe(false);
          const prefix = await db
            .selectFrom('note_updates')
            .select(['seq', 'update_v1'])
            .where('note_id', '=', idBytes(noteId))
            .where('seq', '<=', checkpoint.seq)
            .orderBy('seq', 'asc')
            .execute();
          expect(prefix.map((row) => row.seq)).toEqual(
            Array.from({ length: checkpoint.seq }, (_, index) => index + 1),
          );
          for (const row of prefix) loadState(replay, row.update_v1, 1, LOAD_ORIGIN);
          expect(sameDocumentState(recoverable, replay)).toBe(true);
          expect(projectMarkdown(replay)).toBe(checkpoint.markdown);
          expect(Buffer.from(checkpoint.content_hash)).toEqual(
            contentHash(projectMarkdown(replay)),
          );
        } finally {
          recoverable.destroy();
          replay.destroy();
        }
        const repaired = await app.notes.repairContent(noteId, {
          actor,
          context: { client: 'cli', request_id: 'repair-proof' },
        });
        expect(repaired).toMatchObject({
          outcome: 'repaired',
          reason: fixture.reason,
          droppedEmbeds: fixture.droppedEmbeds,
          attributeRuns: fixture.attributeRuns,
        });
        const durable = await harness.committed(noteId);
        expect(durable.contentInvalid).toBe(false);
        expect(durable.projected).toBe(durable.head);
        const repairRows = durable.updates.filter((row) => row.seq > before.head);
        expect(repairRows.length).toBeGreaterThan(0);
        expect(durable.head).toBe(before.head + repairRows.length);
        expect(
          repairRows.every(
            (row) => row.origin === 'repair' && row.bytes <= LIMITS.YJS_UPDATE_MAX_BYTES,
          ),
        ).toBe(true);
        expect(durable.text).not.toContain('\r');
        expect(durable.text.match(/⟦IMPORT-MARK⟧/gu)).toHaveLength(1);
        const audit = await db
          .selectFrom('audit_events')
          .select(['actor_type', 'actor_id', 'credential_type', 'reason', 'target_id'])
          .where('action', '=', 'note.content.repaired')
          .where('target_id', '=', idBytes(noteId))
          .execute();
        expect(audit).toHaveLength(1);
        expect(audit[0]).toMatchObject({
          actor_type: actor.kind === 'user' ? 'user' : 'system',
          credential_type: actor.kind === 'user' ? 'session' : 'cli',
          reason: fixture.reason,
        });
        expect((await app.notes.repairContent(noteId, { actor })).outcome).toBe('clean');
        const fresh = await rest.get(`/notes/${noteId}/markdown?fresh=true`);
        expect(fresh.status).toBe(200);
        expect(fresh.body).toBe(durable.text);
        await expect(fresh).toMatchOpenApi('notes.getMarkdown', 200);
        client.marker('continued-after-repair');
        await client.waitFor('saved');
        await expect
          .poll(async () => (await harness.committed(noteId)).text)
          .toContain('continued-after-repair');
      } finally {
        await harness.close();
      }
    },
    60_000,
  );
});
