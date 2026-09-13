# A1 — Monorepo toolchain: pnpm workspaces + Turborepo, TypeScript 7 native, oxlint/oxfmt, tsdown, Vite 8

**Status:** Accepted (2026-09-11); amended 2026-09-13: a `spikes/*` workspace glob and the `spike` boundary tag join the layout (12-milestones.md D12-5), the catalog is defined as what the manifests declare rather than what the plan pins (knip 6 reports an unused entry), and the single-copy `overrides` list is recorded in full — `@types/node`, `fast-check` and `axe-core` alongside A14's CRDT and CodeMirror entries.

## Context

Iridium is one repository holding a Node 24 server, a browser SPA, an Electron shell, and seven isomorphic or browser-only packages that both apps consume (skeleton §B). The toolchain must give one TypeScript checker for the whole repository, one bundler family for web and desktop, reproducible installs, and supply-chain controls that an enterprise reviewer will accept. Three verified facts shaped the choice (digest §9.2): TypeScript 7.0.2 is the Go-native compiler and ships **no programmatic JS API** (expected in 7.1), so typescript-eslint (peer `<6.1.0`) cannot run on it without the `@typescript/typescript6` alias — i.e. two TypeScripts in one repo; tsup is officially unmaintained ("consider using tsdown"); and Nx deprecated all free self-hosted remote-cache packages after CVE-2025-36852 and shipped malicious versions in the "s1ngularity" incident (CVE-2025-10894). Vite 8 replaces esbuild/Rollup with Rolldown/Oxc, and `@vitejs/plugin-react` 6.1.1 peers on Vite 8; electron-vite 5 supports only Vite ≤7 (digest §4.2, §9.2).

## Decision

pnpm 12.4.1 workspaces (`apps/*`, `packages/*`, `tooling/*`, `spikes/*`) with `catalog:` in `strict` mode, `saveExact`, `minimumReleaseAge 4320`, `trustPolicy no-downgrade`, and an explicit `allowBuilds: {electron, lefthook, @node-rs/argon2, esbuild}`; the catalog carries every version a manifest in the repository declares and nothing else, because knip 6 reports an unused catalog entry — a version this plan pins for a later milestone waits in 02-system-architecture.md's dependency table until the milestone that declares it (amended 2026-09-13); Turborepo 2.10.12 for the task graph with the experimental `boundaries` tags of skeleton §B.2 (dependency-cruiser 18.2.0 as the fallback checker); TypeScript 7.0.2 installed plain (no alias) repository-wide with `erasableSyntaxOnly`, `verbatimModuleSyntax`, `isolatedDeclarations`, `target es2024`, explicit `.ts` import extensions, ESM only; oxlint 1.82.0 with oxlint-tsgolint 7.0.2001 (type-aware) and oxfmt 0.67.0; tsdown 0.23.0 for Node bundles (server, bridge, Electron main/preload); Vite 8.3.0 + @vitejs/plugin-react 6.1.1 for browser bundles (web and Electron renderer share one config); lefthook 2.1.12, @commitlint/cli 21.2.2, @changesets/cli 3.0.2 with `privatePackages: {version: true, tag: true}` and one `fixed` group so the repository has one product version; renovate `config:best-practices`; knip 6.35.1; mise + `.node-version`; `.gitattributes * text=auto eol=lf`. Packages are classified compiled (`tsc -b` with declarations) or JIT (exports `./src/*`, compiled by the consuming Vite build) exactly as skeleton §B lists them.

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| Nx 23 | Larger trust surface for less need; free remote-cache plugins deprecated after CVE-2025-36852; 2025 npm supply-chain incident; Turborepo covers `--affected`, `prune --docker`, `boundaries`. |
| ESLint 10 + typescript-eslint via the `@typescript/typescript6` alias repo-wide | Requires a second TypeScript everywhere; type-aware rules would then check against TS 6 semantics while `tsc` builds with TS 7. tsgolint covers 59 of 61 typed rules on the same checker. |
| Prettier 3.9.6 | Kept as the documented drop-in (`oxfmt --migrate prettier` is reversible) if oxfmt's pre-1.0 churn becomes unacceptable; not the default because oxfmt passes Prettier's JS/TS conformance suite and adds import/Tailwind sorting natively. |
| Biome 2.x | Its own type inference, not the TypeScript checker; materially narrower typed-rule coverage. |
| tsx / tsup / esbuild | Node 24 strips types natively for the dev loop; tsup unmaintained; esbuild no longer part of Vite. |
| Vite+ 0.3 | Pre-1.0 and not a Turborepo-class task graph. |
| TypeScript project references | Turborepo's guidance recommends per-package `check-types` with `dependsOn: ['topo']`; references add a second cache layer. |

## Consequences

Positive: a single checker and single Vite major across web and desktop; `erasableSyntaxOnly` makes every package runnable by Node's native type stripping and structurally excludes decorator frameworks; `minimumReleaseAge` (3 days, above Renovate's `security:minimumReleaseAgeNpm`) and `trustPolicy` give a stated supply-chain posture; the catalog-matches-manifests rule keeps `knip --production` green without an exception list at the catalog level; one `fixed` Changesets group means server image, web bundle, installers, and bridge always share a version (needed by A54). Negative: oxfmt is pre-1.0 (documented Prettier fallback); `turbo boundaries` is experimental (dependency-cruiser fallback); oxlint JS plugins are alpha, so custom lint rules are written as `no-restricted-imports` patterns or as tests (the guard tests of A51); type-aware oxlint in a monorepo needs dependents' built `.d.ts`, so `lint` depends on `^build` in `turbo.json`; `turbo prune --docker` previously dropped unknown `pnpm-lock.yaml` settings (issue #12442, fixed) — the CI Docker build installs with `--frozen-lockfile` from the pruned lockfile to catch any regression.

## Verification

M0 exit: `pnpm turbo run build check-types lint test` green on ubuntu and windows; `gen-drift` job green (A3); `deps.single-instance.guard` test (A14); boundaries job (`turbo boundaries`, or dependency-cruiser) green; `knip --production` clean; Docker image builds from the pruned lockfile with `pnpm install --frozen-lockfile`; the Turbo `envMode: strict` env lists are diffed against `EnvSchema` keys in CI (skeleton §B.2 invariant).

## References

Digest §9.1–§9.5, §11.19, §11.20, §4.2 (Vite 8 / electron-vite matrix); plan-risk-first ADR-18; plan-product-dx 001/002; plan-enterprise ADR-26; plan-agent-first ADR-22. Implemented in `02-system-architecture.md` (repository layout) and `10-testing-and-quality.md` (CI).

---

Source: docs/plan/13-decision-log.md, decision A1. This file is a faithful copy of that entry's Status, Context, Decision, Alternatives considered, Consequences, Verification and References fields; the decision log remains the authoritative, continuously-maintained record (status supersessions are recorded there first).
