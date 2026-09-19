/**
 * `crdt.frame.unit` — the header peek the pre-dispatch awareness cap and the per-type counter rest
 * on (05-collaboration-and-durability.md, "Mounting on `/collab`"; D05-18).
 *
 * Every frame here is written with lib0's own encoder, the way Hocuspocus's `OutgoingMessage` and
 * `IncomingMessage` write and read it, so the peek is checked against the protocol's writer and not
 * against a copy of it.
 */
import * as encoding from 'lib0/encoding';
import { describe, expect, it } from 'vitest';

import {
  decodeAwarenessEntries,
  decodeSyncUpdate,
  FRAME_TYPE,
  peekFrame,
  peekStatelessPayload,
  peekSyncType,
  SYNC_TYPE,
} from './frame.ts';

const NOTE = 'note:0190f2a0-0000-7000-8000-000000000001';

/** A frame as Hocuspocus encodes it: `varString(name)`, `varUint(type)`, then the body. */
function frame(name: string, type: number, body: (encoder: encoding.Encoder) => void): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarString(encoder, name);
  encoding.writeVarUint(encoder, type);
  body(encoder);
  return encoding.toUint8Array(encoder);
}

describe('crdt.frame.unit [area:collab]', () => {
  it('reads the document name and the message type of a Hocuspocus-encoded awareness frame', () => {
    const bytes = frame(NOTE, FRAME_TYPE.awareness, (encoder) => {
      encoding.writeVarUint8Array(encoder, new Uint8Array(3));
    });
    const nameBytes = encoding.length(
      (() => {
        const encoder = encoding.createEncoder();
        encoding.writeVarString(encoder, NOTE);
        return encoder;
      })(),
    );
    expect(peekFrame(bytes)).toEqual({
      routingKey: NOTE,
      documentName: NOTE,
      type: FRAME_TYPE.awareness,
      bodyOffset: nameBytes + 1,
    });
  });

  it('cuts a `\\0`-suffixed routing key at the separator, as Hocuspocus routes it', () => {
    const bytes = frame(`${NOTE}\0session-7`, FRAME_TYPE.sync, () => undefined);
    expect(peekFrame(bytes)).toMatchObject({
      documentName: NOTE,
      routingKey: `${NOTE}\0session-7`,
    });
  });

  it('reads a multi-byte name length and a multi-byte type', () => {
    const longName = `note:${'a'.repeat(200)}`;
    const bytes = frame(longName, 300, () => undefined);
    expect(peekFrame(bytes)).toMatchObject({ documentName: longName, type: 300 });
  });

  it('answers null for a truncated frame rather than throwing', () => {
    expect(peekFrame(new Uint8Array(0))).toBeNull();
    // A declared name length of 5 with one byte behind it.
    expect(peekFrame(Uint8Array.from([0x05, 0x61]))).toBeNull();
    // A complete name and no type.
    const nameOnly = (() => {
      const encoder = encoding.createEncoder();
      encoding.writeVarString(encoder, NOTE);
      return encoding.toUint8Array(encoder);
    })();
    expect(peekFrame(nameOnly)).toBeNull();
    // A varint that never terminates.
    expect(peekFrame(Uint8Array.from(Array.from({ length: 12 }, () => 0x80)))).toBeNull();
  });

  it('answers null for an oversize document name: a declared length past the end of the frame', () => {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 100_000);
    encoding.writeVarUint8Array(encoder, new Uint8Array(16));
    expect(peekFrame(encoding.toUint8Array(encoder))).toBeNull();
  });

  it('decodes only complete update-bearing sync frames and refuses trailing or truncated data', () => {
    for (const type of [FRAME_TYPE.sync, FRAME_TYPE.syncReply]) {
      const bytes = frame(NOTE, type, (encoder) => {
        encoding.writeVarUint(encoder, SYNC_TYPE.step2);
        encoding.writeVarUint8Array(encoder, Uint8Array.of(0, 0));
      });
      const header = peekFrame(bytes);
      if (header === null) throw new Error('The generated header must be complete.');
      expect(decodeSyncUpdate(bytes, header)).toEqual(Uint8Array.of(0, 0));
      expect(decodeSyncUpdate(bytes.subarray(0, -1), header)).toBeNull();
      expect(decodeSyncUpdate(Uint8Array.of(...bytes, 0), header)).toBeNull();
      expect(decodeSyncUpdate(bytes, { ...header, bodyOffset: -1 })).toBeNull();
      expect(decodeSyncUpdate(bytes, { ...header, bodyOffset: bytes.length })).toBeNull();
      expect(decodeSyncUpdate(bytes, { ...header, type: FRAME_TYPE.awareness })).toBeNull();
    }
    const step1 = frame(NOTE, FRAME_TYPE.sync, (encoder) => {
      encoding.writeVarUint(encoder, SYNC_TYPE.step1);
      encoding.writeVarUint8Array(encoder, Uint8Array.of(0));
    });
    const header = peekFrame(step1);
    if (header === null) throw new Error('The generated header must be complete.');
    expect(decodeSyncUpdate(step1, header)).toBeNull();
  });

  it('peeks the sync sub-type behind a Sync header', () => {
    const bytes = frame(NOTE, FRAME_TYPE.sync, (encoder) => {
      encoding.writeVarUint(encoder, SYNC_TYPE.update);
      encoding.writeVarUint8Array(encoder, new Uint8Array(2));
    });
    const header = peekFrame(bytes);
    expect(header).not.toBeNull();
    if (header === null) return;
    expect(peekSyncType(bytes, header)).toBe(SYNC_TYPE.update);
    expect(peekSyncType(bytes.subarray(0, header.bodyOffset), header)).toBeNull();
  });

  it('peeks the payload of a Stateless frame and the reason of a CLOSE frame', () => {
    const payload = '{"v":1,"t":"persisted","seq":3,"sv":"AA=="}';
    const stateless = frame(NOTE, FRAME_TYPE.stateless, (encoder) => {
      encoding.writeVarString(encoder, payload);
    });
    const header = peekFrame(stateless);
    expect(header).not.toBeNull();
    if (header === null) return;
    expect(peekStatelessPayload(stateless, header)).toBe(payload);
    expect(
      peekStatelessPayload(stateless.subarray(0, stateless.byteLength - 4), header),
    ).toBeNull();

    const close = frame(NOTE, FRAME_TYPE.close, (encoder) => {
      encoding.writeVarString(encoder, 'awareness-spoof');
    });
    const closeHeader = peekFrame(close);
    expect(closeHeader?.type).toBe(FRAME_TYPE.close);
    if (closeHeader === null) return;
    expect(peekStatelessPayload(close, closeHeader)).toBe('awareness-spoof');
  });

  describe('raw awareness entries', () => {
    function decodeUpdate(
      write: (encoder: encoding.Encoder) => void,
    ): ReturnType<typeof decodeAwarenessEntries> {
      const update = encoding.createEncoder();
      write(update);
      const bytes = frame(NOTE, FRAME_TYPE.awareness, (encoder) => {
        encoding.writeVarUint8Array(encoder, encoding.toUint8Array(update));
      });
      const header = peekFrame(bytes);
      if (header === null) throw new Error('the test writer emitted no frame header');
      return decodeAwarenessEntries(bytes, header);
    }

    it('preserves duplicate client ids, complete states, and explicit null removals in wire order', () => {
      const states = [{ user: { id: 'first' } }, { user: { id: 'second' } }, null];
      expect(
        decodeUpdate((encoder) => {
          encoding.writeVarUint(encoder, states.length);
          for (const [index, state] of states.entries()) {
            encoding.writeVarUint(encoder, Number.MAX_SAFE_INTEGER);
            encoding.writeVarUint(encoder, index + 1);
            encoding.writeVarString(encoder, JSON.stringify(state));
          }
        }),
      ).toEqual(
        states.map((state, index) => ({
          clientId: Number.MAX_SAFE_INTEGER,
          clock: index + 1,
          state,
        })),
      );
    });

    it('accepts an empty awareness update', () => {
      expect(decodeUpdate((encoder) => encoding.writeVarUint(encoder, 0))).toEqual([]);
    });

    it.each(['[]', 'false', '1', '"user"', '{'])(
      'rejects a non-object or malformed state %s',
      (state) => {
        expect(
          decodeUpdate((encoder) => {
            encoding.writeVarUint(encoder, 1);
            encoding.writeVarUint(encoder, 7);
            encoding.writeVarUint(encoder, 1);
            encoding.writeVarString(encoder, state);
          }),
        ).toBeNull();
      },
    );

    it('rejects impossible counts, unsafe integer fields, truncated entries and trailing data', () => {
      expect(
        decodeUpdate((encoder) => encoding.writeVarUint(encoder, Number.MAX_SAFE_INTEGER)),
      ).toBeNull();
      expect(
        decodeUpdate((encoder) => {
          encoding.writeVarUint(encoder, 1);
          encoding.writeVarUint(encoder, Number.MAX_SAFE_INTEGER + 1);
          encoding.writeVarUint(encoder, 1);
          encoding.writeVarString(encoder, '{}');
        }),
      ).toBeNull();
      expect(
        decodeUpdate((encoder) => {
          encoding.writeVarUint(encoder, 1);
          encoding.writeVarUint(encoder, 7);
          encoding.writeVarUint(encoder, 1);
          encoding.writeVarUint(encoder, 100);
        }),
      ).toBeNull();
      expect(
        decodeUpdate((encoder) => {
          encoding.writeVarUint(encoder, 0);
          encoding.writeVarUint(encoder, 1);
        }),
      ).toBeNull();
      const bytes = frame(NOTE, FRAME_TYPE.awareness, (encoder) => {
        encoding.writeVarUint8Array(encoder, Uint8Array.of(0));
        encoding.writeVarUint(encoder, 1);
      });
      const header = peekFrame(bytes);
      if (header === null) throw new Error('the test writer emitted no frame header');
      expect(decodeAwarenessEntries(bytes, header)).toBeNull();
      expect(decodeAwarenessEntries(bytes, { ...header, bodyOffset: -1 })).toBeNull();
      expect(decodeAwarenessEntries(bytes, { ...header, type: FRAME_TYPE.sync })).toBeNull();
    });
  });
  it('spells the protocol numbers of Hocuspocus 4.7', () => {
    expect(FRAME_TYPE).toEqual({
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
    expect(SYNC_TYPE).toEqual({ step1: 0, step2: 1, update: 2 });
  });
});
