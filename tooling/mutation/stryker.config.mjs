/**
 * tooling/mutation/stryker.config.mjs — the mutation lane (10-testing-and-quality.md, "Mutation").
 *
 * Run from the **repository root**, because every `mutate` glob, `tsconfigFile` and plugin path below
 * is repository-relative and Stryker has no working-directory option — its project file set is a walk
 * of `process.cwd()`, so the root is the only directory the lane can run from:
 *
 *     stryker run tooling/mutation/stryker.config.mjs
 *
 * Six settings depart from the configuration as first drafted in 10-testing-and-quality.md, each for a
 * reason spike S5 measured and `docs/spikes/S05-stryker-vitest5.md` records:
 *
 *  - The file is `.mjs`, not `.jsonc`. Stryker 10.0.0 accepts only `json`, `js`, `mjs` and `cjs`
 *    (`config-file-formats.js`) and `import()`s anything that is not `.json`, so a `.jsonc` file
 *    dies with `ERR_UNKNOWN_FILE_EXTENSION` before a single option is read. `.mjs` keeps the
 *    comments a `.json` file would lose.
 *  - `plugins` names the two plugin entry points by path. Stryker's default `['@stryker-mutator/*']`
 *    globs the directory that *core itself* is installed in, which under pnpm's isolated layout
 *    holds only `api`, `core`, `instrumenter` and `util` — so the glob silently matches nothing,
 *    no runner and no checker are ever loaded, and the only symptom is a pair of "Unknown stryker
 *    config option" warnings for `vitest` and `typescriptChecker`.
 *  - `vitest.configFile`, `incrementalFile` and the two reporter filenames are repository-relative
 *    rather than package-relative, for the same absent working-directory option.
 *  - `ignorePatterns` keeps `tsconfig.stryker.json` out of the sandbox. Stryker's
 *    `TSConfigPreprocessor` rewrites the `tsconfigFile` it finds among the sandboxed files through
 *    `ts.parseConfigFileTextToJson`, imported from a `typescript` resolved at *core's* own location —
 *    the repository-wide 7.0.2, which exports no JS compiler API at all (R-T10), so the run dies with
 *    `TypeError: ts.parseConfigFileTextToJson is not a function`. The checker does not need the file
 *    there: checker workers run in the repository root, not in the sandbox, and read the real
 *    `tsconfig.stryker.json` and the real sources, applying each mutant in memory. Keeping the file
 *    out of the sandbox is therefore the whole fix, and the sandbox itself is kept — mutating the
 *    workspace in place would rewrite live source files under any developer working in parallel.
 *  - `testRunnerNodeArgs` loads `vitest-resolution.mjs`, without which the runner ignores this
 *    package's `vitest` 4.1.11 and loads the repository's 5.0.0, whose test-name matching the runner
 *    does not support: every mutant then runs zero tests and is reported as survived. That file
 *    carries the mechanism and the measurements.
 *  - `disableTypeChecks` is off. Its default pattern is rooted at the top-level `test`, `src` and
 *    `lib` directories, which in this layout hold nothing — every mutated file sits two levels down,
 *    under a package or under the server app — so Stryker does not currently insert `// @ts-nocheck`
 *    into the files it mutates. If it ever did, every compile-error mutant would silently become a
 *    survivor, and seeing those mutants is half of what this lane is for.
 *
 * `IRIDIUM_PROP_SEED` is set here, in the parent process, because Stryker's children inherit its
 * environment (`{ STRYKER_MUTATOR_WORKER, ...process.env }`) and the seed must already be fixed when
 * the dry run registers its test names. `@fast-check/vitest` writes the seed it drew into the test
 * name, Stryker filters mutant runs by the names the dry run recorded, and a seed drawn afresh per
 * run therefore matches nothing — which is how `packages/crdt/src/**`, covered only by property
 * files, reported every mutant as survived in spike S5. The value is arbitrary; only its fixedness
 * matters. Setting the variable before the run overrides it, which is how a lane failure gets
 * re-searched on other inputs; the ordinary test lanes leave it unset and keep drawing fresh seeds.
 */
process.env['IRIDIUM_PROP_SEED'] ??= '42';
// Instrumented large-update properties must finish the same 200 cases; only the deadline widens.
process.env['IRIDIUM_PROP_INTERRUPT_MS'] ??= '600000';

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  plugins: [
    './tooling/mutation/node_modules/@stryker-mutator/vitest-runner/dist/src/index.js',
    './tooling/mutation/node_modules/@stryker-mutator/typescript-checker/dist/src/index.js',
  ],
  testRunner: 'vitest',
  vitest: { configFile: 'tooling/mutation/vitest.stryker.config.ts', related: true },
  testRunnerNodeArgs: [`--import=${new URL('./vitest-resolution.mjs', import.meta.url).href}`],
  checkers: ['typescript'],
  tsconfigFile: 'tooling/mutation/tsconfig.stryker.json',
  typescriptChecker: { prioritizePerformanceOverAccuracy: true },
  disableTypeChecks: false,
  mutate: [
    'apps/server/src/auth/**/*.ts',
    'apps/server/src/authz/**/*.ts',
    'apps/server/src/oauth/**/*.ts',
    'apps/server/src/audit/chain.ts',
    'apps/server/src/collab/persistence/**/*.ts',
    'apps/server/src/collab/limits.ts',
    'apps/server/src/mcp/{cursor,verifier,rate-limit}.ts',
    'apps/server/src/tree/{names,paths,rename-impact}.ts',
    'apps/server/src/collab/owner-lease.ts',
    'packages/contracts/src/{tokens,paths,authz,ids,limits,markdown-limits}.ts',
    'packages/crdt/src/**/*.ts',
    'packages/markdown/src/sanitize/**/*.ts',
    'packages/markdown/src/{normalize,restore}.ts',
    'packages/markdown/src/links/**/*.ts',
    'packages/collab-client/src/save-state.ts',
    '!**/*.spec.ts',
  ],
  // The checker's own tsconfig (see above), then the generated trees: Stryker's project walk reads no
  // `.gitignore`, so build output, coverage and turbo caches would otherwise be copied into every
  // sandbox. Nothing in the sandbox reads them — workspace packages resolve through the `node_modules`
  // junctions to the real tree.
  ignorePatterns: [
    'tooling/mutation/tsconfig.stryker.json',
    'dist',
    '.turbo',
    '.vitest',
    'coverage',
    'test-results',
    'playwright-report',
    // Historical evidence and sealed checkouts are outputs, never mutation or test inputs.
    '/reports',
  ],
  // Stryker's default name, and it has to stay a bare directory name: the walk that symlinks
  // `node_modules` into the sandbox skips the temp directory by comparing `tempDirName` against a
  // single path segment, so a `tooling/mutation/.stryker-tmp` is never skipped — every run then walks
  // the sandbox it has just filled, and a run that crashed after symlinking leaves junctions behind
  // for the next run to copy into its own sandbox. `.gitignore` covers `.stryker-tmp/` at any depth.
  tempDirName: '.stryker-tmp',
  ignoreStatic: true,
  incremental: true,
  incrementalFile: 'tooling/mutation/reports/stryker-incremental.json',
  concurrency: 4,
  timeoutMS: 10000,
  // The full 200-case property baseline spans all mutation targets before any mutant runs.
  dryRunTimeoutMinutes: 20,
  thresholds: { high: 90, low: 75, break: 70 },
  reporters: ['progress', 'clear-text', 'html', 'json'],
  htmlReporter: { fileName: 'tooling/mutation/reports/mutation/mutation.html' },
  jsonReporter: { fileName: 'tooling/mutation/reports/mutation/mutation.json' },
};
