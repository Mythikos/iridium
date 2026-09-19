/**
 * `scripts/check-load-budget.ts` — run by ``nightly.yml › load › `Budget check against the
 * baseline` ``, immediately after ``k6 run apps/server/test/load/scenarios.js``.
 *
 * The rule is 10-testing-and-quality.md, "Server and collaboration SLOs" and its "Result handling"
 * paragraph, with decision D10-14:
 *
 * > Each nightly run writes `reports/load/<date>-<runner-class>.json` (k6 summary export) and is
 * > compared against `apps/server/test/load/baseline.json`: a threshold breach fails the job; a p95
 * > regression greater than 20 % against the baseline with no threshold breach fails the job with a
 * > "regression" message; an improvement greater than 20 % prints a reminder to re-baseline. The
 * > baseline is updated only by an explicit commit with the run artifact attached, never
 * > automatically.
 *
 * The `load` job is enabled at M8, when its generator and committed baseline are due. A nightly
 * exit rehearsal can target M8 without changing CURRENT. If this script is invoked directly before
 * those inputs exist, it reports the missing evidence rather than treating an empty run as a pass:
 *
 *  - **No summary in `reports/load/`** → exit `2`, naming the step that produces one. The rule was
 *    not evaluated, and saying so is the only honest report.
 *  - **No `apps/server/test/load/baseline.json`** → the SLO thresholds are still enforced, in full,
 *    and the regression comparison is reported as not performed with the milestone that commits the
 *    baseline (D10-14). A load lane that passed because it had nothing to compare against would be
 *    the worst of the three outcomes.
 *
 * ## The thresholds are enforced here as well as in k6
 *
 * `scenarios.js` declares k6 `thresholds`, and k6 fails its own run on a breach. This script
 * re-evaluates the SLO table anyway, from the numbers below, for two reasons: a metric the generator
 * forgot to declare a threshold for would otherwise pass silently, and "a budget with no measurement
 * is not a budget" — a budgeted metric absent from the summary is a finding, not an omission. Where
 * the summary *does* carry k6's own threshold verdicts, a failed one is reported too, so the job says
 * which threshold expression broke rather than only which number was over.
 *
 * Four rows of the SLO table are deliberately **not** checked here: server RSS,
 * `collab_writer_backlog`, `collab_persist_failures_total` and MySQL `Innodb_row_lock_waits`. The
 * table's own "Measured by" column sources them from `/metrics` and `SHOW GLOBAL STATUS` rather than
 * from the k6 summary, so they are the load scenario's assertions to make, not this file's.
 *
 * ## The two file shapes
 *
 * The summary is k6's `--summary-export` JSON: `metrics.<name>.values["p(95)"]`, `.rate`, `.count`,
 * and an optional `metrics.<name>.thresholds`. The baseline is
 *
 * ```json
 * { "runnerClass": "ubuntu-latest", "gitSha": "…", "recordedAt": "2027-01-01",
 *   "metrics": { "ws_connecting": { "p95": 412.3 } } }
 * ```
 *
 * — one file, carrying the runner class it was recorded on, because "the runner class is recorded
 * with every result, and a budget is only compared against results from the same class". A summary
 * from a different class still has its thresholds enforced and is reported as not compared.
 */
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import {
  EnvironmentError,
  finding,
  repoPath,
  runAsMain,
  type Check,
  type CheckResult,
  type Finding,
} from './lib/check.ts';
import { filesWithSuffix, isFile } from './lib/files.ts';
import { isRecord, parseJson, stringMember } from './lib/json.ts';
import { CHECK_INPUTS, REPORTS_ROOT } from './lib/paths.ts';

/** Which statistic of a metric the budget is stated over. */
type Statistic = 'p95' | 'rate' | 'count';

/** One row of the SLO table that the k6 summary carries. */
interface Budget {
  readonly metric: string;
  readonly statistic: Statistic;
  /** `below`: the value must be under `limit`. `atLeast`: at or above. `exactly`: equal. */
  readonly bound: 'below' | 'atLeast' | 'exactly';
  readonly limit: number;
  readonly stated: string;
}

/** The SLO table of 10-testing-and-quality.md, "Server and collaboration SLOs" (M8 gate). */
const BUDGETS: readonly Budget[] = [
  { metric: 'ws_connecting', statistic: 'p95', bound: 'below', limit: 500, stated: 'p95 < 500 ms' },
  {
    metric: 'yjs_propagation_ms',
    statistic: 'p95',
    bound: 'below',
    limit: 250,
    stated: 'p95 < 250 ms',
  },
  { metric: 'durable_ack_ms', statistic: 'p95', bound: 'below', limit: 1000, stated: 'p95 < 1 s' },
  {
    metric: 'projection_lag_ms',
    statistic: 'p95',
    bound: 'below',
    limit: 12_000,
    stated: 'p95 < 12 s',
  },
  {
    metric: 'mcp_get_note_ms',
    statistic: 'p95',
    bound: 'below',
    limit: 300,
    stated: 'p95 < 300 ms',
  },
  {
    metric: 'rest_note_markdown_ms',
    statistic: 'p95',
    bound: 'below',
    limit: 150,
    stated: 'p95 < 150 ms',
  },
  {
    metric: 'rest_search_ms',
    statistic: 'p95',
    bound: 'below',
    limit: 400,
    stated: 'p95 < 400 ms',
  },
  { metric: 'checks', statistic: 'rate', bound: 'atLeast', limit: 0.99, stated: '> 0.99' },
  {
    metric: 'dropped_iterations',
    statistic: 'count',
    bound: 'exactly',
    limit: 0,
    stated: '0 (a dropped iteration voids the result)',
  },
];

/** D10-14's regression band. */
const REGRESSION_FRACTION = 0.2;

/** The k6 statistic key for each of the three shapes above. */
const SUMMARY_KEY: Readonly<Record<Statistic, string>> = {
  p95: 'p(95)',
  rate: 'rate',
  count: 'count',
};

function numberAt(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) return undefined;
  const member = value[key];
  return typeof member === 'number' && Number.isFinite(member) ? member : undefined;
}

/** One k6 summary export, reduced to what the budgets need. */
interface Summary {
  readonly path: string;
  readonly runnerClass: string;
  /** `<metric>` → `<statistic key>` → value. */
  readonly values: ReadonlyMap<string, ReadonlyMap<string, number>>;
  /** k6's own threshold verdicts: `<metric>` → `<expression>` → passed. */
  readonly thresholds: readonly { metric: string; expression: string; ok: boolean }[];
}

/**
 * The runner class from the file name.
 *
 * The plan fixes the name as `<date>-<runner-class>.json`, and the date is an ISO day, so the class
 * is everything after the eleventh character. A name that does not start with a date is reported
 * rather than guessed at, because comparing against the wrong runner class is worse than not
 * comparing.
 */
function runnerClassOf(path: string): string | null {
  const name = basename(path, '.json');
  const match = /^\d{4}-\d{2}-\d{2}-(.+)$/.exec(name);
  return match?.[1] ?? null;
}

function readSummary(path: string): Summary | { path: string; why: string } {
  let parsed: unknown;
  try {
    parsed = parseJson(readFileSync(path, 'utf8'));
  } catch (error) {
    return { path, why: error instanceof Error ? error.message : String(error) };
  }
  const metrics = isRecord(parsed) ? parsed['metrics'] : undefined;
  if (!isRecord(metrics))
    return { path, why: 'no `metrics` object (is this a k6 summary export?)' };
  const runnerClass = runnerClassOf(path);
  if (runnerClass === null) {
    return {
      path,
      why: 'the file name is not `<date>-<runner-class>.json`, so the runner class is unknown',
    };
  }

  const values = new Map<string, Map<string, number>>();
  const thresholds: { metric: string; expression: string; ok: boolean }[] = [];
  for (const [metric, entry] of Object.entries(metrics)) {
    const statistics = new Map<string, number>();
    const bag = isRecord(entry) ? entry['values'] : undefined;
    // k6 2.x nests statistics under `values`; older exports put them on the metric itself.
    const source = isRecord(bag) ? bag : isRecord(entry) ? entry : {};
    for (const [key, value] of Object.entries(source)) {
      if (typeof value === 'number' && Number.isFinite(value)) statistics.set(key, value);
    }
    values.set(metric, statistics);

    const declared = isRecord(entry) ? entry['thresholds'] : undefined;
    if (!isRecord(declared)) continue;
    for (const [expression, verdict] of Object.entries(declared)) {
      // A verdict is either a bare boolean or `{ ok: boolean }`, depending on the k6 line.
      const ok =
        typeof verdict === 'boolean' ? verdict : isRecord(verdict) && verdict['ok'] === true;
      thresholds.push({ metric, expression, ok });
    }
  }
  return { path, runnerClass, values, thresholds };
}

/** The committed baseline, or `null` when it has not landed yet. */
interface Baseline {
  readonly runnerClass: string;
  readonly recordedAt: string;
  readonly p95: ReadonlyMap<string, number>;
}

function readBaseline(): Baseline | null {
  if (!isFile(CHECK_INPUTS.loadBaseline)) return null;
  const parsed = parseJson(readFileSync(CHECK_INPUTS.loadBaseline, 'utf8'));
  const runnerClass = stringMember(parsed, 'runnerClass');
  const metrics = isRecord(parsed) ? parsed['metrics'] : undefined;
  if (runnerClass === undefined || !isRecord(metrics)) {
    throw new EnvironmentError(
      `${repoPath(CHECK_INPUTS.loadBaseline)} carries no \`runnerClass\` or no \`metrics\` object.\n` +
        'Remedy: the file is `{ "runnerClass": "<class>", "recordedAt": "<ISO date>", "gitSha": "…", ' +
        '"metrics": { "<metric>": { "p95": <number> } } }`, committed with the run artifact attached ' +
        '(D10-14).',
    );
  }
  const p95 = new Map<string, number>();
  for (const [metric, entry] of Object.entries(metrics)) {
    const value = numberAt(entry, 'p95');
    if (value !== undefined) p95.set(metric, value);
  }
  return {
    runnerClass,
    recordedAt: stringMember(parsed, 'recordedAt') ?? 'an unrecorded date',
    p95,
  };
}

export const check: Check = {
  name: 'check-load-budget',
  workflow: 'nightly.yml › load › `Budget check against the baseline`',
  owns: '10-testing-and-quality.md, "Server and collaboration SLOs" (D10-14)',
  run(): CheckResult {
    const directory = join(REPORTS_ROOT, 'load');
    const files = filesWithSuffix(directory, '.json');
    if (files.length === 0) {
      throw new EnvironmentError(
        `no k6 summary in ${repoPath(directory)}, so no budget was evaluated.\n` +
          'The summary is written by `k6 run apps/server/test/load/scenarios.js` as ' +
          '`reports/load/<date>-<runner-class>.json` (10-testing-and-quality.md, "Result handling").\n' +
          'Remedy: run the load scenarios before this step, as nightly.yml › load does.',
      );
    }

    const findings: Finding[] = [];
    const details: string[] = [];
    const baseline = readBaseline();
    if (baseline === null) {
      details.push(
        `${repoPath(CHECK_INPUTS.loadBaseline)} does not exist: the SLO thresholds below were ` +
          'enforced, and the > 20 % p95 regression comparison was not performed. The baseline is ' +
          'committed at M8 with the run artifact attached (D10-14).',
      );
    } else {
      details.push(
        `Baseline recorded ${baseline.recordedAt} on runner class \`${baseline.runnerClass}\`, ` +
          `${String(baseline.p95.size)} p95 value(s).`,
      );
    }

    for (const file of files) {
      const summary = readSummary(file);
      if (!('values' in summary)) {
        findings.push(
          finding(
            summary.path,
            `this k6 summary could not be read: ${summary.why}.`,
            "write it with k6's summary export as `reports/load/<date>-<runner-class>.json`; an " +
              'unreadable summary is a load run whose result is lost.',
          ),
        );
        continue;
      }

      details.push(
        `${repoPath(summary.path)}: runner class \`${summary.runnerClass}\`, ` +
          `${String(summary.values.size)} metric(s).`,
      );

      // k6's own verdicts first, so the job names the threshold expression that broke.
      for (const threshold of summary.thresholds) {
        if (threshold.ok) continue;
        findings.push(
          finding(
            summary.path,
            `k6 threshold \`${threshold.metric}: ${threshold.expression}\` failed.`,
            'fix the regression; a threshold breach fails the load job outright and is never rebaselined ' +
              'away.',
          ),
        );
      }

      for (const budget of BUDGETS) {
        const statistics = summary.values.get(budget.metric);
        const key = SUMMARY_KEY[budget.statistic];
        const value = statistics?.get(key);
        if (value === undefined) {
          findings.push(
            finding(
              summary.path,
              `\`${budget.metric}\` has no \`${key}\` in the summary, so its budget (${budget.stated}) ` +
                'was not measured.',
              'emit the metric from the load generator; a budget with no measurement is not a budget ' +
                '(10-testing-and-quality.md, "Performance budgets and how they are measured").',
            ),
          );
          continue;
        }

        const breached =
          budget.bound === 'below'
            ? value >= budget.limit
            : budget.bound === 'atLeast'
              ? value < budget.limit
              : value !== budget.limit;
        if (breached) {
          findings.push(
            finding(
              summary.path,
              `\`${budget.metric}\` is ${String(value)}, outside its budget of ${budget.stated}.`,
              'fix the regression. The constant is raised only with a measurement in the nightly `perf` ' +
                'job and an explanation in the commit, never to make a change fit.',
            ),
          );
          continue;
        }

        if (baseline === null || budget.statistic !== 'p95') continue;
        if (summary.runnerClass !== baseline.runnerClass) continue;
        const previous = baseline.p95.get(budget.metric);
        if (previous === undefined || previous <= 0) continue;
        const change = (value - previous) / previous;
        if (change > REGRESSION_FRACTION) {
          findings.push(
            finding(
              summary.path,
              `regression: \`${budget.metric}\` p95 is ${String(value)} against a baseline of ` +
                `${String(previous)}, ${(change * 100).toFixed(1)} % worse, with no threshold breach.`,
              'find the cause. Thresholds catch cliffs; this comparison catches the slow slide that turns ' +
                'a passing SLO into a failing one three releases later (D10-14).',
            ),
          );
        } else if (change < -REGRESSION_FRACTION) {
          details.push(
            `Re-baseline reminder: \`${budget.metric}\` p95 improved ` +
              `${(Math.abs(change) * 100).toFixed(1)} % (${String(previous)} → ${String(value)}). ` +
              `Update ${repoPath(CHECK_INPUTS.loadBaseline)} in an explicit commit with the run artifact ` +
              'attached; it is never updated automatically.',
          );
        }
      }

      if (baseline !== null && summary.runnerClass !== baseline.runnerClass) {
        details.push(
          `${repoPath(summary.path)}: not compared against the baseline — it was recorded on ` +
            `\`${summary.runnerClass}\` and the baseline on \`${baseline.runnerClass}\`, and a budget is ` +
            'only compared against results from the same runner class.',
        );
      }
    }

    return {
      summary:
        findings.length === 0
          ? `${String(files.length)} load summary(ies) inside every SLO budget.`
          : `${String(files.length)} load summary(ies) weighed; the load budget is broken.`,
      details,
      findings,
    };
  },
};

if (import.meta.main) await runAsMain(check);
