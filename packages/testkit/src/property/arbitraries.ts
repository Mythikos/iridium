/**
 * The shared arbitraries the server's property suites draw from
 * (10-testing-and-quality.md, "Property and model suites" → *Shared policy*).
 *
 * The policy sentence is the specification for this module: *"string arbitraries that feed the
 * Markdown pipeline use `fc.string({ unit: 'grapheme' })` plus a curated alphabet including CR, LF,
 * BOM, tab, NUL, combining marks, surrogate pairs, RTL marks and Markdown sigils"*, because
 * *"Unicode bugs are the realistic bugs; unbounded generation blows the timeout"*. Both halves matter:
 * a purely random grapheme string almost never produces a CRLF pair, a BOM in the middle of a line or
 * a `[`…`](` sequence, and those are exactly the inputs the normalizer, the sanitizer and the
 * `\r`-free `Y.Text` invariant are written against.
 *
 * Size is always bounded and always stated: every arbitrary here takes its generation size from
 * `PROP_SIZE`, so `IRIDIUM_PROP_SIZE` raises the whole suite together and no file quietly grows its
 * own inputs.
 */

import * as fc from 'fast-check';

import { PROP_SIZE } from './config.ts';

/**
 * The curated alphabet, grouped by what each group is there to break. Each member is one unit a
 * generated string may be built from, so a group's characters appear adjacent to each other and to
 * ordinary graphemes — which is where the interesting failures live.
 */
const LINE_ENDINGS = ['\r', '\n', '\r\n'] as const;

/** `U+FEFF` anywhere but position 0 is a zero-width no-break space, not a BOM (08 §"Normalize"). */
const INVISIBLES = ['﻿', '\t', '\0', ' ', '​', ' ', ' '] as const;

/** Bidirectional controls: a note that renders differently from its source is a security finding. */
const BIDI_MARKS = ['‎', '‏', '‪', '‫', '‬', '‭', '‮'] as const;

/** Combining marks and a pre-composed twin, so normalisation differences are generated. */
const COMBINING = ['́', '̈', '̧', 'é', 'é'] as const;

/** Astral code points as surrogate pairs, and the lone halves the import boundary refuses. */
const SURROGATES = ['😀', '𝄞', '👨‍👩‍👧‍👦', '\uD83D', '\uDE00'] as const;

/** The characters that start a Markdown construct, which is what makes a parser disagree. */
const MARKDOWN_SIGILS = [
  '#',
  '*',
  '_',
  '`',
  '~',
  '[',
  ']',
  '(',
  ')',
  '<',
  '>',
  '|',
  '-',
  '+',
  '!',
  '\\',
  '&',
  '"',
  "'",
  ':',
  '---',
  '```',
  '- [ ]',
  '[[',
  ']]',
  '$$',
  '%%',
  '==',
] as const;

/**
 * The curated alphabet in full, frozen so a suite cannot append to it and quietly change every
 * other suite's inputs.
 */
export const HOSTILE_UNITS: readonly string[] = Object.freeze([
  ...LINE_ENDINGS,
  ...INVISIBLES,
  ...BIDI_MARKS,
  ...COMBINING,
  ...SURROGATES,
  ...MARKDOWN_SIGILS,
]);

/** The same alphabet with every carriage return removed — the unit set `noteText()` draws from. */
const LF_ONLY_UNITS: readonly string[] = Object.freeze(
  HOSTILE_UNITS.filter((unit) => !unit.includes('\r')),
);

/** How much of a generated string is drawn from the curated alphabet rather than from graphemes. */
const CURATED_WEIGHT = 1;
const GRAPHEME_WEIGHT = 3;

/** One grapheme, which is the `unit: 'grapheme'` half of the policy. */
const oneGrapheme: fc.Arbitrary<string> = fc.string({
  unit: 'grapheme',
  minLength: 1,
  maxLength: 1,
});

function unitArbitrary(units: readonly string[]): fc.Arbitrary<string> {
  const [first, ...rest] = units;
  if (first === undefined) {
    throw new Error('@iridium/testkit: a hostile alphabet needs at least one unit');
  }
  return fc.oneof(
    { weight: GRAPHEME_WEIGHT, arbitrary: oneGrapheme },
    { weight: CURATED_WEIGHT, arbitrary: fc.constantFrom(first, ...rest) },
  );
}

/** What every string arbitrary here accepts. Bounds are the caller's; the size default is shared. */
export interface HostileStringOptions {
  readonly minLength?: number;
  readonly maxLength?: number;
  /** Defaults to `PROP_SIZE`, so `IRIDIUM_PROP_SIZE` moves every suite at once. */
  readonly size?: fc.SizeForArbitrary;
}

function stringFrom(units: readonly string[], options: HostileStringOptions): fc.Arbitrary<string> {
  return fc.string({
    unit: unitArbitrary(units),
    size: options.size ?? PROP_SIZE,
    ...(options.minLength === undefined ? {} : { minLength: options.minLength }),
    ...(options.maxLength === undefined ? {} : { maxLength: options.maxLength }),
  });
}

/**
 * A string mixing ordinary graphemes with the curated alphabet: the input every Markdown-facing
 * property (normalize/restore round trips, sanitization, projection) is generated from.
 *
 * It **can** contain a carriage return, a NUL and a lone surrogate, because refusing those is the
 * behaviour under test. Anything that writes into `Y.Text` wants `noteText()` instead.
 */
export function hostileString(options: HostileStringOptions = {}): fc.Arbitrary<string> {
  return stringFrom(HOSTILE_UNITS, options);
}

/**
 * A hostile string with no carriage return, for anything that inserts into a note's `Y.Text`.
 *
 * `\r` never reaches the CRDT: line endings are normalised once at import and restored on export
 * (principle 5, `collab.lf-invariant.guard`), so a generator that produced one would be generating
 * a state the product refuses rather than a state it must survive.
 */
export function noteText(options: HostileStringOptions = {}): fc.Arbitrary<string> {
  return stringFrom(LF_ONLY_UNITS, options);
}

/** One insertion into a note: a position expressed as a fraction of the current length, and text. */
export interface TextInsertion {
  /** `0` is the start of the document, `1` its end; the caller scales it to the live length. */
  readonly at: number;
  readonly text: string;
}

/**
 * An insertion for the convergence and persistence models: a relative position plus `\r`-free text.
 *
 * The position is relative because a model command is generated before the document it applies to
 * exists — an absolute offset would be out of range for most of the runs that generated it, and a
 * pre-condition that skips those runs is how a property quietly stops testing anything.
 */
export function textInsertion(options: HostileStringOptions = {}): fc.Arbitrary<TextInsertion> {
  return fc.record({
    at: fc.double({ min: 0, max: 1, noNaN: true }),
    text: noteText({ minLength: 1, ...options }),
  });
}
