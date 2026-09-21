/** The same immutable-object contract runs against actual filesystem and S3 implementations. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { CreateBucketCommand, DeleteBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { LIMITS } from '@iridium/contracts';
import { startS3 } from '@iridium/testkit';
import { describe, expect, it } from 'vitest';

import { FsStorageDriver } from '../../src/attachments/fs-storage.ts';
import { S3StorageDriver } from '../../src/attachments/s3-storage.ts';
import {
  AttachmentBytesMissingError,
  AttachmentStorageIntegrityError,
  AttachmentStorageKeyError,
  type StorageDriver,
} from '../../src/attachments/storage.ts';

interface StorageFixture {
  readonly storage: StorageDriver;
  close(): Promise<void>;
}
interface Implementation {
  readonly name: string;
  open(): Promise<StorageFixture>;
}
const IMPLEMENTATIONS: readonly Implementation[] = [
  {
    name: 'FsStorageDriver',
    open: async () => {
      const root = await mkdtemp(join(tmpdir(), 'iridium-storage-contract-')),
        storage = new FsStorageDriver(root);
      return {
        storage,
        close: async () => {
          await storage.close();
          await rm(root, { recursive: true, force: true });
        },
      };
    },
  },
  {
    name: 'S3StorageDriver',
    open: async () => {
      const fixture = await startS3(),
        bucket = `contract-${randomUUID()}`;
      const configuration = {
        driver: 's3' as const,
        endpoint: fixture.endpoint,
        region: fixture.region,
        bucket,
        forcePathStyle: true,
        accessKeyId: fixture.accessKeyId,
        secretAccessKey: fixture.secretAccessKey,
      };
      const administration = new S3Client({
        ...configuration,
        credentials: { accessKeyId: fixture.accessKeyId, secretAccessKey: fixture.secretAccessKey },
      });
      await administration.send(new CreateBucketCommand({ Bucket: bucket }));
      const storage = new S3StorageDriver(configuration);
      return {
        storage,
        close: async () => {
          try {
            for await (const item of storage.list()) await storage.delete(item.key);
            await administration.send(new DeleteBucketCommand({ Bucket: bucket }));
          } finally {
            await storage.close();
            administration.destroy();
            await fixture.stop();
          }
        },
      };
    },
  },
];
const VAULT = '01989a42-72a5-7000-8000-000000000001';
const OTHER = '01989a42-72a5-7000-8000-000000000002';
function keyOf(bytes: Buffer, vault = VAULT): string {
  const hash = createHash('sha256').update(bytes).digest('hex');
  return `${vault}/${hash.slice(0, 2)}/${hash}`;
}
async function bytesOf(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe.each(IMPLEMENTATIONS)('storage-driver.contract [area:seams] $name', (implementation) => {
  it('publishes only complete immutable bytes, deduplicates, ranges, scopes enumeration and deletes idempotently', async () => {
    const fixture = await implementation.open(),
      storage = fixture.storage;
    try {
      const small = Buffer.from('complete immutable object'),
        smallKey = keyOf(small);
      await storage.healthcheck();
      const altered = Buffer.from(small);
      altered[0] = 0;
      await expect(
        storage.put(smallKey, Readable.from([altered]), {
          sizeBytes: small.length,
          mime: 'application/octet-stream',
        }),
      ).rejects.toBeInstanceOf(AttachmentStorageIntegrityError);
      expect(await storage.exists(smallKey)).toBe(false);
      const bytes = Buffer.alloc(LIMITS.ATTACHMENT_MULTIPART_THRESHOLD_BYTES + 1, 65),
        key = keyOf(bytes),
        other = keyOf(bytes, OTHER);
      const options = { sizeBytes: bytes.length, mime: 'application/octet-stream' };
      expect(await storage.exists(key)).toBe(false);
      await expect(storage.get(key)).rejects.toBeInstanceOf(AttachmentBytesMissingError);
      await expect(storage.exists('../escape')).rejects.toBeInstanceOf(AttachmentStorageKeyError);
      await expect(
        storage.put(key, Readable.from([bytes.subarray(0, 3)]), options),
      ).rejects.toBeInstanceOf(AttachmentStorageIntegrityError);
      expect(await storage.exists(key)).toBe(false);
      await Promise.all([
        storage.put(key, Readable.from([bytes]), options),
        storage.put(key, Readable.from([bytes]), options),
      ]);
      await storage.put(other, Readable.from([bytes]), options);
      await storage.put(key, Readable.from([Buffer.from('ignore duplicate')]), {
        sizeBytes: 16,
        mime: 'text/plain',
      });
      expect(await bytesOf(await storage.get(key))).toEqual(bytes);
      expect(
        await bytesOf(await storage.get(key, { start: bytes.length - 2, end: bytes.length - 1 })),
      ).toEqual(Buffer.from('AA'));
      const scoped = [];
      for await (const item of storage.list(VAULT)) scoped.push(item);
      expect(scoped).toEqual([{ key, sizeBytes: bytes.length }]);
      await storage.delete(key);
      await storage.delete(key);
      expect(await storage.exists(key)).toBe(false);
      expect(await storage.exists(other)).toBe(true);
      await expect(storage.get(key)).rejects.toBeInstanceOf(AttachmentBytesMissingError);
      await storage.delete(other);
      await storage.healthcheck();
      const remaining = [];
      for await (const item of storage.list()) remaining.push(item);
      expect(remaining).toEqual([]);
    } finally {
      await fixture.close();
    }
  });
});
