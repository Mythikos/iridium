/** The real compose-profile target exercises both atomic S3 write mechanisms. */
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

import { CreateBucketCommand, DeleteBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { LIMITS } from '@iridium/contracts';
import { startS3 } from '@iridium/testkit';
import { describe, expect, it } from 'vitest';

import { S3StorageDriver } from '../../src/attachments/s3-storage.ts';
import { AttachmentBytesMissingError } from '../../src/attachments/storage.ts';

const VAULT = '01989a42-72a5-7000-8000-000000000001';

function keyOf(bytes: Buffer): string {
  const digest = createHash('sha256').update(bytes).digest('hex');
  return `${VAULT}/${digest.slice(0, 2)}/${digest}`;
}

describe('attachments.s3.integration [area:attachments]', () => {
  it('stores small and multipart objects, deduplicates, ranges, enumerates and deletes against SeaweedFS', async () => {
    const fixture = await startS3();
    const bucket = `attachment-proof-${randomUUID()}`;
    const config = {
      driver: 's3' as const,
      endpoint: fixture.endpoint,
      region: fixture.region,
      bucket,
      forcePathStyle: true,
      accessKeyId: fixture.accessKeyId,
      secretAccessKey: fixture.secretAccessKey,
    };
    const administration = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: true,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    });
    const storage = new S3StorageDriver(config);
    try {
      await administration.send(new CreateBucketCommand({ Bucket: bucket }));
      const small = Buffer.from('small immutable text');
      const large = Buffer.alloc(LIMITS.ATTACHMENT_MULTIPART_THRESHOLD_BYTES + 1, 65);
      const smallKey = keyOf(small);
      const largeKey = keyOf(large);
      expect(await storage.exists(smallKey)).toBe(false);
      await storage.put(smallKey, Readable.from([small]), {
        sizeBytes: small.length,
        mime: 'text/plain',
      });
      await storage.put(
        largeKey,
        Readable.from([large.subarray(0, large.length - 1), large.subarray(large.length - 1)]),
        { sizeBytes: large.length, mime: 'text/plain' },
      );
      expect(await storage.exists(largeKey)).toBe(true);
      await storage.put(smallKey, Readable.from([Buffer.from('ignored duplicate')]), {
        sizeBytes: 17,
        mime: 'text/plain',
      });
      const bytes: Buffer[] = [];
      for await (const chunk of await storage.get(smallKey)) bytes.push(Buffer.from(chunk));
      expect(Buffer.concat(bytes)).toEqual(small);
      const range: Buffer[] = [];
      for await (const chunk of await storage.get(largeKey, {
        start: large.length - 2,
        end: large.length - 1,
      }))
        range.push(Buffer.from(chunk));
      expect(Buffer.concat(range)).toEqual(Buffer.from('AA'));
      const inventory = [];
      for await (const object of storage.list(VAULT)) inventory.push(object);
      expect(inventory.toSorted((left, right) => left.key.localeCompare(right.key))).toEqual(
        [
          { key: smallKey, sizeBytes: small.length },
          { key: largeKey, sizeBytes: large.length },
        ].toSorted((left, right) => left.key.localeCompare(right.key)),
      );
      await storage.delete(smallKey);
      await storage.delete(largeKey);
      await storage.delete(largeKey);
      await expect(storage.get(smallKey)).rejects.toBeInstanceOf(AttachmentBytesMissingError);
      await administration.send(new DeleteBucketCommand({ Bucket: bucket }));
    } finally {
      await storage.close();
      administration.destroy();
      await fixture.stop();
    }
  });
});
