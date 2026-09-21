/** Real HTTP, authorization, MIME policy, reference refusal and the upload cap. */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { Attachment, AttachmentUploaded, LIMITS, Node } from '@iridium/contracts';
import { attachmentClient } from '@iridium/testkit';
import { describe, expect, it } from 'vitest';

import { FsStorageDriver } from '../../src/attachments/fs-storage.ts';
import { idBytes } from '../../src/auth/ids.ts';
import { startCollab } from '../support/collab-harness.ts';
import { ManualClock } from '../support/manual-clock.ts';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
  'base64',
);

describe('attachments.security.integration [area:attachments]', () => {
  it('enforces vault isolation, sniffing and hardening without allowing partial multipart commits', async () => {
    const harness = await startCollab();
    try {
      const cast = await harness.server.seed.kernel();
      const editor = await harness.server.loginAs(cast.editorA);
      const viewer = await harness.server.loginAs(cast.viewer);
      const outsider = await harness.server.loginAs(cast.outsider);
      const uploader = attachmentClient(editor);
      const uploaded = await uploader.upload({
        vaultId: cast.vault.id,
        filename: 'diagram.pdf',
        bytes: PNG,
        declaredMime: 'text/html',
      });
      expect(uploaded.status).toBe(201);
      const result = AttachmentUploaded.parse(uploaded.body);
      expect(result.attachment.mime).toBe('image/png');
      expect(result.attachment.inlineable).toBe(true);
      const path = `/vaults/${cast.vault.id}/attachments/${result.attachment.id}`;
      const downloaded = await viewer.get(path);
      expect(downloaded.status).toBe(200);
      expect(downloaded.body).toEqual(new Uint8Array(PNG));
      expect(downloaded.contentType).toBe('image/png');
      expect(downloaded.headers.get('content-disposition')).toMatch(/^inline; filename\*=UTF-8''/);
      expect(downloaded.headers.get('x-content-type-options')).toBe('nosniff');
      expect(downloaded.headers.get('content-security-policy')).toBe('sandbox');
      expect(downloaded.headers.get('cache-control')).toBe('private, max-age=3600');
      expect(downloaded.headers.get('cross-origin-resource-policy')).toBe('same-origin');
      expect(downloaded.headers.get('x-permitted-cross-domain-policies')).toBe('none');
      expect(downloaded.headers.get('referrer-policy')).toBe('no-referrer');
      expect(downloaded.headers.get('vary')).toContain('Authorization');
      const invalidList = await editor.get(`/vaults/${cast.vault.id}/attachments`, {
        query: { limit: 0 },
      });
      expect(invalidList.status).toBe(422);
      expect(invalidList.body).toMatchObject({ code: 'validation_failed' });
      const invalidDownload = await editor.get(`/vaults/${cast.vault.id}/attachments/not-an-id`);
      expect(invalidDownload.status).toBe(422);
      expect(invalidDownload.body).toMatchObject({ code: 'validation_failed' });
      const invalidDelete = await editor.del(path, {
        ifMatch: result.attachment.version,
        query: { force: 'sometimes' },
      });
      expect(invalidDelete.status).toBe(422);
      expect(invalidDelete.body).toMatchObject({ code: 'validation_failed' });
      expect((await outsider.get(path)).status).toBe(404);
      expect((await outsider.get(`${path}/meta`)).status).toBe(404);
      expect((await outsider.get(`/vaults/${cast.vault.id}/attachments`)).status).toBe(404);
      expect(
        (
          await attachmentClient(viewer).upload({
            vaultId: cast.vault.id,
            filename: 'denied.txt',
            bytes: Buffer.from('denied'),
          })
        ).status,
      ).toBe(403);
      expect((await viewer.del(path, { ifMatch: result.attachment.version })).status).toBe(403);

      const svg = await uploader.upload({
        vaultId: cast.vault.id,
        filename: 'untrusted.svg',
        bytes: Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
        ),
        declaredMime: 'image/png',
      });
      expect(svg.status).toBe(201);
      const vector = AttachmentUploaded.parse(svg.body).attachment;
      expect(vector.inlineable).toBe(false);
      const vectorBytes = await editor.get(`/vaults/${cast.vault.id}/attachments/${vector.id}`);
      expect(vectorBytes.contentType).toBe('image/svg+xml');
      expect(vectorBytes.headers.get('content-disposition')).toMatch(/^attachment;/);
      const html = await uploader.upload({
        vaultId: cast.vault.id,
        filename: 'claimed.txt',
        bytes: Buffer.from('<!doctype html><script>alert(1)</script>'),
        declaredMime: 'text/plain',
      });
      expect(html.status).toBe(415);
      const unsafe = await uploader.upload({
        vaultId: cast.vault.id,
        filename: 'safe.txt',
        bytes: Buffer.from('never stored'),
        pathHint: '../escape.txt',
      });
      expect(unsafe.status).toBe(422);

      const multiple = new FormData();
      multiple.append('file', new Blob(['first']), 'one.txt');
      multiple.append('file', new Blob(['second']), 'two.txt');
      const refused = await editor.post(`/vaults/${cast.vault.id}/attachments`, { body: multiple });
      expect(refused.status).toBe(422);
      expect(refused.body).toMatchObject({
        code: 'validation_failed',
        errors: [{ code: 'multiple_files' }],
      });
      const listing = await editor.get<{ items: readonly Attachment[] }>(
        `/vaults/${cast.vault.id}/attachments`,
      );
      expect(listing.body.items.map((item) => item.id).toSorted()).toEqual(
        [result.attachment.id, vector.id].toSorted(),
      );
    } finally {
      await harness.close();
    }
  });

  it('refuses reference deletion, retains forced-deletion bytes and reports missing storage as 503', async () => {
    const harness = await startCollab();
    try {
      const cast = await harness.server.seed.kernel();
      const editor = await harness.server.loginAs(cast.editorA);
      const uploaded = await attachmentClient(editor).upload({
        vaultId: cast.vault.id,
        filename: 'reference.png',
        bytes: PNG,
      });
      expect(uploaded.status).toBe(201);
      const attachment = AttachmentUploaded.parse(uploaded.body).attachment;
      const created = await editor.post(`/vaults/${cast.vault.id}/nodes`, {
        json: {
          kind: 'note',
          parentId: cast.vault.rootNodeId,
          name: 'Attachment reference',
          markdown: `![a](${attachment.pathHint})`,
        },
      });
      expect(created.status).toBe(201);
      const note = Node.parse(created.body);
      const path = `/vaults/${cast.vault.id}/attachments/${attachment.id}`;
      await expect
        .poll(
          async () => Attachment.parse((await editor.get(`${path}/meta`)).body).referencedByTotal,
        )
        .toBe(1);
      const missingValidator = await editor.del(path);
      expect(missingValidator.status).toBe(428);
      expect((await editor.del(path, { ifMatch: attachment.version + 1 })).status).toBe(409);
      const refusal = await editor.del(path, { ifMatch: attachment.version });
      expect(refusal.status).toBe(409);
      expect(refusal.body).toMatchObject({
        code: 'attachment_referenced',
        references: [{ noteId: note.id, path: note.path }],
      });
      expect(
        (await editor.del(path, { ifMatch: attachment.version, query: { force: true } })).status,
      ).toBe(204);
      expect((await editor.get(path)).status).toBe(404);

      const config = harness.application().iridiumConfig.storage;
      if (config.driver !== 'fs')
        throw new Error('This fixture requires its isolated fs attachment directory.');
      const storage = new FsStorageDriver(config.dir);
      const key = `${cast.vault.id}/${attachment.sha256.slice(0, 2)}/${attachment.sha256}`;
      expect(await storage.exists(key)).toBe(true);
      const revived = await attachmentClient(editor).upload({
        vaultId: cast.vault.id,
        filename: 'reference.png',
        bytes: PNG,
      });
      expect(revived.status).toBe(201);
      await storage.delete(key);
      const missing = await editor.get(path);
      expect(missing.status).toBe(503);
      expect(missing.body).toMatchObject({ code: 'server_error', status: 503 });
      expect(harness.logs.some((line) => line.includes('attachment.bytes_missing'))).toBe(true);
      await storage.close();
    } finally {
      await harness.close();
    }
  });

  it('rejects a stream exceeding the actual 50 MiB default and commits no attachment', async () => {
    const harness = await startCollab();
    try {
      const cast = await harness.server.seed.kernel();
      const editor = await harness.server.loginAs(cast.editorA);
      const oversized = await attachmentClient(editor).upload({
        vaultId: cast.vault.id,
        filename: 'large.txt',
        bytes: Buffer.alloc(LIMITS.UPLOAD_MAX_BYTES + 1, 65),
      });
      expect(oversized.status).toBe(413);
      expect(oversized.body).toMatchObject({ code: 'payload_too_large' });
      const listing = await editor.get<{ items: readonly Attachment[] }>(
        `/vaults/${cast.vault.id}/attachments`,
      );
      expect(listing.body.items).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it('refuses the upload after the actual per-minute budget without changing stored content', async () => {
    const harness = await startCollab({
      clock: new ManualClock(),
      extraEnv: { JOBS_ENABLED: 'false' },
    });
    try {
      const user = await harness.server.seed.admin();
      const vault = await harness.server.seed.vault({ admin: user, name: 'Upload rate budget' });
      const admin = await harness.server.loginAs(user);
      const uploader = attachmentClient(admin);
      const input = { vaultId: vault.id, filename: 'budget.txt', bytes: Buffer.from('same bytes') };
      let attachment: Attachment | undefined;
      for (let sent = 0; sent < LIMITS.ATTACHMENT_UPLOADS_PER_MINUTE; sent += 1) {
        // eslint-disable-next-line no-await-in-loop -- spend the exact per-principal budget without racing the stream cap
        const accepted = await uploader.upload(input);
        expect(accepted.status).toBe(201);
        attachment = AttachmentUploaded.parse(accepted.body).attachment;
      }
      const refused = await uploader.upload(input);
      expect(refused.status).toBe(429);
      expect(refused.body).toMatchObject({ code: 'rate_limited', retryAfterMs: 60_000 });
      expect(refused.headers.get('retry-after')).toBe('60');
      const listing = await admin.get<{ items: readonly Attachment[] }>(
        `/vaults/${vault.id}/attachments`,
      );
      expect(listing.body.items).toHaveLength(1);
      expect(listing.body.items[0]?.id).toBe(attachment?.id);
    } finally {
      await harness.close();
    }
  });

  it('refuses a ninth active upload and releases every slot after the real commits settle', async () => {
    const harness = await startCollab({
      clock: new ManualClock(),
      extraEnv: { JOBS_ENABLED: 'false' },
    });
    const release = Promise.withResolvers<void>();
    const pending: Promise<unknown>[] = [];
    try {
      const user = await harness.server.seed.admin();
      const vault = await harness.server.seed.vault({ admin: user, name: 'Upload concurrency' });
      const admin = await harness.server.loginAs(user);
      const uploader = attachmentClient(admin);
      expect(
        (
          await uploader.upload({
            vaultId: vault.id,
            filename: 'initial.txt',
            bytes: Buffer.from('initial bytes'),
          })
        ).status,
      ).toBe(201);
      const app = harness.application();
      const db = app.database.dbApp;
      const storage = app.iridiumConfig.storage;
      if (db === null || storage.driver !== 'fs')
        throw new Error('The concurrency proof requires its real database and filesystem storage.');
      const stagedDirectory = join(storage.dir, '.tmp');
      expect(await readdir(stagedDirectory)).toEqual([]);
      const locked = Promise.withResolvers<void>();
      // A real vault lock holds accepted uploads at publication after their HTTP bodies are staged.
      const blocker = db.transaction().execute(async (trx) => {
        await app.collab.ownerLease.captureFence().assertCurrent(trx);
        await trx
          .selectFrom('vaults')
          .select('id')
          .where('id', '=', idBytes(vault.id))
          .forUpdate()
          .executeTakeFirstOrThrow();
        locked.resolve();
        await release.promise;
      });
      pending.push(blocker);
      await locked.promise;
      const uploads = Array.from({ length: LIMITS.ATTACHMENT_UPLOAD_CONCURRENCY }, (_, index) =>
        uploader.upload({
          vaultId: vault.id,
          filename: `active-${String(index)}.txt`,
          bytes: Buffer.from(`active upload ${String(index)}`),
        }),
      );
      pending.push(...uploads);
      await expect
        .poll(async () => (await readdir(stagedDirectory)).length, { timeout: 10_000 })
        .toBe(LIMITS.ATTACHMENT_UPLOAD_CONCURRENCY);
      const refused = await uploader.upload({
        vaultId: vault.id,
        filename: 'over-capacity.txt',
        bytes: Buffer.from('must never be stored'),
      });
      expect(refused.status).toBe(503);
      expect(refused.body).toMatchObject({ code: 'capacity', retryAfterMs: 60_000 });
      expect(refused.headers.get('retry-after')).toBe('60');
      expect(await readdir(stagedDirectory)).toHaveLength(LIMITS.ATTACHMENT_UPLOAD_CONCURRENCY);
      release.resolve();
      await blocker;
      expect((await Promise.all(uploads)).map((response) => response.status)).toEqual(
        Array.from({ length: LIMITS.ATTACHMENT_UPLOAD_CONCURRENCY }, () => 201),
      );
      expect(await readdir(stagedDirectory)).toEqual([]);
      expect(
        (
          await uploader.upload({
            vaultId: vault.id,
            filename: 'after-settlement.txt',
            bytes: Buffer.from('slot released'),
          })
        ).status,
      ).toBe(201);
      const listing = await admin.get<{ items: readonly Attachment[] }>(
        `/vaults/${vault.id}/attachments`,
      );
      expect(listing.body.items.some((item) => item.originalName === 'over-capacity.txt')).toBe(
        false,
      );
      expect(listing.body.items).toHaveLength(LIMITS.ATTACHMENT_UPLOAD_CONCURRENCY + 2);
    } finally {
      release.resolve();
      await Promise.allSettled(pending);
      await harness.close();
    }
  });
});
