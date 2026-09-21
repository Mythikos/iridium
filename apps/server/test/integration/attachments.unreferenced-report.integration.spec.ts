/** The administrator's report preserves an attachment whose only reference is a named revision. */
import { AttachmentUploaded, Node, UnreferencedAttachmentPage } from '@iridium/contracts';
import { attachmentClient } from '@iridium/testkit';
import { describe, expect, it } from 'vitest';

import { startCollab } from '../support/collab-harness.ts';

describe('attachments.unreferenced-report.integration [area:attachments]', () => {
  it('scans retained revisions in the worker and publishes the durable job result without deleting bytes', async () => {
    const harness = await startCollab({ extraEnv: { JOBS_ENABLED: 'false' } });
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
      const created = await editor.post(`/vaults/${cast.vault.id}/nodes`, {
        json: {
          kind: 'note',
          parentId: cast.vault.rootNodeId,
          name: 'Retained attachment history',
          markdown: `[history](${retained.pathHint})`,
        },
      });
      expect(created.status).toBe(201);
      const note = Node.parse(created.body);
      const named = await editor.post(`/notes/${note.id}/revisions`, {
        json: { label: 'Keep this attachment' },
      });
      expect(named.status).toBe(201);
      const client = await harness.open(cast.editorA, note.id);
      await client.waitSynced();
      client.deleteAt(0, client.text.length);
      client.typeAt(0, 'The current note no longer refers to a file.');
      await client.waitFor('saved');
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
      const reportResponse = await admin.get('/admin/attachments/unreferenced', {
        query: { vaultId: cast.vault.id },
      });
      expect(reportResponse.status).toBe(200);
      const report = UnreferencedAttachmentPage.parse(reportResponse.body);
      expect(report.jobId).toBe(run.body.id);
      expect(new Set(report.items.map((item) => item.id))).toEqual(
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
      expect((await editor.get(`/vaults/${cast.vault.id}/attachments/${retained.id}`)).body).toBe(
        'retained bytes',
      );
      expect((await editor.get(`/vaults/${cast.vault.id}/attachments/${unused.id}`)).body).toBe(
        'unreferenced bytes',
      );
      const viewer = await harness.server.loginAs(cast.viewer);
      expect(
        (await viewer.get('/admin/attachments/unreferenced', { query: { vaultId: cast.vault.id } }))
          .status,
      ).toBe(403);
    } finally {
      await harness.close();
    }
  });
});
