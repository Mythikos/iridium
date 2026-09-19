/**
 * The two property budgets (10-testing-and-quality.md, "Property and model suites" → "Shared policy").
 *
 * Two budgets, because the two cost classes differ by three orders of magnitude per run: a pure
 * property is CPU only, a DB-backed model command is a MySQL round trip. `PROP` is for
 * `*.prop.spec.ts` in the `unit` project (pure logic and the in-memory model mirrors); `PROP_DB` is
 * for `apps/server/test/property/**`, the same models driven against real MySQL. A file picks the
 * one its cost class dictates and never overrides a number downward.
 *
 * Packages that cannot depend on the testkit — `@iridium/contracts` is tagged `core` and
 * `@iridium/crdt` `iso`, while this package is `node` — carry a mirror of `PROP` in
 * `packages/<pkg>/test/prop-budget.ts`. The mirrors read the same environment variables, so a
 * nightly run raises every budget together.
 */

import * as fc from 'fast-check';

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

/**
 * The generation size for string arbitraries. In fast-check 4 `size` is a property of the
 * arbitrary rather than of the run parameters, so it is exported separately and passed where it
 * applies (`fc.string({ size: PROP_SIZE })`).
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

export const PROP_SIZE: fc.SizeForArbitrary = SIZES[process.env['IRIDIUM_PROP_SIZE'] ?? '='] ?? '=';

/**
 * The budget's own type, declared here rather than borrowed as `fc.Parameters<unknown>`.
 *
 * `fc.Parameters<T>` is generic in the tuple the property generates, through exactly two members —
 * `examples?: T[]` and `reporter?: (details: RunDetails<T>) => void`. A budget annotated
 * `fc.Parameters<unknown>` therefore cannot be handed to `test.prop([a, b])(…, PROP)`, whose
 * parameter is `fc.Parameters<[A, B]>`: under `strictFunctionTypes` the reporter is contravariant
 * and under `exactOptionalPropertyTypes` `unknown[]` is not an `[A, B][]`. Naming only the members
 * the budget actually sets — none of them generic — makes one `PROP` assignable to every
 * `fc.Parameters<Ts>`, which is what lets a property file pass it straight through.
 * `isolatedDeclarations` forbids relying on inference here, so the type is written out.
 */
export interface PropertyBudget {
  /** Present only when `IRIDIUM_PROP_SEED` is set (the mutation lane; spike S5). */
  readonly seed?: number;
  readonly verbose: fc.VerbosityLevel;
  readonly markInterruptAsFailure: boolean;
  readonly numRuns: number;
  readonly interruptAfterTimeLimit: number;
}

const shared = {
  ...seedFrom(process.env['IRIDIUM_PROP_SEED']),
  /** Every failure prints the seed, the path and the shrunk counterexample, replayable verbatim. */
  verbose: fc.VerbosityLevel.Verbose,
  /**
   * The load-bearing line. With `false`, fast-check abandons the run at the time limit and reports
   * success if it has not yet found a counterexample; a truncated run is a failure, never a silent
   * pass.
   */
  markInterruptAsFailure: true,
} as const;

/** `*.prop.spec.ts` in the `unit` project: pure logic and the in-memory model mirrors. */
export const PROP: PropertyBudget = {
  ...shared,
  /** PR 200, nightly 5 000 (`nightly.yml` sets the variable). */
  numRuns: Number(process.env['IRIDIUM_PROP_RUNS'] ?? 200),
  interruptAfterTimeLimit: Number(process.env['IRIDIUM_PROP_INTERRUPT_MS'] ?? 60_000),
};

/**
 * The DB-backed budget: fast-check's run parameters plus the command bound that `fc.commands` takes
 * separately (`fc.commands(arbitraries, { maxCommands: PROP_DB.maxCommands })`).
 */
export interface DbPropertyBudget extends PropertyBudget {
  readonly maxCommands: number;
}

/** `apps/server/test/property/**`: the same models driven against real MySQL. */
export const PROP_DB: DbPropertyBudget = {
  ...shared,
  /** M1 exit: PR 200, nightly 5 000 (12-milestones.md section 5.4). */
  numRuns: Number(process.env['IRIDIUM_PROP_DB_RUNS'] ?? 200),
  /** PR 60, nightly 300 — passed to `fc.commands` as `maxCommands`, always bounded and stated. */
  maxCommands: Number(process.env['IRIDIUM_PROP_DB_COMMANDS'] ?? 60),
  interruptAfterTimeLimit:
    Number(process.env['IRIDIUM_PROP_DB_RUNS'] ?? 200) > 200 ? 3_600_000 : 600_000,
};
