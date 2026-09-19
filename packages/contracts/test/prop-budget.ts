/**
 * The `PROP` budget for this package's pure property files (10-testing-and-quality.md,
 * "Shared policy": 200 runs on a pull request, 5 000 nightly, and a truncated run is a failure).
 *
 * `packages/testkit/src/property/config.ts` is where the budget lives for every package that may
 * depend on the testkit. `@iridium/contracts` is tagged `core` and may not — the testkit is a
 * `node` package and is a `devDependency` of `apps/server`, `apps/e2e` and `tooling/mutation`
 * only — so the two numbers are mirrored here rather than imported. They are read from the same
 * environment variables, so a nightly run raises both together.
 *
 * This file lives under `test/` rather than `src/` so it is dev-only for `knip --production` and
 * outside the coverage `include` globs, while the property files themselves stay co-located under
 * `src/` where the `unit` project collects them.
 */

import * as fc from 'fast-check';

/**
 * The environment, declared rather than cast off `globalThis`: this package pulls in no Node
 * types, and a `typeof` guard on an ambient declaration is a real check where a cast would not be.
 */
declare const process: { readonly env?: Record<string, string | undefined> } | undefined;

const env: Record<string, string | undefined> =
  typeof process === 'undefined' ? {} : (process.env ?? {});

/**
 * The fast-check seed, fixed only when `IRIDIUM_PROP_SEED` holds an integer — which the mutation
 * lane sets and no other lane does (`tooling/mutation/stryker.config.mjs`, spike S5).
 * `@fast-check/vitest` writes the seed it drew into the registered test name, and Stryker filters
 * every mutant run by the test names its dry run recorded, so a seed drawn afresh per run leaves
 * each name unmatched, each mutant untested and each mutant reported as survived. A malformed value
 * is fatal rather than silently ignored, because the failure it causes is a plausible-looking
 * mutation score rather than an error. Unset, the seed stays fresh per run, which is what the
 * ordinary lanes want and what keeps the property search a search.
 */
function seedFrom(raw: string | undefined): { readonly seed?: number } {
  if (raw === undefined) {
    return {};
  }
  const seed = Number(raw);
  if (!Number.isInteger(seed)) {
    throw new Error(`IRIDIUM_PROP_SEED must be an integer; received "${raw}".`);
  }
  return { seed };
}

/** Pure properties: CPU only, so the budget is runs rather than commands. */
export const PROP = {
  numRuns: Number(env['IRIDIUM_PROP_RUNS'] ?? 200),
  ...seedFrom(env['IRIDIUM_PROP_SEED']),
  verbose: fc.VerbosityLevel.Verbose,
  /** A truncated run is a failure, never a silent pass. */
  markInterruptAsFailure: true,
  interruptAfterTimeLimit: Number(env['IRIDIUM_PROP_INTERRUPT_MS'] ?? 60_000),
} as const;

/**
 * The generation size for string arbitraries. In fast-check 4 `size` is a property of the
 * arbitrary rather than of the run parameters, so it is exported separately and passed where it
 * applies.
 */
const SIZES: Record<string, fc.SizeForArbitrary> = {
  xsmall: 'xsmall',
  small: 'small',
  medium: 'medium',
  large: 'large',
  xlarge: 'xlarge',
  max: 'max',
  '=': '=',
  '+1': '+1',
  '+2': '+2',
  '-1': '-1',
};

export const PROP_SIZE: fc.SizeForArbitrary = SIZES[env['IRIDIUM_PROP_SIZE'] ?? '='] ?? '=';

const codePoint = (value: number): string => String.fromCodePoint(value);

/**
 * The curated alphabet Unicode bugs actually live in: separators, dots, control characters, a
 * BOM, a combining mark, an astral pair, an RTL mark and Markdown sigils, alongside plain
 * letters. Every entry is built with `String.fromCodePoint` so the file itself stays printable.
 */
export const HOSTILE_CHARACTERS: readonly string[] = [
  'a',
  'Z',
  '0',
  ' ',
  '.',
  '/',
  '\\',
  codePoint(0x00), // NUL
  codePoint(0x09), // tab
  codePoint(0x0a), // line feed
  codePoint(0x0d), // carriage return
  codePoint(0x1f), // unit separator
  codePoint(0x7f), // delete
  codePoint(0xa0), // no-break space
  codePoint(0xfe_ff), // byte order mark
  codePoint(0x20_0f), // right-to-left mark
  codePoint(0x1_f6_00), // an astral code point, so surrogate pairs appear
  '%',
  '2',
  'F',
  'é', // NFC
  `e${codePoint(0x03_01)}`, // the same letter in NFD
  '#',
  '*',
  '_',
  '[',
  ']',
  'ß',
  'CON',
  'COM9',
];

/** A string built from the hostile alphabet, bounded so generation never blows the budget. */
export function hostileString(maxLength = 24): fc.Arbitrary<string> {
  return fc
    .array(fc.constantFrom(...HOSTILE_CHARACTERS), { maxLength, size: PROP_SIZE })
    .map((parts) => parts.join(''));
}
