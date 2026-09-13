/**
 * The contract every `static`-job check in `scripts/` implements, and the runner that prints it.
 *
 * `scripts/lib/step.ts` is the sibling of this module: a *step* of `pnpm gen` produces an artefact
 * and is judged by whether the bytes changed, while a *check* produces no artefact and is judged by
 * whether it found anything. The workflows run checks directly — `node scripts/<name>.ts` — so the
 * runner here owns the three exit codes the CI lanes rely on, and owns them in one place so ten
 * scripts cannot disagree about what "failed" means:
 *
 * | Exit | Meaning |
 * |---|---|
 * | `0` | the rule holds |
 * | `1` | the rule is broken, and every finding names the file and the remedy |
 * | `2` | the check could not run: a missing argument, a missing input the check does not own |
 *
 * The distinction between `1` and `2` is the one that matters in a lane. A `1` is a red check with a
 * fix in the repository; a `2` says the check never happened, which is the state a silent skip would
 * hide. Nothing here ever returns `0` because an input was absent — a check that cannot see its
 * input says so and exits `2` (10-testing-and-quality.md, "Exclusion hygiene": a gate that silently
 * skips is worse than a red one).
 *
 * **Findings are sorted before printing.** Two runs over the same tree must produce byte-identical
 * output, because the first thing anyone does with a red check is diff it against the last green one.
 */
import { relative } from 'node:path';

import { REPO_ROOT } from './paths.ts';

/** One broken rule: where it is, what is wrong, and what to do about it. */
export interface Finding {
  /** Repository-relative, forward slashes. Absolute paths are converted by `finding()`. */
  readonly file: string;
  /** 1-based, when the finding is about one line of a file. */
  readonly line?: number;
  /** What is wrong, in one sentence, without the remedy. */
  readonly problem: string;
  /** What to do about it, in one sentence. Every finding carries one. */
  readonly remedy: string;
}

/** What a check reports back to the runner. */
export interface CheckResult {
  /** One line, printed on success and on failure. Always says what was examined. */
  readonly summary: string;
  /** Extra lines printed under the summary: counts, skipped comparisons, quoted plan rules. */
  readonly details?: readonly string[];
  /** Every broken rule. An empty list — or none at all — is a pass. */
  readonly findings?: readonly Finding[];
  /**
   * A document written verbatim to stdout.
   *
   * Only `scripts/perf-trend.ts` uses it: its workflow step is
   * `node scripts/perf-trend.ts >> "$GITHUB_STEP_SUMMARY"`, so stdout is the artefact and every
   * diagnostic has to go to stderr. When this is set the runner prints the summary, the details and
   * the findings on stderr instead.
   */
  readonly report?: string;
}

/**
 * Thrown when the check cannot run at all: a missing argument, or an input produced by a step that
 * did not happen. Exits `2`, never `1` — the rule was not evaluated, so calling it broken would be a
 * lie.
 */
export class EnvironmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvironmentError';
  }
}

/** One check, as a module the runner and the tests can both import. */
export interface Check {
  /** The file's own basename, e.g. `check-licenses`. Prefixes every line the runner prints. */
  readonly name: string;
  /** The workflow step that runs it, e.g. ``ci.yml › static › `License scan` ``. */
  readonly workflow: string;
  /** The plan section that owns the rule, printed with a failure so the rule can be read. */
  readonly owns: string;
  run(argv: readonly string[]): CheckResult | Promise<CheckResult>;
}

/** Repository-relative path with forward slashes, for every message a check prints. */
export function repoPath(absolute: string): string {
  return relative(REPO_ROOT, absolute).replaceAll('\\', '/');
}

/** A finding whose `file` is an absolute path. */
export function finding(file: string, problem: string, remedy: string, line?: number): Finding {
  return { file: repoPath(file), problem, remedy, ...(line === undefined ? {} : { line }) };
}

function toStdout(line: string): void {
  console.info(line);
}

function toStderr(line: string): void {
  console.error(line);
}

function order(a: Finding, b: Finding): number {
  return (
    a.file.localeCompare(b.file) ||
    (a.line ?? 0) - (b.line ?? 0) ||
    a.problem.localeCompare(b.problem)
  );
}

/**
 * Run one check as a program: parse `process.argv`, print the result, set the exit code.
 *
 * An unexpected throw is exit `2`, not `1`: a check that crashed did not evaluate the rule, and
 * reporting a crash as a rule violation would send somebody to fix the wrong file.
 */
export async function runAsMain(check: Check): Promise<void> {
  let result: CheckResult;
  try {
    result = await check.run(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof EnvironmentError) {
      console.error(`${check.name}: cannot run.`);
      for (const line of message.split('\n')) console.error(`  ${line}`);
    } else {
      console.error(`${check.name}: FAILED unexpectedly — this is a defect in the check itself.`);
      for (const line of message.split('\n')) console.error(`  ${line}`);
      if (error instanceof Error && error.stack !== undefined) console.error(error.stack);
    }
    console.error(`  Run by ${check.workflow}; the rule is ${check.owns}.`);
    process.exitCode = 2;
    return;
  }

  if (result.report !== undefined) process.stdout.write(result.report);
  // A check whose artefact is stdout keeps stdout clean; everything else reports there.
  const say = result.report === undefined ? toStdout : toStderr;

  const findings = (result.findings ?? []).toSorted(order);
  if (findings.length === 0) {
    say(`${check.name}: ${result.summary}`);
    for (const line of result.details ?? []) say(`  ${line}`);
    return;
  }

  console.error(`${check.name}: ${result.summary}`);
  for (const line of result.details ?? []) console.error(`  ${line}`);
  for (const item of findings) {
    const where = item.line === undefined ? item.file : `${item.file}:${String(item.line)}`;
    console.error(`  ${where}`);
    console.error(`      ${item.problem}`);
    console.error(`      Remedy: ${item.remedy}`);
  }
  console.error(`  ${String(findings.length)} finding(s). The rule is ${check.owns}.`);
  process.exitCode = 1;
}
