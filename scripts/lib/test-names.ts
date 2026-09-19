/**
 * Test names, layers and milestones — the vocabulary `docs/acceptance-map.json` is keyed on.
 *
 * The name grammar is the one `scripts/check-test-name-references.ts` greps for
 * (10-testing-and-quality.md, "Inventory completeness"): `<area>.<subject>.<layer>` with `layer` drawn
 * from the ten legal layers. `docs.spikes.spec` is the single literal exception, fixed by
 * 14-risks-and-open-questions.md D14-11 and recorded as an exception in 12-milestones.md §13.5.
 */

/** The ten legal layer segments of a test name. */
export const LAYER_SEGMENTS: readonly string[] = [
  'unit',
  'component',
  'integration',
  'prop',
  'chaos',
  'contract',
  'mcp',
  'e2e',
  'guard',
  'drill',
];

/**
 * The one name whose layer segment is not in the list above.
 *
 * `docs.spikes.spec` is D14-11's spelling, adopted unchanged by 10-testing-and-quality.md rather than
 * overruled, and carried by the reference checker as a literal exception — widening the alternation
 * with `spec` was rejected because every `*.spec.ts` filename quoted in the plan would then look like
 * a test name.
 */
export const LITERAL_TEST_NAMES: readonly string[] = ['docs.spikes.spec'];

/**
 * `<area>[.<subject>…].<layer>`.
 *
 * **This is deliberately one quantifier wider than the grep 10-testing-and-quality.md prints for
 * `scripts/check-test-name-references.ts`.** That grep is
 * `[a-z][a-z0-9-]*(\.[a-z0-9-]+)+\.(unit|…|drill)`, whose `+` requires at least three
 * dot-separated segments — so it matches `collab.convergence.integration` but not
 * `three-editors.e2e`, and most of the web E2E inventory is exactly that two-segment shape
 * (`saved-indicator.e2e`, `viewer-readonly.e2e`, `vault-isolation.e2e`, `admin.e2e`, …). Those are
 * real names in the plan's own inventories, and the acceptance map is keyed on them, so the builder
 * must recognise them. The `*` here is that correction; the divergence is recorded rather than
 * silently adopted, because the grep as printed leaves every two-segment name unchecked by the
 * reference checker.
 */
const NAME_PATTERN = new RegExp(
  `^[a-z][a-z0-9-]*(?:\\.[a-z0-9-]+)*\\.(?:${LAYER_SEGMENTS.join('|')})$`,
);

/**
 * Code spans that fit the grammar but are not test names.
 *
 * `@fast-check/vitest`'s runner API is `it.prop(...)` and `test.prop(...)` — two segments, the second
 * a legal layer — and the plan quotes it as code wherever it explains how properties are written.
 * Neither is a test, so the checker must know them by name; rewording every mention to dodge the
 * grammar would make the prose worse to keep the grep simple.
 */
export const NOT_TEST_NAMES: readonly string[] = ['it.prop', 'test.prop'];

/** Whether a code span is a test name rather than a file, a flag, an identifier or a runner API. */
export function isTestName(candidate: string): boolean {
  if (NOT_TEST_NAMES.includes(candidate)) return false;
  return NAME_PATTERN.test(candidate) || LITERAL_TEST_NAMES.includes(candidate);
}

/** The layer segment of a test name, or `null` for the literal exception. */
export function layerSegment(name: string): string | null {
  const segment = name.slice(name.lastIndexOf('.') + 1);
  return LAYER_SEGMENTS.includes(segment) ? segment : null;
}

/**
 * The pyramid layer a test runs at (10-testing-and-quality.md, "Testing pyramid").
 *
 * Two segments need a rule rather than a lookup:
 *
 *  - `drill` is L5. The drills live in `apps/server/test/chaos/` by the Location convention and row 9
 *    of the overview requires L5 for a test list that is two `.chaos` files and two `.drill` files.
 *  - `e2e` splits between L6 (web, Playwright `chromium`) and L7 (Electron, Playwright `electron`).
 *    The E2E inventory separates them by directory, and every Electron spec's name begins `desktop.`
 *    with one exception, `release.packaged-smoke.e2e`, which the same inventory lists under Electron.
 *    Both prefixes are therefore L7 and everything else is L6.
 */
export function layerOf(name: string): string {
  if (LITERAL_TEST_NAMES.includes(name)) return 'L1';
  const segment = layerSegment(name);
  switch (segment) {
    case 'unit':
    case 'guard': {
      return 'L1';
    }
    case 'component': {
      return 'L2';
    }
    case 'integration': {
      return 'L3';
    }
    case 'prop': {
      return 'L4';
    }
    case 'chaos':
    case 'drill': {
      return 'L5';
    }
    case 'e2e': {
      return name.startsWith('desktop.') || name.startsWith('release.') ? 'L7' : 'L6';
    }
    case 'contract':
    case 'mcp': {
      return 'L8';
    }
    default: {
      throw new Error(`${name} has no recognised layer segment.`);
    }
  }
}

/** `M0` … `M8` as a number, so milestones can be compared and minimised. */
export function milestoneIndex(milestone: string): number {
  const parsed = /^M(\d+)$/.exec(milestone);
  if (parsed === null) throw new Error(`${milestone} is not a milestone of the form M<n>.`);
  return Number(parsed[1]);
}

/** The earlier of two milestones. */
export function earlierMilestone(a: string, b: string): string {
  return milestoneIndex(a) <= milestoneIndex(b) ? a : b;
}

/** Explicit first-delivery annotation in an inventory assertion, never an incidental milestone mention. */
export function inventoryMilestone(assertion: string): string | undefined {
  const match = /\*\*(M\d+)(?:\s+exit)?\*\*|\b[Ss]ince\s+(M\d+)\b|^\s*(M\d+)\b/.exec(assertion);
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  if (value !== undefined && !/^M[0-8]$/.test(value)) {
    throw new Error(`Unsupported inventory milestone: ${value}`);
  }
  return value;
}
