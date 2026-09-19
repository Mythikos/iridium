/**
 * `peekFrame` — the header of one inbound Hocuspocus frame, read without decoding the body
 * (05-collaboration-and-durability.md, "Mounting on `/collab`" and "Limits"; D05-18).
 *
 * Every frame Hocuspocus 4.7 receives starts with `varString(documentName)` and `varUint(type)`,
 * written with lib0's encoders. The `/collab` socket layer needs both before dispatch — the awareness
 * rate cap is keyed on the document and filters type 1 only, `beforeHandleMessage` counts frames by
 * type and caps the size of a single update — and reading them here, with lib0's own decoder, is
 * what keeps a hand-rolled varint out of the server. This package is the one importer of lib0
 * (13-decision-log.md A14), which is why the function lives here and not beside its callers.
 *
 * A frame that does not carry a complete header — truncated bytes, a name whose declared length runs
 * past the end, a varint that never terminates — is answered with `null`, never an exception: the
 * caller lets Hocuspocus refuse it as it would have anyway.
 */
import * as decoding from 'lib0/decoding';

/**
 * The message types of Hocuspocus 4.7: Sync 0, Awareness 1, Auth 2, QueryAwareness 3, SyncReply 4,
 * Stateless 5, CLOSE 7, SyncStatus 8, Ping 9, Pong 10. The wire numbers are the protocol, not an
 * internal, and comparing a decoded header against them keeps the enum the library declares out of
 * every comparison.
 */
export const FRAME_TYPE: Readonly<{
  sync: 0;
  awareness: 1;
  auth: 2;
  queryAwareness: 3;
  syncReply: 4;
  stateless: 5;
  close: 7;
  syncStatus: 8;
  ping: 9;
  pong: 10;
}> = Object.freeze({
  sync: 0,
  awareness: 1,
  auth: 2,
  queryAwareness: 3,
  syncReply: 4,
  stateless: 5,
  close: 7,
  syncStatus: 8,
  ping: 9,
  pong: 10,
});

/** The y-protocols sync sub-types inside a `Sync` frame. */
export const SYNC_TYPE: Readonly<{ step1: 0; step2: 1; update: 2 }> = Object.freeze({
  step1: 0,
  step2: 1,
  update: 2,
});

/** The two header fields of every inbound frame, and where the body starts. */
export interface FrameHeader {
  /** The complete address, including any session suffix, before Hocuspocus normalizes it. */
  readonly routingKey: string;
  /** The routing key without a `\0`-suffixed session id, as Hocuspocus compares it. */
  readonly documentName: string;
  /** A `FRAME_TYPE` value. */
  readonly type: number;
  /** Where the body starts, for a reader that needs the next field. */
  readonly bodyOffset: number;
}

/** A lib0 read that answers `null` instead of throwing on a short or malformed buffer. */
function read<T>(decoder: decoding.Decoder, reader: (decoder: decoding.Decoder) => T): T | null {
  try {
    const value = reader(decoder);
    return decoder.pos > decoder.arr.byteLength ? null : value;
  } catch {
    return null;
  }
}

/**
 * Reads the header of one frame. `null` when the bytes do not carry a complete header.
 *
 * The document name is cut at the first `\0`: Hocuspocus 4.7 lets a provider address a document as
 * `<name>\0<sessionId>` and routes on the part before the separator, and a limiter must key on the
 * same string or a client could dodge a bucket by appending a session id.
 */
export function peekFrame(bytes: Uint8Array): FrameHeader | null {
  const decoder = decoding.createDecoder(bytes);
  const rawKey = read(decoder, decoding.readVarString);
  if (rawKey === null) return null;
  const type = read(decoder, decoding.readVarUint);
  if (type === null) return null;
  const separator = rawKey.indexOf('\0');
  return {
    routingKey: rawKey,
    documentName: separator === -1 ? rawKey : rawKey.slice(0, separator),
    type,
    bodyOffset: decoder.pos,
  };
}

/** The Yjs sync sub-type of a `Sync` frame (`SyncStep1` 0, `SyncStep2` 1, `Update` 2), or `null`. */
export function peekSyncType(bytes: Uint8Array, header: FrameHeader): number | null {
  const decoder = decoding.createDecoder(bytes.subarray(header.bodyOffset));
  return read(decoder, decoding.readVarUint);
}

/** The exact V1 update carried by a complete Step2 or Update frame, or null on malformed input. */
export function decodeSyncUpdate(bytes: Uint8Array, header: FrameHeader): Uint8Array | null {
  if (
    (header.type !== FRAME_TYPE.sync && header.type !== FRAME_TYPE.syncReply) ||
    !Number.isSafeInteger(header.bodyOffset) ||
    header.bodyOffset < 0 ||
    header.bodyOffset >= bytes.byteLength
  )
    return null;
  const decoder = decoding.createDecoder(bytes.subarray(header.bodyOffset));
  const subtype = read(decoder, decoding.readVarUint);
  if (subtype !== SYNC_TYPE.step2 && subtype !== SYNC_TYPE.update) return null;
  const update = read(decoder, decoding.readVarUint8Array);
  return update !== null && decoder.pos === decoder.arr.byteLength ? update : null;
}

/** The payload of a `Stateless` or `CLOSE` frame — the one `varString` they carry — or `null`. */
export function peekStatelessPayload(bytes: Uint8Array, header: FrameHeader): string | null {
  const decoder = decoding.createDecoder(bytes.subarray(header.bodyOffset));
  return read(decoder, decoding.readVarString);
}

/** One awareness wire entry, retaining duplicates and explicit removal tombstones for validation. */
export interface AwarenessFrameEntry {
  readonly clientId: number;
  readonly clock: number;
  readonly state: Readonly<Record<string, unknown>> | null;
}

/**
 * Decode every entry before y-protocols folds duplicate ids or discards removal states. Malformed
 * lengths, unsafe integers, non-object states, and trailing bytes return `null`. Entry count is
 * bounded by the received bytes, so an attacker-controlled count cannot drive an unbounded loop.
 */
export function decodeAwarenessEntries(
  bytes: Uint8Array,
  header: FrameHeader,
): readonly AwarenessFrameEntry[] | null {
  if (
    header.type !== FRAME_TYPE.awareness ||
    !Number.isSafeInteger(header.bodyOffset) ||
    header.bodyOffset < 0 ||
    header.bodyOffset >= bytes.byteLength
  ) {
    return null;
  }
  const body = decoding.createDecoder(bytes.subarray(header.bodyOffset));
  const update = read(body, decoding.readVarUint8Array);
  if (update === null || body.pos !== body.arr.byteLength) return null;
  const decoder = decoding.createDecoder(update);
  const count = read(decoder, decoding.readVarUint);
  // Even an empty state string needs three bytes: the id, clock and string length varints.
  if (
    count === null ||
    !Number.isSafeInteger(count) ||
    count > (decoder.arr.byteLength - decoder.pos) / 3
  ) {
    return null;
  }
  const entries: AwarenessFrameEntry[] = [];
  for (let index = 0; index < count; index++) {
    const clientId = read(decoder, decoding.readVarUint);
    const clock = read(decoder, decoding.readVarUint);
    const encoded = read(decoder, decoding.readVarString);
    if (
      clientId === null ||
      clock === null ||
      !Number.isSafeInteger(clientId) ||
      !Number.isSafeInteger(clock) ||
      encoded === null
    ) {
      return null;
    }
    let state: unknown = null;
    try {
      state = JSON.parse(encoded);
    } catch {
      return null;
    }
    if (state !== null && !isAwarenessObject(state)) return null;
    entries.push({ clientId, clock, state });
  }
  return decoder.pos === decoder.arr.byteLength ? entries : null;
}

function isAwarenessObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
