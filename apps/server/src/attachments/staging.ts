/** Whole-stream digest and byte cap with a bounded sniff prefix (08 §9.2). */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { LIMITS } from '@iridium/contracts';

import { ProblemError } from '../security/problem.ts';
import { sniffAttachment } from './sniff.ts';
import { storageErrorCode } from './storage.ts';

/** One validated temporary upload; the owner must dispose it in finally. */
export interface StagedAttachment {
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly mime: string;
  readonly originalName: string;
  open(): Readable;
  dispose(): Promise<void>;
}

/** Stages one file without retaining its body in memory. */
export async function stageAttachment(
  body: Readable,
  filename: string,
  directory: string,
  maxBytes: number,
): Promise<StagedAttachment> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, randomUUID());
  const digest = createHash('sha256');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let sizeBytes = 0;
  let prefix = Buffer.alloc(0);
  let validUtf8 = true;
  const discard = async (): Promise<void> => {
    await unlink(temporary).catch((error: unknown) => {
      if (storageErrorCode(error) !== 'ENOENT') throw error;
    });
  };
  const hash = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      sizeBytes += chunk.byteLength;
      if (sizeBytes > maxBytes) {
        callback(new ProblemError('payload_too_large'));
        return;
      }
      digest.update(chunk);
      if (prefix.length < LIMITS.ATTACHMENT_SNIFF_BYTES)
        prefix = Buffer.concat([
          prefix,
          chunk.subarray(0, LIMITS.ATTACHMENT_SNIFF_BYTES - prefix.length),
        ]);
      if (validUtf8) {
        try {
          decoder.decode(chunk, { stream: true });
        } catch {
          validUtf8 = false;
        }
      }
      callback(null, chunk);
    },
  });
  try {
    await pipeline(body, hash, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
    if (validUtf8) {
      try {
        decoder.decode();
      } catch {
        validUtf8 = false;
      }
    }
    const sniffed = await sniffAttachment(prefix, filename, validUtf8);
    if (!sniffed.accepted)
      throw new ProblemError('unsupported_media', {
        detail: `Attachment type '${sniffed.mime}' is not permitted.`,
      });
    return {
      sha256: digest.digest('hex'),
      sizeBytes,
      mime: sniffed.mime,
      originalName: filename,
      open: () => createReadStream(temporary),
      dispose: discard,
    };
  } catch (error) {
    await discard();
    throw error;
  }
}
