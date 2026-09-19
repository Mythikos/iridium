import { describe, expect, it } from 'vitest';

import {
  MESSAGE_TYPE_AWARENESS,
  MESSAGE_TYPE_STATELESS,
  awarenessFrame,
  encodeAwarenessUpdate,
  statelessFrame,
} from './clients/awareness-frame.ts';

/**
 * The hand-built frames, pinned against bytes written out by hand.
 *
 * The encoder exists because `packages/testkit` carries the `node` boundary tag and may not import
 * `lib0` or `y-protocols` (A14), so there is nothing to compare it against at run time — which makes
 * these golden bytes the only thing standing between a drifted varint and a chaos-lane failure that
 * reports `protocol-error` and explains nothing.
 */

const UTF8 = new TextEncoder();

function varUintOf(value: number): readonly number[] {
  return [...encodeAwarenessUpdate([{ clientId: value, clock: 0, state: null }])].slice(
    1,
    // count, then the client id, then the clock and the state: the id is everything between.
    -1 - 1 - UTF8.encode('null').byteLength,
  );
}

describe('testkit.awareness-frame.unit [area:testkit]', () => {
  it('writes an awareness update exactly as y-protocols does', () => {
    const state = { user: { id: 'u' } };
    const json = JSON.stringify(state);
    const update = encodeAwarenessUpdate([{ clientId: 1, clock: 2, state }]);

    expect([...update]).toStrictEqual([
      1, // one entry
      1, // clientId
      2, // clock
      json.length, // the varString length is in bytes
      ...UTF8.encode(json),
    ]);
  });

  it('encodes a removal as the JSON null y-protocols writes', () => {
    expect([...encodeAwarenessUpdate([{ clientId: 3, clock: 9, state: null }])]).toStrictEqual([
      1,
      3,
      9,
      4,
      ...UTF8.encode('null'),
    ]);
  });

  it('writes lib0 varints: seven bits per byte, low group first', () => {
    expect(varUintOf(0)).toStrictEqual([0]);
    expect(varUintOf(127)).toStrictEqual([127]);
    expect(varUintOf(128)).toStrictEqual([0x80, 1]);
    expect(varUintOf(300)).toStrictEqual([0xac, 2]);
  });

  it('writes a client id above 32 bits, which a shift would truncate', () => {
    // `2 ** 33` is a legal Yjs `clientID`; `num >>> 7` would report it as 0.
    const encoded = varUintOf(2 ** 33);
    expect(encoded.at(-1)).toBeGreaterThan(0);
    expect(encoded).toHaveLength(5);
  });

  it('measures a varString in UTF-8 bytes and not in code units', () => {
    const state = { emoji: '😀' };
    const json = JSON.stringify(state);
    const update = encodeAwarenessUpdate([{ clientId: 1, clock: 1, state }]);
    expect(update[3]).toBe(UTF8.encode(json).byteLength);
    expect(update[3]).toBeGreaterThan(json.length);
  });

  it('frames an awareness update for one document', () => {
    const name = 'note:01890000-0000-7000-8000-000000000000';
    const frame = awarenessFrame({
      documentName: name,
      entries: [{ clientId: 1, clock: 1, state: null }],
    });
    const nameBytes = UTF8.encode(name);

    expect(Array.from(frame.slice(0, 1 + nameBytes.byteLength))).toStrictEqual([
      nameBytes.byteLength,
      ...nameBytes,
    ]);
    expect(frame[1 + nameBytes.byteLength]).toBe(MESSAGE_TYPE_AWARENESS);
    // The update is length-prefixed, which is what `readVarUint8Array` reads on the other side.
    const update = encodeAwarenessUpdate([{ clientId: 1, clock: 1, state: null }]);
    expect(frame[2 + nameBytes.byteLength]).toBe(update.byteLength);
  });

  it('frames a stateless payload as a var string rather than a byte array', () => {
    const frame = statelessFrame({ documentName: 'note:x', payload: '{"v":1,"t":"baseline"}' });
    const nameBytes = UTF8.encode('note:x');
    expect(frame[1 + nameBytes.byteLength]).toBe(MESSAGE_TYPE_STATELESS);
    expect(frame[2 + nameBytes.byteLength]).toBe(UTF8.encode('{"v":1,"t":"baseline"}').byteLength);
  });

  it('refuses a negative or fractional client id rather than writing nonsense', () => {
    expect(() => encodeAwarenessUpdate([{ clientId: -1, clock: 0, state: null }])).toThrow(
      /non-negative integer/,
    );
    expect(() => encodeAwarenessUpdate([{ clientId: 1.5, clock: 0, state: null }])).toThrow(
      /non-negative integer/,
    );
  });
});
