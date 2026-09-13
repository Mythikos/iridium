/**
 * The step contract every generator in `scripts/` implements, and the runner `scripts/gen.ts` uses.
 *
 * A step is a function, not a script, so the pipeline can run the ordered sequence in one process
 * (12-milestones.md §4.3 fixes that order and its reason: the acceptance map is generated last
 * because it references the operation and tool names the earlier steps emit). Each module also has a
 * `main` entry so it can be run on its own while it is being worked on — `node scripts/<name>.ts` —
 * which is what makes a failing step debuggable without re-running the whole pipeline.
 *
 * `--check` is the same code path with the write suppressed (10-testing-and-quality.md, "Inventory
 * completeness"): the step computes exactly the same bytes and reports whether they differ from the
 * committed file, so a contributor sees the artefact named before `gen.drift.guard` reports the
 * diff.
 */
import type { WriteOutcome } from './write.ts';

/** What every step is told about the run. */
export interface StepContext {
  /** `--check`: compute the artefact, compare, write nothing. */
  readonly check: boolean;
  /**
   * `--skip-db` / `IRIDIUM_GEN_SKIP_DB=1`: do not start a MySQL container.
   *
   * Only the kysely-codegen comparison needs one. It writes no artefact — `schema.ts` is
   * hand-written by design — so skipping it cannot change what `git diff --exit-code` sees; what it
   * does change is whether the comparison ran, which is why the skip is loud and named in the
   * summary rather than silent. The same invariant is asserted on both merge-blocking MySQL matrix
   * entries by `migrations.integration`.
   */
  readonly skipDatabase: boolean;
}

/** What a step reports back to the runner. */
export interface StepResult {
  /** One line for the pipeline summary. Present even when nothing changed. */
  readonly summary: string;
  /** Every artefact the step wrote or would have written. */
  readonly writes?: readonly WriteOutcome[];
  /** Set when the step did not do its work, and why. A skipped step is never silent. */
  readonly skipped?: string;
  /** Extra lines printed under the summary, for a comparison that found differences worth naming. */
  readonly details?: readonly string[];
}

/** One ordered step of `pnpm gen`. */
export interface Step {
  /** The name used in the summary and in failure messages. */
  readonly name: string;
  /** What the step produces, for the summary header. */
  readonly produces: string;
  /**
   * The steps whose output this one reads, by name.
   *
   * The pipeline runs in the plan's order and does **not** stop at the first failure: a step that
   * depends on nothing broken still runs, because `pnpm gen` exists to regenerate committed artefacts
   * and a missing tool in one step is no reason to leave seven others stale. A step whose dependency
   * failed is blocked rather than run, so nobody reads a second, derived failure instead of the first
   * real one. The run still exits non-zero.
   */
  readonly dependsOn?: readonly string[];
  run(context: StepContext): Promise<StepResult>;
}

/** Parse the flags every step script accepts. */
export function parseContext(argv: readonly string[]): StepContext {
  return {
    check: argv.includes('--check'),
    skipDatabase: argv.includes('--skip-db') || process.env['IRIDIUM_GEN_SKIP_DB'] === '1',
  };
}

/**
 * Run one step as a standalone program: parse `process.argv`, print the result, exit non-zero on a
 * failure or on a `--check` difference.
 */
export async function runAsMain(step: Step): Promise<void> {
  const context = parseContext(process.argv.slice(2));
  try {
    const result = await step.run(context);
    if (result.skipped !== undefined) {
      console.warn(`- ${step.name}: SKIPPED — ${result.skipped}`);
      return;
    }
    console.info(`- ${step.name}: ${result.summary}`);
    for (const line of result.details ?? []) console.info(`    ${line}`);
    const changed = (result.writes ?? []).filter((write) => write.changed);
    if (context.check && changed.length > 0) {
      for (const write of changed) console.error(`  ${write.path} is out of date`);
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(`- ${step.name}: FAILED`);
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
