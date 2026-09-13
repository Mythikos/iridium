/**
 * tooling/mutation/run.mjs — the lane's entry point, behind `pnpm --filter @iridium/mutation mutation`.
 *
 * Stryker's project file set is a walk of `process.cwd()` and Stryker has no working-directory option,
 * so the lane can only run from the repository root: every `mutate` glob, the `tsconfigFile`, the
 * Vitest config and both plugin paths in `stryker.config.mjs` are repository-relative. pnpm runs a
 * package script in that package's own directory, so the change of directory has to happen here —
 * a `cd ../.. &&` in the script would put cmd.exe and POSIX shell semantics into a line that has to
 * work on a developer's Windows machine and on the Linux CI runner alike.
 *
 * Arguments are forwarded, so a run can be narrowed to part of the register:
 *
 *     pnpm --filter @iridium/mutation mutation -- --mutate packages/crdt/src/dominates.ts
 *
 * The exit code is forwarded as well, because a score below `thresholds.break` has to fail the caller.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const strykerCli = fileURLToPath(
  new URL('./node_modules/@stryker-mutator/core/bin/stryker.js', import.meta.url),
);

// pnpm hands the separator itself to the script, and Stryker's CLI counts it as an argument to
// `run`. Both `mutation -- --mutate <globs>` and `mutation --mutate <globs>` should work.
const forwarded = process.argv.slice(2);
if (forwarded[0] === '--') {
  forwarded.shift();
}

const { status, error } = spawnSync(
  process.execPath,
  [strykerCli, 'run', 'tooling/mutation/stryker.config.mjs', ...forwarded],
  { cwd: repositoryRoot, stdio: 'inherit' },
);

if (error) {
  throw error;
}

// `null` means a signal killed it, which is a failure like any other.
process.exit(status ?? 1);
