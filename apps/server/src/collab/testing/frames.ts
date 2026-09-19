/**
 * Hand-built inbound `/collab` frames for the hook suites: the header the limiter peeks
 * (`varString(documentName)`, `varUint(type)`) followed by the body each type carries.
 *
 * Written out rather than imported for the same reason as `@iridium/testkit`'s frame builders: the
 * encoders live in `lib0` and `y-protocols`, which only `@iridium/crdt` may import (A14), and a
 * frame a hostile client would send is not something the CRDT package should know how to build.
 * The byte layout is lib0's `writeVarUint` / `writeVarString` / `writeVarUint8Array` and
 * y-protocols' sync messages (`varUint(subType)` then `varUint8Array(body)`).
 */
import { FRAME_TYPE, SYNC_TYPE } from '@iridium/crdt';

const CONTINUATION_BIT = 0x80;
const SEVEN_BITS = 0x7f;
const VARINT_SHIFT = 128;
const UTF8 = new TextEncoder();

class FrameWriter {
  readonly #parts: number[] = [];

  varUint(value: number): this {
    let rest = value;
    while (rest > SEVEN_BITS) {
      this.#parts.push(CONTINUATION_BIT | (SEVEN_BITS & rest));
      rest = Math.floor(rest / VARINT_SHIFT);
    }
    this.#parts.push(SEVEN_BITS & rest);
    return this;
  }

  varBytes(bytes: Uint8Array): this {
    this.varUint(bytes.byteLength);
    for (const byte of bytes) this.#parts.push(byte);
    return this;
  }

  varString(text: string): this {
    return this.varBytes(UTF8.encode(text));
  }

  bytes(): Uint8Array {
    return Uint8Array.from(this.#parts);
  }
}

function header(documentName: string, type: number): FrameWriter {
  return new FrameWriter().varString(documentName).varUint(type);
}

/** A `Sync` frame carrying one y-protocols sub-message. */
export function syncFrame(documentName: string, subType: number, body: Uint8Array): Uint8Array {
  return header(documentName, FRAME_TYPE.sync).varUint(subType).varBytes(body).bytes();
}

/** `SyncStep1` with a state vector. */
export function step1Frame(documentName: string, stateVector: Uint8Array): Uint8Array {
  return syncFrame(documentName, SYNC_TYPE.step1, stateVector);
}

/** `SyncStep2` with an update. */
export function step2Frame(documentName: string, update: Uint8Array): Uint8Array {
  return syncFrame(documentName, SYNC_TYPE.step2, update);
}

/** `Update` with an update. */
export function updateFrame(documentName: string, update: Uint8Array): Uint8Array {
  return syncFrame(documentName, SYNC_TYPE.update, update);
}

/** An `Awareness` frame with an already-encoded awareness update. */
export function awarenessFrameOf(documentName: string, encoded: Uint8Array): Uint8Array {
  return header(documentName, FRAME_TYPE.awareness).varBytes(encoded).bytes();
}

/** A `Stateless` frame. */
export function statelessFrameOf(documentName: string, payload: string): Uint8Array {
  return header(documentName, FRAME_TYPE.stateless).varString(payload).bytes();
}

/** A `Ping`. */
export function pingFrame(documentName: string): Uint8Array {
  return header(documentName, FRAME_TYPE.ping).bytes();
}

/** A `QueryAwareness`. */
export function queryAwarenessFrame(documentName: string): Uint8Array {
  return header(documentName, FRAME_TYPE.queryAwareness).bytes();
}
