// oxlint-disable vitest/no-standalone-expect -- `test.prop(...)(name, fn)` is the
// @fast-check/vitest form of a test block, which this rule does not know about yet.

import { test } from '@fast-check/vitest';
import * as fc from 'fast-check';
import { describe, expect } from 'vitest';

import { PROP } from '../test/prop-budget.ts';
import {
  CANONICAL_ID_PATTERN,
  createIdGenerator,
  ID_BYTE_LENGTH,
  idFromBytes,
  idTimestamp,
  idToBytes,
} from './ids.ts';

/** Unix milliseconds inside the 48 bits a UUIDv7 timestamp has. */
const millisecond = fc.integer({ min: 0, max: 2 ** 48 - 1 });

/**
 * Sixteen bytes as they come back from a `BINARY(16)` column: arbitrary, except that the version
 * and variant nibbles are the ones the generator writes, because those are the only rows the
 * column ever holds.
 */
const binary16 = fc
  .uint8Array({ minLength: ID_BYTE_LENGTH, maxLength: ID_BYTE_LENGTH })
  .map((bytes) => {
    const shaped = Uint8Array.from(bytes);
    shaped[6] = 0x70 | ((shaped[6] ?? 0) & 0x0f);
    shaped[8] = 0x80 | ((shaped[8] ?? 0) & 0x3f);
    return shaped;
  });

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  for (let index = 0; index < left.length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** A generator pinned to a clock and a random byte, so a property can replay it exactly. */
function pinned(now: () => number, byte: number): () => string {
  const generate = createIdGenerator({ now, fillRandom: (bytes) => bytes.fill(byte) });
  return () => generate();
}

describe('contracts.ids.prop [area:contracts]', () => {
  test.prop([millisecond, fc.integer({ min: 0, max: 0xff })], PROP)(
    'every id is sixteen bytes with version 7 and variant 10',
    (now, byte) => {
      const bytes = idToBytes(pinned(() => now, byte)());
      expect(bytes).toHaveLength(ID_BYTE_LENGTH);
      expect((bytes[6] ?? 0) >>> 4).toBe(0x7);
      expect((bytes[8] ?? 0) >>> 6).toBe(0b10);
    },
  );

  test.prop(
    [millisecond, fc.integer({ min: 0, max: 0x0f }), fc.integer({ min: 2, max: 16 })],
    PROP,
  )('ids created in one millisecond are strictly increasing', (now, byte, count) => {
    const generate = pinned(() => now, byte);
    const ids = Array.from({ length: count }, () => generate());
    for (let index = 1; index < ids.length; index += 1) {
      const previous = ids[index - 1] ?? '';
      const current = ids[index] ?? '';
      expect(current > previous).toBe(true);
      expect(compareBytes(idToBytes(current), idToBytes(previous))).toBeGreaterThan(0);
      expect(idTimestamp(current)).toBe(now);
    }
  });

  test.prop([binary16], PROP)(
    'the canonical string round trip is lossless and lowercase',
    (bytes) => {
      const id = idFromBytes(bytes);
      expect(id).toBe(id.toLowerCase());
      expect(idToBytes(id)).toStrictEqual(bytes);
      expect(idToBytes(id.toUpperCase())).toStrictEqual(bytes);
    },
  );

  test.prop([millisecond, millisecond, fc.integer({ min: 0, max: 0x0f })], PROP)(
    'BINARY(16) ordering follows timestamp ordering',
    (left, right, byte) => {
      fc.pre(left !== right);
      const earlier = Math.min(left, right);
      const later = Math.max(left, right);
      let current = earlier;
      const generate = pinned(() => current, byte);
      const first = generate();
      current = later;
      const second = generate();
      expect(compareBytes(idToBytes(second), idToBytes(first))).toBeGreaterThan(0);
      expect(second > first).toBe(true);
    },
  );

  test.prop([millisecond, fc.integer({ min: 0, max: 0xff })], PROP)(
    'a generated id always matches the canonical pattern the wire publishes',
    (now, byte) => {
      expect(pinned(() => now, byte)()).toMatch(CANONICAL_ID_PATTERN);
    },
  );
});
