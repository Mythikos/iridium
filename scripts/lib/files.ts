/**
 * Deterministic directory reading for the `static`-job checks.
 *
 * Three of the checks walk a tree (`check-fixture-size.ts`, `check-stryker-disables.ts`) and four
 * read every file of one directory (`check-openapi-coverage.ts`, `check-load-budget.ts`,
 * `perf-trend.ts`, `check-release-feed.ts`). They share this module rather than each carrying a
 * `readdirSync` recursion, for one reason: **`readdirSync` order is filesystem order**, which is not
 * the same on ext4 and on NTFS. A check whose findings are listed in filesystem order prints a
 * different report on the development machine and on the runner, and the first thing anyone does
 * with a red check is compare it against the last green one. Every list here is sorted by path.
 *
 * `node_modules`, build output and tool caches are skipped by name. None of the trees these checks
 * walk is supposed to contain them, and walking into one would turn a fixture-weight check into a
 * dependency-weight check.
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Directory names never descended into, whatever tree the walk was pointed at. */
const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  'coverage',
  '.turbo',
  '.vitest',
  '.git',
  '.stryker-tmp',
]);

/** One file found by a walk, with the size `statSync` reported. */
export interface FoundFile {
  /** Absolute path. */
  readonly path: string;
  readonly bytes: number;
}

/** Whether `path` exists and is a directory. */
export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Whether `path` exists and is a regular file. */
export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Every regular file under `root`, depth-first, sorted by path.
 *
 * A `root` that does not exist yields an empty list. That is deliberate and is never on its own a
 * pass: the caller decides whether an absent tree is "nothing to weigh" or a missing input, because
 * only the caller knows which milestone creates it.
 */
export function walkFiles(root: string): FoundFile[] {
  if (!isDirectory(root)) return [];
  const found: FoundFile[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory).toSorted((a, b) => a.localeCompare(b))) {
      const path = join(directory, entry);
      const stats = statSync(path);
      if (stats.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry)) walk(path);
        continue;
      }
      if (stats.isFile()) found.push({ path, bytes: stats.size });
    }
  };
  walk(root);
  return found;
}

/**
 * The files directly inside `directory` whose name ends with `suffix`, sorted by name.
 *
 * Used for the report directories the lanes fill — `reports/perf/*.jsonl`, `reports/load/*.json`,
 * `reports/openapi-coverage/*.json`. It does not recurse: those directories are flat by
 * specification, and a nested file would be a report written to the wrong place rather than one to
 * silently include.
 */
export function filesWithSuffix(directory: string, suffix: string): string[] {
  if (!isDirectory(directory)) return [];
  return readdirSync(directory)
    .filter((entry) => entry.endsWith(suffix))
    .map((entry) => join(directory, entry))
    .filter((path) => isFile(path))
    .toSorted((a, b) => a.localeCompare(b));
}
