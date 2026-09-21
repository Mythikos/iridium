/** S3-compatible immutable object driver, including bounded multipart writes (08 §9.1). */
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
  UploadPartCommand,
  type CompletedPart,
} from '@aws-sdk/client-s3';
import { LIMITS } from '@iridium/contracts';

import type { StorageConfig } from '../config/env.ts';
import {
  assertStorageKey,
  AttachmentBytesMissingError,
  AttachmentStorageIntegrityError,
  type ByteRange,
  type StorageDriver,
  type StoredObject,
} from './storage.ts';

function missing(error: unknown): boolean {
  return error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404;
}

function alreadyPublished(error: unknown): boolean {
  return error instanceof S3ServiceException && error.$metadata.httpStatusCode === 412;
}

/** Owns the SDK connection pool and closes it with the application. */
export class S3StorageDriver implements StorageDriver {
  readonly #client: S3Client;
  readonly #bucket: string;
  constructor(config: Extract<StorageConfig, { driver: 's3' }>) {
    this.#bucket = config.bucket;
    this.#client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    });
  }

  /** Atomic publication: either PutObject completes or the complete multipart set does. */
  async put(
    key: string,
    body: Readable,
    options: { readonly sizeBytes: number; readonly mime: string },
  ): Promise<void> {
    assertStorageKey(key);
    if (await this.exists(key)) {
      body.destroy();
      return;
    }
    if (options.sizeBytes <= LIMITS.ATTACHMENT_MULTIPART_THRESHOLD_BYTES) {
      try {
        await this.#client.send(
          new PutObjectCommand({
            Bucket: this.#bucket,
            Key: key,
            Body: body,
            ContentLength: options.sizeBytes,
            ContentType: options.mime,
            ChecksumSHA256: Buffer.from(key.split('/')[2] ?? '', 'hex').toString('base64'),
            IfNoneMatch: '*',
          }),
        );
      } catch (error) {
        body.destroy();
        if (error instanceof S3ServiceException && error.name === 'BadDigest')
          throw new AttachmentStorageIntegrityError(key);
        if (!alreadyPublished(error)) throw error;
      }
      return;
    }
    const created = await this.#client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.#bucket,
        Key: key,
        ContentType: options.mime,
      }),
    );
    if (created.UploadId === undefined) throw new AttachmentStorageIntegrityError(key);
    const uploadId = created.UploadId;
    const parts: CompletedPart[] = [];
    let buffered = Buffer.alloc(0);
    let size = 0;
    const digest = createHash('sha256');
    const upload = async (bytes: Buffer): Promise<void> => {
      const partNumber = parts.length + 1;
      const result = await this.#client.send(
        new UploadPartCommand({
          Bucket: this.#bucket,
          Key: key,
          UploadId: uploadId,
          PartNumber: partNumber,
          Body: bytes,
          ContentLength: bytes.length,
        }),
      );
      if (result.ETag === undefined) throw new AttachmentStorageIntegrityError(key);
      parts.push({ PartNumber: partNumber, ETag: result.ETag });
    };
    try {
      for await (const raw of body) {
        const chunk: unknown = raw;
        if (!(chunk instanceof Uint8Array)) throw new AttachmentStorageIntegrityError(key);
        size += chunk.byteLength;
        if (size > options.sizeBytes) throw new AttachmentStorageIntegrityError(key);
        digest.update(chunk);
        buffered = Buffer.concat([buffered, chunk]);
        while (buffered.length >= LIMITS.ATTACHMENT_MULTIPART_THRESHOLD_BYTES) {
          // eslint-disable-next-line no-await-in-loop -- one bounded part in flight avoids whole-upload buffering
          await upload(buffered.subarray(0, LIMITS.ATTACHMENT_MULTIPART_THRESHOLD_BYTES));
          buffered = buffered.subarray(LIMITS.ATTACHMENT_MULTIPART_THRESHOLD_BYTES);
        }
      }
      if (size !== options.sizeBytes || digest.digest('hex') !== key.split('/')[2])
        throw new AttachmentStorageIntegrityError(key);
      if (buffered.length > 0) await upload(buffered);
      await this.#client.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.#bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: { Parts: parts },
          IfNoneMatch: '*',
        }),
      );
    } catch (error) {
      await this.#client.send(
        new AbortMultipartUploadCommand({ Bucket: this.#bucket, Key: key, UploadId: uploadId }),
      );
      if (alreadyPublished(error)) return;
      throw error;
    }
  }

  /** The SDK returns a Node stream; ranges are inclusive as they are on the REST route. */
  async get(key: string, range?: ByteRange): Promise<Readable> {
    assertStorageKey(key);
    try {
      const result = await this.#client.send(
        new GetObjectCommand({
          Bucket: this.#bucket,
          Key: key,
          ...(range === undefined ? {} : { Range: `bytes=${range.start}-${range.end}` }),
        }),
      );
      if (!(result.Body instanceof Readable)) throw new AttachmentBytesMissingError(key);
      return result.Body;
    } catch (error) {
      if (missing(error)) throw new AttachmentBytesMissingError(key);
      throw error;
    }
  }

  /** Deletion is reserved for confirmed operator purges. */
  async delete(key: string): Promise<void> {
    assertStorageKey(key);
    await this.#client.send(new DeleteObjectCommand({ Bucket: this.#bucket, Key: key }));
  }

  /** Distinguishes a missing object from an inaccessible bucket. */
  async exists(key: string): Promise<boolean> {
    assertStorageKey(key);
    try {
      await this.#client.send(new HeadObjectCommand({ Bucket: this.#bucket, Key: key }));
      return true;
    } catch (error) {
      if (missing(error)) return false;
      throw error;
    }
  }

  /** A private zero-byte PUT/HEAD/DELETE checks the exact bucket credentials used by uploads. */
  async healthcheck(): Promise<void> {
    const key = `.iridium-probe-${String(process.pid)}-${randomUUID()}`;
    try {
      await this.#client.send(
        new PutObjectCommand({
          Bucket: this.#bucket,
          Key: key,
          Body: Buffer.alloc(0),
          ContentLength: 0,
        }),
      );
      const observed = await this.#client.send(
        new HeadObjectCommand({ Bucket: this.#bucket, Key: key }),
      );
      if (observed.ContentLength !== 0)
        throw new Error('Attachment storage readiness probe returned different bytes.');
    } finally {
      await this.#client.send(new DeleteObjectCommand({ Bucket: this.#bucket, Key: key }));
    }
  }

  /** Pages the object listing without buffering the bucket. */
  async *list(vaultId?: string): AsyncIterable<StoredObject> {
    let continuation: string | undefined;
    do {
      // eslint-disable-next-line no-await-in-loop -- continuation tokens are sequential
      const result = await this.#client.send(
        new ListObjectsV2Command({
          Bucket: this.#bucket,
          ...(vaultId === undefined ? {} : { Prefix: `${vaultId}/` }),
          ...(continuation === undefined ? {} : { ContinuationToken: continuation }),
        }),
      );
      for (const object of result.Contents ?? []) {
        if (object.Key === undefined || object.Size === undefined) continue;
        if (/^\.iridium-probe-\d+-[0-9a-f-]{36}$/.test(object.Key)) continue;
        assertStorageKey(object.Key, vaultId);
        yield { key: object.Key, sizeBytes: object.Size };
      }
      continuation = result.IsTruncated === true ? result.NextContinuationToken : undefined;
    } while (continuation !== undefined);
  }

  /** Releases the SDK's HTTP connections. */
  async close(): Promise<void> {
    this.#client.destroy();
  }
}
