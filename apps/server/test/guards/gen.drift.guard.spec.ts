/**
 * `gen.drift.guard` (10-testing-and-quality.md, "Guard tests" and the `static` lane;
 * 12-milestones.md §4.3 and §4.6; 01-vision-scope-and-principles.md's "Enforced by" list).
 *
 * Every generated artefact in this repository is **committed**: the OpenAPI document, the api-client
 * `paths.d.ts`, the MCP tool schema, the desktop IPC typings, the msw handler skeleton,
 * `docs/non-goals.json` and `docs/acceptance-map.json`. Committing them is what lets a reviewer read
 * a wire change as a diff and what lets `guards.non-goals.guard` and `guards.acceptance-map.guard`
 * assert against a file instead of against a build. It is also what creates the one failure mode this
 * guard exists to refuse: an artefact that no longer follows from its source. A stale `openapi.json`
 * is a published contract nobody promised; a stale `docs/acceptance-map.json` is a coverage claim
 * about tests that were renamed last week.
 *
 * **The form.** The pipeline is `scripts/gen.ts`, and every step implements `--check`: the same code
 * path with the write suppressed, so a step computes exactly the bytes it would have written and
 * reports whether they differ from the committed file (`scripts/lib/step.ts`). This guard runs the
 * pipeline that way, in a child process under `process.execPath` — the form `scripts/lib/process.ts`
 * uses for every pinned tool, and the only form that behaves identically on the Windows development
 * machine and on Linux CI, because no shell is involved. The pipeline's own report is carried into
 * the assertion message: a guard that says "something drifted" and makes the reader re-run the
 * pipeline to find out what is a guard that costs more than it saves.
 *
 * **One step is skipped, loudly.** Step 4 compares the hand-written Kysely `Database` against
 * `kysely-codegen` output and needs a MySQL container. The `guard` project has no Docker — that is
 * the whole reason guards run in `ci.yml › static` — so the run passes `--skip-db`. The step writes
 * no artefact, so nothing this guard checks depends on it, and `migrations.integration` asserts the
 * same invariant on both required MySQL images. The assertion below is that the skip *happened and
 * said so*: a drift gate that silently drops a step is worse than a red one.
 *
 * **Why the artefact list is written here rather than imported.** `scripts/lib/paths.ts` declares it,
 * but importing it would climb out of `apps/server` — the thing `db.dialect-floor.guard` reaches a
 * workspace package to avoid, and something `turbo boundaries` has an opinion about. The list is
 * therefore restated from the plan's guard row and asserted to be *exactly* the set the pipeline
 * reports, so a pipeline that starts writing an eighth artefact fails here until the row, the map and
 * this list agree. That is the same two-part discipline the non-goal guard has with §4.4.
 *
 * **A note on `pnpm gen && git diff --exit-code`.** That is the shell form the guard table's "How"
 * column names, and `ci.yml › static` keeps running it: it additionally catches an artefact that was
 * regenerated and left uncommitted. It cannot be this file, because a test must not write to the
 * working tree and the `guard` project knows nothing about git. `--check` compares the same bytes
 * against the same files and names the artefact instead of printing a diff, which is the better half
 * of the pair to run first.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const PIPELINE = join(REPO_ROOT, 'scripts', 'gen.ts');

/**
 * The pipeline runs nine steps, three of which spawn a pinned tool of their own, so it is given far
 * more than the `guard` project's 30-second default. The budget is generous rather than tight on
 * purpose: a drift gate that fails as a timeout teaches a contributor to re-run it, not to fix it.
 */
const PIPELINE_TIMEOUT_MS = 240_000;

/**
 * Every artefact the drift gate covers, as 10-testing-and-quality.md's guard row and
 * 12-milestones.md §4.3 list them. `apps/server/src/db/schema.ts` is on the plan's list too but is
 * hand-written and only *compared*, so it is not an artefact the report names.
 */
const COMMITTED_ARTEFACTS: readonly string[] = [
  'docs/acceptance-map.json',
  'docs/non-goals.json',
  'packages/api-client/src/generated/paths.d.ts',
  'packages/contracts/mcp/tools.schema.json',
  'packages/contracts/openapi/openapi.json',
  'packages/contracts/src/generated/desktop-ipc.d.ts',
  'packages/testkit/src/msw/generated/operations.ts',
];

/** One line of the pipeline's artefact table. */
interface Artefact {
  readonly path: string;
  readonly bytes: number;
  readonly stale: boolean;
}

interface PipelineRun {
  readonly exitCode: number;
  /** stdout and stderr, in that order, for the assertion messages. */
  readonly report: string;
  readonly artefacts: readonly Artefact[];
  /** Step names the run reported as skipped, with the reason it printed. */
  readonly skipped: readonly string[];
  /** Step names the run reported as failed or blocked. */
  readonly broken: readonly string[];
}

/**
 * Run `node scripts/gen.ts --check --skip-db` and read its report.
 *
 * `--skip-db` and `IRIDIUM_GEN_SKIP_DB=1` are the same switch (`scripts/lib/step.ts`); both are
 * passed so the run is skipped for a reason the guard chose and not for one it inherited.
 */
function runPipelineCheck(): PipelineRun {
  const result = spawnSync(process.execPath, [PIPELINE, '--check', '--skip-db'], {
    cwd: REPO_ROOT,
    env: { ...process.env, IRIDIUM_GEN_SKIP_DB: '1' },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    // No shell: the argument array reaches the child verbatim on every platform.
    shell: false,
    windowsHide: true,
    timeout: PIPELINE_TIMEOUT_MS,
  });
  if (result.error !== undefined) throw result.error;
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  // The pipeline writes a skip and a failure with `console.warn`/`console.error`, so the run's own
  // ordering is split across two buffers. They are labelled rather than merged, because a report
  // whose step numbers appear to jump is a report the reader stops trusting.
  const report = [
    stdout.trimEnd(),
    stderr.trim() === '' ? '' : `--- stderr (skips and failures) ---\n${stderr.trimEnd()}`,
  ]
    .filter((stream) => stream !== '')
    .join('\n');
  return { exitCode: result.status ?? 1, report, ...parseReport(report) };
}

/**
 * Read the pipeline's own summary: its artefact table, the steps it skipped, and the steps it failed
 * or blocked behind a failure. Separated from the run so the matcher is provable without a second
 * pipeline invocation.
 */
function parseReport(report: string): Omit<PipelineRun, 'exitCode' | 'report'> {
  const artefacts: Artefact[] = [];
  const skipped: string[] = [];
  const broken: string[] = [];
  for (const line of report.split('\n')) {
    const artefact = /^ {2}(current|written|STALE)\s+(\d+) B {2}(.+)$/.exec(line);
    if (artefact !== null) {
      artefacts.push({
        path: (artefact[3] ?? '').replaceAll('\\', '/'),
        bytes: Number(artefact[2]),
        stale: artefact[1] === 'STALE',
      });
      continue;
    }
    const step = /^ {2}\d+\/\d+ (.+?): (SKIPPED|FAILED|BLOCKED by .+)$/.exec(line);
    if (step === null) continue;
    if (step[2] === 'SKIPPED') skipped.push(step[1] ?? '');
    else broken.push(`${step[1] ?? ''}: ${step[2] ?? ''}`);
  }
  return { artefacts, skipped, broken };
}

let run: PipelineRun;

beforeAll(() => {
  run = runPipelineCheck();
}, PIPELINE_TIMEOUT_MS + 30_000);

const REMEDY =
  'Remedy: run `pnpm gen` and commit the result. Every artefact above is generated from a source in ' +
  'this repository, so a difference means the source moved and the committed artefact did not — ' +
  'never that the artefact should be edited by hand.';

describe('gen.drift.guard [area:contracts]', () => {
  describe('the pipeline runs in check mode', () => {
    it('runs `scripts/gen.ts --check` to completion and reports its steps', () => {
      expect(
        run.report,
        `the pipeline printed nothing; it was run as \`${process.execPath} scripts/gen.ts --check --skip-db\``,
      ).toContain('pnpm gen --check');
      expect(run.report, 'the pipeline did not reach its artefact summary').toContain(
        'Artefacts (',
      );
    });

    it('fails no step, and blocks none behind a failed one', () => {
      expect(
        run.broken.join('\n'),
        `A \`pnpm gen\` step failed, so the drift check below has nothing trustworthy to compare.\n${run.report}`,
      ).toBe('');
    });

    it('skips exactly the database comparison, and says which lane covers it instead', () => {
      expect(
        run.skipped,
        `the run skipped ${String(run.skipped.length)} step(s): ${run.skipped.join(', ') || '(none)'}`,
      ).toEqual(['kysely schema diff']);
      expect(
        run.report,
        'a skipped step must name the lane that asserts the same invariant, or the skip is silent',
      ).toContain('migrations.integration');
      expect(run.report).toContain('IRIDIUM_GEN_SKIP_DB=1');
    });
  });

  describe('every committed artefact still follows from its source', () => {
    it('reports exactly the artefact set the plan enumerates', () => {
      const reported = run.artefacts
        .map((artefact) => artefact.path)
        .toSorted((a, b) => a.localeCompare(b));
      expect(
        reported.join('\n'),
        `The drift gate covers a fixed set of committed artefacts (10-testing-and-quality.md, "Guard tests"; 12-milestones.md §4.3). The pipeline reported a different set, so either a step stopped writing one or a new artefact needs adding to the plan row, docs/acceptance-map.json and this guard.\n${run.report}`,
      ).toBe([...COMMITTED_ARTEFACTS].toSorted((a, b) => a.localeCompare(b)).join('\n'));
    });

    it('finds no stale artefact', () => {
      const stale = run.artefacts
        .filter((artefact) => artefact.stale)
        .map((artefact) => `  ${artefact.path} (${String(artefact.bytes)} B as generated)`);
      expect(
        stale.join('\n'),
        `\`pnpm gen\` would change ${String(stale.length)} committed artefact(s).\n${REMEDY}\n\n${run.report}`,
      ).toBe('');
    });

    it('exits zero, which is what the `static` lane reads', () => {
      expect(
        run.exitCode,
        `\`pnpm gen --check --skip-db\` exited ${String(run.exitCode)}.\n${run.report}`,
      ).toBe(0);
    });
  });

  describe('the report parser', () => {
    it('reads a stale artefact, a current one, a skip and a failure out of one report', () => {
      const parsed = parseReport(
        [
          'pnpm gen --check',
          '  1/9 openapi export: 0 operation(s), 3330 bytes',
          '  4/9 kysely schema diff: SKIPPED',
          '      no database requested (--skip-db / IRIDIUM_GEN_SKIP_DB=1).',
          '  5/9 mcp tool schema: FAILED',
          '  6/9 desktop ipc typings: BLOCKED by `mcp tool schema`',
          '',
          'Artefacts (2):',
          '  current      3330 B  packages/contracts/openapi/openapi.json',
          '  STALE      320161 B  docs/acceptance-map.json',
        ].join('\n'),
      );
      expect(parsed.artefacts).toEqual([
        { path: 'packages/contracts/openapi/openapi.json', bytes: 3330, stale: false },
        { path: 'docs/acceptance-map.json', bytes: 320_161, stale: true },
      ]);
      expect(parsed.skipped).toEqual(['kysely schema diff']);
      expect(parsed.broken).toEqual([
        'mcp tool schema: FAILED',
        'desktop ipc typings: BLOCKED by `mcp tool schema`',
      ]);
    });

    it('reads nothing out of a report that printed nothing', () => {
      const parsed = parseReport('');
      expect(parsed.artefacts).toEqual([]);
      expect(parsed.skipped).toEqual([]);
      expect(parsed.broken).toEqual([]);
    });
  });
});
