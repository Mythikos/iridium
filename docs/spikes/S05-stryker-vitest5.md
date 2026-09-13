# S05 — Stryker 10 on Vitest 5

## Question

Does Stryker 10.0.0 with `@stryker-mutator/vitest-runner` and `typescript-checker` run against Vitest 5.0.0 inside `tooling/mutation` with the `@typescript/typescript6` alias — completing a run on `packages/contracts/src/tokens.ts` and `packages/crdt/src/dominates.ts`, reporting compile-error mutants as such, producing at least one killed and one survived mutant, and writing an incremental file that a second run reuses?

## Why it blocks

Mutation thresholds are milestone exit criteria from M1 onwards: Stryker `break` 70 on the mutated globs at M1–M2, 75 at M3–M7, 80 at M8 (decision D12-3), over `apps/server/src/auth/**`, `apps/server/src/authz/**`, `apps/server/src/collab/persistence/**`, `packages/contracts/src/{tokens,paths,authz,ids,limits}.ts` and `packages/crdt/src/**`. `@stryker-mutator/vitest-runner` 10.0.0 predates Vitest 5.0.0 and only nominally allows it (its `peerDependencies.vitest` is `>=2.0.0`), and Stryker's TypeScript checker needs the compiler API that `typescript` 7.0.2 does not expose (R-T10), which is why `tooling/mutation` aliases `typescript` to `@typescript/typescript6`. Without an answer here, `ci.yml › mutation-scoped` and `nightly.yml › mutation` cannot be written as gates, and every mutation number quoted in a milestone exit would be unverified.

## Pinned versions

| Component | Exact version | Where |
|---|---|---|
| `@stryker-mutator/core` | `10.0.0` | `tooling/mutation` |
| `@stryker-mutator/api` | `10.0.0` | transitive |
| `@stryker-mutator/instrumenter` | `10.0.0` | transitive |
| `@stryker-mutator/util` | `10.0.0` | transitive |
| `@stryker-mutator/vitest-runner` | `10.0.0` | `tooling/mutation` (latest published release; there is no 10.0.x patch) |
| `@stryker-mutator/typescript-checker` | `10.0.0` | `tooling/mutation` |
| `vitest` | `5.0.0` | catalog — resolved to **two** physical copies (see Result) |
| `vite` | `8.3.0` | catalog |
| `@fast-check/vitest` | `0.5.0` | catalog |
| `fast-check` | `4.10.0` | catalog |
| `typescript` | `7.0.2` | repository-wide |
| `typescript` → `@typescript/typescript6` | `6.0.2` (its `ts.version` reports `6.0.3`) | `tooling/mutation` alias |
| `vitest` (fallback probe only) | `4.1.11` | throwaway npm project outside the repository |
| Node | `24.11.0` | runner machine |
| pnpm | `12.4.1` | runner machine |
| OS | Windows 11 (10.0.26200), 32 CPUs | runner machine |

`@stryker-mutator/typescript-checker` resolves `typescript` to the `6.0.2` alias, as intended. `@stryker-mutator/core` does **not**: it resolves `typescript` from its own location, which reaches the repository-wide `7.0.2` (see Result, finding 3). The JSON report therefore records `"dependencies": {"@stryker-mutator/typescript-checker": "10.0.0", "typescript": "7.0.2"}`.

## Method

Read `tooling/mutation/package.json`, `stryker.config.jsonc`, `vitest.stryker.config.ts` and `tsconfig.stryker.json` as bootstrapped, then ran the lane over exactly the two files the register names, with `incremental` enabled, and repeated the run against the cache it wrote:

```
# from the repository root
./tooling/mutation/node_modules/.bin/stryker run tooling/mutation/stryker.config.mjs \
  --mutate "packages/contracts/src/tokens.ts,packages/crdt/src/dominates.ts"
```

Four corrections to the lane's configuration were required before a run could start at all; each is recorded under Result with the evidence that forced it, and each is now committed:

1. `tooling/mutation/stryker.config.jsonc` replaced by `tooling/mutation/stryker.config.mjs`.
2. `plugins` added to that config, naming the two plugin entry points by path.
3. `inPlace: true` and `tempDirName: 'tooling/mutation/.stryker-tmp'` added, and every remaining relative path in the config made repository-root-relative (`vitest.configFile`, `incrementalFile`, `htmlReporter.fileName`, `jsonReporter.fileName`), because Stryker has no working-directory option and the `mutate` globs and `tsconfigFile` were already root-relative.
4. `tooling/mutation/tsconfig.stryker.json`'s `include` narrowed from `packages/*/src/**` to the five packages the `mutate` globs actually cover.

A fifth change, `server.deps.inline: ['@fast-check/vitest']` in `vitest.stryker.config.ts`, is not required for the Stryker path and is documented in that file as defensive; it is what makes the same config usable under the lane's own Vitest binary.

Because `stryker run --logLevel debug` itself crashes on Vitest 5 (finding 7), the per-mutant behaviour was observed with a throwaway Stryker plugin that subclasses `VitestTestRunner`, registers itself under the name `vitest`, and appends the arguments and results of every `dryRun`/`mutantRun` to a log. The mechanism was then isolated three further ways: driving `VitestTestRunner` directly in-process; driving `createVitest` directly with the pattern Stryker builds; and reproducing the whole name-matching step in a self-contained npm project (one spec with a two-level `describe`, two plain `it`s and one `it.prop`) against `vitest` 4.1.11 and `vitest` 5.0.0 in turn, using Stryker's own `escapeRegExp` to build the pattern. That project is the fallback validation.

Harness (throwaway, outside the repository): `C:/Users/Vincent/AppData/Local/Temp/claude/D--Repository-Other-iridium/b6d20f0c-f75b-4d68-9394-a22aa8942a89/scratchpad/m0/s5`.

## Result

**fail.** The run completes and the checker reports compile-error mutants, but **no mutant is ever killed**, because every mutant run executes zero tests and Stryker scores a zero-test run as *Survived*. The lane therefore reports a mutation score of **0.00 %** instead of failing loudly — the worst of the available failure modes, because the number is plausible enough to be read as "these tests are weak".

Everything in this section is about `vitest` 5.0.0, which remains unusable with this runner. The fallback recorded below has since been executed and measured: on `vitest` 4.1.11 the same two files score **90.09 %** with 92 mutants killed. See "Fallback executed".

### Measurements

Cold run, then the second run over the cache it wrote, both over the two register files:

| Measurement | Cold run | Second run (cache present) |
|---|---|---|
| Wall clock | 87.4 s | 82.2 s |
| Incremental file | not found; full run performed | loaded: `using incremental report with 200 mutant(s), and 55 test(s)` |
| Mutants instrumented | 200 over 2 files | 200 over 2 files |
| Mutants tested | 140 | 130 (10 of 140 reused) |
| Initial (dry) test run | 55 tests, net 549 ms | 55 tests, net 560 ms |
| Exit code | 1 (score under `break` 70) | 1 |

Report totals, identical on both runs:

| Status | `packages/contracts/src/tokens.ts` | `packages/crdt/src/dominates.ts` | Total |
|---|---|---|---|
| Mutants | 190 | 10 | 200 |
| Ignored (static, `ignoreStatic`) | 60 | 0 | 60 |
| **CompileError** | 26 | 3 | **29** |
| **Survived** | 104 | 7 | **111** |
| **Killed** | 0 | 0 | **0** |
| Timeout | 0 | 0 | 0 |
| No coverage | 0 | 0 | 0 |
| Mutation score (total / covered) | 0.00 % / 0.00 % | 0.00 % / 0.00 % | **0.00 % / 0.00 %** |

Every mutant that was tested carries `testsCompleted: 0` in `reports/mutation/mutation.json` while carrying a non-empty `coveredBy` (nine covering tests for `dominates.ts`), and the clear-text reporter prints `Ran 0.00 tests per mutant on average`.

The compile-error mutants are genuine and correctly attributed — the checker detects them, they are not reported as survived, and they come from seven mutators (`BlockStatement`, `ArithmeticOperator`, `ObjectLiteral`, `ConditionalExpression`, `EqualityOperator`, `LogicalOperator`, `StringLiteral`), each with the compiler's own message, for example:

```
packages/contracts/src/tokens.ts(306,72): error TS2355: A function whose declared type is
neither 'undefined', 'void', nor 'any' must return a value.
```

That half of the pass criterion holds: the `@typescript/typescript6` alias does give `@stryker-mutator/typescript-checker` 10.0.0 a working compiler API, and 29 of 140 tested mutants are removed as uncompilable before a test ever runs.

### Root cause of the zero-test runs

Per mutant, `@stryker-mutator/vitest-runner` 10.0.0 builds a `testNamePattern` from the ids the dry run recorded and writes it onto every `project.config`. It builds each name by joining the suite names and the test name with a **single space** (`dist/src/test-helpers.js`, `collectTestName`: `nameParts.join(' ')`). Vitest 4.1.x matched a pattern against exactly that string (`getTaskFullName(task)` = `` `${suite} ${name}` ``); **Vitest 5.0.0 matches against the name joined with `' > '`**. The pattern therefore matches nothing as soon as a test lives inside a `describe`, the file is collected but every test in it is skipped, and the mutant survives untested. Measured on one spec, with Stryker's own `escapeRegExp`, in the same project with only the Vitest version changed:

| Pattern the runner would build | `vitest` 4.1.11 | `vitest` 5.0.0 |
|---|---|---|
| suite + test joined with `' '` (what Stryker builds) | **1 of 4 tests ran** | 0 of 4 tests ran |
| suite + test joined with `' > '` | 0 of 4 tests ran | **1 of 4 tests ran** |

Confirmed against the real specs too: a pattern built from `packages/contracts/src/tokens.format.unit.spec.ts`'s names runs 0 of 45 tests when space-joined and 1 of 45 when `' > '`-joined.

This is not reachable through configuration. `coverageAnalysis: 'all'` and `'off'` do not help: the runner's injected setup file always collects per-test coverage, so Stryker always has a `coveredBy` list and always passes a `testFilter` (traced: `coverageAnalysis=all` still yields `perTest=9` and a nine-name pattern).

### A second, version-independent defect in the same path

`@fast-check/vitest` 0.5.0 puts a freshly drawn seed into the **registered** test name — `… is reflexive, in both the map and the byte form (with seed=364364020)` — and the seed changes on every run. A pattern derived from the dry run's names can therefore never match a later run's names, on any Vitest version. Measured: the same property test reported `(with seed=-1756262310)` and then `(with seed=1392212847)` on two consecutive runs of the same process. Pinning the seed in the property parameters makes the name stable (`fixed seed leaf (with seed=42)` on both runs, on 4.1.11 and on 5.0.0).

This matters because `packages/crdt/src/dominates.ts` is covered **only** by `dominates.prop.spec.ts`. Fixing the separator alone would leave every mutant in `packages/crdt/src/**` — a mutate glob M1 gates at 70 — untested and reported as survived. It is also why the incremental cache saved almost nothing between the two runs: five of the 55 test names changed, so the coverage identity of everything they touched was invalidated and only 10 of 140 mutants could be reused.

### Findings that had to be fixed before any run could start

1. **A `.jsonc` config cannot be loaded.** `@stryker-mutator/core` 10.0.0 accepts only `json`, `js`, `mjs` and `cjs` (`config/config-file-formats.js`) and `import()`s anything that is not `.json`, so `stryker run stryker.config.jsonc` dies with `ERR_UNKNOWN_FILE_EXTENSION` before reading a single option. Renaming to `.json` would not work either — the file's comments and trailing commas are not JSON. The config is now `tooling/mutation/stryker.config.mjs`, a default-exported object, which keeps the comments; `stryker.config.jsonc` is deleted.
2. **The default plugin glob loads nothing under pnpm.** `plugins: ['@stryker-mutator/*']` is resolved against the directory `@stryker-mutator/core` is installed in, not against the working directory. Under pnpm's isolated layout that directory holds only `api`, `core`, `instrumenter` and `util`, so the glob matches nothing, neither the runner nor the checker is loaded, and the only visible symptom is `WARN OptionsValidator Unknown stryker config option "vitest"` / `"typescriptChecker"` followed by `Cannot find TestRunner plugin "vitest". In fact, no TestRunner plugins were loaded.` A bare `'@stryker-mutator/vitest-runner'` does not fix it either, because the loader's `import()` also resolves from core's own location. The config now names both plugin entry points by path.
3. **The sandbox needs a TypeScript JS API the repository does not have.** With a sandbox, `TSConfigPreprocessor` rewrites `tsconfigFile` through `ts.parseConfigFileTextToJson` from `await import('typescript')`, resolved from core's location — which reaches the repository-wide `typescript` 7.0.2. That package exports none of the JS compiler API (`parseConfigFileTextToJson`, `createProgram`, `createSourceFile`, `readConfigFile`, `parseJsonConfigFileContent`, `sys` are all `undefined`), so the run dies with `TypeError: ts.parseConfigFileTextToJson is not a function`. This is R-T10 reaching a consumer the mitigation did not cover: the `@typescript/typescript6` alias is scoped to `tooling/mutation`, and core does not resolve from there. `inPlace: true` is the one code path that skips the rewrite, and it is correct here for a second reason — it keeps the workspace's real `node_modules` layout, and Stryker restores the originals from `tempDirName` when the run ends (verified: both source files were byte-identical afterwards on every run). **Superseded**: the lane now keeps the sandbox and excludes the tsconfig from it instead, because the checker never reads the sandbox and `inPlace` rewrites live source files under anyone working in the same tree. See "Fallback executed", change 2.
4. **The checker's tsconfig was too wide.** `tsconfig.stryker.json` included `packages/*/src/**/*.ts`, which pulls the React packages into the program; `packages/ui/src/index.ts` then fails with `TS6142: Module './mount.tsx' was resolved to …, but '--jsx' is not set`, and the checker refuses to start when its dry-run compilation reports any error at all, mutant-related or not. `include` now lists exactly the five packages the `mutate` globs cover (`apps/server`, `collab-client`, `contracts`, `crdt`, `markdown`) and compiles clean under the `6.0.2` alias.

### Other observations

5. **Two physical copies of `vitest@5.0.0` are installed.** `msw` has a peer dependency on `typescript`, which resolves to `@typescript/typescript6@6.0.2` inside `tooling/mutation` and to `typescript@7.0.2` everywhere else; that forks the peer set all the way up to `vitest`, so the lockfile carries two `vitest@5.0.0` snapshots and `tooling/mutation/node_modules/vitest` is not the copy `@fast-check/vitest` is linked against. Running the lane's own Vitest binary on `vitest.stryker.config.ts` then fails every property file with `Error: Vitest failed to find the current suite`. Stryker is unaffected, because its `vitest-wrapper` resolves `vitest/node` from the directory the command was launched in (the repository root); the `server.deps.inline` entry now in the config removes the trap for anyone who runs the config directly.
6. **`disableTypeChecks` happens to be harmless here.** Its default pattern is rooted at `{test,src,lib}/**`, which never matches `packages/*/src/**` or `apps/*/src/**`, so Stryker does not insert `// @ts-nocheck` into the mutated files and the checker can still see compile errors. This is luck, not design: a layout with a top-level `src/` would silently lose every compile-error mutant.
7. **`--logLevel debug` crashes the runner.** `VitestTestRunner.init` does `JSON.stringify(this.ctx.config)` when debug logging is on; Vitest 5's resolved config is circular (`resolvedProjects[0].viteConfig.test` closes the circle) and the run dies with `TypeError: Converting circular structure to JSON`. Debugging the mutation lane on Vitest 5 is therefore not possible through Stryker's own logging.
8. **Stray artifacts are written to the working directory.** The runner writes `stryker-setup-<n>.js` next to `process.cwd()` (one per worker) and does not always remove them; `tempDirName` defaults to `.stryker-tmp`. Neither is in `.gitignore`, which currently ignores only `tooling/mutation/reports/`.

## Decision

The mutation lane runs on Stryker 10.0.0 with the `@typescript/typescript6` alias — the checker works and compile-error mutants are detected — but not on Vitest 5.0.0, so `tooling/mutation` pins `vitest` 4.1.11 for itself while every other test project stays on 5.0.0, the runner is made to load that copy rather than the repository's, and the lane's property tests are given a fixed fast-check seed so that the test names Stryker filters on are stable from one run to the next.

## Fallback executed

**Executed and measured on 2026-09-13**, with the M0 mutation-lane work item. The recorded fallback — `vitest` 4.1.11 (`V4`) inside `tooling/mutation` only, never in the main `unit`, `component`, `integration`, `property`, `chaos`, `contract` or `mcp` projects — is the path taken. It is **not sufficient on its own**: it repairs the name-separator mismatch (measured above) but not the per-run fast-check seed, so `packages/crdt/src/**` would still report every mutant as survived. Both recorded changes are in place:

- `pnpm-workspace.yaml` carries a named catalog `mutation` holding `vitest: 4.1.11`, and `tooling/mutation/package.json` depends on `"vitest": "catalog:mutation"` — a named catalog rather than a literal version, because the repository pins exact versions in catalogs only. `pnpm why vitest -r` reports exactly the required shape: `vitest@4.1.11` with `@iridium/mutation` as its only dependent (directly, and through `@stryker-mutator/vitest-runner`), `vitest@5.0.0` for every other workspace package.
- A fixed fast-check seed for the mutation lane: the `PROP` budgets read `IRIDIUM_PROP_SEED` and pass it to fast-check as `seed` when it holds an integer, so the dry run and every mutant run register identical test names. A malformed value throws rather than silently un-fixing the names, because the damage it causes is a plausible-looking score rather than an error. `stryker.config.mjs` sets the variable (to `42`, arbitrary — only its fixedness matters) before Stryker forks anything; children inherit `process.env`. Every other lane leaves it unset and keeps drawing a fresh seed, which is what keeps the property search a search: the `unit` project still reports names like `(with seed=1862124371)`.

Four further changes were needed before the fallback did anything at all. The first is the one that matters.

**1. The runner ignores the pinned Vitest.** `@stryker-mutator/vitest-runner` 10.0.0 does not use the Vitest it was installed against. Its `vitest-wrapper.js` prefers "the project's local Vitest installation", looked up as `createRequire(path.join(process.cwd(), 'package.json')).resolve('vitest/node')`, and the lane runs from the repository root, where `vitest` is 5.0.0; the static fallback import — which pnpm resolves to this package's own 4.1.11 — is reached only if that lookup throws. Measured directly, by importing the wrapper and printing `vitestWrapper.version`:

| Working directory of the test-runner child | Version the runner loads |
|---|---|
| repository root (as launched) | **5.0.0** — the pin has no effect |
| `tooling/mutation` | **4.1.11** |

`tooling/mutation/vitest-resolution.mjs` closes it. Stryker passes `testRunnerNodeArgs` as the child's `execArgv`, so the file is loaded with `--import` before the plugin loader runs; it imports the runner's plugin entry point with the working directory set to this package, restores the directory immediately, and leaves the module in the ES module cache so the plugin loader's own `import()` of the same file URL is a cache hit. It then asserts the resolved major version is 4 and throws if it is not, so a future upgrade cannot quietly return the lane to 0.00 %. Nothing else observes the directory change: the runner's only cwd-relative work, the per-worker `stryker-setup-<n>.js` shim, is a field initialiser that runs when Stryker constructs the runner, after Stryker has changed to the sandbox.

**2. `inPlace` is off and the sandbox is used — finding 3 above is superseded.** The premise of `inPlace: true` was that the sandbox cannot be built without a TypeScript JS API that `typescript` 7.0.2 does not have. The narrower truth is that only Stryker's own `TSConfigPreprocessor` wants that API, and only for a `tsconfigFile` it finds *among the sandboxed files*. The checker does not need the file there at all: `CheckerChildProcessProxy` forks its worker with `process.cwd()`, not the sandbox, so the typescript checker compiles the real sources at the repository root and applies each mutant in memory. One `ignorePatterns` entry for `tooling/mutation/tsconfig.stryker.json` therefore removes the crash, and the lane keeps the sandbox. That is the right trade for a shared workspace: `inPlace` rewrites live source files for the length of a run, where a developer or another agent editing the same tree sees instrumented code. Verified per run — both mutated files byte-identical before and after (md5), no `stryker-setup-*.js` anywhere in the working tree (the shim lands in the sandbox now), no `.stryker-tmp` left behind, and Stryker's `In place mode is enabled, Stryker will be overriding YOUR files` warning never logged.

**3. The checker's program is the register, not the whole server app.** `tsconfig.stryker.json` included `apps/server/src/**/*.ts`, and the checker refuses to start when its dry-run compilation reports any error at all — so `apps/server/src/ops/openapi.ts`, which the register never mutates and which does not compile under either compiler (a `readonly` document literal against `@fastify/swagger`'s mutable `ServerObject[]`), disabled mutation testing for the whole repository. The `include` now mirrors the `mutate` globs file by file, which is the rule finding 4 already applied to the packages. Whole-app type health is `check-types`'s gate, not this one's, and transitive imports are in the program either way.

**4. The lane needs a launcher.** pnpm runs a package script in that package's directory and Stryker's project file set is a walk of `process.cwd()`, so `stryker run stryker.config.mjs` from `tooling/mutation` reads only `tooling/mutation`. `tooling/mutation/run.mjs` changes to the repository root, forwards its arguments and forwards the exit code; the `mutation` script is `node run.mjs`. `tempDirName` is also back to the bare `.stryker-tmp`: the walk that symlinks `node_modules` into the sandbox skips the temp directory by comparing `tempDirName` against a single path segment, so a `tooling/mutation/.stryker-tmp` is never skipped, and every run walks the sandbox it has just filled.

### What the lane measures now

Both runs over the same two register files, on the same machine as the original measurements, `stryker.config.mjs` unchanged between them:

| Measurement | Cold run | Second run (cache present) |
|---|---|---|
| Wall clock | **69 s** (Stryker: 1 minute and 7 seconds) | **8 s** (Stryker: 6 seconds) |
| Incremental file | not found; full run performed | loaded: `using incremental report with 200 mutant(s), and 55 test(s)` |
| Mutant results reused | 0 | **140 of 200** — every tested mutant |
| Mutants instrumented | 200 over 2 files | 200 over 2 files |
| Mutants tested | 140 | 0 |
| Initial (dry) test run | 55 tests, net 561 ms | 55 tests, net 576 ms |
| Exit code | **0** (score above `break` 70) | **0** |

Report totals, identical on both runs:

| Status | `packages/contracts/src/tokens.ts` | `packages/crdt/src/dominates.ts` | Total |
|---|---|---|---|
| Mutants | 190 | 10 | 200 |
| Ignored (static, `ignoreStatic`) | 60 | 0 | 60 |
| **CompileError** | 26 | 3 | **29** |
| **Killed** | 85 | 7 | **92** |
| **Timeout** | 8 | 0 | **8** |
| **Survived** | 11 | 0 | **11** |
| No coverage | 0 | 0 | 0 |
| Mutation score (total / covered) | 89.42 % / 89.42 % | 100.00 % / 100.00 % | **90.09 % / 90.09 %** |

The 111 mutants that survived untested on Vitest 5 are the same 111 that are now 92 killed, 8 timed out and 11 survived; the compile-error count is unchanged at 29, as it should be, because the checker never depended on the runner. `Ran 1.88 tests per mutant on average`, against `0.00` before. The seed is visible in the names Stryker filters on — `tokens.format.prop [area:tokens] the secret never appears in what a failure is allowed to say (with seed=42)` — and the run is reproducible: two cold runs produced identical scores and identical per-status counts.

Every clause of the pass criterion now holds on 4.1.11: the run completes; compile-error mutants are reported as such, with the compiler's own messages (`packages/crdt/src/dominates.ts(13,63): error TS2355: …`); mutants are killed (92) and mutants survive (11); and the incremental file is written and reused. The 8 timeouts are hit-limit detections (`Hit limit reached (14169301/14169300)`), which Stryker counts as detected.

The lane is run as `pnpm --filter @iridium/mutation mutation`, or narrowed with `-- --mutate <globs>`. Gates after the change: `check-types` and `lint` clean for `@iridium/mutation`, `oxfmt --check` clean on every file touched, and the ordinary `unit` project still green for both edited packages (223 tests) with a freshly drawn seed.

## Follow-ups

- **Upstream, `stryker-mutator/stryker-js`:** `@stryker-mutator/vitest-runner` 10.0.0 builds its per-mutant `testNamePattern` with a space-joined test name, which Vitest 5 does not match; the fix is `' > '` (or `getTestName`) for `vitest >= 5`. The reproduction is the four-line spec and the `createVitest` script in this spike's harness. `peerDependencies.vitest` is `>=2.0.0` and should exclude 5 until then.
- **Upstream, `stryker-mutator/stryker-js`:** `VitestTestRunner.init` crashes under `--logLevel debug` on Vitest 5 (`JSON.stringify` of a circular resolved config).
- **Upstream, `stryker-mutator/stryker-js`:** the `@stryker-mutator/*` plugin glob resolves against core's own install directory and so finds nothing under pnpm's isolated layout; and `TSConfigPreprocessor` requires the TypeScript JS API from a `typescript` resolved at core, which cannot be redirected by a per-package alias.
- **Upstream, `stryker-mutator/stryker-js`:** `vitest-wrapper.js` resolves `vitest/node` from `process.cwd()` and only falls back to the copy the plugin was installed against. In a monorepo the working directory is the repository root, so the runner silently uses a different Vitest from the one its own package depends on — which is how a per-package version pin can appear to be in place and do nothing. Resolving from `import.meta.url` first, or at least logging which copy was chosen, would remove a failure mode that is invisible from the outside.
- **`.gitignore`:** done — it now carries `.stryker-tmp/` and `stryker-setup-*.js` alongside `tooling/mutation/reports/`. Both are belt and braces as of the sandbox change: the temp directory is cleaned when a run ends normally, and the per-worker shim is written inside it.
- **`10-testing-and-quality.md`:** the committed mutation-lane configuration in the "Mutation" section is still the original `stryker.config.jsonc` and must be replaced by the file as it now stands — `stryker.config.mjs`, explicit `plugins`, `ignorePatterns`, `testRunnerNodeArgs`, `disableTypeChecks: false`, `tempDirName`, repository-root-relative `vitest.configFile`/`incrementalFile`/reporter filenames — and must say that the lane runs from the repository root through `run.mjs`. The `Shared policy` snippet in the same document should show `IRIDIUM_PROP_SEED` beside `IRIDIUM_PROP_RUNS`, and D10-5's knob list should name it. `12-milestones.md` §4.4's `tooling/mutation` row names the same config file and needs the same correction.
- **`apps/server/src/ops/openapi.ts` does not compile**, under `typescript` 7.0.2 and the `6.0.2` alias alike: a `readonly` OpenAPI document literal is passed where `@fastify/swagger` wants mutable `ServerObject[]` and `TagObject[]`. It is the server package's own `check-types` failure, not the lane's, but it is what forced change 3 above. Reported to the M0 lead.
- **`turbo.json`:** the test task's `env` list is `["IRIDIUM_TEST_SEED", "IRIDIUM_PROP_RUNS", "IRIDIUM_PROP_SIZE"]` and should include `IRIDIUM_PROP_SEED`, or a developer who sets the variable by hand can be served a cached result from a run at a different seed. The mutation lane itself is unaffected, because it sets the variable from `stryker.config.mjs`, which turbo hashes as an input.
- **`packages/testkit/src/property/config.ts`** does not exist yet. When the canonical `PROP` / `PROP_DB` budgets land there they need the same `seedFrom` helper as the two mirrored budgets, so the three stay consistent. The mutation lane does not need it today: it runs the `unit` project only, and `PROP_DB` covers `apps/server/test/property/**`, which the lane never loads.
- **Sandboxed cross-package imports resolve to the real tree.** Stryker symlinks every `node_modules` directory into the sandbox, so a sandboxed spec that imports a *workspace package* by name (`@iridium/contracts`) reaches the real, unmutated sources through the junction, while a relative import (`./tokens.ts`) reaches the mutated copy. Every register file today is covered by specs co-located under the same `src/`, importing relatively, so nothing is affected — but a spec that exercises a mutated module through its package entry point would silently test unmutated code, and that is worth checking as the register grows at M1.
- **Re-score `R-T11`:** Vitest 5.0.0 freshness has fired, not been mitigated; the note above is the evidence. `ASM-23`'s second clause ("Stryker 10 can run against it") is false as stated and should be rewritten to the split this note records: checker yes, runner no.
- **Watch for a `@stryker-mutator/vitest-runner` release that supports Vitest 5** and retire, together, the `vitest` 4.1.11 pin, the `mutation` catalog entry and `tooling/mutation/vitest-resolution.mjs`; 10.0.0 is currently the newest published version, so there is nothing to upgrade to. `vitest-resolution.mjs` throws on any resolved major other than 4, so the upgrade cannot be done by halves.
- **Guard the fallback:** partly closed. `thresholds.break` 70 already makes a 0.00 % run a non-zero exit rather than a quality signal, and `vitest-resolution.mjs` refuses to run when the resolved Vitest is not 4.x, which is the mechanism that would cause it. Still open: a test that asserts a known-weak mutant is actually killed, so that no future change can return the lane to "0.00 %, everything survived" through some path neither guard covers. A mutation score of zero with zero killed mutants is the signature of this class of breakage.
- **Environment note:** this spike ran on Node 24.11.0, below the repository's `engines.node` floor of `>=24.12.0`. Nothing observed here depends on the Node patch level, but the CI lane should run at or above the declared floor.
