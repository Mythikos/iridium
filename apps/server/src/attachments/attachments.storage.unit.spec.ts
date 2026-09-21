/** Real filesystem semantics, including key validation, atomic publication and range reads. */
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { FsStorageDriver } from './fs-storage.ts';
import {
  AttachmentBytesMissingError,
  AttachmentStorageIntegrityError,
  AttachmentStorageKeyError,
  assertStorageKey,
} from './storage.ts';

const VAULT = '01989a42-72a5-7000-8000-000000000001';
const BYTES = Buffer.from('immutable attachment bytes');
function keyOf(bytes: Buffer): string {
  const digest = createHash('sha256').update(bytes).digest('hex');
  return `${VAULT}/${digest.slice(0, 2)}/${digest}`;
}

describe('attachments.storage.unit [area:attachments]', () => {
  it('writes atomically with restrictive permissions and reads a precise byte slice', async () => {
    const root = await mkdtemp(join(tmpdir(), 'iridium-attachment-fs-'));
    const storage = new FsStorageDriver(root);
    const key = keyOf(BYTES);
    try {
      expect(await storage.exists(key)).toBe(false);
      await storage.put(key, Readable.from([BYTES]), {
        sizeBytes: BYTES.length,
        mime: 'text/plain',
      });
      expect(await readFile(join(root, key))).toEqual(BYTES);
      const mode = (await stat(join(root, key))).mode & 0o777;
      expect(process.platform === 'win32' ? mode & 0o600 : mode).toBe(0o600);
      const chunks: Buffer[] = [];
      for await (const chunk of await storage.get(key, { start: 2, end: 7 }))
        chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks)).toEqual(BYTES.subarray(2, 8));
      await storage.put(key, Readable.from([Buffer.from('ignored duplicate')]), {
        sizeBytes: 17,
        mime: 'text/plain',
      });
      expect(await readFile(join(root, key))).toEqual(BYTES);
      const listed = [];
      for await (const object of storage.list(VAULT)) listed.push(object);
      expect(listed).toEqual([{ key, sizeBytes: BYTES.length }]);
      await storage.delete(key);
      await storage.delete(key);
      expect(await storage.exists(key)).toBe(false);
      await expect(storage.get(key)).rejects.toBeInstanceOf(AttachmentBytesMissingError);
    } finally {
      await storage.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('never publishes truncated or mismatched bytes and rejects keys outside their vault', async () => {
    const root = await mkdtemp(join(tmpdir(), 'iridium-attachment-fs-'));
    const storage = new FsStorageDriver(root);
    const key = keyOf(BYTES);
    try {
      await expect(
        storage.put(key, Readable.from([BYTES.subarray(0, 4)]), {
          sizeBytes: BYTES.length,
          mime: 'text/plain',
        }),
      ).rejects.toBeInstanceOf(AttachmentStorageIntegrityError);
      expect(await storage.exists(key)).toBe(false);
      expect(await readdir(join(root, VAULT, key.split('/')[1] ?? '', '.tmp'))).toEqual([]);
      await expect(
        storage.put(key, Readable.from([BYTES]), { sizeBytes: 1, mime: 'text/plain' }),
      ).rejects.toBeInstanceOf(AttachmentStorageIntegrityError);
      expect(() => assertStorageKey(key, '01989a42-72a5-7000-8000-000000000002')).toThrow(
        AttachmentStorageKeyError,
      );
      await expect(storage.exists('../escape')).rejects.toBeInstanceOf(AttachmentStorageKeyError);
    } finally {
      await storage.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
