/**
 * The administrator's report keeps an attachment out of its candidate list while any retained
 * source still names it, and lists it once the last retaining source is gone.
 *
 * The retaining rows here are `checkpoint` revisions, the kind `revision_thinning` owns
 * (12-milestones.md §6.2), so the job really does decide what the report sees: the run below
 * removes the older of the two referencing rows. It cannot remove the newer one, because D05-10
 * retains every revision whose `content_hash` differs from both retained neighbours, so the newest
 * row of a referencing run always survives — no amount of thinning can make an attachment
 * unreferenced on its own. The flip the row is after is therefore proven against the real removal
 * path for that last source: a purge, after which the report lists the attachment and its bytes
 * still serve (the report never deletes).
 */
import {
  AttachmentUploaded,
  Node,
  NoteId,
  TrashNodeResult,
  UnreferencedAttachmentPage,
  UserId,
} from '@iridium/contracts';
import { storedSv } from '@iridium/crdt';
import { attachmentClient } from '@iridium/testkit';
import { describe, expect, it } from 'vitest';

import { idBytes } from '../../src/auth/ids.ts';
import { insertRevisionRow } from '../../src/collab/persistence/kysely-store.ts';
import { captureStoredState } from '../../src/notes/committed-state.ts';
import { appDb } from '../../src/rest/handler-context.ts';
import { startCollab } from '../support/collab-harness.ts';
import { ManualClock } from '../support/manual-clock.ts';

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
/** Neither clean state may contain the attachment's basename: the scan is conservative text. */
const CLEAN_SOURCE = 'This note starts with no file reference at all.';
const CLEARED_SOURCE = 'The current note no longer refers to a file.';

describe('attachments.unreferenced-report.integration [area:attachments]', () => {
  // Two report runs around a thinning pass, each a real worker scan over the retained revisions.
  // That is a few seconds here and past the project default of 30 s on a shared runner, where the
  // 9.7 lane expired while 8.4 did not. Budgeted per test rather than raising it for the project.
  it(
    'scans retained revisions in the worker and publishes the durable job result without deleting bytes',
    { timeout: 120_000 },
    async () => {
      const clock = new ManualClock(Math.floor(Date.now() / DAY) * DAY + 12 * HOUR);
      const startedAt = clock.now();
      const harness = await startCollab({
        clock,
        extraEnv: {
          JOBS_ENABLED: 'false',
          // The fixture ages history through the injected clock, so the sessions and the step-up
          // window have to outlive the retention bands the thinning run crosses.
          SESSION_WEB_IDLE_HOURS: '2400',
          SESSION_WEB_ABSOLUTE_DAYS: '365',
          STEP_UP_WINDOW_MIN: '100000',
        },
      });
      try {
        const cast = await harness.server.seed.kernel();
        const editor = await harness.server.loginAs(cast.editorA);
        const admin = await harness.server.loginAs(cast.admin);
        const invalid = await admin.get('/admin/attachments/unreferenced', {
          query: { limit: 0 },
        });
        expect(invalid.status).toBe(422);
        expect(invalid.body).toMatchObject({ code: 'validation_failed' });
        const absent = await admin.get('/admin/attachments/unreferenced', {
          query: { vaultId: cast.vault.id },
        });
        expect(absent.status).toBe(503);
        expect(absent.body).toMatchObject({ code: 'unavailable', retryAfterMs: 1000 });
        expect(absent.headers.get('retry-after')).toBe('1');
        const uploader = attachmentClient(editor);
        const retained = AttachmentUploaded.parse(
          (
            await uploader.upload({
              vaultId: cast.vault.id,
              filename: 'history.txt',
              bytes: Buffer.from('retained bytes'),
            })
          ).body,
        ).attachment;
        const unused = AttachmentUploaded.parse(
          (
            await uploader.upload({
              vaultId: cast.vault.id,
              filename: 'unused.txt',
              bytes: Buffer.from('unreferenced bytes'),
            })
          ).body,
        ).attachment;
        const otherUnused = AttachmentUploaded.parse(
          (
            await uploader.upload({
              vaultId: cast.vault.id,
              filename: 'second-unused.txt',
              bytes: Buffer.from('second unreferenced bytes'),
            })
          ).body,
        ).attachment;
        const referencingSource = `[history](${retained.pathHint})`;
        // The create revision and the named revision are both protected kinds (§6.2), so seeding
        // them clean is what leaves the reference resting on thinnable rows alone.
        const created = await editor.post(`/vaults/${cast.vault.id}/nodes`, {
          json: {
            kind: 'note',
            parentId: cast.vault.rootNodeId,
            name: 'Retained attachment history',
            markdown: CLEAN_SOURCE,
          },
        });
        expect(created.status).toBe(201);
        const note = Node.parse(created.body);
        const noteId = NoteId.parse(note.id);
        const named = await editor.post(`/notes/${note.id}/revisions`, {
          json: { label: 'Before the attachment was linked' },
        });
        expect(named.status).toBe(201);
        const application = harness.application();
        const db = appDb(application);
        const client = await harness.open(cast.editorA, note.id);
        await client.waitSynced();
        // The real producer seam: fresh committed state, the injected instant and a real sequence.
        const record = async (at: number, markdown: string): Promise<number> => {
          clock.jump(at);
          const acknowledged = client.waitForAck();
          client.ydoc.transact(() => {
            client.deleteAt(0, client.text.length);
            client.typeAt(0, markdown);
          });
          await acknowledged;
          const revision = await db.transaction().execute(async (trx) => {
            await application.collab.ownerLease.captureFence().assertCurrent(trx);
            const captured = await captureStoredState(trx, noteId, true);
            return insertRevisionRow(trx, idBytes(noteId), {
              seq: captured.throughSeq,
              kind: 'checkpoint',
              label: null,
              markdown: captured.markdown,
              contentHash: Buffer.from(captured.contentHash),
              sizeChars: captured.sizeChars,
              snapshot: captured.stateV2,
              snapshotSv: storedSv(captured.sv),
              actor: { actorType: 'user', userId: UserId.parse(cast.editorA.id), sessionId: null },
              createdAt: clock.date(),
            });
          });
          return revision.id;
        };
        const firstReference = await record(startedAt + HOUR, referencingSource);
        const lastReference = await record(startedAt + HOUR + 10 * MINUTE, referencingSource);
        await record(startedAt + HOUR + 20 * MINUTE, CLEARED_SOURCE);
        client.sendStateless({ v: 1, t: 'flush' });
        await expect
          .poll(
            async () =>
              (
                await editor.get<{ referencedByTotal: number }>(
                  `/vaults/${cast.vault.id}/attachments/${retained.id}/meta`,
                )
              ).body.referencedByTotal,
          )
          .toBe(0);
        await client.close();
        const report = async (): Promise<UnreferencedAttachmentPage> => {
          const run = await admin.post<{ id: string }>(
            '/admin/jobs/attachment_unreferenced_report/run',
            { json: { payload: { vaultId: cast.vault.id } } },
          );
          expect(run.status).toBe(202);
          await expect
            .poll(
              async () =>
                (await admin.get<{ status: string }>(`/admin/jobs/${run.body.id}`)).body.status,
              { timeout: 20_000 },
            )
            .toBe('succeeded');
          const response = await admin.get('/admin/attachments/unreferenced', {
            query: { vaultId: cast.vault.id },
          });
          expect(response.status).toBe(200);
          const page = UnreferencedAttachmentPage.parse(response.body);
          expect(page.jobId).toBe(run.body.id);
          return page;
        };
        const beforeThinning = await report();
        expect(new Set(beforeThinning.items.map((item) => item.id))).toEqual(
          new Set([unused.id, otherUnused.id]),
        );
        const first = UnreferencedAttachmentPage.parse(
          (
            await admin.get('/admin/attachments/unreferenced', {
              query: { vaultId: cast.vault.id, limit: 1 },
            })
          ).body,
        );
        expect(first.items).toHaveLength(1);
        expect(first.nextCursor).toBeTypeOf('string');
        const second = UnreferencedAttachmentPage.parse(
          (
            await admin.get('/admin/attachments/unreferenced', {
              query: { vaultId: cast.vault.id, limit: 1, cursor: first.nextCursor },
            })
          ).body,
        );
        expect(second.items).toHaveLength(1);
        expect(second.nextCursor).toBeUndefined();
        expect(new Set([...first.items, ...second.items].map((item) => item.id))).toEqual(
          new Set([unused.id, otherUnused.id]),
        );
        clock.jump(startedAt + 40 * DAY);
        const thinning = await admin.post<{ id: string }>('/admin/jobs/revision_thinning/run', {
          json: { payload: {} },
        });
        expect(thinning.status).toBe(202);
        await expect
          .poll(
            async () =>
              (await admin.get<{ status: string }>(`/admin/jobs/${thinning.body.id}`)).body.status,
            { timeout: 20_000 },
          )
          .toBe('succeeded');
        const thinned = await db
          .selectFrom('note_revisions')
          .select('id')
          .where('note_id', '=', idBytes(note.id))
          .orderBy('id')
          .execute();
        const survivors = thinned.map((row) => row.id);
        expect(survivors).not.toContain(firstReference);
        // D05-10 keeps the newest row of the referencing run, so the reference outlives the job.
        expect(survivors).toContain(lastReference);
        const afterThinning = await report();
        expect(new Set(afterThinning.items.map((item) => item.id))).toEqual(
          new Set([unused.id, otherUnused.id]),
        );
        const current = Node.parse((await admin.get(`/nodes/${note.id}`)).body);
        const trashed = await admin.post(`/nodes/${note.id}/trash`, {
          json: {},
          ifMatch: current.version,
        });
        expect(trashed.status).toBe(200);
        const tombstone = TrashNodeResult.parse(trashed.body).nodes.find(
          (row) => row.id === note.id,
        );
        if (tombstone === undefined) throw new Error('Trash must return its root node.');
        const purged = await admin.del(`/nodes/${note.id}`, {
          query: { purge: true },
          ifMatch: tombstone.version,
        });
        expect(purged.status, JSON.stringify(purged.body)).toBe(204);
        const afterPurge = await report();
        expect(new Set(afterPurge.items.map((item) => item.id))).toEqual(
          new Set([retained.id, unused.id, otherUnused.id]),
        );
        expect((await editor.get(`/vaults/${cast.vault.id}/attachments/${retained.id}`)).body).toBe(
          'retained bytes',
        );
        expect((await editor.get(`/vaults/${cast.vault.id}/attachments/${unused.id}`)).body).toBe(
          'unreferenced bytes',
        );
        const viewer = await harness.server.loginAs(cast.viewer);
        expect(
          (
            await viewer.get('/admin/attachments/unreferenced', {
              query: { vaultId: cast.vault.id },
            })
          ).status,
        ).toBe(403);
        // The report is a candidate list, never a deletion: the only deletion path still refuses a
        // live reference and names the notes that hold it.
        const live = await editor.post(`/vaults/${cast.vault.id}/nodes`, {
          json: {
            kind: 'note',
            parentId: cast.vault.rootNodeId,
            name: 'Live attachment reference',
            markdown: referencingSource,
          },
        });
        expect(live.status).toBe(201);
        const referencingNote = Node.parse(live.body);
        await expect
          .poll(
            async () =>
              (
                await editor.get<{ referencedByTotal: number }>(
                  `/vaults/${cast.vault.id}/attachments/${retained.id}/meta`,
                )
              ).body.referencedByTotal,
          )
          .toBe(1);
        const refusal = await editor.del(`/vaults/${cast.vault.id}/attachments/${retained.id}`, {
          ifMatch: retained.version,
        });
        expect(refusal.status).toBe(409);
        expect(refusal.body).toMatchObject({
          code: 'attachment_referenced',
          references: [{ noteId: referencingNote.id, path: referencingNote.path }],
        });
      } finally {
        clock.jump(startedAt);
        await harness.close();
      }
    },
  );
});
