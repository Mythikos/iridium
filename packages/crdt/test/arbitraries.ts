/**
 * The text and edit generators the package's property files share.
 *
 * 10-testing-and-quality.md, "Shared policy": a string arbitrary that feeds the Markdown pipeline
 * uses a curated alphabet including CR, LF, BOM, tab, NUL, combining marks, surrogate pairs, RTL
 * marks and Markdown sigils, because Unicode bugs are the realistic bugs. Two alphabets are exported
 * rather than one: the LF-only alphabet is what a normalised note may contain, and the hostile one
 * adds exactly the characters `normalizeSource()` removes, so a guard test can generate the input
 * the guard exists for.
 */
import * as fc from 'fast-check';

/** Markdown sigils, whitespace and LF — everything a normalised note may hold, in ASCII. */
const ASCII_UNITS = [
  'a',
  'b',
  'Z',
  '0',
  ' ',
  '\t',
  '\n',
  '#',
  '*',
  '_',
  '`',
  '[',
  ']',
  '(',
  ')',
  '|',
  '>',
  '-',
  '!',
  '\\',
];

/** Combining marks, RTL marks, CJK and astral-plane code points (surrogate pairs when encoded). */
const UNICODE_UNITS = [
  '\u00e9', // e with acute
  '\u0301', // combining acute accent
  '\u200f', // right-to-left mark
  '\u00a0', // no-break space
  '\u6f22', // CJK
  '\u5b57', // CJK
  '\u3042', // hiragana
  '\ufeff', // zero-width no-break space: a BOM only at offset 0
  '\u{1f600}', // astral: grinning face
  '\u{1d11e}', // astral: G clef
];

/** The alphabet of a normalised note: LF-only, never a carriage return, never a NUL. */
export const LF_UNITS: readonly string[] = [...ASCII_UNITS, ...UNICODE_UNITS];

/** The alphabet plus everything `normalizeSource()` removes before text reaches a `Y.Doc`. */
export const HOSTILE_UNITS: readonly string[] = [...LF_UNITS, '\r', '\u0000'];

/** Text drawn from `LF_UNITS`, sized in code points rather than UTF-16 units. */
export function lfText(maxLength = 60): fc.Arbitrary<string> {
  return fc.string({ unit: fc.constantFrom(...LF_UNITS), maxLength });
}

/** Text that may contain a carriage return, a BOM or a NUL. */
export function hostileText(maxLength = 60): fc.Arbitrary<string> {
  return fc.string({ unit: fc.constantFrom(...HOSTILE_UNITS), maxLength });
}

/** One edit in a generated session: an insertion at a position, or a deletion of a range. */
export type Edit =
  | { readonly kind: 'insert'; readonly at: number; readonly text: string }
  | { readonly kind: 'delete'; readonly at: number; readonly length: number };

/** A sequence of edits; `at` is clamped to the current length when the edit is applied. */
export function edits(maxEdits = 12): fc.Arbitrary<Edit[]> {
  return fc.array(
    fc.oneof(
      fc.record({
        kind: fc.constant<'insert'>('insert'),
        at: fc.nat({ max: 4096 }),
        text: lfText(24),
      }),
      fc.record({
        kind: fc.constant<'delete'>('delete'),
        at: fc.nat({ max: 4096 }),
        length: fc.nat({ max: 24 }),
      }),
    ),
    { maxLength: maxEdits },
  );
}
