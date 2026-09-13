/**
 * `scripts/perf-trend.ts` — run by ``nightly.yml › perf › `Performance trend table` `` as
 * `node scripts/perf-trend.ts >> "$GITHUB_STEP_SUMMARY"`, with `if: always()`.
 *
 * The rule is 10-testing-and-quality.md, "Trend artifacts" (decision D10-18):
 *
 * > Every performance-producing suite writes a line to a JSONL artifact (`reports/perf/*.jsonl`) with
 * > the metric name, value, git sha, runner class and date. The nightly job uploads them, and
 * > `scripts/perf-trend.ts` renders a plain-text table into the nightly job summary. There is no
 * > dashboard to maintain and no external service: the artifacts and the summary are the record, and
 * > the only automation that acts on them is the two budget-checking scripts above.
 *
 * So this script is a renderer, not a gate. It compares nothing against a budget — `check-load-budget`
 * and `check-bundle-budget` are the two scripts that do — and it never fails the `perf` job for a
 * number being large.
 *
 * **It does fail on a line it cannot read.** The artifacts *are* the record, so a malformed line is a
 * lost measurement, and the same suite will keep losing it every night until somebody is told. Exit
 * `1` naming the file, the line and the five fields a line carries.
 *
 * **An empty record is not a failure.** At M0 no suite writes a performance line, so
 * `reports/perf/` is absent; the table then says so in one sentence and exits `0`. The step exists
 * from M0 because a job summary step added later is a job summary nobody notices is missing.
 *
 * ## Why the table is Markdown
 *
 * `$GITHUB_STEP_SUMMARY` renders GitHub-flavoured Markdown, so a pipe table is what "a plain-text
 * table in the nightly job summary" means at the destination: it is plain text in the file and a
 * table on the page. A fixed-width table would need a code fence to survive, which would make it
 * unreadable on a phone and unsortable by eye.
 *
 * ## What a row says
 *
 * One row per `(metric, runner class)` pair — the pairing matters, because a budget is only ever
 * compared against results from the same runner class, and averaging across classes would invent a
 * number no run produced. Each row carries the latest value, the value before it, the change between
 * them, and how many samples the record holds. Rows are sorted by metric and then by runner class, so
 * two nights' summaries can be read side by side.
 *
 * Everything except the table goes to stderr: stdout is the artefact.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  finding,
  repoPath,
  runAsMain,
  type Check,
  type CheckResult,
  type Finding,
} from './lib/check.ts';
import { filesWithSuffix, isDirectory } from './lib/files.ts';
import { isRecord, parseJson, stringMember } from './lib/json.ts';
import { REPORTS_ROOT } from './lib/paths.ts';

/** One measurement, exactly the five fields "Trend artifacts" names. */
interface Sample {
  readonly metric: string;
  readonly value: number;
  readonly sha: string;
  readonly runnerClass: string;
  readonly date: string;
}

/** The five field names, as they appear in a JSONL line and in the failure message. */
const FIELDS = '`metric` (string), `value` (number), `sha`, `runnerClass`, `date`';

function readSample(value: unknown): Sample | null {
  if (!isRecord(value)) return null;
  const metric = stringMember(value, 'metric');
  const sha = stringMember(value, 'sha');
  const runnerClass = stringMember(value, 'runnerClass');
  const date = stringMember(value, 'date');
  const raw = value['value'];
  if (
    metric === undefined ||
    sha === undefined ||
    runnerClass === undefined ||
    date === undefined ||
    typeof raw !== 'number' ||
    !Number.isFinite(raw)
  ) {
    return null;
  }
  return { metric, value: raw, sha, runnerClass, date };
}

/** One `(metric, runner class)` series, in the order the record holds it. */
interface Series {
  readonly metric: string;
  readonly runnerClass: string;
  readonly samples: readonly Sample[];
}

function group(samples: readonly Sample[]): Series[] {
  const series = new Map<string, { metric: string; runnerClass: string; samples: Sample[] }>();
  for (const sample of samples) {
    // A JSON array as the key, so a metric name containing the separator cannot merge two series.
    const key = JSON.stringify([sample.metric, sample.runnerClass]);
    const existing = series.get(key);
    if (existing === undefined) {
      series.set(key, {
        metric: sample.metric,
        runnerClass: sample.runnerClass,
        samples: [sample],
      });
      continue;
    }
    existing.samples.push(sample);
  }
  return [...series.values()]
    .map((entry) => ({
      metric: entry.metric,
      runnerClass: entry.runnerClass,
      // Chronological, with the file order breaking a tie on the same day.
      samples: entry.samples.toSorted((a, b) => a.date.localeCompare(b.date)),
    }))
    .toSorted(
      (a, b) => a.metric.localeCompare(b.metric) || a.runnerClass.localeCompare(b.runnerClass),
    );
}

/** Six significant figures without exponent noise, so a millisecond and a ratio both read well. */
function format(value: number): string {
  if (Number.isInteger(value)) return String(value);
  if (Math.abs(value) >= 100) return value.toFixed(1);
  if (Math.abs(value) >= 1) return value.toFixed(2);
  return value.toFixed(4);
}

function change(latest: number, previous: number): string {
  if (previous === 0) return latest === 0 ? '0 %' : 'n/a';
  const fraction = (latest - previous) / previous;
  const sign = fraction > 0 ? '+' : '';
  return `${sign}${(fraction * 100).toFixed(1)} %`;
}

function render(series: readonly Series[], files: number): string {
  if (series.length === 0) {
    return [
      '### Performance trend',
      '',
      'No performance measurements were recorded. Every performance-producing suite writes a line to',
      '`reports/perf/*.jsonl`; none has run yet.',
      '',
    ].join('\n');
  }
  const rows = series.map((entry) => {
    const latest = entry.samples.at(-1);
    const previous = entry.samples.at(-2);
    return [
      entry.metric,
      entry.runnerClass,
      latest === undefined ? '—' : format(latest.value),
      previous === undefined ? '—' : format(previous.value),
      latest === undefined || previous === undefined ? '—' : change(latest.value, previous.value),
      String(entry.samples.length),
      latest === undefined ? '—' : `${latest.date} \`${latest.sha.slice(0, 7)}\``,
    ];
  });
  return [
    '### Performance trend',
    '',
    `${String(series.length)} metric/runner-class series across ${String(files)} artifact file(s).`,
    '',
    '| Metric | Runner class | Latest | Previous | Change | Samples | Recorded |',
    '|---|---|---|---|---|---|---|',
    ...rows.map((row) => `| ${row.join(' | ')} |`),
    '',
  ].join('\n');
}

export const check: Check = {
  name: 'perf-trend',
  workflow: 'nightly.yml › perf › `Performance trend table`',
  owns: '10-testing-and-quality.md, "Trend artifacts" (D10-18)',
  run(): CheckResult {
    const directory = join(REPORTS_ROOT, 'perf');
    const files = filesWithSuffix(directory, '.jsonl');
    const findings: Finding[] = [];
    const samples: Sample[] = [];

    for (const file of files) {
      const lines = readFileSync(file, 'utf8').replaceAll('\r\n', '\n').split('\n');
      for (const [index, line] of lines.entries()) {
        if (line.trim() === '') continue;
        let parsed: unknown;
        try {
          parsed = parseJson(line);
        } catch {
          findings.push(
            finding(
              file,
              'this line is not JSON, so the measurement it carried is lost.',
              `write one JSON object per line with ${FIELDS}; the artifacts are the record, so an ` +
                'unreadable line is a measurement nobody will ever see.',
              index + 1,
            ),
          );
          continue;
        }
        const sample = readSample(parsed);
        if (sample === null) {
          findings.push(
            finding(
              file,
              'this line is missing a required field, so the measurement it carried cannot be placed.',
              `write ${FIELDS}; the runner class and the date are what make a value comparable with ` +
                "another night's.",
              index + 1,
            ),
          );
          continue;
        }
        samples.push(sample);
      }
    }

    const series = group(samples);
    const details: string[] = [];
    if (!isDirectory(directory)) {
      details.push(
        `${repoPath(directory)} does not exist: no suite has written a performance line yet.`,
      );
    }

    return {
      report: render(series, files.length),
      summary:
        findings.length === 0
          ? `${String(samples.length)} measurement(s) in ${String(series.length)} series rendered from ` +
            `${String(files.length)} artifact file(s).`
          : `${String(samples.length)} measurement(s) rendered; ${String(findings.length)} line(s) of the ` +
            'trend record are unreadable.',
      details,
      findings,
    };
  },
};

if (import.meta.main) await runAsMain(check);
