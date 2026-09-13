// oxlint-disable vitest/no-standalone-expect -- `it.prop(...)(name, fn)` is the
// @fast-check/vitest form of a test block, which this rule does not know about yet.
/**
 * `crdt.prefix-suffix-diff.prop` — the minimal edit behind restore and repair.
 *
 * A version restore and `iridium doctor --repair-content` rewrite a note's text *inside* the live
 * document, because rebuilding it would produce a disjoint identity set that no connected client
 * could reconcile with. The diff is therefore load-bearing twice over: it has to produce exactly the
 * target text, and it has to touch as little as possible, because every untouched unit is a remote
 * cursor or a relative position that survives the operation (05-collaboration-and-durability.md
 * D05-21, "Coordinated version restore").
 */
import { it } from '@fast-check/vitest';
import * as fc from 'fast-check';
import { describe, expect } from 'vitest';

import { lfText } from '../test/arbitraries.ts';
import { PROP } from '../test/prop-budget.ts';
import { createNoteDoc, getContent, projectMarkdown } from './doc.ts';
import { prefixSuffixDiff } from './prefix-suffix-diff.ts';
import { scanHostileContent } from './scan.ts';
import { isHighSurrogate, isLowSurrogate } from './unicode.ts';

const ORIGIN = { source: 'test' };

/** Pairs that actually share a prefix and a suffix, which is the case the diff exists for. */
const relatedPair = fc
  .tuple(lfText(40), lfText(20), lfText(20), lfText(40))
  .map(
    ([prefix, left, right, suffix]) => [prefix + left + suffix, prefix + right + suffix] as const,
  );

/** Pairs with no imposed structure at all. */
const anyPair = fc.tuple(lfText(60), lfText(60)).map(([a, b]) => [a, b] as const);

function applyOnString(current: string, target: string): string {
  const { start, deleteLength, insert } = prefixSuffixDiff(current, target);
  return current.slice(0, start) + insert + current.slice(start + deleteLength);
}

function applyOnText(current: string, target: string): string {
  const doc = createNoteDoc();
  const text = getContent(doc);
  doc.transact(() => {
    text.insert(0, current);
  }, ORIGIN);

  const { start, deleteLength, insert } = prefixSuffixDiff(current, target);
  doc.transact(() => {
    if (deleteLength > 0) text.delete(start, deleteLength);
    if (insert.length > 0) text.insert(start, insert);
  }, ORIGIN);

  expect(scanHostileContent(doc)).toStrictEqual({ ok: true });
  return projectMarkdown(doc);
}

/** Does the text hold a surrogate that is not part of a pair? Neither input ever does. */
function hasLoneSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    if (isLowSurrogate(unit)) return true;
    if (isHighSurrogate(unit)) {
      if (index + 1 >= text.length || !isLowSurrogate(text.charCodeAt(index + 1))) return true;
      index++;
    }
  }
  return false;
}

/** The longest common prefix and suffix, computed independently of the implementation. */
function commonBounds(a: string, b: string): { prefix: number; suffix: number } {
  const shortest = Math.min(a.length, b.length);
  let prefix = 0;
  while (prefix < shortest && a.charCodeAt(prefix) === b.charCodeAt(prefix)) prefix++;
  let suffix = 0;
  while (
    suffix < shortest - prefix &&
    a.charCodeAt(a.length - 1 - suffix) === b.charCodeAt(b.length - 1 - suffix)
  ) {
    suffix++;
  }
  return { prefix, suffix };
}

describe('crdt.prefix-suffix-diff.prop [area:contracts]', () => {
  it.prop([relatedPair], PROP)('applied to the original text yields the target', ([a, b]) => {
    expect(applyOnString(a, b)).toBe(b);
    expect(applyOnText(a, b)).toBe(b);
  });

  it.prop([anyPair], PROP)('applied to an unrelated text yields the target too', ([a, b]) => {
    expect(applyOnString(a, b)).toBe(b);
    expect(applyOnText(a, b)).toBe(b);
  });

  it.prop([relatedPair], PROP)('touches only the minimal differing range', ([a, b]) => {
    fc.pre(a !== b);
    const { start, deleteLength } = prefixSuffixDiff(a, b);
    const bounds = commonBounds(a, b);
    const keptSuffix = a.length - start - deleteLength;

    // Never claims more than the texts actually share, and gives up at most one code unit of each
    // to keep a surrogate pair whole.
    expect(start).toBeLessThanOrEqual(bounds.prefix);
    expect(start).toBeGreaterThanOrEqual(bounds.prefix - 1);
    expect(keptSuffix).toBeLessThanOrEqual(bounds.suffix);
    expect(keptSuffix).toBeGreaterThanOrEqual(bounds.suffix - 1);
  });

  it.prop([lfText()], PROP)('is empty for identical texts', (text) => {
    expect(prefixSuffixDiff(text, text)).toStrictEqual({ start: 0, deleteLength: 0, insert: '' });
  });

  it.prop([relatedPair], PROP)('is empty exactly when the texts are identical', ([a, b]) => {
    const { deleteLength, insert } = prefixSuffixDiff(a, b);
    expect(deleteLength === 0 && insert === '').toBe(a === b);
  });

  it.prop([relatedPair], PROP)(
    'never emits an attribute, a carriage return or half a surrogate pair',
    ([a, b]) => {
      const { start, deleteLength, insert } = prefixSuffixDiff(a, b);

      expect(insert.includes('\r')).toBe(false);
      expect(hasLoneSurrogate(insert)).toBe(false);
      expect(hasLoneSurrogate(a.slice(start, start + deleteLength))).toBe(false);
    },
  );

  it('splits neither the deletion nor the insertion inside a surrogate pair', () => {
    const grinning = '\u{1f600}';
    const beaming = '\u{1f601}';

    expect(prefixSuffixDiff(`x${grinning}`, `x${beaming}`)).toStrictEqual({
      start: 1,
      deleteLength: 2,
      insert: beaming,
    });
    expect(prefixSuffixDiff(`${grinning}x`, `${beaming}x`)).toStrictEqual({
      start: 0,
      deleteLength: 2,
      insert: beaming,
    });
    expect(applyOnText(`a${grinning}b`, `a${beaming}b`)).toBe(`a${beaming}b`);
  });
});
