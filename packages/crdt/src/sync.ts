/** The actual y-protocols sync messages, kept behind the package's single-import boundary. */
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as sync from 'y-protocols/sync';

import type { NoteDoc } from './index.ts';

export interface SyncMessageResult {
  readonly type: number;
  readonly response: Uint8Array;
}

/** Step 1 requests the state missing from this document. */
export function encodeSyncStep1(doc: NoteDoc): Uint8Array {
  const encoder = encoding.createEncoder();
  sync.writeSyncStep1(encoder, doc);
  return encoding.toUint8Array(encoder);
}

/** Apply one protocol message and return its response (empty after step 2 or an update). */
export function receiveSyncMessage(
  doc: NoteDoc,
  message: Uint8Array,
  origin: unknown,
): SyncMessageResult {
  const encoder = encoding.createEncoder();
  const type = sync.readSyncMessage(
    decoding.createDecoder(message),
    encoder,
    doc,
    origin,
    (error: Error) => {
      throw error;
    },
  );
  return { type, response: encoding.toUint8Array(encoder) };
}
