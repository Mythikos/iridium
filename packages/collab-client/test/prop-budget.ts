// oxlint-disable typescript/no-unsafe-type-assertion -- the two assertions here read the
// environment without `node` types and narrow one fast-check option string, both of which the
// canonical testkit config does with `process.env` types this package may not depend on.

/**
 * The `PROP` budget for this package's property files.
 *
 * 10-testing-and-quality.md, "Shared policy": pure properties run at `numRuns` 200 on a pull request
 * and 5 000 nightly, raised through `IRIDIUM_PROP_RUNS` and never lowered per file, with
 * `markInterruptAsFailure` so that a suite too slow to finish reports red rather than green.
 *
 * The canonical object lives in `packages/testkit/src/property/config.ts`, which this package may
 * not import: `@iridium/testkit` carries the boundary tag `node` while `@iridium/collab-client` is
 * `iso`, and a spec file may import the testkit only from `apps/server`, `apps/e2e` or
 * `tooling/mutation`. The env keys and the defaults are therefore mirrored here — deliberately, and
 * only here, exactly as `packages/crdt/test/prop-budget.ts` mirrors them for its own package, so
 * that this one still has exactly one definition of its budget and `IRIDIUM_PROP_RUNS` still raises
 * it.
 */
import { VerbosityLevel, type SizeForArbitrary } from 'fast-check';

// `@iridium/collab-client` compiles without `node` types (it must stay isomorphic), so the
// environment is read through `globalThis` rather than through a `process` the package may not know.
const env: Record<string, string | undefined> =
  (globalThis as { readonly process?: { readonly env?: Record<string, string | undefined> } })
    .process?.env ?? {};

/**
 * The fast-check seed, fixed only when `IRIDIUM_PROP_SEED` holds an integer — which the mutation
 * lane sets and no other lane does (`tooling/mutation/stryker.config.mjs`, spike S5).
 * `@fast-check/vitest` writes the seed it drew into the registered test name, and Stryker filters
 * every mutant run by the test names its dry run recorded, so a seed drawn afresh per run leaves
 * each name unmatched and every mutant reported as survived. This package is in that lane's mutate
 * scope (`packages/collab-client/src/save-state.ts`, D10-16), so the same rule applies here. A
 * malformed value is fatal rather than silently ignored, because the failure it causes is a
 * plausible-looking mutation score rather than an error.
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

export const PROP = {
  numRuns: Number(env['IRIDIUM_PROP_RUNS'] ?? 200),
  ...seedFrom(env['IRIDIUM_PROP_SEED']),
  size: (env['IRIDIUM_PROP_SIZE'] ?? '=') as SizeForArbitrary,
  verbose: VerbosityLevel.Verbose,
  markInterruptAsFailure: true,
  interruptAfterTimeLimit: Number(env['IRIDIUM_PROP_INTERRUPT_MS'] ?? 60_000),
};
