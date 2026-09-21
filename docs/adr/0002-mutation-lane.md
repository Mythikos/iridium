# A2 — Mutation-testing lane isolated with its own TypeScript 6 alias

**Status:** Accepted (2026-09-11); amended 2026-09-13 and 2026-09-20 (see Amendments below).

## Context

StrykerJS 10.0.0's `typescript-checker` needs the TypeScript compiler API, which TypeScript 7.0.2 does not provide (digest §8.2). A1 keeps the main workspace on plain TS 7. Two source plans (enterprise, product-dx) resolved this by running Stryker with `checkers: []`, accepting that compile-error mutants are only killed if a test happens to exercise them. The risk-first plan kept the checker by isolating it. The judge panel grafted the isolation.

## Decision

A dedicated workspace package `tooling/mutation` (`@iridium/mutation`) declares its own `"typescript": "npm:@typescript/typescript6@6.0.2"` alias and runs `@stryker-mutator/core`, `@stryker-mutator/vitest-runner`, and `@stryker-mutator/typescript-checker`, all 10.0.0, with `incremental: true` (`reports/stryker-incremental.json`), `checkers: ['typescript']`, thresholds `high 90 / low 75 / break 70`, raised to `break 80` by M8, against `vitest.stryker.config.ts` (the `unit` Vitest project only). If the M0 spike shows Stryker 10's vitest-runner cannot drive Vitest 5.0.0, this lane alone pins Vitest `V4` (4.1.11); the main workspace stays on Vitest 5. The lane runs in `nightly.yml`.

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| Stryker with `checkers: []` (enterprise, product-dx) | Compile-error mutants survive unless a test incidentally covers them; on authorization code that is exactly the wrong place to lose signal. |
| Alias `@typescript/typescript6` repository-wide | Contradicts A1: two TypeScripts and two rule semantics across the codebase for the sake of one nightly tool. |
| Skip mutation testing | Coverage percentages alone do not prove that `authorize()`, the token verifier, and the persistence writer are asserted, only that they are executed. |

## Consequences

Positive: compile-error mutants are detected; the second TypeScript is confined to devDependency-only leaf packages that nothing imports (one at acceptance; two after the 2026-09-13 amendment; three after the 2026-09-20 amendment). Negative: Stryker forces `bail: 1`, single-threaded workers, coverage off, and does not support Browser Mode, so only the `unit` project is mutated (component/integration lanes are not); the Vitest 5 compatibility is unverified until the spike.

## Verification

M0 spike `docs/spikes/S05-stryker-vitest5.md` (records whether the `V4` fallback was taken); nightly `mutation` job with `break` enforced; M1 gate: Stryker ≥ 70 on `auth/**`, `authz/**`, `tokens`, `collab/persistence/**`, `@iridium/crdt`; M8 gate: `break 80`.

## Amendment (2026-09-13)

`openapi-typescript` 7.13.0, which `pnpm gen` step 3 runs to produce `packages/api-client/src/generated/paths.d.ts`, prints its output through TypeScript's JavaScript compiler API (`ts.factory`) and fails under TypeScript 7.0.2 with `Cannot read properties of undefined (reading 'createKeywordTypeNode')`. This was found the first time the pipeline ran at M0; the plan had assumed the toolchain needed no consumer of the API beyond Stryker (ASM-22).

The isolation this decision established is applied a second time rather than widened: a second leaf package, `tooling/api-codegen` (`@iridium/api-codegen`), declares `openapi-typescript` and its own `"typescript": "npm:@typescript/typescript6@6.0.2"`, has no sources and no scripts, and is what `scripts/lib/tools.ts` resolves the generator from. `@iridium/api-client` keeps owning the artefact and compiles it with TypeScript 7 like every other package. Two `pnpm-workspace.yaml` changes accompany it. `peerDependencyRules.allowedVersions` accepts TypeScript 6 for the `openapi-typescript>typescript` peer only (the package declares `^5.x`; the 6.0 API is the 5.x API with deprecations). And the `mutation` named catalog, which already pinned `vitest: 4.1.11` for this lane, now also pins that line's companions — `@vitest/browser`, `@vitest/browser-playwright`, `@vitest/coverage-v8` and `@vitest/ui`, all four at 4.1.11 — which `tooling/mutation` declares so that pnpm never pairs a Vitest 4 optional peer with the 5.0.0 copy the rest of the graph holds. Those five entries are the whole catalog: `playwright` is not among them, because nothing about the browser driver belongs to a Vitest line, and `tooling/mutation` takes it from the default `catalog:` as every other package does. The workspace keeps pnpm's **default** peer resolution, with the workspace root as fallback, precisely so that one Vitest 5 instance is shared by the root runner and every package: an earlier attempt at `resolvePeersFromWorkspaceRoot: false` split Vitest 5 into a root copy and a per-package copy and broke `@fast-check/vitest`'s `it.prop` with "Vitest failed to find the current suite", and a second attempt to strip the unused peers with `vitest@4>@vitest/*` overrides was dropped in favour of the named catalog. At that amendment, `guards.mutation-lane.guard` allowed the alias in exactly those two manifests and scanned every workspace for other carriers; the 2026-09-20 amendment below adds one named leaf.

Rejected while amending: a `pnpm.overrides` entry `openapi-typescript>typescript` pointing at the alias (pnpm does not apply an `npm:` alias override to a peer dependency; the peer kept resolving to 7.0.2); declaring the alias in `packages/api-client` (its `tsc` would become TypeScript 6); a third TypeScript at 5.9.3 (satisfies the declared range but contradicts the single-alias rule for no gain).

## Amendment (2026-09-20)

S11 executed A42's parser fallback after the representative preview missed the 100 ms gate. Keeping the complete worker payload below 120,000 gzip bytes required a narrow packaging patch to `markdown-it` 15.0.2 that exposes its shared token engine while preserving the upstream root API and grammar sources. `spikes/s11-markdown/make-parser-patch.mjs` uses TypeScript's JavaScript AST parser, transformation factory and printer to reproduce that patch from verified upstream bytes; the native TypeScript 7 compiler has no corresponding API. This is tooling for reproducing a dependency patch, not another product compiler.

The private, `spike`-tagged leaf `spikes/s11-markdown` (`@iridium/spike-s11-markdown`) therefore declares the same exact `"typescript": "npm:@typescript/typescript6@6.0.2"` devDependency. Together with `tooling/mutation/package.json` and `tooling/api-codegen/package.json`, `spikes/s11-markdown/package.json` is the entire alias inventory. No product may import these leaves; no alias is added to a workspace catalog or override, and all product builds and type checks remain on TypeScript 7. The guard enumerates every workspace, compares these three exact paths, and proves that a fourth product or spike manifest fails. Remove the S11 exception when the patch is retired in favor of an equivalent upstream token entry that passes the full semantic matrix and complete-worker size gate. Patch maintenance, source hashes and retained measurements are in `spikes/s11-markdown/PARSER-PATCH.md` and `docs/spikes/S11-markdown-engine-cost.md`.

## References

Digest §8.2 (Stryker 10, TS 7 API), §11.19, §11.21; plan-risk-first §9 harnesses; plan-product-dx 030 (the rejected `checkers: []` option). Implemented in `10-testing-and-quality.md`.

---

Source: docs/plan/13-decision-log.md, decision A2. This file is a faithful copy of that entry's Status, Context, Decision, Alternatives considered, Consequences, Verification and References fields; the decision log remains the authoritative, continuously-maintained record (status supersessions are recorded there first).

## M1 report-isolation amendment (2026-09-18)

Stryker's project walker does not consult `.gitignore`; root `reports/` is excluded explicitly because it contains generated evidence and sealed historical checkouts. The installed walker comparison confirms that this changes neither configured mutation sources nor selected unit tests. The configured mutate globs, thresholds, concurrency and deadlines remain unchanged. The fresh full-scope runner starts with no input cache and proves zero reused results; its written incremental file is retained as output evidence.

Source: `docs/plan/13-decision-log.md`, M1 independent-review amendments, D10 mutation report isolation.
