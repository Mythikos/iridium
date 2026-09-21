/** Deterministic MIME, names, ranges and admission proofs around the real I/O boundary. */
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { ATTACHMENT_TYPES, LIMITS } from '@iridium/contracts';
import { describe, expect, it } from 'vitest';

import { ManualClock } from '../../test/support/manual-clock.ts';
import { AttachmentUploadAdmission } from './admission.ts';
import {
  attachmentMarkdownReference,
  sanitizeAttachmentName,
  validateAttachmentPath,
} from './names.ts';
import { attachmentEtagMatches, parseAttachmentRange } from './range.ts';
import scanAttachmentReferences from './reference-scan.worker.ts';
import { sniffAttachment } from './sniff.ts';
import { stageAttachment } from './staging.ts';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
  'base64',
);

function officeHeader(name: string): Buffer {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50);
  header.writeUInt16LE(Buffer.byteLength(name), 26);
  return Buffer.concat([header, Buffer.from(name), Buffer.alloc(100)]);
}

describe('attachments.policy.unit [area:attachments]', () => {
  it('makes sniffed bytes authoritative and grants inline disposition to exactly five raster types', async () => {
    expect(await sniffAttachment(PNG, 'claims-to-be-pdf.pdf', false)).toEqual({
      accepted: true,
      mime: 'image/png',
    });
    expect(
      Object.entries(ATTACHMENT_TYPES)
        .filter(([, policy]) => policy.inline)
        .map(([mime]) => mime)
        .toSorted(),
    ).toEqual(['image/avif', 'image/gif', 'image/jpeg', 'image/png', 'image/webp']);
    expect(
      await sniffAttachment(
        Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
        'vector.svg',
        true,
      ),
    ).toEqual({ accepted: true, mime: 'image/svg+xml' });
    expect(
      await sniffAttachment(
        Buffer.from('<!doctype html><script>alert(1)</script>'),
        'safe.txt',
        true,
      ),
    ).toEqual({ accepted: false, mime: 'text/html' });
    expect(await sniffAttachment(PNG, 'attack.ps1', false)).toEqual({
      accepted: false,
      mime: 'forbidden extension',
    });
    expect(await sniffAttachment(Buffer.from('pretending'), 'fake.svg', true)).toEqual({
      accepted: false,
      mime: 'application/octet-stream',
    });
    expect(await sniffAttachment(Buffer.from('hello'), 'note.txt', true)).toEqual({
      accepted: true,
      mime: 'text/plain',
    });
    expect((await sniffAttachment(Buffer.from([255, 254]), 'note.txt', false)).accepted).toBe(
      false,
    );
    expect((await sniffAttachment(Buffer.from('unclassified'), 'binary.bin', true)).accepted).toBe(
      false,
    );
  });

  it('validates office archive identity instead of trusting the filename', async () => {
    expect(
      (await sniffAttachment(officeHeader('[Content_Types].xml'), 'report.docx', false)).accepted,
    ).toBe(true);
    expect((await sniffAttachment(officeHeader('mimetype'), 'report.odt', false)).accepted).toBe(
      true,
    );
    expect(
      (await sniffAttachment(officeHeader('payload.exe'), 'report.docx', false)).accepted,
    ).toBe(false);
    expect(
      (await sniffAttachment(officeHeader('[Content_Types].xml'), 'report.zip', false)).accepted,
    ).toBe(false);
    expect(
      (await sniffAttachment(Buffer.from('not an archive'), 'report.docx', true)).accepted,
    ).toBe(false);
  });

  it('normalizes names once and validates explicit paths without traversal or alternate separators', () => {
    expect(sanitizeAttachmentName(' ../bad\\name\u0000.png ')).toBe('badname.png');
    expect(sanitizeAttachmentName('CON.txt')).toBe('_CON.txt');
    expect(sanitizeAttachmentName(' . ')).toBe('file');
    const long = sanitizeAttachmentName(`${'🐈'.repeat(100)}.png`, ' (2)');
    expect(Buffer.byteLength(long)).toBeLessThanOrEqual(LIMITS.ATTACHMENT_NAME_MAX_BYTES);
    expect(long.endsWith(' (2).png')).toBe(true);
    expect(validateAttachmentPath('attachments/図 image.png')).toBe('attachments/図 image.png');
    for (const path of [
      '../escape.png',
      '/escape.png',
      'C:/escape.png',
      'a\\b.png',
      'a/%2e%2e/b.png',
      'a/NUL.png',
      `a/${'a'.repeat(800)}.png`,
    ])
      expect(() => validateAttachmentPath(path)).toThrowError(
        expect.objectContaining({ code: 'validation_failed' }),
      );
    expect(
      attachmentMarkdownReference(
        'test [1].png',
        'attachments/test [1]#?.png',
        'image/png',
        '/nested/note',
      ),
    ).toBe('![test \\[1\\]](../attachments/test%20%5B1%5D%23%3F.png)');
    expect(
      attachmentMarkdownReference('paper.pdf', 'attachments/paper.pdf', 'application/pdf'),
    ).toBe('[paper.pdf](attachments/paper.pdf)');
  });

  it('honors single inclusive byte ranges and rejects unsatisfiable or ambiguous forms', () => {
    expect(parseAttachmentRange(undefined, 10)).toEqual({ kind: 'full' });
    for (const [input, start, end] of [
      ['bytes=0-0', 0, 0],
      ['bytes=5-', 5, 9],
      ['bytes=-3', 7, 9],
      ['bytes=2-99', 2, 9],
      ['bytes=-99', 0, 9],
    ] as const)
      expect(parseAttachmentRange(input, 10)).toEqual({ kind: 'range', range: { start, end } });
    for (const input of [
      'bytes=10-',
      'bytes=3-2',
      'bytes=-0',
      'bytes=-',
      'bytes=0-1,3-4',
      'items=1-2',
      'bytes=9007199254740992-',
    ])
      expect(parseAttachmentRange(input, 10)).toEqual({ kind: 'invalid' });
    expect(parseAttachmentRange('bytes=0-', 0)).toEqual({ kind: 'invalid' });
    expect(attachmentEtagMatches('W/"digest", "other"', '"digest"')).toBe(true);
    expect(attachmentEtagMatches('*', '"digest"')).toBe(true);
    expect(attachmentEtagMatches('"different"', '"digest"')).toBe(false);
    expect(attachmentEtagMatches(undefined, '"digest"')).toBe(false);
  });

  it('protects encoded and relative references held only by retained revisions', () => {
    expect(
      scanAttachmentReferences({
        candidates: [{ id: 'literal-percent', pathHint: 'attachments/literal%20name.txt' }],
        sources: [{ markdown: '[file](attachments/literal%2520name.txt)', revision: 9 }],
      }),
    ).toEqual([{ id: 'literal-percent', revision: 9 }]);
    expect(
      scanAttachmentReferences({
        candidates: [
          { id: 'history', pathHint: 'attachments/My Picture.png' },
          { id: 'orphan', pathHint: 'attachments/orphan.png' },
        ],
        sources: [{ markdown: '![retained](../My%20Picture.png)', revision: 7 }],
      }),
    ).toEqual([{ id: 'history', revision: 7 }]);
    expect(
      scanAttachmentReferences({
        candidates: [{ id: 'live', pathHint: 'attachments/image.png' }],
        sources: [{ markdown: '![live](ATTACHMENTS/image.png)', revision: null }],
      }),
    ).toEqual([{ id: 'live', revision: null }]);
  });

  it('bounds active uploads separately from each principal/vault rate window', async () => {
    const clock = new ManualClock();
    const admission = new AttachmentUploadAdmission(clock);
    const releases = Array.from({ length: LIMITS.ATTACHMENT_UPLOAD_CONCURRENCY }, () =>
      admission.enter('session', 'vault'),
    );
    expect(() => admission.enter('session', 'vault')).toThrowError(
      expect.objectContaining({ code: 'capacity' }),
    );
    for (const release of releases) {
      release();
      release();
    }
    for (
      let index = LIMITS.ATTACHMENT_UPLOAD_CONCURRENCY;
      index < LIMITS.ATTACHMENT_UPLOADS_PER_MINUTE;
      index += 1
    )
      admission.enter('session', 'vault')();
    expect(() => admission.enter('session', 'vault')).toThrowError(
      expect.objectContaining({ code: 'rate_limited' }),
    );
    admission.enter('session', 'other-vault')();
    await clock.advance(60_000);
    admission.enter('session', 'vault')();
  });

  it('hashes every chunk, validates UTF-8 beyond the sniff prefix and discards failed temporary files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'iridium-attachment-stage-'));
    try {
      const source = Buffer.from('plain utf8 text');
      const staged = await stageAttachment(
        Readable.from([source.subarray(0, 3), source.subarray(3)]),
        'text.txt',
        root,
        source.length,
      );
      expect(staged.sha256).toBe(createHash('sha256').update(source).digest('hex'));
      expect(staged.sizeBytes).toBe(source.length);
      const chunks: Buffer[] = [];
      for await (const chunk of staged.open()) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks)).toEqual(source);
      await staged.dispose();
      const invalidUtf8 = Buffer.concat([
        Buffer.alloc(LIMITS.ATTACHMENT_SNIFF_BYTES + 1, 65),
        Buffer.from([255]),
      ]);
      await expect(
        stageAttachment(Readable.from([invalidUtf8]), 'text.txt', root, invalidUtf8.length),
      ).rejects.toMatchObject({ code: 'unsupported_media' });
      await expect(
        stageAttachment(Readable.from([source]), 'text.txt', root, source.length - 1),
      ).rejects.toMatchObject({ code: 'payload_too_large' });
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
