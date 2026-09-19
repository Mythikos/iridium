/**
 * Hand-built `/collab` frames, for the tests that must send what the product client never would
 * (10-testing-and-quality.md, `collab.awareness-identity.integration`: *"An awareness frame built by
 * hand … carrying a foreign `user.id` closes the connection with `awareness-spoof`"*).
 *
 * **Why the encoding is written out here rather than imported.** `lib0` and `y-protocols` are
 * importable by exactly one first-party package, `@iridium/crdt` (13-decision-log.md A14), and
 * `packages/testkit` carries the `node` boundary tag whose `no-restricted-imports` list bans all
 * three. The alternative — an `@iridium/crdt` export that exists only so a harness can forge a frame
 * — would put a forgery tool in the product's own CRDT package. So the three primitives the frame
 * needs (an unsigned LEB128 varint, a length-prefixed UTF-8 string, a length-prefixed byte array)
 * are written here, against the two encoders they must match byte for byte:
 *
 * - `lib0/encoding`: `writeVarUint` is 7 bits per byte with `0x80` as the continuation flag;
 *   `writeVarString` is `writeVarUint(utf8ByteLength)` followed by the UTF-8 bytes;
 *   `writeVarUint8Array` is `writeVarUint(length)` followed by the bytes.
 * - `y-protocols/awareness`'s `encodeAwarenessUpdate`: `varUint(entryCount)` then, per entry,
 *   `varUint(clientId)`, `varUint(clock)`, `varString(JSON.stringify(state))`.
 * - Hocuspocus 4.7's `AwarenessMessage`: `varString(documentName)`, `varUint(MessageType.Awareness)`,
 *   `varUint8Array(awarenessUpdate)`.
 *
 * `testkit.awareness-frame.unit` pins each of those against bytes written out by hand, so a drift in
 * this module fails here rather than as an unexplained `protocol-error` close in a chaos lane.
 */

/** Hocuspocus 4.7's `MessageType.Awareness`. The wire numbers are the protocol, not an internal. */
export const MESSAGE_TYPE_AWARENESS = 1;

/** `MessageType.Stateless`, for a stateless payload sent outside a provider. */
export const MESSAGE_TYPE_STATELESS = 5;

const CONTINUATION_BIT = 0x80;
const SEVEN_BITS = 0x7f;
const VARINT_SHIFT = 128;

const UTF8 = new TextEncoder();

/** A growable byte sink; `bytes()` is the frame. */
class FrameWriter {
  readonly #parts: number[] = [];

  /** `lib0/encoding.writeVarUint`: seven bits per byte, low group first, `0x80` continues. */
  varUint(value: number): this {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(
        `@iridium/testkit: a varUint is a non-negative integer, got ${String(value)}`,
      );
    }
    let rest = value;
    while (rest > SEVEN_BITS) {
      this.#parts.push(CONTINUATION_BIT | (SEVEN_BITS & rest));
      // `Math.floor(rest / 128)` and not `rest >>> 7`: a Yjs `clientID` is a 53-bit integer and the
      // shift operators would truncate it to 32 bits, exactly as lib0 notes at the same line.
      rest = Math.floor(rest / VARINT_SHIFT);
    }
    this.#parts.push(SEVEN_BITS & rest);
    return this;
  }

  /** `lib0/encoding.writeVarUint8Array`. */
  varBytes(bytes: Uint8Array): this {
    this.varUint(bytes.byteLength);
    for (const byte of bytes) this.#parts.push(byte);
    return this;
  }

  /** `lib0/encoding.writeVarString`: the length is in **bytes**, not in code units. */
  varString(value: string): this {
    return this.varBytes(UTF8.encode(value));
  }

  bytes(): Uint8Array {
    return Uint8Array.from(this.#parts);
  }
}

/** One client's awareness entry, as `encodeAwarenessUpdate` writes it. */
export interface AwarenessEntry {
  /** The `Y.Doc` client id the state claims to come from. */
  readonly clientId: number;
  /** The awareness clock; a receiver keeps the highest it has seen per client. */
  readonly clock: number;
  /** The state object, or `null` for the removal a disconnect sends. */
  readonly state: unknown;
}

/**
 * `y-protocols/awareness`' `encodeAwarenessUpdate` for entries a test states outright.
 *
 * Nothing here consults an `Awareness` instance, which is the point: the product client can only
 * publish its own client id and its own state, and the frame this builds is the one it cannot.
 */
export function encodeAwarenessUpdate(entries: readonly AwarenessEntry[]): Uint8Array {
  const writer = new FrameWriter();
  writer.varUint(entries.length);
  for (const entry of entries) {
    writer.varUint(entry.clientId);
    writer.varUint(entry.clock);
    writer.varString(JSON.stringify(entry.state ?? null));
  }
  return writer.bytes();
}

/**
 * A complete Hocuspocus awareness frame for one document, ready for `NoteClient.sendRaw`.
 *
 * `documentName` is the routing key the server reads first (`note:<uuid>`), so a frame addressed to
 * a document this connection never attached is itself a case worth sending.
 */
export function awarenessFrame(o: {
  readonly documentName: string;
  readonly entries: readonly AwarenessEntry[];
}): Uint8Array {
  return new FrameWriter()
    .varString(o.documentName)
    .varUint(MESSAGE_TYPE_AWARENESS)
    .varBytes(encodeAwarenessUpdate(o.entries))
    .bytes();
}

/**
 * A stateless frame built by hand, for payloads the product's codec would never produce — an
 * oversize body, a malformed JSON string, an unknown `t` (09-api-reference.md §7.2).
 */
export function statelessFrame(o: {
  readonly documentName: string;
  readonly payload: string;
}): Uint8Array {
  return new FrameWriter()
    .varString(o.documentName)
    .varUint(MESSAGE_TYPE_STATELESS)
    .varString(o.payload)
    .bytes();
}
