/**
 * `scripts/check-bundle-budget.ts` — run by ``ci.yml › static › `Bundle budget` ``, after the
 * ``Build`` step, which is why that step comes first in the job.
 *
 * The rule is 10-testing-and-quality.md, "Client budgets" (and 07-client-applications.md §9.4,
 * skeleton A40): the renderer bundle is **≤ 900 KB gzip total** and **≤ 350 KB gzip for the initial
 * route chunk**, measured over `apps/web/dist` and `apps/desktop/dist/renderer` by reading the Vite
 * manifest, summing gzip sizes per entry, and comparing against `bundle-budget.json`.
 *
 * This is the **only** client budget that blocks a pull request (D10-13), and it blocks from M0
 * rather than from a later milestone: the section's reason is that bundle size is deterministic on
 * any runner, unlike the timing budgets beside it, which are advisory on a pull request and blocking
 * in the nightly `perf` job. Nothing in the plan makes this check informational at any milestone, so
 * nothing here is.
 *
 * ## The three definitions this check has to fix
 *
 * The section states two numbers and a method; three details are decided here and recorded, because
 * a budget whose measurement is ambiguous is not a budget.
 *
 *  - **`KB` is 1024 bytes.** 900 KB is 921 600 bytes and 350 KB is 358 400. That is the convention
 *    every bundle analyser prints and the one the numbers were chosen against.
 *  - **Gzip is `zlib.gzipSync` at `Z_BEST_COMPRESSION`,** over each emitted file separately. Node
 *    ships its own zlib, and CI and the development machine run the same pinned Node, so the number
 *    is reproducible; compressing each file separately is what a browser actually downloads, since
 *    every asset is a separate response.
 *  - **The initial route chunk is an entry chunk plus its static import closure and its CSS.**
 *    `dynamicImports` are excluded — a lazily loaded route is exactly what the 350 KB figure exists
 *    to encourage. The reported figure is the largest entry of the bundle, because "the initial
 *    route" is whichever one the browser is made to load first.
 *
 * Source maps are excluded from both figures. They are emitted beside the assets and are never
 * fetched by a page load.
 *
 * ## A missing build is a failure, never a skip
 *
 * `apps/web/dist` is produced by `pnpm turbo run build --filter=@iridium/web` and
 * `apps/desktop/dist/renderer` by `--filter=@iridium/desktop`. When either is absent the check exits
 * `2` naming the build that produces it: a bundle budget that passes because it found no bundle is
 * the failure mode this whole gate exists to prevent.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { constants, gzipSync } from 'node:zlib';

import {
  EnvironmentError,
  finding,
  repoPath,
  runAsMain,
  type Check,
  type CheckResult,
  type Finding,
} from './lib/check.ts';
import { isDirectory, isFile } from './lib/files.ts';
import { arrayMember, isRecord, parseJson, stringMember } from './lib/json.ts';
import { CHECK_INPUTS, DESKTOP_RENDERER_DIST, WEB_DIST } from './lib/paths.ts';

/** 900 KB and 350 KB in bytes — the ceilings 10-testing-and-quality.md states. */
const PLAN_TOTAL_BYTES = 900 * 1024;
const PLAN_INITIAL_BYTES = 350 * 1024;

/** The two builds under budget, with the Turbo filter that produces each. */
const BUNDLES: readonly { readonly dist: string; readonly producedBy: string }[] = [
  { dist: WEB_DIST, producedBy: 'pnpm turbo run build --filter=@iridium/web' },
  { dist: DESKTOP_RENDERER_DIST, producedBy: 'pnpm turbo run build --filter=@iridium/desktop' },
];

/** One committed ceiling pair. */
interface Budget {
  readonly totalGzipBytes: number;
  readonly initialRouteChunkGzipBytes: number;
}

/** What one bundle measured. */
interface Measurement {
  readonly dist: string;
  readonly totalGzipBytes: number;
  readonly initialRouteChunkGzipBytes: number;
  readonly initialEntry: string;
  readonly files: number;
}

function numberMember(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) return undefined;
  const member = value[key];
  return typeof member === 'number' && Number.isFinite(member) ? member : undefined;
}

function readBudgets(): Map<string, Budget> {
  if (!isFile(CHECK_INPUTS.bundleBudget)) {
    throw new EnvironmentError(
      `${repoPath(CHECK_INPUTS.bundleBudget)} does not exist.\n` +
        'It is the committed ceiling table 10-testing-and-quality.md names as `bundle-budget.json`.\n' +
        'Remedy: create it with one `bundles` entry per built directory, each carrying ' +
        '`totalGzipBytes` and `initialRouteChunkGzipBytes`.',
    );
  }
  const parsed = parseJson(readFileSync(CHECK_INPUTS.bundleBudget, 'utf8'));
  const bundles = isRecord(parsed) ? parsed['bundles'] : undefined;
  if (!isRecord(bundles)) {
    throw new EnvironmentError(
      `${repoPath(CHECK_INPUTS.bundleBudget)} carries no \`bundles\` object.\n` +
        'Remedy: the file is `{ "bundles": { "<repository-relative dist>": { "totalGzipBytes": n, ' +
        '"initialRouteChunkGzipBytes": n } } }`.',
    );
  }
  const budgets = new Map<string, Budget>();
  for (const [key, value] of Object.entries(bundles)) {
    const total = numberMember(value, 'totalGzipBytes');
    const initial = numberMember(value, 'initialRouteChunkGzipBytes');
    if (total === undefined || initial === undefined) continue;
    budgets.set(key, { totalGzipBytes: total, initialRouteChunkGzipBytes: initial });
  }
  return budgets;
}

/** One chunk of a Vite manifest, narrowed to the members this check reads. */
interface ManifestChunk {
  readonly file: string;
  readonly isEntry: boolean;
  readonly imports: readonly string[];
  readonly css: readonly string[];
  readonly assets: readonly string[];
}

function readChunk(value: unknown): ManifestChunk | null {
  const file = stringMember(value, 'file');
  if (file === undefined) return null;
  const strings = (key: string): string[] =>
    (arrayMember(value, key) ?? []).filter((entry) => typeof entry === 'string');
  const isEntry = isRecord(value) && value['isEntry'] === true;
  return {
    file,
    isEntry,
    imports: strings('imports'),
    css: strings('css'),
    assets: strings('assets'),
  };
}

function gzipBytes(dist: string, file: string): number {
  const path = join(dist, file);
  if (!isFile(path)) {
    throw new EnvironmentError(
      `${repoPath(dist)}/.vite/manifest.json names ${file}, which does not exist on disk.\n` +
        'Remedy: the build output is incomplete — rebuild it rather than editing the manifest.',
    );
  }
  return gzipSync(readFileSync(path), { level: constants.Z_BEST_COMPRESSION }).byteLength;
}

/** Assets a page load never fetches. */
function isShipped(file: string): boolean {
  return !file.endsWith('.map');
}

function measure(dist: string, producedBy: string): Measurement {
  if (!isDirectory(dist)) {
    throw new EnvironmentError(
      `${repoPath(dist)} does not exist, so there is no bundle to weigh.\n` +
        `Remedy: run \`${producedBy}\` first; ci.yml runs the whole \`Build\` step before this check ` +
        'for exactly this reason.',
    );
  }
  const manifestPath = join(dist, '.vite', 'manifest.json');
  if (!isFile(manifestPath)) {
    throw new EnvironmentError(
      `${repoPath(manifestPath)} does not exist, so the entry chunks cannot be identified.\n` +
        `Remedy: run \`${producedBy}\` with \`build.manifest\` enabled in the Vite configuration.`,
    );
  }
  const parsed = parseJson(readFileSync(manifestPath, 'utf8'));
  if (!isRecord(parsed)) {
    throw new EnvironmentError(
      `${repoPath(manifestPath)} is not a JSON object.\n` +
        `Remedy: rebuild with \`${producedBy}\`.`,
    );
  }

  const chunks = new Map<string, ManifestChunk>();
  for (const [key, value] of Object.entries(parsed)) {
    const chunk = readChunk(value);
    if (chunk !== null) chunks.set(key, chunk);
  }

  const shipped = new Set<string>();
  for (const chunk of chunks.values()) {
    for (const file of [chunk.file, ...chunk.css, ...chunk.assets]) {
      if (isShipped(file)) shipped.add(file);
    }
  }
  const totalGzipBytes = [...shipped]
    .toSorted((a, b) => a.localeCompare(b))
    .reduce((sum, file) => sum + gzipBytes(dist, file), 0);

  // The initial route chunk: an entry plus everything it imports statically, plus its stylesheets.
  let initialRouteChunkGzipBytes = 0;
  let initialEntry = '(none)';
  for (const [key, chunk] of chunks) {
    if (!chunk.isEntry) continue;
    const reached = new Set<string>();
    const visit = (name: string): void => {
      if (reached.has(name)) return;
      reached.add(name);
      const target = chunks.get(name);
      if (target === undefined) return;
      for (const imported of target.imports) visit(imported);
    };
    visit(key);
    const files = new Set<string>();
    for (const name of reached) {
      const target = chunks.get(name);
      if (target === undefined) continue;
      for (const file of [target.file, ...target.css, ...target.assets]) {
        if (isShipped(file)) files.add(file);
      }
    }
    const bytes = [...files]
      .toSorted((a, b) => a.localeCompare(b))
      .reduce((sum, file) => sum + gzipBytes(dist, file), 0);
    if (bytes > initialRouteChunkGzipBytes) {
      initialRouteChunkGzipBytes = bytes;
      initialEntry = key;
    }
  }

  if (initialEntry === '(none)') {
    throw new EnvironmentError(
      `${repoPath(manifestPath)} declares no entry chunk (\`isEntry: true\`).\n` +
        'Remedy: the manifest is not a renderer build — check that the Vite configuration builds the ' +
        'HTML entry rather than a library target.',
    );
  }

  return {
    dist: repoPath(dist),
    totalGzipBytes,
    initialRouteChunkGzipBytes,
    initialEntry,
    files: shipped.size,
  };
}

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export const check: Check = {
  name: 'check-bundle-budget',
  workflow: 'ci.yml › static › `Bundle budget`',
  owns: '10-testing-and-quality.md, "Client budgets" (D10-13); 07-client-applications.md §9.4',
  run(): CheckResult {
    const budgets = readBudgets();
    const findings: Finding[] = [];
    const details: string[] = [];

    for (const { dist, producedBy } of BUNDLES) {
      const measurement = measure(dist, producedBy);
      const budget = budgets.get(measurement.dist);
      if (budget === undefined) {
        findings.push(
          finding(
            CHECK_INPUTS.bundleBudget,
            `no \`bundles\` entry for ${measurement.dist}, which the plan puts under budget.`,
            `add \`"${measurement.dist}": { "totalGzipBytes": ${String(PLAN_TOTAL_BYTES)}, ` +
              `"initialRouteChunkGzipBytes": ${String(PLAN_INITIAL_BYTES)} }\`.`,
          ),
        );
        continue;
      }

      // A committed budget may tighten the plan's ceiling but never loosen it.
      if (budget.totalGzipBytes > PLAN_TOTAL_BYTES) {
        findings.push(
          finding(
            CHECK_INPUTS.bundleBudget,
            `${measurement.dist} has a committed total budget of ${kb(budget.totalGzipBytes)}, above the ` +
              `${kb(PLAN_TOTAL_BYTES)} the plan fixes.`,
            `lower it to at most ${String(PLAN_TOTAL_BYTES)}; raising the ceiling is an edit to ` +
              '10-testing-and-quality.md, "Client budgets", not to this file.',
          ),
        );
      }
      if (budget.initialRouteChunkGzipBytes > PLAN_INITIAL_BYTES) {
        findings.push(
          finding(
            CHECK_INPUTS.bundleBudget,
            `${measurement.dist} has a committed initial-chunk budget of ` +
              `${kb(budget.initialRouteChunkGzipBytes)}, above the ${kb(PLAN_INITIAL_BYTES)} the plan fixes.`,
            `lower it to at most ${String(PLAN_INITIAL_BYTES)}; raising the ceiling is an edit to ` +
              '10-testing-and-quality.md, "Client budgets", not to this file.',
          ),
        );
      }

      if (measurement.totalGzipBytes > budget.totalGzipBytes) {
        findings.push(
          finding(
            join(dist, '.vite', 'manifest.json'),
            `${measurement.dist} is ${kb(measurement.totalGzipBytes)} gzip total, over the ` +
              `${kb(budget.totalGzipBytes)} budget by ` +
              `${kb(measurement.totalGzipBytes - budget.totalGzipBytes)}.`,
            'split or drop a dependency; the budget is the only client gate that blocks a pull request ' +
              'and is never raised to make a change fit.',
          ),
        );
      }
      if (measurement.initialRouteChunkGzipBytes > budget.initialRouteChunkGzipBytes) {
        findings.push(
          finding(
            join(dist, '.vite', 'manifest.json'),
            `the initial route chunk of ${measurement.dist} (entry \`${measurement.initialEntry}\`) is ` +
              `${kb(measurement.initialRouteChunkGzipBytes)} gzip, over the ` +
              `${kb(budget.initialRouteChunkGzipBytes)} budget by ` +
              `${kb(measurement.initialRouteChunkGzipBytes - budget.initialRouteChunkGzipBytes)}.`,
            'move work behind a dynamic import so it leaves the entry closure; a lazily loaded route is ' +
              'what the initial-chunk figure exists to encourage.',
          ),
        );
      }

      details.push(
        `${measurement.dist}: ${kb(measurement.totalGzipBytes)} total of ${kb(budget.totalGzipBytes)}, ` +
          `${kb(measurement.initialRouteChunkGzipBytes)} initial of ` +
          `${kb(budget.initialRouteChunkGzipBytes)} (entry \`${measurement.initialEntry}\`, ` +
          `${String(measurement.files)} shipped file(s)).`,
      );
    }

    return {
      summary:
        findings.length === 0
          ? `${String(BUNDLES.length)} renderer bundle(s) are inside budget.`
          : `${String(BUNDLES.length)} renderer bundle(s) weighed; the budget is broken.`,
      details,
      findings,
    };
  },
};

if (import.meta.main) await runAsMain(check);
