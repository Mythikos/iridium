# A2 — Mutation-testing lane isolated with its own TypeScript 6 alias

**Status:** Accepted (2026-09-11); amended 2026-09-13 (see Amendment below).

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

Positive: compile-error mutants are detected; the second TypeScript is confined to devDependency-only leaf packages that nothing imports (one at acceptance; two after the 2026-09-13 amendment). Negative: Stryker forces `bail: 1`, single-threaded workers, coverage off, and does not support Browser Mode, so only the `unit` project is mutated (component/integration lanes are not); the Vitest 5 compatibility is unverified until the spike.

## Verification

M0 spike `docs/spikes/S05-stryker-vitest5.md` (records whether the `V4` fallback was taken); nightly `mutation` job with `break` enforced; M1 gate: Stryker ≥ 70 on `auth/**`, `authz/**`, `tokens`, `collab/persistence/**`, `@iridium/crdt`; M8 gate: `break 80`.

## Amendment (2026-09-13)

`openapi-typescript` 7.13.0, which `pnpm gen` step 3 runs to produce `packages/api-client/src/generated/paths.d.ts`, prints its output through TypeScript's JavaScript compiler API (`ts.factory`) and fails under TypeScript 7.0.2 with `Cannot read properties of undefined (reading 'createKeywordTypeNode')`. This was found the first time the pipeline ran at M0; the plan had assumed the toolchain needed no consumer of the API beyond Stryker (ASM-22).

The isolation this decision established is applied a second time rather than widened: a second leaf package, `tooling/api-codegen` (`@iridium/api-codegen`), declares `openapi-typescript` and its own `"typescript": "npm:@typescript/typescript6@6.0.2"`, has no sources and no scripts, and is what `scripts/lib/tools.ts` resolves the generator from. `@iridium/api-client` keeps owning the artefact and compiles it with TypeScript 7 like every other package. Two `pnpm-workspace.yaml` changes accompany it. `peerDependencyRules.allowedVersions` accepts TypeScript 6 for the `openapi-typescript>typescript` peer only (the package declares `^5.x`; the 6.0 API is the 5.x API with deprecations). And the `mutation` named catalog, which already pinned `vitest: 4.1.11` for this lane, now also pins that line's companions — `@vitest/browser`, `@vitest/browser-playwright`, `@vitest/coverage-v8` and `@vitest/ui`, all four at 4.1.11 — which `tooling/mutation` declares so that pnpm never pairs a Vitest 4 optional peer with the 5.0.0 copy the rest of the graph holds. Those five entries are the whole catalog: `playwright` is not among them, because nothing about the browser driver belongs to a Vitest line, and `tooling/mutation` takes it from the default `catalog:` as every other package does. The workspace keeps pnpm's **default** peer resolution, with the workspace root as fallback, precisely so that one Vitest 5 instance is shared by the root runner and every package: an earlier attempt at `resolvePeersFromWorkspaceRoot: false` split Vitest 5 into a root copy and a per-package copy and broke `@fast-check/vitest`'s `it.prop` with "Vitest failed to find the current suite", and a second attempt to strip the unused peers with `vitest@4>@vitest/*` overrides was dropped in favour of the named catalog. `guards.mutation-lane.guard`'s rule is that those two manifests, and no others, may carry the alias: it parses every workspace manifest and fails if `@typescript/typescript6` appears anywhere else.

Rejected while amending: a `pnpm.overrides` entry `openapi-typescript>typescript` pointing at the alias (pnpm does not apply an `npm:` alias override to a peer dependency; the peer kept resolving to 7.0.2); declaring the alias in `packages/api-client` (its `tsc` would become TypeScript 6); a third TypeScript at 5.9.3 (satisfies the declared range but contradicts the single-alias rule for no gain).

## References

Digest §8.2 (Stryker 10, TS 7 API), §11.19, §11.21; plan-risk-first §9 harnesses; plan-product-dx 030 (the rejected `checkers: []` option). Implemented in `10-testing-and-quality.md`.

---

Source: docs/plan/13-decision-log.md, decision A2. This file is a faithful copy of that entry's Status, Context, Decision, Alternatives considered, Consequences, Verification and References fields; the decision log remains the authoritative, continuously-maintained record (status supersessions are recorded there first).
