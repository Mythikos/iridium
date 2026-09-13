/**
 * tooling/mutation/vitest-resolution.mjs — loaded with `--import` into Stryker's test-runner child
 * process by `testRunnerNodeArgs` in `stryker.config.mjs`. It is the reason the lane's `vitest`
 * 4.1.11 pin has any effect at all.
 *
 * ## What it repairs
 *
 * `@stryker-mutator/vitest-runner` 10.0.0 does not use the Vitest it was installed against. Its
 * `vitest-wrapper.js` prefers what it calls "the project's local Vitest installation", looked up as
 *
 *     createRequire(path.join(process.cwd(), 'package.json')).resolve('vitest/node')
 *
 * and the lane is run from the repository root, where `vitest` is 5.0.0. Its static fallback import
 * — which pnpm resolves to this package's own 4.1.11 — is reached only when that lookup throws.
 *
 * Spike S5 (`docs/spikes/S05-stryker-vitest5.md`) measured what Vitest 5 costs here: the runner
 * builds each mutant's `testNamePattern` from the test names its dry run recorded, joining suite and
 * test names with a single space, while Vitest 5 matches that pattern against the names joined with
 * `' > '`. Every test then filters out, every mutant runs zero tests, and Stryker scores a zero-test
 * run as *Survived* — a mutation score of 0.00 % with nothing killed, which reads like weak tests
 * rather than like the broken lane it is. `tooling/mutation` pins `vitest` 4.1.11 for itself so the
 * space-joined pattern matches; this file is what makes the runner actually load that copy.
 *
 * ## How
 *
 * The runner's plugin entry point is imported here with the working directory set to this package,
 * so the wrapper's `process.cwd()` lookup lands on `tooling/mutation/node_modules/vitest`. The
 * directory is restored immediately — well before Stryker sets it to the sandbox — and the module
 * stays in the ES module cache, so the plugin loader's own `import()` of the same file URL moments
 * later is a cache hit and every worker uses the 4.1.11 API this resolved. Nothing else observes the
 * change: the runner's only cwd-relative work, the per-worker `stryker-setup-<n>.js` shim, is a field
 * initialiser that runs when Stryker constructs the runner, long after this module is done.
 *
 * The resolved version is then asserted rather than assumed, because the failure it guards against is
 * silent. Upstream follow-ups are listed in the spike note; this file goes away when a
 * `@stryker-mutator/vitest-runner` release supports Vitest 5.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainThread } from 'node:worker_threads';

/** This package's directory, taken from this file rather than from the working directory. */
const laneDirectory = path.dirname(fileURLToPath(import.meta.url));

const RUNNER_PLUGIN = './node_modules/@stryker-mutator/vitest-runner/dist/src/index.js';
const RUNNER_WRAPPER = './node_modules/@stryker-mutator/vitest-runner/dist/src/vitest-wrapper.js';

// Vitest's own workers inherit `execArgv`, and the runner forces `pool: 'threads'`, where
// `process.chdir` does not exist. Only Stryker's own child process has anything to resolve.
if (isMainThread) {
  const workingDirectory = process.cwd();
  process.chdir(laneDirectory);
  try {
    await import(new URL(RUNNER_PLUGIN, import.meta.url).href);
  } finally {
    process.chdir(workingDirectory);
  }

  const { vitestWrapper } = await import(new URL(RUNNER_WRAPPER, import.meta.url).href);
  if (Number.parseInt(vitestWrapper.version, 10) !== 4) {
    throw new Error(
      `The mutation lane resolved vitest ${vitestWrapper.version}. ` +
        '@stryker-mutator/vitest-runner 10.0.0 can only filter test names on vitest 4.x ' +
        '(docs/spikes/S05-stryker-vitest5.md): on 5.x every mutant runs zero tests and is reported ' +
        'as survived. Refusing to run rather than report a mutation score of 0.00 %.',
    );
  }
}
