/** Content identity, filename collision, revision validators and byte ranges over real HTTP. */
import { Attachment, AttachmentPage, AttachmentUploaded } from '@iridium/contracts';
import { attachmentClient } from '@iridium/testkit';
import { describe, expect, it } from 'vitest';

import { idBytes } from '../../src/auth/ids.ts';
import { startCollab } from '../support/collab-harness.ts';

describe('attachments.dedupe.integration [area:attachments]', () => {
  it('serializes concurrent duplicate uploads, reuses live paths and revives soft-deleted rows', async () => {
    const harness = await startCollab();
    try {
      const cast = await harness.server.seed.kernel();
      const editor = await harness.server.loginAs(cast.editorA);
      const uploader = attachmentClient(editor);
      const bytes = Buffer.from('0123456789 immutable content');
      const results = await Promise.all(
        ['original.txt', 'different.txt'].map((filename) =>
          uploader.upload({ vaultId: cast.vault.id, filename, bytes }),
        ),
      );
      expect(results.map((result) => result.status)).toEqual([201, 201]);
      const bodies = results.map((result) => AttachmentUploaded.parse(result.body));
      expect(new Set(bodies.map((body) => body.attachment.id)).size).toBe(1);
      expect(new Set(bodies.map((body) => body.attachment.pathHint)).size).toBe(1);
      expect(
        bodies
          .map((body) => body.deduplicated)
          .toSorted((left, right) => Number(left) - Number(right)),
      ).toEqual([false, true]);
      const first = bodies[0];
      if (first === undefined) throw new Error('Both concurrent uploads must return a result.');
      const attachment = first.attachment;
      const path = `/vaults/${cast.vault.id}/attachments/${attachment.id}`;
      expect(results.map((result) => result.headers.get('location'))).toEqual([
        `/api/v1${path}/meta`,
        `/api/v1${path}/meta`,
      ]);
      const createdMetadata = await editor.get(`${path}/meta`);
      expect(createdMetadata.status).toBe(200);
      expect(Attachment.parse(createdMetadata.body).id).toBe(attachment.id);
      const db = harness.application().database.dbApp;
      if (db === null) throw new Error('The dedupe proof requires a real database.');
      const rows = await db
        .selectFrom('attachments')
        .select(['id', 'sha256'])
        .where('vault_id', '=', idBytes(cast.vault.id))
        .execute();
      expect(rows).toHaveLength(1);
      const ranged = await editor.get(path, { headers: { range: 'bytes=2-7' } });
      expect(ranged.status).toBe(206);
      expect(ranged.body).toBe('234567');
      expect(ranged.headers.get('content-range')).toBe(`bytes 2-7/${bytes.length}`);
      expect(ranged.headers.get('content-length')).toBe('6');
      expect((await editor.get(path, { headers: { range: 'bytes=-7' } })).body).toBe('content');
      const invalid = await editor.get(path, { headers: { range: `bytes=${bytes.length}-` } });
      expect(invalid.status).toBe(416);
      expect(invalid.headers.get('content-range')).toBe(`bytes */${bytes.length}`);
      expect(invalid.body).toMatchObject({ code: 'validation_failed', status: 416 });
      const cached = await editor.get(path, {
        headers: { 'if-none-match': `"${attachment.sha256}"` },
      });
      expect(cached.status).toBe(304);
      expect(cached.body).toBeUndefined();
      expect(
        (await editor.get(path, { headers: { range: 'bytes=0-1', 'if-range': '"another-hash"' } }))
          .status,
      ).toBe(200);

      expect((await editor.del(path, { ifMatch: attachment.version })).status).toBe(204);
      const deletedListing = await editor.get(`/vaults/${cast.vault.id}/attachments`, {
        query: { includeDeleted: true },
      });
      expect(AttachmentPage.parse(deletedListing.body).items[0]?.deletedAt).not.toBeNull();
      const revived = await uploader.upload({
        vaultId: cast.vault.id,
        filename: 'revived.txt',
        bytes,
      });
      const revivedBody = AttachmentUploaded.parse(revived.body);
      expect(revivedBody.deduplicated).toBe(true);
      expect(revivedBody.attachment.id).toBe(attachment.id);
      expect(revivedBody.attachment.pathHint).toBe(attachment.pathHint);
      expect(revivedBody.attachment.version).toBe(attachment.version + 2);
      expect(Attachment.parse((await editor.get(`${path}/meta`)).body).deletedAt).toBeNull();
      expect((await editor.get(path)).body).toBe(bytes.toString());
    } finally {
      await harness.close();
    }
  });

  it('suffixes default path collisions, refuses explicit collisions and keeps dedupe within one vault', async () => {
    const harness = await startCollab();
    try {
      const cast = await harness.server.seed.kernel();
      const editor = await harness.server.loginAs(cast.editorA);
      const uploader = attachmentClient(editor);
      const first = AttachmentUploaded.parse(
        (
          await uploader.upload({
            vaultId: cast.vault.id,
            filename: 'same.txt',
            bytes: Buffer.from('first'),
          })
        ).body,
      ).attachment;
      const second = AttachmentUploaded.parse(
        (
          await uploader.upload({
            vaultId: cast.vault.id,
            filename: 'same.txt',
            bytes: Buffer.from('second'),
          })
        ).body,
      ).attachment;
      expect(first.pathHint).toBe('attachments/same.txt');
      expect(second.pathHint).toBe('attachments/same (2).txt');
      const collision = await uploader.upload({
        vaultId: cast.vault.id,
        filename: 'third.txt',
        bytes: Buffer.from('third'),
        pathHint: first.pathHint,
      });
      expect(collision.status).toBe(409);
      expect(collision.body).toMatchObject({ code: 'name_conflict' });
      const another = await harness.server.seed.vault({
        admin: cast.admin,
        name: 'Other attachment vault',
        members: [[cast.editorA, 'editor']],
      });
      const foreign = AttachmentUploaded.parse(
        (
          await uploader.upload({
            vaultId: another.id,
            filename: 'same.txt',
            bytes: Buffer.from('first'),
          })
        ).body,
      ).attachment;
      expect(foreign.id).not.toBe(first.id);
      expect(foreign.sha256).toBe(first.sha256);
      expect((await editor.get(`/vaults/${another.id}/attachments/${first.id}`)).status).toBe(404);
      const pageOne = AttachmentPage.parse(
        (await editor.get(`/vaults/${cast.vault.id}/attachments`, { query: { limit: 1 } })).body,
      );
      expect(pageOne.nextCursor).toBeTypeOf('string');
      const pageTwo = AttachmentPage.parse(
        (
          await editor.get(`/vaults/${cast.vault.id}/attachments`, {
            query: { limit: 1, cursor: pageOne.nextCursor },
          })
        ).body,
      );
      expect(new Set([...pageOne.items, ...pageTwo.items].map((item) => item.id)).size).toBe(2);
      expect(pageTwo.nextCursor).toBeUndefined();
      expect(
        (
          await editor.get(`/vaults/${another.id}/attachments`, {
            query: { cursor: pageOne.nextCursor },
          })
        ).status,
      ).toBe(422);
      expect(
        (
          await editor.del(`/vaults/${cast.vault.id}/attachments/${first.id}`, {
            ifMatch: first.version,
          })
        ).status,
      ).toBe(204);
      expect((await editor.get(`/vaults/${another.id}/attachments/${foreign.id}`)).body).toBe(
        'first',
      );
    } finally {
      await harness.close();
    }
  });
});
