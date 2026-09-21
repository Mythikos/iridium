/** Content-addressed storage boundary (08 §9.1). It never authorizes a request. */
import type { Readable } from 'node:stream';

/** Inclusive byte offsets, validated before the storage boundary. */
export interface ByteRange {
  readonly start: number;
  readonly end: number;
}
/** An object found during the read-only orphan report. */
export interface StoredObject {
  readonly key: string;
  readonly sizeBytes: number;
}
/** Immutable atomic writes, ranged reads and explicit operator deletion. */
export interface StorageDriver {
  put(
    key: string,
    body: Readable,
    options: { readonly sizeBytes: number; readonly mime: string },
  ): Promise<void>;
  get(key: string, range?: ByteRange): Promise<Readable>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  /** Verifies write/read/delete access without publishing an attachment object. */
  healthcheck(): Promise<void>;
  /** Report enumeration is streaming, so object count cannot become a memory spike. */
  list(vaultId?: string): AsyncIterable<StoredObject>;
  close(): Promise<void>;
}

/** A malformed persisted key is corruption, never an alternate filesystem path. */
export class AttachmentStorageKeyError extends Error {
  constructor(key: string) {
    super(`Invalid attachment storage key '${key}'; repair the row before serving its bytes.`);
    this.name = 'AttachmentStorageKeyError';
  }
}

/** Checks the closed layout before any filesystem or S3 operation. */
export function assertStorageKey(key: string, vaultId?: string): void {
  const match =
    /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/([0-9a-f]{2})\/([0-9a-f]{64})$/.exec(
      key,
    );
  if (
    match === null ||
    match[2] !== match[3]?.slice(0, 2) ||
    (vaultId !== undefined && match[1] !== vaultId)
  ) {
    throw new AttachmentStorageKeyError(key);
  }
}

/** A stream did not contain the immutable bytes advertised by its key and metadata. */
export class AttachmentStorageIntegrityError extends Error {
  constructor(key: string) {
    super(
      `Attachment bytes disagree with storage key or length '${key}'; discard the upload and retry.`,
    );
    this.name = 'AttachmentStorageIntegrityError';
  }
}

/** A missing blob is operational corruption, distinct from a missing metadata row. */
export class AttachmentBytesMissingError extends Error {
  readonly storageKey: string;
  constructor(key: string) {
    super(
      `Attachment bytes '${key}' are missing; restore the attachment volume from the matching backup.`,
    );
    this.name = 'AttachmentBytesMissingError';
    this.storageKey = key;
  }
}

/** Node and SDK adapters expose errors through separate classes but share these status fields. */
export function storageErrorCode(error: unknown): string | undefined {
  return error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : undefined;
}
