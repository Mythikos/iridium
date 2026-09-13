// oxlint-disable vitest/no-standalone-expect -- `test.prop(...)(name, fn)` is the
// @fast-check/vitest form of a test block, which this rule does not know about yet.

import { test } from '@fast-check/vitest';
import * as fc from 'fast-check';
import { describe, expect } from 'vitest';

import { hostileString, PROP } from '../test/prop-budget.ts';
import { LIMITS } from './limits.ts';
import {
  checkNodeName,
  hasControlCharacter,
  isSafeNodeName,
  joinPath,
  RESERVED_DEVICE_NAMES,
  safePath,
  utf8ByteLength,
  type NameRejection,
} from './paths.ts';

/** Rejections that no case, separator or encoding trick can turn into an acceptance. */
const STRUCTURAL: ReadonlySet<NameRejection> = new Set([
  'separator',
  'control_character',
  'lone_surrogate',
  'dot_segment',
  'leading_space_or_dot',
  'trailing_space_or_dot',
  'reserved_device_name',
]);

function reasonOf(name: string): NameRejection | null {
  const check = checkNodeName(name);
  return check.ok ? null : check.reason;
}

/** Names as the world supplies them: hostile alphabet, plain text, and the device names. */
const anyName = fc.oneof(
  hostileString(),
  fc.string({ maxLength: 40 }),
  fc.constantFrom(...RESERVED_DEVICE_NAMES),
);

describe('contracts.paths.prop [spec:structural-concurrency]', () => {
  test.prop([anyName], PROP)('accepts only names the tree can store', (name) => {
    if (!isSafeNodeName(name)) {
      expect(reasonOf(name)).not.toBeNull();
      return;
    }
    expect(name.length).toBeGreaterThan(0);
    expect(name.normalize('NFC')).toBe(name);
    expect(utf8ByteLength(name)).toBeLessThanOrEqual(LIMITS.NODE_NAME_MAX_BYTES);
    expect(name.includes('/')).toBe(false);
    expect(name.includes('\\')).toBe(false);
    expect(hasControlCharacter(name)).toBe(false);
    expect(name === '.' || name === '..').toBe(false);
    expect(/^[\s.]/.test(name)).toBe(false);
    expect(/[\s.]$/.test(name)).toBe(false);
    expect(RESERVED_DEVICE_NAMES).not.toContain((name.split('.')[0] ?? '').toUpperCase());
  });

  test.prop([anyName], PROP)(
    'the rejected set is closed under case, so a device name cannot be shouted through',
    (name) => {
      const reason = reasonOf(name);
      fc.pre(reason !== null && STRUCTURAL.has(reason));
      expect(isSafeNodeName(name.toUpperCase())).toBe(false);
      expect(isSafeNodeName(name.toLowerCase())).toBe(false);
    },
  );

  test.prop([anyName], PROP)('the rejected set is closed under Unicode normalisation', (name) => {
    fc.pre(!isSafeNodeName(name));
    expect(isSafeNodeName(name.normalize('NFD'))).toBe(false);
    expect(isSafeNodeName(name.normalize('NFKD'))).toBe(false);
  });

  test.prop([anyName], PROP)('the rejected set is closed under percent-encoding', (name) => {
    fc.pre(!isSafeNodeName(name));
    let encoded: string;
    try {
      encoded = encodeURIComponent(name);
    } catch {
      // A lone surrogate cannot be percent-encoded at all, so there is no transformation to close
      // over: the name is refused before any encoding is attempted.
      expect(reasonOf(name)).toBe('lone_surrogate');
      return;
    }
    expect(isSafeNodeName(encoded)).toBe(false);
  });

  test.prop([anyName, fc.constantFrom('/', '\\', '.', ' ', String.fromCodePoint(0))], PROP)(
    'appending a separator, a control character, a dot or a space always refuses',
    (name, suffix) => {
      expect(isSafeNodeName(`${name}${suffix}`)).toBe(false);
      expect(isSafeNodeName(`${suffix}${name}`)).toBe(false);
    },
  );

  test.prop([fc.array(anyName, { minLength: 1, maxLength: 8 })], PROP)(
    'a path is safe exactly when every name it splits into is storable',
    (parts) => {
      const path = joinPath(parts);
      // The authority is the path, not the array it was built from: a part that itself contains a
      // separator re-splits, which is precisely why `safePath` re-derives the segments.
      const segments = path.split('/');
      const expected =
        !path.startsWith('/') &&
        segments.length <= LIMITS.TREE_MAX_DEPTH &&
        segments.every((segment) => isSafeNodeName(segment));
      const check = safePath(path);
      expect(check.ok).toBe(expected);
      if (check.ok) expect(check.segments).toStrictEqual(segments);
    },
  );

  test.prop([fc.integer({ min: 1, max: 200 })], PROP)(
    'a path deeper than TREE_MAX_DEPTH is refused',
    (depth) => {
      const segments = Array.from({ length: depth }, (_unused, index) => `n${String(index)}`);
      const check = safePath(joinPath(segments));
      expect(check.ok).toBe(depth <= LIMITS.TREE_MAX_DEPTH);
    },
  );
});
