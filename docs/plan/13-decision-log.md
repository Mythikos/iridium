# Decision log (ADRs)

This file is the authoritative record of every settled architecture decision for Iridium. Areas 1–8 correspond one-to-one with the rows of the decision skeleton (A1–A57) plus the single limits policy (A.1), and were all accepted on 2026-09-11. Area 9 holds the ADRs the project owner's answers of **2026-09-12** produced: the log is no longer one-to-one with the skeleton, and it now carries its first **superseded** and **superseded in part** statuses. Nothing here is provisional.

The eight questions of `14-risks-and-open-questions.md` §G were all answered on 2026-09-12. Four answers changed a settled decision and produced an Area 9 ADR — G1 (native connectors: yes) → AG1, G3 (MySQL 8 required: yes) → A59, G6 (desktop is the supported client at 1.0) → AG6, G8 (unsigned zipped bundles at 1.0) → the amendments to A53. Four answers confirmed the default the ADR already stated — G2, G4, G5 and G7 — and are recorded in the **Status** and **References** lines of the ADRs they confirm and in "Decisions settled by the owner's answers of 2026-09-12" near the end of this file. No ADR below depends on an unanswered question any more.

An implementer (human or agent) should treat this log as the "why" behind the plan: the other sections say *what* to build; this section says which alternatives were weighed, what was rejected and for which reason, what each choice costs, and — critically — which spike, test, or CI check proves the decision holds. Where a decision was terse in the skeleton, the detail here is drawn from the research digest (`research-digest.md`, cited as "digest §n.m") and from the four source plans (`plan-risk-first`, `plan-agent-first`, `plan-enterprise-first`, `plan-product-dx-first`, cited by their own ADR numbers).

## How to read this log

Every ADR carries the same fields, in the same order:

| Field | Meaning |
|---|---|
| **Id / title** | The skeleton id (`A1`…`A57`, `A.1`), a later `A<nn>` for an ADR that supersedes a skeleton row in full, or an `AG<n>` for an owner answer that changes several ADRs in part. The id is stable and is what other plan sections cite. |
| **Status** | `Accepted (<date>)` for a live decision; `Superseded by <id> (<date>)` for one replaced in full; `Superseded in part by <id> (<date>)`, naming the clause, for one replaced only there (D13-14); `deprecated` for one withdrawn without a replacement. An accepted ADR's *Decision* text is never **silently** edited: the text as accepted is kept and labelled, and the superseding decision is written beside it under an inline **Superseded …** marker naming the superseding id and the date, so a reader sees both what was decided and what replaced it. A **Status** line may also record that an owner answer *confirmed* the decision, which changes nothing else in the entry. |
| **ADR file** | The path under `docs/adr/` seeded at M0 (see "Decisions made in this section"). |
| **Context** | The forces: spec requirements, verified library facts, threats, and the contested points among the source plans. |
| **Decision** | The exact decision, with exact versions, names, paths, and values. This is normative. |
| **Alternatives considered** | Each rejected option and the concrete reason it lost. |
| **Consequences** | Positive and negative, including the follow-on obligations the decision creates for other sections. |
| **Verification** | How the decision is validated: the named spike (`docs/spikes/*.md`), the named test(s), or the CI check. |
| **References** | Digest sections, spec sections, source-plan ADRs, and the plan sections that implement the decision. |

Version numbers are exact pins from the digest (verified as of 2026-09-11); items the digest did not cover are marked "pin at M0" and receive an exact pin plus a license check during repository bootstrap (`12-milestones.md`, M0).

**Test names in a Verification block are citations, never coinages.** Every `<area>.<subject>.<layer>` name below exists in the named test inventory of `10-testing-and-quality.md`, which owns file names, projects and lanes; `scripts/check-test-name-references.ts` in the `static` job greps every plan and `docs/` markdown file for that pattern and fails on a name absent from `docs/acceptance-map.json`, printing the canonical spelling from that section's "Superseded spellings" table. A Verification field is therefore normative about *what* is proven and cites the inventory for *where* it is proven (D13-5). Where an assertion is a CI step rather than a spec file — the license scan, `gen-drift`, Schemathesis, Redocly lint — this log names the step and the script instead of inventing a test name.

### Decision-id prefixes

Each plan section ends with a "Decisions made in this section" table whose ids this log merges as ADRs, and two sections keep a prefix that predates the dominant `D<NN>-<n>` form. The table below is the complete set, so a reader who meets an id anywhere in the plan can tell which section owns it. Superseded spellings are listed because they still appear in cross-references written before the renumbering; a citation using one resolves to the same decision.

| Section | Prefix in use | Superseded spellings |
|---|---|---|
| `01-vision-scope-and-principles.md` | `D01-` | — |
| `02-system-architecture.md` | `ARCH-` | — |
| `03-data-model.md` | `D03-` | `D3-` |
| `04-auth-and-access-control.md` | `D04-` | — |
| `05-collaboration-and-durability.md` | `D05-` | `D-05-` |
| `06-mcp-and-agent-access.md` | `D06-` | — |
| `07-client-applications.md` | `D07-` | — |
| `08-markdown-pipeline-import-export.md` | `D08-` | — |
| `09-api-reference.md` | `D09-` | — |
| `10-testing-and-quality.md` | `D10-` | `TQ-` |
| `11-operations-and-deployment.md` | `OPS-` | — |
| `12-milestones.md` | `D12-` | — |
| `13-decision-log.md` | `D13-` | — |
| `14-risks-and-open-questions.md` | `D14-` | — |
| Owner answers to open questions G1–G8 | `AG` (`AG1`…`AG8`) | — |

`A<n>` (this log, from the skeleton), `F<n>` (spec deviations, `01-vision-scope-and-principles.md`), `T<n>` (threat-model rows, `04-auth-and-access-control.md` §12), `P<n>` (principles, `01-vision-scope-and-principles.md`), `G<n>` (the eight questions of `14-risks-and-open-questions.md` §G, all answered on 2026-09-12 — the namespace names an answered decision, not an open one), `HP-<n>` (hard properties, `10-testing-and-quality.md`) and the `R-T`/`R-P`/`R-O`, `S<n>` and `ASM-<n>` families of `14-risks-and-open-questions.md` are separate namespaces and never collide with a `D`-prefixed section id.

An owner answer that changes a settled decision becomes an ADR of its own, numbered `AG<n>` after the open question it answers, and the ADRs it supersedes record that in their **Status** line rather than having their *Decision* text edited. The numbering is deliberate: it is collision-free when several answers land at once, and it says on its face which question produced the decision. An answer that supersedes one skeleton ADR **in full** instead takes the next free `A<nn>` in sequence, because the log's Areas 1–8 are read by subsystem and a replacement should carry a number in the same series as the thing it replaces; the entry itself still sits in Area 9 with the other answers, and the superseded ADR's own **Status** line is what carries a subsystem reader to it — which is why G3's answer is `A59` (it replaces A9 outright) while G1's and G6's are `AG1` and `AG6` (each changes several ADRs in part). An `AG<n>` ADR has no number of its own to derive a file name from, so it takes the next free file number under `docs/adr/` in the order the answers are recorded (D13-13). The G1 change specification called `AG1` "ADR-15a" before this convention existed; a citation using that spelling resolves to `AG1`.

### Areas

| Area | ADRs |
|---|---|
| 1. Repository, toolchain, and delivery | A1, A2, A3, A4, A51, A52, A54, A56 |
| 2. HTTP server, validation, and data layer | A5, A6, A7, A8, A9, A10, A11, A12, A13 |
| 3. Collaboration engine and durability | A14, A15, A16, A17, A18, A19, A20, A21, A22, A50, A.1 |
| 4. Identity, sessions, and authorization | A23, A24, A25, A26, A27, A28, A29, A30, A31 |
| 5. MCP and agent access | A32, A33, A34, A35, A36, A37, A38 |
| 6. Content pipeline, search, attachments, and portability | A39, A42, A43, A44, A45 |
| 7. Client applications | A40, A41, A53, A55 |
| 8. Audit, backup, operations, and threat model | A46, A47, A48, A49, A57 |
| 9. Owner answers to the open questions (2026-09-12) | AG1, A59, AG6 |

### Decision dependencies

The decisions are not independent. The diagram shows the load-bearing chains: a change to an upstream node would reopen every node below it. Implementers should read the upstream ADRs of any decision they touch.

```mermaid
flowchart LR
  A14[A14 Yjs v13, one instance] --> A15[A15 V2 snapshot + V1 log]
  A15 --> A16[A16 update log, compaction, checkpoints]
  A17[A17 Hocuspocus embedded] --> A19[A19 Saved ack protocol]
  A16 --> A19
  A19 --> A21[A21 NoteWriter FIFO + backpressure]
  A21 --> A50[A50 admission control]
  A19 --> A38[A38 projection freshness]
  A38 --> A37[A37 ContentReadCore]
  A37 --> A34[A34 MCP tools + resources]
  A30[A30 permission matrix] --> A31[A31 PAT model]
  A31 --> A33[A33 MCP authentication]
  A33 --> A32[A32 MCP transport]
  A33 --> AG1[AG1 OAuth AS, second mount]
  A26 --> AG1
  A23 --> AG1
  A9[A9 MySQL version] --> A59[A59 two required MySQL lines]
  A55[A55 a11y, i18n, browsers] --> AG6[AG6 supported clients at 1.0]
  A23[A23 live revocation] --> A20[A20 role change on live connection]
  A26[A26 session model] --> A24[A24 collab tickets]
  A24 --> A17
  A12[A12 tree model] --> A13[A13 version CAS + If-Match]
  A42[A42 markdown pipeline] --> A39[A39 search]
  A42 --> A45[A45 import/export]
  A42 --> A43[A43 Obsidian syntax]
  A46[A46 audit chain] --> A47[A47 backup/restore]
  A7[A7 Kysely migrations] --> A8[A8 DB roles]
  A8 --> A46
  A1[A1 toolchain] --> A2[A2 mutation lane]
  A1 --> A51[A51 test harnesses]
  A51 --> A52[A52 CI]
```

---

## Area 1 — Repository, toolchain, and delivery

### A1 — Monorepo toolchain: pnpm workspaces + Turborepo, TypeScript 7 native, oxlint/oxfmt, tsdown, Vite 8

**Status.** Accepted (2026-09-11); **amended 2026-09-13**: a `spikes/*` workspace glob and the `spike` boundary tag join the layout (12-milestones.md D12-5), the catalog is defined as what the manifests declare rather than what the plan pins (knip 6 reports an unused entry), and the single-copy `overrides` list is recorded in full — `@types/node`, `fast-check` and `axe-core` alongside A14's CRDT and CodeMirror entries. **ADR file.** `docs/adr/0001-monorepo-toolchain.md`.

**Context.** Iridium is one repository holding a Node 24 server, a browser SPA, an Electron shell, and seven isomorphic or browser-only packages that both apps consume (skeleton §B). The toolchain must give one TypeScript checker for the whole repository, one bundler family for web and desktop, reproducible installs, and supply-chain controls that an enterprise reviewer will accept. Three verified facts shaped the choice (digest §9.2): TypeScript 7.0.2 is the Go-native compiler and ships **no programmatic JS API** (expected in 7.1), so typescript-eslint (peer `<6.1.0`) cannot run on it without the `@typescript/typescript6` alias — i.e. two TypeScripts in one repo; tsup is officially unmaintained ("consider using tsdown"); and Nx deprecated all free self-hosted remote-cache packages after CVE-2025-36852 and shipped malicious versions in the "s1ngularity" incident (CVE-2025-10894). Vite 8 replaces esbuild/Rollup with Rolldown/Oxc, and `@vitejs/plugin-react` 6.1.1 peers on Vite 8; electron-vite 5 supports only Vite ≤7 (digest §4.2, §9.2).

**Decision.** pnpm 12.4.1 workspaces (`apps/*`, `packages/*`, `tooling/*`, `spikes/*`) with `catalog:` in `strict` mode, `saveExact`, `minimumReleaseAge 4320`, `trustPolicy no-downgrade`, and an explicit `allowBuilds: {electron, lefthook, @node-rs/argon2, esbuild}`; the catalog carries every version a manifest in the repository declares and nothing else, because knip 6 reports an unused catalog entry — a version this plan pins for a later milestone waits in 02-system-architecture.md's dependency table until the milestone that declares it (amended 2026-09-13); Turborepo 2.10.12 for the task graph with the experimental `boundaries` tags of skeleton §B.2 (dependency-cruiser 18.2.0 as the fallback checker); TypeScript 7.0.2 installed plain (no alias) repository-wide with `erasableSyntaxOnly`, `verbatimModuleSyntax`, `isolatedDeclarations`, `target es2024`, explicit `.ts` import extensions, ESM only; oxlint 1.82.0 with oxlint-tsgolint 7.0.2001 (type-aware) and oxfmt 0.67.0; tsdown 0.23.0 for Node bundles (server, bridge, Electron main/preload); Vite 8.3.0 + @vitejs/plugin-react 6.1.1 for browser bundles (web and Electron renderer share one config); lefthook 2.1.12, @commitlint/cli 21.2.2, @changesets/cli 3.0.2 with `privatePackages: {version: true, tag: true}` and one `fixed` group so the repository has one product version; renovate `config:best-practices`; knip 6.35.1; mise + `.node-version`; `.gitattributes * text=auto eol=lf`. Packages are classified compiled (`tsc -b` with declarations) or JIT (exports `./src/*`, compiled by the consuming Vite build) exactly as skeleton §B lists them.

**Alternatives considered.**

| Alternative | Why rejected |
|---|---|
| Nx 23 | Larger trust surface for less need; free remote-cache plugins deprecated after CVE-2025-36852; 2025 npm supply-chain incident; Turborepo covers `--affected`, `prune --docker`, `boundaries`. |
| ESLint 10 + typescript-eslint via the `@typescript/typescript6` alias repo-wide | Requires a second TypeScript everywhere; type-aware rules would then check against TS 6 semantics while `tsc` builds with TS 7. tsgolint covers 59 of 61 typed rules on the same checker. |
| Prettier 3.9.6 | Kept as the documented drop-in (`oxfmt --migrate prettier` is reversible) if oxfmt's pre-1.0 churn becomes unacceptable; not the default because oxfmt passes Prettier's JS/TS conformance suite and adds import/Tailwind sorting natively. |
| Biome 2.x | Its own type inference, not the TypeScript checker; materially narrower typed-rule coverage. |
| tsx / tsup / esbuild | Node 24 strips types natively for the dev loop; tsup unmaintained; esbuild no longer part of Vite. |
| Vite+ 0.3 | Pre-1.0 and not a Turborepo-class task graph. |
| TypeScript project references | Turborepo's guidance recommends per-package `check-types` with `dependsOn: ['topo']`; references add a second cache layer. |

**Consequences.** Positive: a single checker and single Vite major across web and desktop; `erasableSyntaxOnly` makes every package runnable by Node's native type stripping and structurally excludes decorator frameworks; `minimumReleaseAge` (3 days, above Renovate's `security:minimumReleaseAgeNpm`) and `trustPolicy` give a stated supply-chain posture; the catalog-matches-manifests rule keeps `knip --production` green without an exception list at the catalog level; one `fixed` Changesets group means server image, web bundle, installers, and bridge always share a version (needed by A54). Negative: oxfmt is pre-1.0 (documented Prettier fallback); `turbo boundaries` is experimental (dependency-cruiser fallback); oxlint JS plugins are alpha, so custom lint rules are written as `no-restricted-imports` patterns or as tests (the guard tests of A51); type-aware oxlint in a monorepo needs dependents' built `.d.ts`, so `lint` depends on `^build` in `turbo.json`; `turbo prune --docker` previously dropped unknown `pnpm-lock.yaml` settings (issue #12442, fixed) — the CI Docker build installs with `--frozen-lockfile` from the pruned lockfile to catch any regression.

**Verification.** M0 exit: `pnpm turbo run build check-types lint test` green on ubuntu and windows; `gen-drift` job green (A3); `deps.single-instance.guard` test (A14); boundaries job (`turbo boundaries`, or dependency-cruiser) green; `knip --production` clean; Docker image builds from the pruned lockfile with `pnpm install --frozen-lockfile`; the Turbo `envMode: strict` env lists are diffed against `EnvSchema` keys in CI (skeleton §B.2 invariant).

**References.** Digest §9.1–§9.5, §11.19, §11.20, §4.2 (Vite 8 / electron-vite matrix); plan-risk-first ADR-18; plan-product-dx 001/002; plan-enterprise ADR-26; plan-agent-first ADR-22. Implemented in `02-system-architecture.md` (repository layout) and `10-testing-and-quality.md` (CI).

### A2 — Mutation-testing lane isolated with its own TypeScript 6 alias

**Status.** Accepted (2026-09-11); **amended 2026-09-13**: the isolation pattern applies to a second consumer of the TypeScript compiler API, `openapi-typescript` 7.13.0, whose type printer calls `ts.factory` and therefore fails under TypeScript 7.0.2 (found when `pnpm gen` step 3 first ran at M0). It is declared by a second leaf package, `tooling/api-codegen` (`@iridium/api-codegen`), with its own `"typescript": "npm:@typescript/typescript6@6.0.2"` and no sources; `peerDependencyRules.allowedVersions` in `pnpm-workspace.yaml` accepts TypeScript 6 for the `openapi-typescript>typescript` peer only, and the `mutation` named catalog carries exactly five entries — `vitest`, `@vitest/browser`, `@vitest/browser-playwright`, `@vitest/coverage-v8` and `@vitest/ui`, all at 4.1.11 — so that lane's peers stay inside one Vitest line while the workspace keeps pnpm's default peer resolution and one shared Vitest 5 instance; `playwright` is deliberately not one of them, and `tooling/mutation` takes it from the default `catalog:`. At that amendment, `guards.mutation-lane.guard` allowed the alias in exactly those two manifests and scanned every workspace for other carriers; the 2026-09-20 amendment below adds one named leaf. `packages/api-client` still owns the generated `paths.d.ts` and compiles it with TypeScript 7. **ADR file.** `docs/adr/0002-mutation-lane.md`.

**Amended 2026-09-20.** S11 executed A42's parser fallback after the representative preview missed the 100 ms gate. Its pinned `markdown-it` 15.0.2 packaging patch exposes the shared token engine without copying grammar algorithms or changing the upstream root API. `spikes/s11-markdown/make-parser-patch.mjs` reproduces the patch from verified upstream bytes using TypeScript's JavaScript AST parser, transformation factory and printer, APIs absent from TypeScript 7. The private, `spike`-tagged `spikes/s11-markdown` leaf therefore declares the same exact `"typescript": "npm:@typescript/typescript6@6.0.2"` devDependency. `tooling/mutation/package.json`, `tooling/api-codegen/package.json` and `spikes/s11-markdown/package.json` are the entire alias inventory. No product may import those leaves, no catalog or override carries the alias, and every product build and type check stays on TypeScript 7. The guard scans every workspace and proves that an unreviewed fourth product or spike leaf fails. Remove the S11 exception with the patch when an equivalent upstream token entry passes the full semantic matrix and complete-worker size gate. Maintenance, source hashes and retained measurements are in `spikes/s11-markdown/PARSER-PATCH.md` and `docs/spikes/S11-markdown-engine-cost.md`.

**Context.** StrykerJS 10.0.0's `typescript-checker` needs the TypeScript compiler API, which TypeScript 7.0.2 does not provide (digest §8.2). A1 keeps the main workspace on plain TS 7. Two source plans (enterprise, product-dx) resolved this by running Stryker with `checkers: []`, accepting that compile-error mutants are only killed if a test happens to exercise them. The risk-first plan kept the checker by isolating it. The judge panel grafted the isolation.

**Decision.** A dedicated workspace package `tooling/mutation` (`@iridium/mutation`) declares its own `"typescript": "npm:@typescript/typescript6@6.0.2"` alias and runs `@stryker-mutator/core`, `@stryker-mutator/vitest-runner`, and `@stryker-mutator/typescript-checker`, all 10.0.0, with `incremental: true` (`reports/stryker-incremental.json`), `checkers: ['typescript']`, thresholds `high 90 / low 75 / break 70`, raised to `break 80` by M8, against `vitest.stryker.config.ts` (the `unit` Vitest project only). If the M0 spike shows Stryker 10's vitest-runner cannot drive Vitest 5.0.0, this lane alone pins Vitest `V4` (4.1.11); the main workspace stays on Vitest 5. The lane runs in `nightly.yml`.

**Alternatives considered.**

| Alternative | Why rejected |
|---|---|
| Stryker with `checkers: []` (enterprise, product-dx) | Compile-error mutants survive unless a test incidentally covers them; on authorization code that is exactly the wrong place to lose signal. |
| Alias `@typescript/typescript6` repository-wide | Contradicts A1: two TypeScripts and two rule semantics across the codebase for the sake of one nightly tool. |
| Skip mutation testing | Coverage percentages alone do not prove that `authorize()`, the token verifier, and the persistence writer are asserted, only that they are executed. |

**Consequences.** Positive: compile-error mutants are detected; the second TypeScript is confined to devDependency-only leaf packages that nothing imports (one at acceptance; two after the 2026-09-13 amendment; three after the 2026-09-20 amendment). Negative: Stryker forces `bail: 1`, single-threaded workers, coverage off, and does not support Browser Mode, so only the `unit` project is mutated (component/integration lanes are not); the Vitest 5 compatibility is unverified until the spike.

**Verification.** M0 spike `docs/spikes/S05-stryker-vitest5.md` (records whether the `V4` fallback was taken); nightly `mutation` job with `break` enforced; M1 gate: Stryker ≥ 70 on `auth/**`, `authz/**`, `tokens`, `collab/persistence/**`, `@iridium/crdt`; M8 gate: `break 80`.

**References.** Digest §8.2 (Stryker 10, TS 7 API), §11.19, §11.21; plan-risk-first §9 harnesses; plan-product-dx 030 (the rejected `checkers: []` option). Implemented in `10-testing-and-quality.md`.

### A3 — Contracts-first code generation with CI drift checks

**Status.** Accepted (2026-09-11). **ADR file.** `docs/adr/0003-contracts-first-codegen.md`.

**Context.** Iridium has four wire surfaces (REST, WebSocket stateless messages, MCP, desktop IPC) consumed by three clients (web, Electron, bridge) and by external agents. Hand-maintained client types drift silently. The product-dx plan proposed an in-house Storybook-like workbench (`apps/workbench`) as a contract surface; the judges rejected it as unverified tooling in the bootstrap milestone.

**Decision.** `@iridium/contracts` (zod 4.6.2 only) is the single source of wire contracts. A root `pnpm gen` runs, in order: (1) `apps/server` boots in `in-process` mode and writes `packages/contracts/openapi/openapi.json` via `app.swagger()` (OpenAPI 3.1, with `links` so Schemathesis can run stateful fuzzing), then `@redocly/cli 2.52.1 lint`; (2) openapi-typescript 7.13.0 emits `packages/api-client/src/generated/paths.d.ts`, consumed by openapi-fetch 0.17.0; (3) kysely-codegen 0.20.0 generates types from a migrated database and diffs them against the hand-written `apps/server/src/db/schema.ts`; (4) `packages/contracts/mcp/tools.schema.json` is emitted from the zod tool schemas and a test asserts the live `tools/list` (both eras) equals it in deterministic order; (5) desktop IPC typings for `window.iridium` are generated from `contracts/desktop-ipc.ts`; (6) an msw 2.15.0 handler skeleton is generated from `openapi.json` for component tests. CI runs `pnpm gen && git diff --exit-code` (job `gen-drift` inside `static`).

**Alternatives considered.**

| Alternative | Why rejected |
|---|---|
| Hand-maintained client types and MCP schema JSON | Drift is invisible until a client breaks; no build failure. |
| In-house workbench `apps/workbench` (product-dx 021) | Unverified tooling in M0; component tests run in Vitest Browser Mode instead (A51). |
| Storybook | No verified Vite 8 Storybook version in the digest. |
| Separate schema languages per surface (TypeBox for REST, JSON Schema for MCP) | One schema language (A6) is what makes (4) and (5) trivial. |

**Consequences.** Positive: any change to a route, stateless message, tool, or IPC channel is a build failure until the generated artifacts are regenerated and committed; the OpenAPI document is an executable contract (A6's `toMatchOpenApi`, Schemathesis). Negative: `pnpm gen` needs a database for step (3) (Testcontainers MySQL in CI; documented local `compose.yaml`); generated files are committed, so reviewers see large diffs on contract changes (accepted — that visibility is the point).

**Verification.** CI `static` job step `gen-drift`; `mcp.tools-schema.contract` (M3); `rest.route-index.contract` (M2); Redocly lint; kysely-codegen diff step (M0).

**References.** Digest §8.2 (OpenAPI tooling status), §5.2 (`@fastify/swagger` dynamic mode), §3.2 (deterministic `tools/list`); plan-product-dx §2.6/§9.4 (graft source); judges 1–3. Implemented in `09-api-reference.md` and `10-testing-and-quality.md`.

### A4 — Node.js 24 LTS as the single runtime

**Status.** Accepted (2026-09-11). **ADR file.** `docs/adr/0004-node-24.md`.

**Context.** The server, the stdio bridge, the Electron main process, and every test runner share TypeScript code. Electron 44.3.0 embeds Node 24.20.0; Hocuspocus 4 requires Node ≥22; Node 22 is in Maintenance (EOL 2027-04-30); Node 26 is Current until 2026-10-28 and is not embedded by any supported Electron (digest §5.2, §9.2, §11.7). Native type stripping is stable since Node 24.12.0.

**Decision.** Node 24.21.0, declared in `package.json` `devEngines.runtime` (`{name:'node', version:'24.21.0', onFail:'download'}`), `.node-version`, `mise.toml`, and `engines: ">=24.12 <25"`; `@types/node` 24.13.4 (the `latest` dist-tag is misleadingly 22.x); Docker base `node:24.21.0-bookworm-slim`. Node 26 is adopted only after an Electron release embeds it, as an explicit post-MVP step.

**Alternatives considered.**

| Alternative | Why rejected |
|---|---|
| Node 22 LTS | Maintenance line; loses stable type stripping semantics and `--env-file-if-exists`; not what Electron 44 embeds. |
| Node 26 now | Current, not LTS; Electron main would run a different major from the server, splitting `@types/node` and runtime behaviour for shared packages. |

**Consequences.** Positive: one runtime contract for server, bridge, and Electron main; the dev loop runs `.ts` natively (no tsx); one `@types/node`. Negative: Node 24 leaves Active LTS on 2026-10-20 (Maintenance until 2028-04-30) — acceptable, and the Electron cadence policy (A53) is the trigger for the Node 26 move; `engines` upper bound `<25` must be raised deliberately.

**Verification.** M0: pnpm refuses installs on an incompatible runtime (`devEngines`), CI `setup-node` pinned to 24.21.0, Docker image built on the pinned base; `desktop.launch.e2e` proves the Electron main runs the shared code.

**References.** Digest §5.2, §9.2, §4.2, §11.7; unanimous across the four plans (risk-first ADR-07, enterprise ADR-01, product-dx 033). Implemented in `02-system-architecture.md` and `11-operations-and-deployment.md`.

### A51 — Testing harnesses: one runner per layer, real infrastructure, one boot path, `@iridium/testkit`

**Status.** Accepted (2026-09-11); the `integration` project's single MySQL image is **superseded in part by A59 (2026-09-12)**: the project runs as a two-entry matrix over `mysql:8.4.11` and `mysql:9.7.2-oraclelinux9`, with an unset `IRIDIUM_MYSQL_IMAGE` resolving to the floor. **Amended 2026-09-13:** the coverage numbers in the Decision below are unchanged, but they are **enforced for the M1 exit and its rehearsals onward** rather than at M0 — the root `vitest.config.ts` applies `coverage.thresholds` only when the job sets `IRIDIUM_COVERAGE_GATE=1` and the effective test target is past M0 (`IRIDIUM_TEST_TARGET_MILESTONE` when set; otherwise the last exited milestone in CURRENT), because the M0 tree deliberately contained the empty stubs of every M1+ boot step and the placeholder packages, so the aggregate would measure stubs and the 100 %-per-file rule on `apps/server/src/authz/**` could not hold while `route-policy.ts` was reached only by its boot guard. CI defaults the target to at least M1 while CURRENT still records M0, so the M1 gate is enforced before the pointer advances. The M0 exit record reports the merged numbers without gating on them, and "a threshold is never lowered" applies from the first exit that enforces them (10-testing-and-quality.md, "Coverage"). **ADR file.** `docs/adr/0051-testing-harnesses.md`.

**Context.** The spec's nine acceptance rows (spec §9) are statements about durability, authorization, and convergence under failure; they cannot be proven with mocks. The digest verified the exact behaviours the tests must pin: Hocuspocus's `SyncStatus` precedes persistence (§8.2, §2.2), there is no store retry (§11.4), and Yjs's own convergence harness is the reference model (§8.2). Vitest 5.0.0 is eight days old with a `V4` fallback; Playwright 1.63 adds test locks; Testcontainers 12.1 needs an explicit image string; k6's ability to run bundled yjs/lib0 is unvalidated (§8.2).

**Decision.** Vitest 5.0.0 (+ `@vitest/coverage-v8`, `@vitest/browser-playwright`, `@vitest/ui` 5.0.0; `V4` 4.1.11 only for the mutation lane per A2) with `test.projects`: `unit` (ubuntu + windows, `pool: forks`, `sequence.shuffle` with the seed printed), `component` (Browser Mode chromium via `playwright()` provider, vitest-browser-react 2.3.0, axe-core pinned at M0), `integration` (Testcontainers 12.1.0 `MySqlContainer(process.env.IRIDIUM_MYSQL_IMAGE ?? 'mysql:8.4.11')` on tmpfs, per-worker schemas, in-process `buildApp({mode:'in-process'})`), `property` (fast-check 4.10.0 + @fast-check/vitest 0.5.0; `numRuns 200` on PR, 5 000 + soak nightly), `chaos` (child-process server, `@testcontainers/toxiproxy` 12.1.0 / toxiproxy 2.12.0, and the `IRIDIUM_FAULT` registry active only when `NODE_ENV=test`: `store.throw`, `store.crash-before-commit`, `store.crash-after-commit-before-ack`, `store.slow:<ms>`, `compact.throw`, `ws.drop-after-ack`, `auth.slow:<ms>`), `contract` (`toMatchOpenApi(operationId, status)` on ajv 8.20.0 + swagger-parser 13.0.0; Schemathesis 4.26.1), `mcp` (in-process `handler.fetch` for both eras, `@modelcontextprotocol/conformance` 0.1.16 with an empty expected-failures baseline, Inspector 2.6.0 `--cli`). Playwright 1.63.0 projects `setup` / `chromium` (4 shards, test locks) / `electron` (ubuntu xvfb, windows, macos with `shogo82148/actions-setup-mysql@v1` `9.7`). k6 2.2.0 with bundled yjs/lib0 (M0 spike; fallback: a Node worker generator on `@iridium/collab-client`) with SLOs `ws_connecting p95 < 500 ms`, `yjs_propagation_ms p95 < 250 ms`, `durable_ack_ms p95 < 1 s`, `projection_lag_ms p95 < 12 s`, MCP `get_note p95 < 300 ms`, RSS < 1.5 GB at 300 VUs / 60 docs on 4 vCPU. `@iridium/testkit` provides `startTestEnv`, `startServer({mode:'in-process'|'child'})`, `NoteClient` (a `ws` subclass injecting `Origin: <PUBLIC_ORIGIN>`), `vaultChannelClient`, `restClient`, `mcpClient(token, era)`, fixtures (demo vault; Obsidian sample vault with `.obsidian/`, `.trash/`, `.canvas`, CRLF, BOM; hostile corpus; CommonMark 0.31.2 JSON; msw handlers). Policies: Vitest `retry: 0`; Playwright `retries: 2` in CI only, with traces; coverage v8 global 85/85/80/85 (lines/functions/branches/statements), 100 % per-file on `auth/**`, `authz/**`, `contracts/{tokens,paths,authz}`, 95/90 on `collab/persistence/**` and `@iridium/crdt`. Guard tests (grep- or snapshot-based, collected by path into their own `guard` project and run first in the `static` job): `deps.single-instance.guard`, `collab.initial-state-only-path.guard` (`new Y.Doc(` only inside `@iridium/crdt`, `collab/persistence/initial-state.ts`, and tests), `collab.no-reinit.guard` (`getText('content').insert` only inside `NoteService.initialize`, restore, repair), `collab.lf-invariant.guard`, `limits.single-source.guard`, `authz.route-policy.boot.guard`, `authz.no-mcp-admin-implied.guard`, `ipc.origin.guard`, `desktop.preload-surface.guard`, `desktop.web-preferences.guard`, `desktop.fuses.guard`. Three invariants the skeleton lists alongside them — DB grants, awareness identity and log redaction — need a live database or a live socket, so they ship as `db-grants.integration`, `collab.awareness-identity.integration` and `logging-redaction.integration` in the `integration` project rather than as guards.

**Alternatives considered.**

| Alternative | Why rejected |
|---|---|
| Jest | Second transform pipeline next to Vite; no Browser Mode; slower on ESM-only packages. |
| WebdriverIO for Electron | Playwright's `_electron.launch` is the path Electron's own testing guide recommends, and it shares the web E2E runner. |
| Artillery for load | Its `ws` engine documents no binary frames or message assertions; Yjs sync is binary. |
| jest-openapi / vitest-openapi | Stale (2022/2023); an ajv + swagger-parser matcher is a few dozen lines and tracks OpenAPI 3.1. |
| Pact | Consumer-driven contracts across teams; Iridium's clients live in the same repository and are generated from the same OpenAPI document (A3). |
| Mocks for MySQL / network faults | The acceptance rows are about real commits and real socket failures. |
| `electron-playwright-helpers` IPC helpers | Require `nodeIntegration: true, contextIsolation: false`, incompatible with A53. |

**Consequences.** Positive: every acceptance row maps to a named test (`10-testing-and-quality.md`); durability is proven under injected faults on both sides of `COMMIT`; both MCP eras are exercised through the deployed handler; `@iridium/testkit` is the only test harness, so `buildApp()` is the only boot path. Negative: integration and chaos lanes need Docker (Linux runners only); Vitest 5 is very new (breaking-change list in digest §8.2 — `clearMocks` default true, un-awaited assertions fail, `test.sequential` removed — adopted deliberately); the k6 bundling spike may fail (fallback recorded); Playwright retries mask flakiness only in CI and only with traces attached.

**Verification.** This ADR is itself the verification framework; its own checks: M0 exit (all Vitest projects and Playwright projects run empty-green on ubuntu + windows, Electron launch on three OSes), `docs/spikes/S06-k6-yjs-bundle.md`, `docs/spikes/S05-stryker-vitest5.md`, coverage thresholds enforced in `merge-reports`.

**References.** Digest §8.1–§8.5, §11.21, §2.2 (`SyncStatus` timing), §11.4 (no store retry); plan-risk-first ADR-20 + §9; plan-product-dx §9.3 testkit graft; plan-enterprise ADR-28. Implemented in `10-testing-and-quality.md`.

### A52 — CI: `ci.yml` / `nightly.yml` / `release.yml` with digest-pinned actions and license compliance

**Status.** Accepted (2026-09-11); the `nightly.yml` cross-browser smoke lane is **superseded in part by AG6 (2026-09-12)**, the `nightly.yml` MySQL 8.4.11 lane is **superseded in part by A59 (2026-09-12)**, and `release.yml`'s signing and notarisation secrets are **superseded in part by G8 (2026-09-12)** — 1.0 publishes six unsigned bundles with a published SHA-256 each (A53), while the test-signed E2E package smoke, which proves the fuse variant rather than a distribution signature, is unaffected. **Amended 2026-09-13:** the Decision's "`release.yml` (tags from `changeset git-tag`)" is corrected — `changeset git-tag` emits one `<pkg>@<version>` tag per package and never a product tag, so `release.yml` triggers on the `v<major>.<minor>.<patch>` milestone tag, which is cut by hand at the exit (D12-1), and every job but `version-pr` carries a version floor that skips the M0 tag `v0.0.0`. Changesets' role is unchanged: it versions the packages under A1's single `fixed` group and `version-pr` runs `changesets/action` off `main`. **Amended 2026-09-19:** while changes land directly on main by owner instruction, remove `version-pr` and the main-push release trigger. Run `pnpm changeset version` locally and commit its versions/changelogs before the exit record; only product tags select release artifacts. Branch-protection setup is deferred with the PR workflow; due CI checks remain milestone-exit gates. Every other lane stands, and the job list in the Decision below is kept as the record of what was accepted (D13-2, D13-14). **ADR file.** `docs/adr/0052-ci-pipelines.md`.

**Context.** Everything security-relevant must be a build failure, not a review comment. GitHub-hosted runners require Linux for service containers (digest §8.2); Electron E2E needs three OSes and native MySQL on Windows/macOS (`shogo82148/actions-setup-mysql`). No plan had a license-compliance check; GPL `remark-obsidian` (digest §7.2) shows why one is needed.

**Decision.** `ci.yml` (PR and push, concurrency-cancelled; `actions/checkout@v7.0.1`, `pnpm/action-setup@v6.1.0`, `actions/setup-node@v7.0.0`, all pinned by digest, Renovate `helpers:pinGitHubActionDigests`): job `static` (`tsc -b --builders 8`, `oxlint --type-aware`, `oxfmt --check`, `knip --production`, `turbo boundaries`, Redocly lint, `pnpm gen && git diff --exit-code`, `pnpm audit --audit-level high`, dedupe check, **license scan** with allowlist MIT / Apache-2.0 / BSD-2-Clause / BSD-3-Clause / ISC / MPL-2.0 / 0BSD / Unlicense / BlueOak-1.0.0 (added at M0, 2026-09-13) / PSF-2.0 (added at M2, 2026-09-21; 10-testing-and-quality.md records why for both) and denylist GPL / AGPL / LGPL / BSL / UNLICENSED, tool pinned at M0) → `unit` [ubuntu, windows] (unit + component + property-light, blob reporter) → `integration` (ubuntu with Docker: integration + contract + mcp + Schemathesis light) → `e2e-web` (4 shards, `mysql:9.7.2-oraclelinux9` service container) → `e2e-electron` [ubuntu xvfb, windows, macos] → `chaos-core` (≈20 kill iterations) → `merge-reports` (coverage thresholds, Playwright report). Critical path budget ≤ 15 minutes wall-clock per run (a performance budget for the pipeline, enforced by job timeouts, not an effort estimate). `nightly.yml`: property-long, chaos-extended (200 kill iterations, all toxics), load (k6 or fallback generator), mutation (A2), Schemathesis full, backup-restore drill (A47), cross-browser smoke (firefox/webkit), electron full, MySQL 8.4.11 lane (A9), real MCP client matrix (Claude Code ≥ 2.1.232 v2 runtime, VS Code, Cursor, bridge), proxied-stack MCP header passthrough (A48), `compose.prod.yaml` clean-VM boot. `release.yml` (tags from `changeset git-tag`): server image via `docker/build-push-action@v7.3.0` with SBOM and provenance, electron-builder matrix with signing/notarisation secrets, test-signed E2E package smoke, final packages, update-feed artifacts published with `iridium desktop-updates publish`, `changesets/action@v2.1.2` Version PR.

**Alternatives considered.** No plan proposed a different CI shape; the differences were in what was missing (license scan, proxied-stack MCP test, clean-VM compose boot), all of which are now included.

**Consequences.** Positive: a dependency with a disallowed license, an OpenAPI drift, a duplicate Yjs instance, a failing chain verification, or a desktop bundle whose file names, digests or fuse bits disagree with the release contract (`release.bundle-integrity`) cannot merge or ship — the clause as accepted named an unsigned installer, which G8 retired along with the installers themselves (A53). Negative: three-OS Electron E2E and Docker-based lanes make CI minutes the scarce resource; the ≤ 15 minute critical-path budget is protected by sharding and by moving long suites to nightly.

**Verification.** The pipelines are verified by running them at M0 exit (skeleton-green skeletons), and by M8's requirement that all nine acceptance rows are green on PR and nightly for 7 consecutive nightly runs.

**References.** Digest §8.2 (runner labels, action tags, `actions-setup-mysql`), §9.2 (Renovate, Changesets 3, pnpm 12 CI semantics), §7.2 (GPL plugin); all four plans' CI sections; gap fix (license scan). Implemented in `10-testing-and-quality.md` and `11-operations-and-deployment.md`. The MySQL lane assignment in this ADR's `nightly.yml` list is superseded by A59: the `mysql-84` job is deleted and `integration` and `chaos-core` become two-entry matrices, both entries required on `main`. The cross-browser smoke lane is superseded by AG6: the `browser-smoke` job and the `firefox-smoke` and `webkit-smoke` Playwright projects are deleted, and `release.yml`'s signing and notarisation secrets are superseded by G8 (A53), which ships unsigned bundles at 1.0.

### A54 — Client/server compatibility: integer `apiVersion`, `minClientVersion`, additive-only rule, N-1 window

**Status.** Accepted (2026-09-11). **ADR file.** `docs/adr/0054-client-server-compatibility.md`.

**Context.** Desktop fleets update on the administrator's schedule (A53 update policy), so an older client will talk to a newer server. No source plan defined what "compatible" means; this ADR closes that gap.

**Decision.** `GET /meta` returns `{apiVersion: int, minClientVersion, serverVersion, features: string[], publicOrigin}`; clients send `X-Iridium-Client-Version`. A **breaking** change is removing or renaming a field, endpoint, stateless message type, or IPC channel, changing semantics, or tightening validation; it increments `apiVersion` and raises `minClientVersion`. **Non-breaking** changes are additive optional fields, endpoints, stateless messages, or `features` entries. The server supports `apiVersion` N and N-1 for one release cycle. Stateless collab messages carry `v: 1`. Desktop IPC has no skew (renderer and main ship in one installer). A desktop client below `minClientVersion` shows an "update required" screen and prompts according to the update policy. Changesets keeps one product version across server image, web bundle, installers, and bridge (A1).

**Alternatives considered.**

| Alternative | Why rejected |
|---|---|
| Package-version negotiation (semver ranges) | Ties protocol compatibility to release numbering; an integer that only moves on breaking changes is simpler to reason about and to test. |
| No compatibility contract (web-only mindset) | The Electron fleet makes skew a certainty. |

**Consequences.** Positive: an explicit definition of "breaking" that reviewers can apply; the `features[]` list lets clients light up capabilities without a version bump. Negative: N-1 support means the server keeps deprecated fields for one cycle and tests both shapes (`rest.route-index.contract` and the `toMatchOpenApi` matcher run against both `apiVersion` values during a transition).

**Verification.** `meta.apiversion.integration` (shape and values), `desktop.update-required.e2e` (client below `minClientVersion`), and `rest.route-index.contract` during any transition; the release checklist in `11-operations-and-deployment.md` requires an `apiVersion` decision on every breaking change.

**References.** Gap fix (no digest section; product expectations in digest §10.2). Implemented in `09-api-reference.md`, `07-client-applications.md`, `12-milestones.md`.

### A56 — Milestone ordering: risk-first order with enterprise foundations folded into M0/M1

**Status.** Accepted (2026-09-11). **ADR file.** `docs/adr/0056-milestone-ordering.md`.

**Context.** Spec §10 names the first milestone literally: "one authenticated note, two editors, one viewer, MySQL persistence, and a server restart. Prove correct collaboration, authorization, and saving before expanding the vault-management UI." The four plans ordered work differently: platform-first (enterprise), UI-first (product-dx, with a visible editor at M1), MCP-before-structure (agent-first), and kernel-first (risk-first). The judges chose risk-first in two of three panels.

**Decision.** M0 bootstrap + harnesses + spikes → M1 headless kernel (the spec §10 sentence is the literal gate; the audit chain, configuration, readiness, DB roles, and CLI foundations from the enterprise plan are included here rather than in a separate platform milestone) → M2 structure / lifecycle / revisions / projections / search → M3 MCP + tokens + bridge → M4 shared UI + web host (+ vault channel) → M5 Electron → M6 import/export/attachments UI → M7 admin console → M8 operations hardening + release. A minimal visible web editor may be demonstrated at M1 but is not a gate. Each milestone exits only on green automated tests; no time or effort estimates appear anywhere in the plan.

**Alternatives considered.**

| Alternative | Why rejected |
|---|---|
| Platform-first (enterprise M1 "platform skeleton" before collaboration) | Delays the highest-risk proof (durable saving under faults); its contents are folded into M1 instead. |
| UI-first (product-dx: visible editor as the M1 gate) | Makes UI work a prerequisite of proving the kernel; the demo remains allowed but ungated. |
| MCP-before-structure (agent-first M2) | MCP reads projections and paths that M2 defines (`ContentReadCore`, `note_projections`, derived paths). |

**Consequences.** Positive: the riskiest technical claims (A15, A16, A19, A21, A23) are proven headless before any UI exists; MCP (a primary feature) ships at M3, immediately after the read model exists. Negative: nothing user-visible exists until M4 — accepted deliberately; the optional M1 demo mitigates it without becoming a gate.

**Verification.** `12-milestones.md` lists the exit tests per milestone; M1's `kernel.smoke.integration` is the literal spec §10 sentence.

**References.** Spec §10; judges 1–3; plan-risk-first §11; plan-enterprise M1/M2 (folded). Implemented in `12-milestones.md`.

---

## Area 2 — HTTP server, validation, and data layer

### A5 — Fastify 5 as the single HTTP host for REST, `/collab`, and `/mcp`

**Status.** Accepted (2026-09-11). **ADR file.** `docs/adr/0005-fastify.md`.

**Context.** One process must serve REST, the Hocuspocus WebSocket, static bundles, and the MCP endpoint on one port behind one Origin/Host policy (spec §6, §8). The digest (§5.2, §11.6) verified: Express 5.2.1 has had no release since 2025-12-01 and has no validation/OpenAPI story; Hono's Node adapter makes raw `IncomingMessage` integrations (needed for `Hocuspocus.handleConnection` and `toNodeHandler`) second-class; NestJS 12 depends on decorators, which `erasableSyntaxOnly` (A1) forbids; Fastify 5.12.4 has `@fastify/websocket` (auth in `preValidation` during upgrade, `options.maxPayload`, `injectWS()`), `fastify-type-provider-zod` 7.0.0 for zod 4, `@fastify/swagger` 9.8.1 for OpenAPI 3.1, and an official `@modelcontextprotocol/fastify` 2.0.0 adapter.

**Decision.** fastify 5.12.4 with @fastify/websocket 11.3.0, @fastify/helmet 13.1.1 (CSP nonces via `enableCSPNonces`), @fastify/rate-limit 11.2.0, @fastify/cookie 11.1.2, @fastify/multipart 10.1.1, @fastify/under-pressure 9.1.0, @fastify/static (pin at M0), @fastify/swagger 9.8.1 (+ @fastify/swagger-ui 6.1.1 on `/docs`, admin or dev only), fastify-type-provider-zod 7.0.0, @modelcontextprotocol/fastify 2.0.0. `buildApp({mode})` in `apps/server/src/app.ts` is the only boot path, with plugin order config → db → security → auth → authz → audit → rest → collab → mcp → ops → jobs. Every route declares `config.auth` (A30); a boot-time assertion fails the process if one does not. The server binds `127.0.0.1:4000` behind a reverse proxy (A48) with `trustProxy` set to the proxy CIDR only.

**Alternatives considered.**

| Alternative | Why rejected |
|---|---|
| Express 5.2.1 | Stale; hand-wired `ws` upgrade outside the middleware tree; no schema-driven OpenAPI; the MCP SDK's own `createMcpExpressApp` still needs Host/Origin wiring by hand. |
| Hono 4.13.7 + @hono/node-server | Web-standard `Request` in handlers is elegant, but Hocuspocus and the MCP Node handler need the raw Node socket/response; those integrations become adapter special cases. |
| NestJS 12.0.1 | Decorators and DI ceremony conflict with `erasableSyntaxOnly` and the native `.ts` dev loop; a second validation model. |
| Two processes (REST vs collaboration) | Loses the shared in-memory revocation bus, tombstone set, and per-vault mutex that A23/A46 rely on; the `CollabServer` interface preserves the split for later (F9). |

**Consequences.** Positive: same-port WebSocket with auth inside the plugin tree; one OpenAPI document generated from the routes; the official MCP adapter; helmet nonces feed CodeMirror's `EditorView.cspNonce`. Negative: Fastify 5's LTS table lists Node 20/22 (works on 24 in practice — pinned and tested); `@fastify/websocket` forwards `message`/`close` to `ClientConnection.handleMessage/handleClose` by hand (A17), which the M0 spike validates.

**Verification.** M0 spike `docs/spikes/S02-fastify-websocket-hocuspocus.md`; `authz.route-policy.boot.guard` (every route has `config.auth`); `rest.route-index.contract`; `mcp.dual-era.contract` through the mounted route; `readyz.integration`.

**References.** Digest §5.1–§5.3, §11.6, §3.2 (`toNodeHandler`), §6.2 (`trustProxy`, helmet); unanimous across plans (risk-first ADR-06, agent-first ADR-02, enterprise ADR-02, product-dx 003). Implemented in `02-system-architecture.md` and `09-api-reference.md`.

### A6 — zod 4 everywhere; OpenAPI 3.1 generated, committed, linted, and fuzzed

**Status.** Accepted (2026-09-11). **ADR file.** `docs/adr/0006-zod-and-openapi.md`.

**Context.** REST DTOs, stateless collab messages, MCP tool schemas, desktop IPC payloads, and the server's environment all need validation with inferred types. The MCP SDK v2 accepts zod 4 natively; `fastify-type-provider-zod` 7.0.0 imports `zod/v4`; TypeBox split into two incompatible lines (`typebox` 1.x vs `@sinclair/typebox` 0.34) (digest §5.2).

**Decision.** zod 4.6.2 is the only schema language (`zod/v4` import path inside MCP code). Every REST route is typed with `ZodTypeProvider`; the error shape is `ProblemDetails {type, title, status, code, detail?, current?, requestId}` with the closed `code` vocabulary of skeleton §D.1. The OpenAPI 3.1 document is generated by `app.swagger()`, committed at `packages/contracts/openapi/openapi.json`, linted by Redocly (A3), fuzzed by Schemathesis 4.26.1 with `--stateful=links` (light on PR, full nightly), and every integration/E2E response passes `toMatchOpenApi(operationId, status)` (ajv 8.20.0 + swagger-parser 13.0.0). `EnvSchema` (zod) validates configuration with `*_FILE` secret indirection, fail-fast `z.prettifyError`, and rejection of unknown `IRIDIUM_*` keys.

**Alternatives considered.**

| Alternative | Why rejected |
|---|---|
| TypeBox | Ecosystem split between `typebox` 1.x and `@sinclair/typebox`; no MCP SDK-native path. |
| zod-openapi / @asteasolutions/zod-to-openapi | The Fastify provider already emits the document; a second generator would be a second source of truth. |
| Hand-written OpenAPI | Drift (A3). |

**Consequences.** Positive: one schema language across REST, MCP, IPC, and config; `outputSchema` for MCP tools and IPC typings derive from the same objects; the OpenAPI document is executable (fuzzing, matcher, generated client). Negative: zod 4's JSON Schema emission must be kept within what OpenAPI 3.1 and MCP clients accept (Claude Code rewrites root-level `anyOf/oneOf/allOf`, digest §3.2) — the `mcp.output-schema.mcp` test guards it.

**Verification.** `rest.route-index.contract` (the route table, the boot-time policy and `openapi.json` agree) and the `toMatchOpenApi(operationId, status)` matcher on every integration and E2E response; Schemathesis light (PR) and full (nightly); `mcp.output-schema.mcp`; `config.env.unit` (fail-fast, unknown keys).

**References.** Digest §5.2 (provider, swagger, TypeBox split), §3.2 (Standard Schema in SDK v2), §8.2 (OpenAPI tooling), §9.2 (zod env primitives); all four plans. Implemented in `09-api-reference.md` and `10-testing-and-quality.md`.

### A7 — Kysely + kysely-ctl + kysely-codegen; forward-only migrations in production; fail-closed readiness

**Status.** Accepted (2026-09-11). **ADR file.** `docs/adr/0007-kysely-migrations.md`.

**Context.** The schema (skeleton §C) needs DDL that ORMs cannot express: `FULLTEXT` indexes, virtual generated columns in `UNIQUE` keys, multi-valued JSON indexes, `RANGE COLUMNS` partitions, triggers, and grants. Digest §5.2 verified that drizzle-kit has no MySQL `FULLTEXT` support (issues #1018/#1495 open) and Drizzle 1.0 is still RC; Prisma 7's only MySQL adapter is `@prisma/adapter-mariadb` and its CLI `latest` is an 8.0 RC; Kysely 0.29.5 offers typed SQL, `Migrator` with per-migration `transactionMode`, and raw `sql` for the rest.

**Decision.** kysely 0.29.5 with `MysqlDialect` over mysql2 pools (A10); kysely-ctl 0.21.0 migrations in `apps/server/migrations/NNNN_<name>.ts`, one DDL statement per file, idempotent guards, `transactionMode: 'per-migration'`, the whole run wrapped in `GET_LOCK('iridium_migrate', 60)`; kysely-codegen 0.20.0 output diffed in CI against the hand-written `apps/server/src/db/schema.ts`. `iridium migrate status|up|to` uses `DATABASE_MIGRATE_URL` (the migrator role of A8). The container entrypoint migrates only when `IRIDIUM_MIGRATE_ON_BOOT=true` (default `true` in dev/compose; documented off for HA). `/readyz` returns 503 while migrations are pending. Production migrations are forward-only with the expand/contract rule (a column is dropped one release after code stops using it). Triggers and grants live in migrations so a restore re-applies them (A45/A47). The initial set is `0001_users` … `0034_grants` (skeleton §C.11).

**Alternatives considered.**

| Alternative | Why rejected |
|---|---|
| Drizzle 0.45 / 1.0-rc | No `FULLTEXT`, generated-column, or functional-unique DDL; `push` cannot detect index-expression changes; 1.0 not GA. |
| Prisma 7 | mariadb driver, not mysql2; CLI on an 8.0 RC; `Bytes`/`DateTime(3)` defaults fight the schema. |
| Raw mysql2 without a query builder | Loses typed results and the codegen drift check. |
| Auto-migrate on every boot | Operators must control schema changes; HA needs one migrator. |
| Down migrations in production | Data-destroying rollbacks; the expand/contract rule plus backups (A47) replace them. |

**Consequences.** Positive: exact DDL; typed SQL without a model layer; operators run migrations deliberately and readiness refuses traffic on a schema mismatch. Negative: `kysely-ctl 0.21.0` requires `kysely < 0.30` (pin discipline); one-DDL-per-file means 34 initial files (deliberate: each is individually idempotent and retryable).

**Verification.** M0: migrations 0001–0034 apply on `mysql:8.4.11` and `mysql:9.7.2-oraclelinux9` — under A59 both are entries of the merge-blocking `ci.yml › integration` matrix rather than a primary and a nightly lane, and `migrations.parity.integration` additionally asserts that the schema the two produce is **identical**, not merely legal; kysely-codegen diff step in `static`; `readyz.integration` (503 with a pending migration); `migrations.integration` (two concurrent `migrate up` runs — one waits on `GET_LOCK`); the M8 upgrade rehearsal (M1-era backup → current).

**References.** Digest §5.2 (Kysely, Drizzle, Prisma facts, generated columns, partitions), §11.8; unanimous (risk-first ADR-08, agent-first ADR-14, enterprise ADR-04/ADR-29, product-dx 004). Implemented in `03-data-model.md` and `11-operations-and-deployment.md`.

### A8 — Least-privilege MySQL roles: `iridium_app`, `iridium_migrator`, `iridium_backup`

**Status.** Accepted (2026-09-11). **ADR file.** `docs/adr/0008-db-roles.md`.

**Context.** The audit log (A46) is only tamper-evident if the application cannot alter it. A single application user with DDL rights defeats triggers and grants. The enterprise plan introduced three roles; judges 1 and 3 grafted them.

**Decision.** `infra/docker/mysql/init/01_roles.sql` creates: `iridium_app` (DML on all tables; `INSERT` + `SELECT` only on `audit_events` and `audit_events_archive`; `SELECT` only on `kysely_migration*`; no DDL, `FILE`, or `SUPER`), `iridium_migrator` (DDL + DML + `TRIGGER`; no `GRANT OPTION`), and `iridium_backup` (`SELECT`, `LOCK TABLES`, `RELOAD`, `PROCESS`, `REPLICATION CLIENT`, `SHOW VIEW`, `TRIGGER`, `EVENT`). Migration `0034_grants` re-applies grants and is skipped when the migrating user lacks `GRANT` (managed hosting). `db-grants.integration` asserts the app role cannot `UPDATE`/`DELETE` audit rows and that the `SIGNAL SQLSTATE '45000'` trigger fires.

**Alternatives considered.**

| Alternative | Why rejected |
|---|---|
| Single application user | "The app physically cannot alter history" is the property enterprise reviewers ask for; a single user cannot provide it. |
| Application-enforced immutability only | Any SQL injection or bug in the app would bypass it. |

**Consequences.** Positive: append-only audit at the database privilege level; backups run under a read-only principal; migrations under a principal the app never uses. Negative: three credentials to provision (`DATABASE_URL`, `DATABASE_MIGRATE_URL`, backup credentials via `*_FILE`); `iridium audit archive` runs under the migrator role because the app role cannot move rows out of `audit_events`.

**Verification.** `db-grants.integration` (M1 gate); `audit.chain.integration`; `restore --verify` re-applies grants through `iridium migrate` (A47).

**References.** Digest §6.2 (append-only audit guidance), §5.2 (MySQL roles/grants facts); plan-enterprise §3.8/§10.3, ADR-13; judges 1, 3. Implemented in `03-data-model.md` and `11-operations-and-deployment.md`.

### A9 — MySQL 9.7 LTS primary, 8.4 LTS certified; baked `my.cnf`

**Status.** Superseded by A59 (2026-09-12). **ADR file.** `docs/adr/0009-mysql-version.md`.

> Superseded by **A59 — MySQL 8.4 LTS and 9.7 LTS as equal required targets**. The baked `my.cnf` contents, the `log_bin = binlog` base-name correction and the `authentication_policy` spelling all carry forward unchanged; what A59 supersedes is the primary/certified split, the 8.0.13 compatibility floor, the nightly lane assignment, and the claim in this ADR's alternatives table that 9.7 adds Community tablespace encryption — `component_keyring_file` is Community Edition on 8.4 and 9.7 alike.

A9's **Decision** and **References** below are the text as accepted on 2026-09-11 and are kept unedited (D13-2). Their two mentions of open question G3 — the Decision's closing sentence "Whether the 8.4 lane remains a requirement is open question G3 (default: both)" and the References list's `open question G3` — are historical record of a question the owner answered on 2026-09-12, not a live dependency. The answer, and the assumption it rests on, are in A59 and in "Decisions settled by the owner's answers of 2026-09-12".

**Context.** MySQL 8.0 reached end of life on 2026-04-30; 9.7 is the current LTS line with eight-year support; 8.4 LTS is supported to 2032; upgrades hop LTS to LTS (8.0 → 8.4 → 9.7, no skipping); Percona XtraBackup 9.7 exists; the Docker `latest` tag is an innovation release (digest §5.2, §11.8). Several settings (`innodb_ft_min_token_size`, stopwords, `sql_require_primary_key`) must be fixed before the first `FULLTEXT` index or table is created.

**Decision.** `mysql:9.7.2-oraclelinux9` is the pinned image for compose, Testcontainers, and service containers; a nightly CI lane runs `mysql:8.4.11`; all SQL stays 8.0.13-compatible (functional key parts are the floor). `infra/docker/mysql/my.cnf` is baked before migration `0001`: `character_set_server=utf8mb4`, `collation_server=utf8mb4_0900_ai_ci`, `authentication_policy=caching_sha2_password`, `innodb_flush_log_at_trx_commit=1`, `sync_binlog=1`, `log_bin=binlog`, `binlog_format=ROW`, `binlog_expire_logs_seconds=604800`, `innodb_ft_min_token_size=2`, `innodb_ft_enable_stopword=OFF`, `max_allowed_packet=256M`, `innodb_redo_log_capacity=2G`, `sql_require_primary_key=ON`, `max_connections=200`, `cte_max_recursion_depth=200`.

Two spellings in that list are load-bearing and were wrong in earlier drafts of it. `log_bin`'s argument is the log **base name**, not a boolean: `log_bin=ON` produces `ON.000001` and breaks every `binlog.NNNNNN` path in the backup manifest, the PITR runbook and `iridium doctor --pitr-window`. And the plugin pin is `authentication_policy`, because `default_authentication_plugin` was deprecated in 8.0.27 and **removed in 8.4.0** — an unknown variable makes `mysqld` exit at startup rather than warn, and this one file is mounted into the development compose, `compose.prod.yaml`, the Testcontainers fixture and the 8.4 nightly lane, so setting it would mean the database never comes up, before migration `0001` and before any drill. `authentication_policy` exists on both 8.4 and 9.x, and `init/01_roles.sh` already writes `IDENTIFIED WITH caching_sha2_password` per user. `ft_min_word_len` is deliberately absent: it is MyISAM-only, every Iridium table is InnoDB, and `innodb_ft_min_token_size` is what governs the FULLTEXT tokenizer. Whether the 8.4 lane remains a requirement is open question G3 (default: both).

**Alternatives considered.**

| Alternative | Why rejected |
|---|---|
| MySQL 8.0 | End of life. |
| 8.4 LTS only | Forces the 8.4 → 9.7 hop during the product's life; 9.7 adds Community TDE and the tooling Iridium documents (XtraBackup 9.7). |
| 9.7 only, no 8.4 lane | Conservative sites run 8.4; the lane is cheap and keeps SQL portable (G3 can drop it). |
| Innovation releases (26.x) | Unsupported after ~3 months each. |

**Consequences.** Positive: long support horizon; the durability settings the "kill after ack" proof depends on (`innodb_flush_log_at_trx_commit=1`, `sync_binlog=1`) are configuration of record, and `/readyz` checks the first (A49); PITR via binlogs (A47). Negative: `mysql_native_password` is removed in 9.x (mysql2 speaks `caching_sha2_password`, fine); a repository bug once auto-upgraded 8.4 hosts to 9.7 (digest §10.2) — the deployment docs pin the major explicitly.

**Verification.** M0 exit: an empty server passes `/readyz` against 9.7.2 and 8.4.11 with the shipped `my.cnf` mounted — which is itself the standing check that the file contains no variable either release rejects; the nightly 8.4 lane repeats it; `readyz.integration` asserts `innodb_flush_log_at_trx_commit == 1` under `READYZ_STRICT_DURABILITY=true`; `migrations.integration` applies `0001`–`0034` on both images against the same file; `ops.pitr.chaos` proves the binlog base name by replaying `binlog.NNNNNN` files out of the backup set; `search.acl.integration` and `search.snippets.unit` depend on the baked FULLTEXT settings and fail on a default `my.cnf`.

**References.** Digest §5.2, §9.2, §10.2, §11.8; unanimous (risk-first ADR-07, agent-first ADR-13, enterprise ADR-03, product-dx 004); open question G3. Implemented in `03-data-model.md` and `11-operations-and-deployment.md`.

### A10 — mysql2 with two Kysely instances: `dbApp` and `dbPersist`

**Status.** Accepted (2026-09-11). **ADR file.** `docs/adr/0010-two-pools.md`.

**Context.** The persistence writer's transactions are the "Saved" path (A19). If REST/MCP bursts exhaust a shared pool, saves queue behind reads and the truthful ack becomes slow or fails. Digest §5.2 verified mysql2 defaults: `FOUND_ROWS` in the client flags (so `affectedRows` counts matched rows — required for `WHERE version=?` CAS), `jsonStrings: false`, `supportBigNumbers: false` by default, `connectionLimit 10`.

**Decision.** mysql2 3.24.4. Two Kysely instances over two pools: `dbApp` (`connectionLimit 20`; REST, MCP, jobs) and `dbPersist` (`connectionLimit 4`; reserved for `NoteWriter` transactions and compaction). Both pools set `supportBigNumbers: true`, `jsonStrings: false`, and the default `FOUND_ROWS` flag is asserted at boot (the CAS code relies on `numUpdatedRows === 1n` meaning "matched one row"). Pool sizes are `DB_POOL_APP` / `DB_POOL_PERSIST` env values; the persist pool size is also the global persistence concurrency (A21).

**Alternatives considered.**

| Alternative | Why rejected |
|---|---|
| One pool | REST bursts starve saves; no way to bound persistence concurrency independently. |
| Separate process for persistence | Loses the in-process `saveMutex`/writer coordination with Hocuspocus (A17); the interface seam (`CollabPersistence`) keeps the option. |

**Consequences.** Positive: save latency is isolated from read traffic; `iridium_db_pool_in_use{pool}` makes starvation visible. Negative: two pools count against `max_connections=200`; `/readyz` must ping both.

**Verification.** `readyz.integration` (both pools pinged); `collab.backpressure.chaos` and the k6 SLO `durable_ack_ms p95 < 1 s` under REST load; a boot assertion test for the `FOUND_ROWS` flag.

**References.** Digest §5.2 (mysql2 defaults, Kysely dialect); all plans (risk-first ADR-08). Implemented in `02-system-architecture.md` and `03-data-model.md`.

### A11 — Entity IDs: UUIDv7 in `BINARY(16)`, canonical strings on every wire

**Status.** Accepted (2026-09-11). **ADR file.** `docs/adr/0011-uuidv7-ids.md`.

**Context.** Note and vault IDs are stable identities exposed to agents (`iridium://vault/{vault_id}/note/{note_id}`), stored as primary keys in InnoDB (clustered), and must be ASCII-stable in URIs. Two plans chose ULID `CHAR(26)`; two chose UUIDv7. Judges 1 and 2 chose UUIDv7.

**Decision.** UUIDv7 generated in-repo by `@iridium/contracts/ids.ts` (no dependency; monotonic within a process), stored as `BINARY(16)`, rendered as canonical lowercase UUID strings on every REST/MCP/IPC surface; branded TypeScript types per entity (`VaultId`, `NodeId`, `NoteId`, `AttachmentId`, `UserId`, `TokenId`, `SessionId`, `JobId`, `RevisionId`).

**Alternatives considered.**

| Alternative | Why rejected |
|---|---|
| ULID `CHAR(26) ascii_bin` (agent-first, product-dx) | 26 bytes per key versus 16; every secondary index carries the key; no standard textual form that URL and OpenAPI validators already know. |
| UUIDv4 | Random clustered inserts fragment InnoDB pages. |
| Auto-increment | Enumerable; leaks cardinality; unusable across vault exports/imports. |

**Consequences.** Positive: time-ordered inserts, half the key width of ULID text, `format: uuid` in OpenAPI, ASCII-stable `iridium://` URIs. Negative: MySQL helpers (`UUID_TO_BIN`) are not used — conversion happens in one codec module so the binary form never leaks; property tests cover monotonicity and round-trip.

**Verification.** `contracts.ids.unit` (round-trip, ordering, uniqueness across workers); the `toMatchOpenApi(operationId, status)` matcher enforces `format: uuid`; `mcp.resources.mcp` tests the URI template.

**References.** Digest §5.2 (BINARY/clustered facts); judges 1, 2; plan-risk-first ADR-24; plan-product-dx 023 (rejected ULID). Implemented in `03-data-model.md` and `09-api-reference.md`.

### A12 — Tree model: adjacency list with a real root row, derived paths, per-vault mutex

**Status.** Accepted (2026-09-11). **ADR file.** `docs/adr/0012-tree-model.md`.

**Context.** Categories and notes form a tree with filesystem-like naming (spec §2–§3): unique names among live siblings, rejected cycles, cross-vault moves refused, trash that frees the name. Digest §5.2 verified: InnoDB allows `UNIQUE` on virtual generated columns (partial-unique emulation for soft delete); `NULL`s are distinct in unique indexes (so a nullable `parent_id` root defeats sibling uniqueness at the top level); locking reads in an outer statement do not lock rows read inside a recursive CTE (so `FOR UPDATE` over a CTE is not a mutex); `utf8mb4_0900_as_ci` gives accent-sensitive, case-insensitive names (Windows/macOS-compatible export). The agent-first plan stored a materialised `path`; the digest's Topic 5 recommendation was "paths derived, never stored".

**Decision.** `nodes.parent_id NOT NULL` with a real root row per vault (`parent_id = id`; CTEs stop at `id = parent_id`; `vaults.root_node_id`); `UNIQUE uq_sibling(parent_id, name, live)` where `live` is `TINYINT GENERATED ALWAYS AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL`; `name VARCHAR(255) COLLATE utf8mb4_0900_as_ci`; paths derived by one recursive CTE per request (the per-vault in-process path cache keyed by `vaults.tree_version` is the designated optimisation, added only when measured p95 `list_notes` > 200 ms at 20 000 nodes); every structural transaction runs at `REPEATABLE READ` and begins with `SELECT id, tree_version FROM vaults WHERE id=? AND status='active' FOR UPDATE` (`db/withVaultLock.ts`); a move runs the recursive ancestor walk of the target parent and refuses if it contains the moving id; depth ≤ 64; `vaults.tree_version` is bumped in every structural transaction and broadcast on the vault channel (A18); name rules: no `/`, `\`, or control characters, no leading/trailing spaces or dots, not `.`/`..`, ≤ 255 bytes, reserved Windows names rejected; `vault_id` is immutable (cross-vault moves rejected). Trash is modelled by `trash_entries` with `cascade_root_id` as the restore unit.

**Alternatives considered.**

| Alternative | Why rejected |
|---|---|
| Materialised `path`/`path_key` (agent-first ADR-15) | Every rename/move rewrites a subtree; the stored path can disagree with the parent chain; derived paths cannot. |
| Closure table | Write amplification on move; a second structure to keep consistent. |
| Nullable `parent_id` root | `NULL`s are distinct in `UNIQUE`, so two root-level notes could share a name. |
| `utf8mb4_bin` names | Case-sensitive siblings ("Notes" and "notes") break export to Windows/macOS filesystems. |
| Relying on `FOR UPDATE` over the CTE | Verified not to lock base rows; the vault-row mutex is the only correct serialisation. |

**Consequences.** Positive: O(1) writes for rename/move; sibling uniqueness survives soft delete; the vault mutex makes structural concurrency deterministic (spec §9 "Structural concurrency"); Obsidian-like naming semantics. Negative: path derivation is a CTE per request (bounded by `cte_max_recursion_depth=200` and depth ≤ 64); the per-vault mutex serialises structural writes per vault (acceptable — they are low-rate).

**Verification.** `tree.structural-concurrency.integration`, `tree.stale-resurrection.integration`, `hierarchy.model.prop` (fast-check model of a tree against the SQL implementation), `contracts.paths.unit`, `lock-order.integration` (M2 gates); perf budget for `list_notes` at 20 000 nodes (M8 load lane).

**References.** Digest §5.2 (generated columns, CTE locking, collations), digest Topic 5 recommendation; judges 1–3; plan-risk-first ADR-14; plan-enterprise ADR-24. Implemented in `03-data-model.md` and `09-api-reference.md`.

### A13 — Optimistic concurrency: `version` CAS and `If-Match` on REST

**Status.** Accepted (2026-09-11). **ADR file.** `docs/adr/0013-version-cas-if-match.md`.

**Context.** Spec §6: "Hierarchy, names, permissions, and deletion use database transactions and metadata version checks; they do not become safe merely because document text uses CRDTs." Spec §9 requires concurrent rename/move/delete to "succeed consistently or return an explicit conflict". Version restore must succeed while other people are typing, so it cannot be conditioned on the note's `head_seq` (which changes per keystroke).

**Decision.** Every mutable metadata row carries `version INT UNSIGNED NOT NULL DEFAULT 1`; every update is `UPDATE … SET version = version + 1 WHERE id = ? AND version = ?` asserting `numUpdatedRows === 1n` (A10's `FOUND_ROWS`). REST exposes `ETag: "<version>"`. `If-Match` is **required** on `PATCH /nodes/:nodeId`, `POST /nodes/:nodeId/trash|restore`, `PATCH /vaults/:vaultId`, `PUT`/`DELETE /vaults/:vaultId/members/:userId` (for an existing row), `PATCH /me`, `PATCH /admin/users/:userId`, `PATCH /admin/tokens/:tokenId`, `PUT /admin/settings`, and `DELETE /vaults/:vaultId/attachments/:attachmentId` — the list `09-api-reference.md` §1.2 publishes, and the `If-Match` column of its route table is what `rest.route-index.contract` compares against `openapi.json`: missing → `428 precondition_required`; mismatch → `409 stale_version` with the `current` representation in the ProblemDetails body. The validator each one compares against is the `ETag` of the matching read (`GET /nodes/:nodeId`, `GET /vaults/:vaultId`, `GET /auth/me`, `GET /admin/users/:userId`, `GET /admin/settings`), except member, token and trash rows, which carry `version` in the collection body only so a list view can supply `If-Match` without a second request. Structural conflicts are explicit: `409 name_conflict` (from `ER_DUP_ENTRY` on `uq_sibling`), `409 invalid_move`, `409 category_not_empty`. The note body is CRDT and exempt. Version restore takes `{revision}` in the body with UI confirmation and step-up (A26), and **no** `If-Match` on `head_seq`.

**Alternatives considered.**

| Alternative | Why rejected |
|---|---|
| `If-Match` on `head_seq` for restore | Changes with every keystroke; restores during active editing would never succeed. |
| Last-writer-wins on metadata | Violates spec §6 and §9. |
| Optional `If-Match` | Clients that omit it would silently overwrite; `428` makes the contract unmissable. |

**Consequences.** Positive: every conflict is explicit and carries the current row for the UI to re-render; the CAS is one statement, no advisory locks. Negative: clients must thread ETags through every mutation (the generated API client does this); `409 stale_version` on the tree is common under live collaboration and the UI must handle it as a normal path (rename dialog refresh, not an error toast).

**Verification.** `tree.structural-concurrency.integration` (`Promise.all` of conflicting rename/move/trash → exactly one 409 or both succeed with a valid tree); `authz.rest-viewer.integration` (every mutating route); `toMatchOpenApi(operationId, status)` (the 428 and 409 shapes); `revisions.restore.integration` (restore succeeds during active edits).

**References.** Spec §6, §9; digest §5.2 (`FOUND_ROWS`); plan-risk-first + plan-product-dx §3.6 concurrency contract; judge verdict on restore. Implemented in `03-data-model.md` and `09-api-reference.md`.

---

## Area 3 — Collaboration engine and durability

### A14 — Yjs v13 stable set, one module instance, one first-party import point

**Status.** Accepted (2026-09-11). **ADR file.** `docs/adr/0014-yjs-v13-single-instance.md`.

**Context.** The spec mandates Yjs (spec §5). The digest verified (§1.2) that the stable line is yjs 13.6.32 with y-protocols 1.0.7, lib0 0.2.117 and y-codemirror.next 0.3.6, that Hocuspocus 4.7.0 peers on `yjs ^13.6.8`, and that every Yjs v14 package (`@y/y` 14.0.0-rc.26, `@y/codemirror` 0.0.0-3, `@y/protocols` 1.0.6-rc.1, lib0 1.0.0-rc.32) is a pre-release whose v13↔v14 state and wire compatibility is undocumented (53-bit client IDs suggest a wire change; §11.17). The y-codemirror.next README tells users to stay on v13. Two copies of `yjs` (two versions, or ESM+CJS of one version) break `instanceof` checks and log `Yjs was already imported`; two copies of `@codemirror/state` throw `Unrecognized extension value`; a duplicated `@codemirror/view` makes the binding stop syncing silently (§1.2, §1.4).

**Decision.** Exact pins in the pnpm catalog: yjs 13.6.32, y-protocols 1.0.7, lib0 0.2.117, y-codemirror.next 0.3.6, @hocuspocus/server, @hocuspocus/provider and @hocuspocus/common 4.7.0. Single-instance enforcement in four layers: (1) pnpm `overrides` plus catalog entries for `yjs`, `lib0`, `y-protocols`, `@codemirror/state`, `@codemirror/view`; (2) Vite `resolve.dedupe` for the same five packages in the shared browser config; (3) a CI step (`deps.single-instance.guard`) that runs `pnpm why` for each and fails on more than one resolved version, plus a bundle-analysis assertion that the renderer bundle contains one copy; (4) a server startup guard that fails the process if the `Yjs was already imported` console error fires during boot. `@iridium/crdt` is the **only** first-party package that imports `yjs` or `y-protocols`; it exports `createNoteDoc`, `getContent(doc)` (the single `Y.Text 'content'`), `loadState`/`encodeState` (the V1/V2 codec with branded `V1Update`/`V2State`/`StateVector` types), `dominates()`, `prefixSuffixDiff()`, `projectMarkdown()`, the LF/no-attributes guards and `initialNoteState(markdown)`. Server persistence, `@iridium/collab-client` and `@iridium/editor` consume it. The document model is one `Y.Doc` per note with the body in `doc.getText('content')`; no `Y.XmlFragment`, no formatting attributes, no embeds; note metadata lives in MySQL. Yjs v14 is a deliberate post-MVP evaluation gated on a v13↔v14 compatibility spike.

**Alternatives considered.**

| Alternative | Why rejected |
|---|---|
| `@y/y` 14 RC with `@y/codemirror` | Every package is a release candidate; the binding is at 0.0.0-3; v13↔v14 compatibility is undocumented; Hocuspocus and y-codemirror.next peer on v13. |
| Two isolation points (`@iridium/collab-client` for clients, `apps/server/src/collab/persistence` for the server), as in plan-risk-first ADR-01 | Two codecs and two places to migrate; the isomorphic `@iridium/crdt` package gives one codec, one set of branded types and one migration point. |
| Carets on the Yjs set | A lib0 1.0.0-rc could leak in through any transitive range and break the single-instance invariant. |
| `Y.XmlFragment` document model | y-codemirror.next binds only `Y.Text`; the spec forbids rich-text round-tripping (spec §3). |

**Consequences.** Positive: `instanceof`-based failures are structurally impossible in a green build; a v14 migration touches one package plus a schema marker (`note_docs.yjs_major`); the codec's branded types make V1/V2 mixing (A15) a type error. Negative: the pins must be bumped deliberately (Renovate groups the five packages into one PR that must pass `deps.single-instance.guard`); the guard test is grep-based (`new Y.Doc(` only inside `@iridium/crdt`, `collab/persistence/initial-state.ts` and tests) because oxlint JS plugins are alpha (A1).

**Verification.** `deps.single-instance.guard` (M0 exit, first step of the CI `static` job: one resolved version per package in `pnpm-lock.yaml`, and the built web and desktop bundles scanned for a second `Yjs was already imported` sentinel); a startup-guard unit test that fires the console error and asserts boot fails; `collab.initial-state-only-path.guard` and `collab.no-reinit.guard` (M1); `crdt.dominates.prop` and the codec property tests in `@iridium/crdt` (M0).

**References.** Digest §1.1–§1.5, §2.2 (peer ranges), §11.17; plan-risk-first ADR-01; plan-agent-first ADR-25; plan-product-dx 006 (isolation in `@iridium/crdt`). Implemented in `02-system-architecture.md` and `05-collaboration-and-durability.md`.

### A15 — Yjs state storage: V2 compacted snapshot plus V1 append log, applied manually

**Status.** Accepted (2026-09-11); **amended 2026-09-13** by spike S1 (`docs/spikes/S01-onloaddocument-v2-apply.md`, pass): the in-place apply and the `afterLoadDocument`/`isLoading` semantics are confirmed and the fallback is not taken, but the size advantage measures 1.6–1.75×, not the order of magnitude the Context quotes from yjs #675. The decision is unchanged; the budgets that cite the ratio are not. **ADR file.** `docs/adr/0015-yjs-state-encoding.md`.

**Context.** Digest §11.1 records the sharpest disagreement among the research topics. Topic 1 recommends storing the compacted state as V2 (`Y.encodeStateAsUpdateV2`, ~95 % smaller — yjs #675 measured 8,969,403 bytes V1 → 452,346 bytes V2) with the wire log kept V1; Topics 2 and 5 recommend V1 everywhere because Hocuspocus, y-protocols and `Y.mergeUpdates` are V1-native and "mixing Yjs V1 and V2 encodings corrupts merges". Facts both sides agree on: y-protocols is V1-only on the wire; Hocuspocus's `onLoadDocument` applies a returned `Uint8Array` with V1 `applyUpdate`; `@hocuspocus/extension-database` is V1 full-state; `mergeUpdates` never garbage-collects, so compaction must load into a `Y.Doc` regardless of format (§1.2). Two of the three judge panels chose V2 snapshots (plan-risk-first ADR-04, plan-enterprise ADR-05) over the V1-everywhere position (plan-agent-first ADR-06, plan-product-dx 006).

**Decision.** `note_docs.snapshot` holds `Y.encodeStateAsUpdateV2(doc)` with `snapshot_format = 2` and `yjs_major = 13`; `note_updates.update_v1` holds the wire bytes exactly as applied (`yjs_major = 13`). `onLoadDocument` applies `applyUpdateV2(snapshot)` then `applyUpdate(update_v1)` for every row with `seq > snapshot_through_seq` in `seq` order, mutating `data.document` in place, and **returns `undefined`** — never bytes, so Hocuspocus's V1 return path is never used. The codec lives in one module of `@iridium/crdt` with branded `V1Update`, `V2State` and `StateVector` types, so passing a V2 blob to a V1 function is a compile error. The M0 spike `docs/spikes/S01-onloaddocument-v2-apply.md` confirms the in-place apply and the `afterLoadDocument`/`isLoading` semantics on Hocuspocus 4.7.0; its recorded fallback is V1 snapshots behind the same `snapshot_format` column (one function change in the codec, no schema change). `note_revisions.snapshot` uses the same codec and columns (`snapshot_format`, `yjs_major`, `snapshot_sv`).

**Alternatives considered.**

| Alternative | Why rejected |
|---|---|
| V1 everywhere with a `yjs_format` column (agent-first, product-dx, judge 1) | Up to 20× larger snapshots multiply backup size, load time and resident memory for every note, revision and restore; the "one encoding" simplicity is largely illusory because the codec must exist anyway for compaction. |
| Return merged bytes from `onLoadDocument` (`Y.mergeUpdates([snapshot, ...updates])`) | Forces V1 snapshots and never GCs; the Hocuspocus 4.7.x return path is also the one fixed by #1155 ("skip the document self-apply") — in-place apply avoids it entirely. |
| Yjs snapshots (`Y.snapshot`) for history | Require `gc: false`; growth is unbounded; history comes from `note_revisions` instead (A16). |

**Consequences.** Positive: backups, restores and loads scale with content rather than tombstones; compaction (which loads into a `Y.Doc` anyway) produces a GC'd, small state; `yjs_major` marks every blob for a future v14 migration. Negative: V2 encoding is roughly twice as slow as V1 (yjs #675) — acceptable at compaction cadence; the spike is a hard M0 gate (passed 2026-09-13), and it measured the size advantage at 1.6–1.75× rather than the ~95 % the Context quotes from yjs #675, so the storage and compaction budgets are sized from the measurement rather than from the issue; readers of the log must never treat `update_v1` and `snapshot` interchangeably (enforced by the branded types).

**Verification.** M0 spike `docs/spikes/S01-onloaddocument-v2-apply.md` (pass, or fallback executed and recorded); `persistence.model.prop` (fast-check model: random update sequences persisted, compacted at random points, reloaded — the reloaded `toString()` equals the model); `collab.restart-no-duplication.integration` (spec §9 row "Initialization/reconnection"); `collab.initial-state-only-path.guard`; `restore --verify` sample-loads snapshots and compares hashes (A47).

**References.** Digest §1.2 (encoding API, #675, `mergeUpdates` never GCs), §2.2 (`onLoadDocument` return handling, #1155), §11.1; plan-risk-first ADR-04; plan-enterprise ADR-05; judges 2 and 3. Implemented in `03-data-model.md` (§C.5) and `05-collaboration-and-durability.md`.

### A16 — Per-update append log, compaction in the same per-note FIFO, Markdown checkpoints separate from sync state

**Status.** Accepted (2026-09-11). **ADR file.** `docs/adr/0016-update-log-compaction-checkpoints.md`.

**Context.** Spec §5 defines Saved as durable persistence; spec §8 requires recoverable checkpoints separate from the binary sync state; spec §6 requires per-note serialised persistence. The digest verified that Hocuspocus's `onStoreDocument` is debounced per document (2 000 / 10 000 ms), runs inside `document.saveMutex`, and on error only logs and returns — there is **no retry** (§2.2, §11.4), and that `SyncStatus(true)` is sent after the in-memory apply, before any store (§2.2). Topics disagreed on whether the durable write happens per update or per debounced store (§11.2) and whether Saved must also imply a Markdown checkpoint. A gap common to all four plans was that `onStoreDocument` returned before compaction finished, making `flushPendingStores()` and the post-store unload check untruthful.

**Decision.** Two write paths share one per-note FIFO (`NoteWriter`, A21). (1) **Log path:** the writer coalesces a burst into one transaction, but not into one row. The batch is split into contiguous `(actor, session, origin)` **runs**, each run is merged with `Y.mergeUpdates` into one `note_updates` row (≤ 1 MiB per row, `YJS_UPDATE_MAX_BYTES`), so one COMMIT writes `seq = head+1 … head+N` and performs a **single** `head_seq` compare-and-set to `head+N`. Rows therefore scale with commits and with changes of authorship, never with keystrokes, and per-row authorship stays exact for `list_note_revisions` and for the audit trail. `head_seq = 412` means 412 update rows have committed and the note's current revision is 412 — not that 412 batches were committed — and a `persisted {seq}` after one COMMIT can advance by more than one, which a client must treat as normal rather than as a lost acknowledgement (`05-collaboration-and-durability.md` D05-01; `01-vision-scope-and-principles.md` §"Update batch"). One batch is itself capped at `WRITER_BATCH_MAX_UPDATES` (512) updates and `WRITER_BATCH_MAX_RAW_BYTES` (8 MiB) of raw update bytes so a long database stall cannot make one transaction unbounded. The transaction and the post-COMMIT `persisted` broadcast are specified in A19. (2) **Compaction path:** `onStoreDocument` (debounce 2 000 / maxDebounce 10 000 ms; 100 / 500 ms in integration tests) enqueues a compaction job into the same FIFO **and awaits it** while holding Hocuspocus's `saveMutex`, so `flushPendingStores()` and the unload check are truthful. The job captures `{stateV2, sv, throughSeq = lastCommittedSeq, markdown, sizeChars}` synchronously at the head of the queue (after every earlier row has committed), then runs one transaction in the order `03-data-model.md` §8.6 fixes: the same `note_docs d JOIN nodes n … FOR UPDATE` guard as the write transaction; `UPDATE note_docs SET snapshot = ?, snapshot_sv = ?, snapshot_through_seq = ?, snapshot_size = ?, snapshot_at = ? WHERE note_id = ? AND snapshot_through_seq < ?`; the guarded `note_projections`/`note_search`/`note_links` replacement (`WHERE revision < ?`, `<=` for idempotent re-runs); the `note_revisions` insert when the checkpoint policy fires; then **one** `UPDATE notes SET size_chars = ?, oversize = ?, content_invalid = ?, last_edited_by = ?, last_edited_at = ?, last_checkpoint_at = ?, updated_at = ?` — exactly one `notes` row lock per compaction, which is where the hostile-content verdict of A22 and the last editor the writer carried forward in memory both land (D03-14); and `note_docs.projected_seq` **last**, so a crash leaves it behind rather than ahead. After COMMIT it schedules the derived projection job (piscina, A42) and broadcasts `{t:'projected', seq}`. **Checkpoint kinds** (`note_revisions.kind`): `create`, `import`, `checkpoint` (content hash changed ∧ ≥ `vaults.auto_checkpoint_interval_min` (default 10) since the last), `unload` (last client left and no revision row exists at head — invariant: an unloaded note always has a revision at `head_seq`), `named` (Ctrl/Cmd+S), `pre_restore` (current content captured before a restore), `restore`, `trash`. **Thinning** (`jobs/revision_thinning`) applies to `checkpoint` and `unload` kinds only: keep all for 24 h, hourly for 30 d, daily thereafter; `named`, `restore`, `pre_restore`, `import`, `create` and `trash` are never thinned. **Log pruning** (`jobs/update_log_prune`): rows with `seq <= snapshot_through_seq` older than 7 days are deleted — loading never depends on pruned rows. The V2 `snapshot` blob is copied into `note_revisions.snapshot` for `named`/`restore`/`pre_restore`/`import`/`trash` rows and for `checkpoint` rows below 4 MB.

**Alternatives considered.**

| Alternative | Why rejected |
|---|---|
| Full-state store per debounce with the ack in `afterStoreDocument` (digest Topics 8 and 10) | Saved latency equals the debounce (2–10 s); write amplification is the whole state per store; there is no retry to lean on. |
| Compaction outside the FIFO | An older asynchronous compaction could overwrite a newer state (spec §6 forbids exactly this); the FIFO plus the `snapshot_through_seq < ?` guard make it impossible. |
| Yjs snapshots for revisions | Need `gc: false` and grow without bound (A15). |
| A checkpoint on every compaction | Write amplification; the hash-and-interval policy bounds growth while `flush` makes the checkpoint current on demand. |
| Immediate log pruning after compaction | Loses the forensic window; 7 days is cheap because rows are coalesced. |

**Consequences.** Positive: durable acknowledgement is per commit and independent of the debounce; every restore is reversible (`pre_restore`); the "checkpoint at head for unloaded notes" invariant lets `restore --verify` and `iridium doctor` check consistency; retention is bounded and named versions are permanent. Negative: the compactor holds `saveMutex` while awaiting a transaction on `dbPersist` — bounded by the FIFO and the pool size; thinning removes intermediate `checkpoint` rows, so `get_note(revision=N)` on a thinned revision answers "not retained; nearest retained: …" (A34).

**Verification.** `collab.durable-ack.chaos` (kill-after-ack ×20 on PR, ×200 nightly; `store.throw`, `store.crash-before-commit`, `store.crash-after-commit-before-ack`, `store.slow:<ms>`, `compact.throw`); `collab.unload-after-veto.integration`; `collab.graceful-shutdown.chaos`; `projection.monotonic.integration`; `revisions.thinning.integration`; `revisions.restore.integration` (`pre_restore` + `restore` rows); `persistence.model.prop`; the `iridium doctor` invariant `head_seq == GREATEST(snapshot_through_seq, MAX(note_updates.seq))`.

**References.** Digest §2.2 (`saveMutex`, no retry, `SkipFurtherHooksError`, `flushPendingStores`), §1.2 (`mergeUpdates`, GC), §11.2, §11.4, §11.23; spec §5, §6, §8; plan-risk-first ADR-03; plan-agent-first ADR-04; plan-enterprise ADR-07/ADR-08; plan-product-dx 007/028. Implemented in `05-collaboration-and-durability.md` and `03-data-model.md` (§C.5).

### A17 — Hocuspocus 4.7.0 embedded as the `Hocuspocus` class inside Fastify with Iridium's own extensions

**Status.** Accepted (2026-09-11); amended 2026-09-17, 2026-09-19 and 2026-09-20. **ADR file.** `docs/adr/0017-hocuspocus-embedded.md`.

**Context.** Spec §6 names Hocuspocus and states that MySQL integration is part of this project. Digest §2.2–§2.3 verified that Hocuspocus 4.7.0 is the only MIT, actively maintained (12 releases in 2026), Node-embeddable Yjs backend with per-document `onAuthenticate` and `connection.readOnly`, `onTokenSync`/`requestToken`, `beforeHandleMessage`/`beforeHandleAwareness`, a stateless side channel, `DirectConnection` for server-side edits, `saveMutex`, and the `Hocuspocus` class (`handleConnection(WebSocketLike, Request, context)`) for mounting on an existing HTTP server. The `Server` class owns its own port; `@y/websocket-server` is a basic Yjs-14-beta backend without auth hooks; y-sweet is a separate Rust process with its own store and whose maintainer was acquired; a custom y-protocols server would re-implement everything. Verified hazards: `onChange` is invoked without `await`/`catch` (issue #754) so a rejecting hook is an unhandled rejection; Hocuspocus creates an empty document for any requested name; `closeConnections()` uses 4205 for everyone.

**Decision.** `new Hocuspocus({timeout: 60000, debounce: 2000, maxDebounce: 10000, unloadImmediately: true, yDocOptions: {gc: true}, maxPendingDocuments: 100, extensions: [IridiumAuth, IridiumLimits, IridiumPersistence, IridiumVaultChannel]})` created in `apps/server/src/collab/server.ts` and mounted with `app.get('/collab', {websocket: true, preValidation: [originAllowlist, connectionCaps]}, …)` via @fastify/websocket 11.3.0 (`options.maxPayload = 2 MiB`), forwarding `message`/`close` to `ClientConnection.handleMessage`/`handleClose`. Document names are `note:<uuid>` and `vault:<uuid>`. The **persistence listener is Iridium's own `document.on('update')`** registered in `afterLoadDocument`, filtering `LOAD_ORIGIN` and accepting `{source:'connection'}` and `{source:'local'}` origins; `onChange` is not used for persistence. Every hook body is wrapped so it never rejects (issue #754). `@hocuspocus/extension-database` is not used. Hocuspocus specifics are confined behind `CollabServer` (start/stop, `closeNote`, `revokeUser`, `changeRole`, `broadcastVault`, `openServerEdit`, `participants`) and `CollabPersistence` interfaces in `apps/server/src/collab/`. Hook contract per document (skeleton §D.2): `onAuthenticate`, `onLoadDocument`, `afterLoadDocument`, `beforeHandleMessage`, `beforeHandleAwareness`, `onStateless`, `onTokenSync`, `onStoreDocument`, `beforeUnloadDocument`, `afterUnloadDocument`. `onLoadDocument` refuses unknown, trashed, foreign-vault and archived notes so Hocuspocus can never create phantom documents.

**Amendment (2026-09-17): awareness frame fidelity.** The pinned 4.7.0 `MessageReceiver` creates a scratch awareness instance whose synthetic local `{}` state reaches identity hooks, and its filtered re-encoding drops explicit null removals. Keep a version-bound pnpm patch to the source and both shipped runtimes: remove only that scratch participant and metadata, preserve null removals from the input, and retain a hook's deletion of a non-null state as suppression. Register restored presence (reported as `updated` by y-protocols) back to its connection so a later close removes it. The client adapter publishes only its own document client id, including null removal; remote timeouts remain local. Iridium validates every raw awareness entry before dispatch, including duplicate client ids and removal ownership, then keeps the identity/shape hook as defence in depth. This preserves strict impersonation checks and legitimate disconnect presence removal. `collab.awareness-identity.integration`, `crdt.frame.unit`, and `kernel.smoke.integration` verify the boundary; remove the patch only when an upstream version passes the same tests.

**Amendment (2026-09-19): failed-load ownership.** A document is not published in Hocuspocus's registry until both load hooks succeed. In pinned 4.7.0, an `onLoadDocument` rejection calls `unloadDocument`, which refuses unregistered documents; an `afterLoadDocument` rejection has no cleanup. Both paths leave the allocated document and its awareness timer alive. Extend the version-bound source/ESM/CJS patch to destroy that unpublished document before rethrowing the original error. Successful loads retain the ordinary unload-veto path. `collab.upgrade-cleanup.unit` proves destruction and a clean retry at both hook boundaries; `notes.fresh-capacity.integration` proves the real refused REST load and child lifecycle on Actions. Keep this patch until an upstream version passes those regressions.

**Amendment (2026-09-20): first-frame persistence latches.** Hocuspocus 4.7 drains queued frames before its `connected` hook chain finishes; IridiumAuth awaits participant identity SQL in that chain. Initial persistence latches therefore run once per native connection at the first `beforeHandleMessage` or `connected` boundary, whichever occurs first. This composes content-invalid, oversize, failed/backpressure and ownership/principal latches before native sync applies a queued update, while also notifying idle connections. A weak connection set prevents duplicate initialization notices. Extension order, subsequent ACL composition, native read-only handling and recovery policy are unchanged. `collab.persistence-hook.unit` sends real SyncStep2 and Update frames before connected and proves refusal without changing document or durable head, plus the writable control. `collab.latches.integration` holds the real connected hook chain across role upgrade, then preserves the original epoch, token and pending-edit assertions. The failed nightly check `106065102033` in run `35505721446` and negative local reproductions remain in `docs/milestones/remote-ci.md`.

**Alternatives considered.**

| Alternative | Why rejected |
|---|---|
| Hocuspocus `Server` class on its own port | Second port, second TLS endpoint, second Origin policy; cannot share Fastify's upgrade `preValidation`. |
| y-websocket / `@y/websocket-server` | No auth hooks; persistence only on last disconnect; Yjs 14 beta line. |
| y-sweet | Separate Rust process with its own S3/filesystem store and token scheme; MySQL cannot be the system of record; no releases since 2025-09. |
| Custom `ws` + y-protocols server | Re-implements multiplexing, auth queues, readOnly, awareness, ping/pong, ordered processing, load/unload and backoff for the sole benefit of an ack message the stateless channel already provides. |
| crossws node adapter (the documented pattern) | Loses Fastify's plugin-tree auth on upgrade; `@fastify/websocket` keeps `Origin` checks and connection caps inside `preValidation` (validated by the M0 spike). |
| `onChange` as the persistence hook | Fire-and-forget without catch (#754); a direct `update` listener is synchronous and owned by Iridium. |

**Consequences.** Positive: one port, one TLS endpoint, one Origin policy, one revocation path (A23) and one ticket scheme (A24); server-side edits (restore, repair, import fix-ups) flow through `DirectConnection` and the same durability pipeline; the interface seam preserves F9 (a later split into a separate process) without a rewrite. Negative: the Fastify wiring is hand-written (`handleMessage`/`handleClose`) and Hocuspocus's `onRequest`/`onUpgrade`/`onListen` hooks do not fire in this mode — the M0 spike validates it; the client is locked to `@hocuspocus/provider` (its wire protocol is proprietary), acceptable behind `@iridium/collab-client`; Tiptap's "future of Hocuspocus" survey (issue #1153) is a watch item recorded in `14-risks-and-open-questions.md`.

**Verification.** M0 spike `docs/spikes/S02-fastify-websocket-hocuspocus.md`; `kernel.smoke.integration`; `collab.convergence.integration` (three clients, overlapping positions); `collab.viewer-enforcement.integration` (`SyncStatus(false)`, no state change); `collab.baseline-on-connect.integration`; `security.ws-origin.integration`; `collab.limits.integration`; every hook has a unit test asserting it never rejects.

**References.** Digest §2.1–§2.5, §11.6 (framework), §11.22; spec §6; plan-risk-first ADR-02; plan-agent-first ADR-03; plan-enterprise ADR-06/ADR-16; plan-product-dx 005. Implemented in `05-collaboration-and-durability.md` and `02-system-architecture.md`.

### A18 — Vault realtime channel: `vault:<vaultId>` as an empty, never-persisted Hocuspocus document

**Status.** Accepted (2026-09-11). **ADR file.** `docs/adr/0018-vault-channel.md`.

**Context.** Spec §3 says nothing about live tree semantics; without a push channel the tree, membership and vault presence are stale until refresh. The desktop client cannot carry its bearer credential on an `EventSource`, and a second WebSocket would need a second auth and revocation path. Hocuspocus already provides authenticated, revocable, multiplexed documents on one socket and a stateless broadcast primitive (digest §2.2). The product-dx plan proposed this design (022); all three judge panels grafted it.

**Decision.** Every vault has a Hocuspocus document named `vault:<vaultId>` handled by the `IridiumVaultChannel` extension: `onLoadDocument` returns nothing (the document stays empty), `onStoreDocument` throws `SkipFurtherHooksError`, `connection.readOnly = true` for every connection, and no update from a client is ever applied. The document is used only for `document.broadcastStateless` of `tree-changed {treeVersion, changes:[{nodeId, parentId, kind, op, version}]}`, `member-changed {userId, role|null}` and `vault-updated {version}`, and for vault awareness `{id, activeNoteId}`. It is authenticated with the same tickets (A24), authorised by `vault:read`, and closed by the same `CollabGateway` revocation path (A23). One provider per open vault per window; the UI invalidates the TanStack Query keys `[origin, 'vault', vaultId, …]` on each message (A40). Adopted at M4 (the server side ships with M2's tree service, which already bumps `vaults.tree_version` and calls `broadcastVault`).

**Alternatives considered.**

| Alternative | Why rejected |
|---|---|
| REST polling | Stale by the poll interval; wasted load at fleet scale. |
| Server-Sent Events | Cannot carry the desktop bearer (main-only custody, A26) without a second credential path; a second connection to revoke. |
| Second WebSocket endpoint | Duplicates auth, Origin, ticket and revocation logic. |
| Persisting the vault document | Nothing to persist; an empty document avoids the compaction/checkpoint machinery entirely. |

**Consequences.** Positive: instant tree/membership freshness and vault presence over an already-authenticated, already-revocable socket; the stateless messages are schema-validated in `@iridium/contracts/collab.ts` (`v: 1`). Negative: one extra Hocuspocus document per open vault counts against `maxPendingDocuments`/the admission budget (A50) — vault documents are empty and cheap; a client that sends a Yjs update on `vault:*` is answered `SyncStatus(false)` and, on a second attempt, closed `protocol-error`.

**Verification.** `tree-live-updates.e2e` (Playwright web, M4); `collab.live-revocation.integration` covers `vault:*` closures; `collab.isolation.integration` asserts that `onStoreDocument` throws `SkipFurtherHooksError`, that `onLoadDocument` leaves the document empty, and that no client update on `vault:*` is ever applied; `collab.limits.integration` covers the read-only enforcement.

**References.** Digest §2.2 (stateless channel, multiplexing, `SkipFurtherHooksError`); plan-product-dx 022; judges 1–3; skeleton F11. Implemented in `05-collaboration-and-durability.md` and `07-client-applications.md`.

### A19 — The "Saved" acknowledgement protocol

**Status.** Accepted (2026-09-11); amended 2026-09-18 to require a canonical delete-set fingerprint beside vector dominance. **ADR file.** `docs/adr/0019-saved-ack-protocol.md`.

**Context.** Spec §5: "Saved means the server has durably persisted a state that includes the user's pending edits. Being connected or synchronized with the server's memory is not sufficient." Digest §2.2 verified that Hocuspocus's `SyncStatus(true)` and the provider's `unsyncedChanges === 0`/`synced` fire immediately after the in-memory apply and before any store, and that there is no store retry (§11.4). §11.3 records the disagreement over which client clock to compare: own-clientID clock (Topics 1, 2, 5) versus full state-vector dominance (Topic 8), with Hocuspocus issue #845 ("maxDebounce causing client-id to change", still open) as the reason to prefer dominance. Two gaps existed in every plan: a client that opens a note without editing has no `persisted` message to compare against, and a crash between COMMIT and the broadcast leaves the client in `syncing` forever.

**Decision.** (1) A client Yjs update reaches the server; `applyUpdate` runs; Hocuspocus answers `SyncStatus(true)` — in-memory only, never "Saved". (2) Iridium's `update` listener captures `svAfter = Y.encodeStateVector(doc)` and `dsAfter = deleteSetFingerprint(doc)` synchronously at the same applied-update boundary and enqueues `{update, svAfter, dsAfter, actor:{userId, sessionId}, origin}` into the `NoteWriter`. (3) The writer transaction on `dbPersist`: `BEGIN; SELECT deleted_at FROM nodes WHERE id = ? FOR SHARE; SELECT node_id FROM notes WHERE node_id = ? FOR UPDATE; SELECT head_seq FROM note_docs WHERE note_id = ? FOR UPDATE` (trashed → drop the batch and close the document `note-trashed`); coalesce (A16); `INSERT note_updates (seq = head+1 … head+N, update_v1, sv_after, actor_type, actor_id, session_id, origin, …)`; `UPDATE note_docs SET head_seq = head+N, updated_at = ? WHERE note_id = ? AND head_seq = head` asserting `numUpdatedRows === 1n` (a mismatch is a corruption alarm, never silent); `COMMIT` under `innodb_flush_log_at_trx_commit = 1`. (4) Only after COMMIT: `document.broadcastStateless({t:'persisted', seq: head+N, sv: base64(svAfter_last), ds: dsAfter_last})`; the writer records `lastPersisted = {seq, sv, ds}`. (5) **Baseline:** after every provider `synced` event (initial connect and every reconnect) the client sends `{t:'baseline'}`; `onStateless` replies `connection.sendStateless({t:'persisted', seq, sv, ds})` from `lastPersisted`, initialised in `afterLoadDocument` from the fully replayed committed document and `note_docs.head_seq`; both the vector and fingerprint describe that committed FIFO prefix. An unloaded baseline replays the snapshot and ordered log before computing the pair. (6) The client's `SaveStateMachine` (`@iridium/collab-client`, pure, property-tested): `saved ⇔ socket connected ∧ provider.synced ∧ unsyncedChanges == 0 ∧ dominates(persistedSv, Y.encodeStateVector(ydoc)) ∧ persistedDs === deleteSetFingerprint(ydoc)`, where `dominates` checks every `(clientId, clock)` pair of the local vector and exact fingerprint equality additionally covers local or relayed deletions whose clocks do not change. (7) Failure: `{t:'persist-failed', seq, reason, retryInMs}` with `reason ∈ {db_unavailable, db_error, note_trashed, too_large, backpressure, content_invalid}`; the batch stays at the head of the queue; backoff 200 ms → 5 s with jitter, unbounded while the document is loaded; the writer enters `failed` after 10 attempts or 30 s (alert; keeps retrying every 30 s). (8) The client shows `save-failed` when a `persist-failed` is newer than the last `persisted`, or when vector dominance and exact delete-set fingerprint equality have not both been reached within 15 s of the last local edit. (9) `{t:'flush'}` (Ctrl/Cmd+S; ≤ 6 per minute per connection) triggers immediate compaction plus projection and answers `{t:'projected', seq}`; the status pill shows "Saved · up to date for agents". Spec deviation F2 makes the definition precise: a Markdown checkpoint is **not** required for Saved (it trails by ≤ 10 s; `flush` makes it current).

**Alternatives considered.**

| Alternative | Why rejected |
|---|---|
| Ack from `afterStoreDocument` | Only per debounced store; skipped on failure; no retry (§11.4). |
| Hocuspocus `SyncStatus` / provider `synced` | Means "in server memory" (§2.2); violates spec §5 literally. |
| Own-clientID clock only (`decodeStateVector(sv).get(ydoc.clientID)`) | Vulnerable to #845 and to relayed updates from a second tab; dominance costs the same and is strictly more conservative. |
| Counter-based acks (sequence numbers only) | Cannot express that the persisted state includes *this client's* edits after a reconnect that merged pending updates. |
| Requiring a Markdown checkpoint for Saved | Would tie Saved to the 2–10 s compaction and multiply write amplification; `flush` covers the agent-freshness need. |

**Consequences.** Positive: the acceptance row "Durable saving" holds under kill-after-ack with a 500–2 000 ms Toxiproxy latency toxic widening the window; a note opened without edits shows Saved immediately from the baseline; crash-after-commit-before-ack self-heals on reconnect; the `save-failed` state is explicit and recoverable. Negative: one extra round trip on every `synced` (the baseline message); the client must keep its own `unsyncedChanges` accounting in step with the provider's (which decrements only on `SyncStatus(true)`); the protocol is Iridium-specific and versioned (`v: 1`, A54).

**Verification.** `collab.durable-ack.chaos` (all fault points, kill-after-ack ×20 PR / ×200 nightly); `collab.baseline-on-connect.integration`; `collab.deletion-durability.integration` (local and relayed deletions held before COMMIT); `crdt.durability.unit`; `convergence.model.prop` and `crdt.dominates.prop`; `save-state.machine.prop` (random event sequences never report `saved` without vector dominance and exact canonical delete-set fingerprint equality); Playwright `saved-indicator.e2e` (Saved only after ack under a delayed-commit fault, M4); k6 SLO `durable_ack_ms p95 < 1 s`.

**References.** Digest §2.2, §1.2 (state vectors), §11.2, §11.3, §11.4; spec §5, §9; plan-risk-first ADR-03/ADR-05; plan-agent-first ADR-04/ADR-05; plan-enterprise ADR-07; plan-product-dx 007/008 (flush graft); skeleton F2. Implemented in `05-collaboration-and-durability.md`, `09-api-reference.md` (§D.2) and `07-client-applications.md` (status pill).

### A19 amendment, 2026-09-18: deletion-aware Saved acknowledgements

A pure deletion can leave every Yjs state-vector clock unchanged. The real held-COMMIT regression reproduced Saved before the deletion was durable, so v1 `persisted` now requires `ds`: exactly 64 lowercase hexadecimal characters containing SHA-256 of `Y.encodeSnapshot(Y.createSnapshot(Y.snapshot(doc).ds, new Map()))`, computed by `deleteSetFingerprint` in `@iridium/crdt`. The fingerprint records deleted struct ranges; it neither replaces the state vector nor contains deleted content or synthetic document metadata.

The writer captures `{svAfter, dsAfter}` synchronously at each applied-update boundary. Coalescing retains the final member's pair, and retry or exact durable reconciliation retains that same committed FIFO prefix witness; later edits never enter an earlier acknowledgement. Baselines compute both witnesses from the fully replayed committed document. Saved, the pending-work warning and the 15 s deadline require vector dominance AND exact fingerprint equality. A server fingerprint containing additional deletions is conservatively unsaved until replay and a matching acknowledgement. Missing or malformed `ds` is rejected, never defaulted. No SQL witness column is required. This is a pre-release v1 correction: the server and clients must ship together.

Verification: `collab.deletion-durability.integration` holds local and relayed deletions before COMMIT; `crdt.durability.unit` proves canonical fingerprint behavior; `save-state.machine.prop` covers the combined predicate.

### A20 — Role change on a live connection: server flips `readOnly`, client re-attaches on upgrade

**Status.** Accepted (2026-09-11). **ADR file.** `docs/adr/0020-live-role-change.md`.

**Context.** Spec §4 requires that downgrading a role affects already-open sessions. Digest §2.2 verified that for a `readOnly` connection an incoming update is not applied and is answered `SyncStatus(false)`, which leaves the provider's `unsyncedChanges` permanently above zero; the provider re-authenticates only when the socket reopens, and `forceSync()` does not resend rejected updates. Every source plan handled the downgrade; none handled the upgrade back to editor, which is the common "give me edit rights for a minute" flow.

**Decision.** Downgrade: `CollabGateway.changeRole()` sets `connection.readOnly = true` on every `note:*` connection of that user in the vault and sends `connection.sendStateless({t:'role', role:'viewer'})`; pending viewer updates are answered `SyncStatus(false)` and the client enters the `rejected` state with its text exportable via `host.files.saveText` ("Export my text"). Upgrade: `readOnly = false` plus `{t:'role', role}`; the client detaches the provider and attaches a **fresh `HocuspocusProvider` on the same `Y.Doc`** with a fresh ticket — the full SyncStep1/SyncStep2 exchange merges every pending local update, `unsyncedChanges` resets — then requests the baseline (A19). `forceSync()` alone is not used.

**Alternatives considered.**

| Alternative | Why rejected |
|---|---|
| `forceSync()` on upgrade | Verified not to resend updates that were rejected; `unsyncedChanges` never returns to zero, so Saved is unreachable. |
| Close the connection on any role change and let the provider reconnect | Loses the pending viewer edits the spec wants kept "visibly unsaved and recoverable" (spec §5). |
| Client-side re-authentication only | The server must flip `readOnly` itself; it is the security boundary (spec §4). |

**Consequences.** Positive: both directions are handled without losing text; the same `Y.Doc` and `UndoManager` survive the re-attach, so per-client undo is intact. Negative: a re-attach is a full sync of the note (bounded by the note-size limits, A.1); the client must serialise re-attach with any in-flight ticket fetch.

**Verification.** `collab.live-revocation.integration` (includes downgrade → upgrade re-attach, asserting pending updates land and Saved is reached); `status-pill.transitions.component` (a fake provider driven through baseline and re-attach, M4); `revocation-while-open.e2e`.

**References.** Digest §2.2 (readOnly enforcement, `unsyncedChanges` accounting, per-document close semantics); spec §4, §5; gap fix "role upgrade after downgrade". Implemented in `05-collaboration-and-durability.md` and `07-client-applications.md`.



**M1 recovery amendment (2026-09-17).** The same resynchronization is required after a persistence outage, backpressure, content repair or an oversize reduction, even when the ACL role is unchanged. Only the writer's committed recovery path emits `role {role, recovered:true}`, after every write latch has cleared. The client then replaces its provider on the same document and undo manager, resends refused local edits and reseeds content latches through a fresh handshake. Ordinary membership and epoch refreshes carry no marker and reapply the writer's current latches server-side, so an ACL upgrade cannot unlock an invalid note. Detach waits for the previous attachment's close echo before installing its replacement. `notes.repair-content.integration`, `collab.db-outage.chaos`, `collab.backpressure.chaos` and `note-session.unit` cover these paths.

### A21 — Per-document persistence serialisation and backpressure: `NoteWriter`

**Status.** Accepted (2026-09-11). **ADR file.** `docs/adr/0021-note-writer-backpressure.md`.

**Context.** Spec §6: "Serialize persistence per note so an older asynchronous save cannot overwrite a newer state." During a MySQL outage an unbounded in-memory queue grows without limit (the risk-first plan's queue was unbounded); Hocuspocus's `beforeUnloadDocument` can veto an unload but nothing re-triggers it afterwards, so a vetoed unload could pin a document in memory forever (a gap in every plan).

**Decision.** One `NoteWriter` per loaded document (`apps/server/src/collab/persistence/writer.ts`), strict FIFO, at most one in-flight transaction per note; compaction jobs share the FIFO (A16). The database guard is `note_docs … FOR UPDATE` plus the `head_seq` CAS — never an in-memory counter alone. **Queue bound:** 5 000 updates or 32 MiB; when exceeded the document becomes read-only for all connections, the writer broadcasts `persist-failed {reason:'backpressure'}` and an alert fires, until the queue drains. **Global fairness:** persistence concurrency equals `DB_POOL_PERSIST` (4) with round-robin scheduling across notes so no note starves. `beforeUnloadDocument` throws while the queue is non-empty or a transaction is in flight; **after the drain, if `getConnectionsCount() === 0`, the writer calls `hocuspocus.unloadDocument(document)`** so vetoed unloads complete; `afterUnloadDocument` disposes the writer. `/readyz` reports unhealthy when the oldest pending update is older than 30 s or any writer has been `failed` for more than 60 s (A49).

**Alternatives considered.**

| Alternative | Why rejected |
|---|---|
| Unbounded queue (plan-risk-first) | Memory grows without bound during a DB outage; OOM converts a database incident into a collaboration outage. |
| In-memory sequence counter as the only guard | A restart or a second process breaks it; the row lock plus CAS is the only authoritative serialisation. |
| Dropping updates under backpressure | Violates spec §5 (edits must stay recoverable); read-only mode keeps the text on every client. |
| One global writer for all notes | Head-of-line blocking across notes; per-note FIFOs plus round-robin give fairness. |

**Consequences.** Positive: bounded memory during outages while the ack stays truthful; no note can starve another; documents never leak after a veto. Negative: read-only under backpressure is a visible degradation (by design, with an alert); the writer's retry loop is Iridium code to maintain (Hocuspocus provides none).

**Verification.** `collab.backpressure.chaos` (Toxiproxy latency/timeout on MySQL → queue bound reached → read-only + `persist-failed {backpressure}` → drain → editable again); `collab.unload-after-veto.integration`; `collab.graceful-shutdown.chaos` (drain within 20 s); `readyz.integration` (backlog age and `failed` writer conditions); k6 fairness assertion (no note's `durable_ack_ms` p95 exceeds the SLO while others are hot).

**References.** Digest §2.2 (`beforeUnloadDocument`, `unloadDocument`, `shouldUnloadDocument`), §2.4 (pool sizing under simultaneous maxDebounce flushes); spec §6; plan-product-dx 007 (bounded queue graft); gap fixes. Implemented in `05-collaboration-and-durability.md`.

### A22 — Hostile CRDT content detection at compaction, flag, and repair CLI

**Status.** Accepted (2026-09-11). **ADR file.** `docs/adr/0022-hostile-crdt-content.md`.

**Context.** The Y.Text of record must be LF-only and attribute-free: CodeMirror treats `\r\n` as one position while Y.Text counts two UTF-16 units (y-codemirror.next #35), and `Y.Text.toString()` silently drops `ContentFormat`/`ContentEmbed` items, so a client that inserts formatting attributes or `\r` makes projections diverge from the CRDT without any error (digest §1.2, §1.4). A hostile or buggy client can do either through the ordinary sync protocol; decoding every incoming update server-side to check would be expensive (§1.6).

**Decision.** At every compaction (A16) the compactor verifies that `ytext.toDelta()` contains only `{insert: string}` entries (no `attributes`, no embeds) and that `markdown.includes('\r')` is false. On violation: `note_projections.status = 'invalid_content'`, `notes.content_invalid = 1`, stateless `{t:'content-invalid', reason:'cr'|'attributes'}` (the editor becomes read-only for that note), audit event `note.content.invalid`, metric and alert. Repair is explicit and audited: `iridium doctor --repair-content <note>` rewrites the Y.Text through a `DirectConnection` with origin `{source:'local', context:{reason:'repair'}}` — removing `\r` and re-inserting formatted spans as plain text — and writes `note.content.repaired`. Entry points normalise at the boundary (A45, F1): import, create, restore and repair enforce LF; the client strips `\r` on paste and blocks its insertion (A41).

**Alternatives considered.**

| Alternative | Why rejected |
|---|---|
| Decode and validate every incoming update in `beforeHandleMessage` | CPU cost per keystroke for every connection; the compaction-time scan catches the same conditions before any projection is published. |
| Silently strip attributes in the projection | Hides data loss; the CRDT would still carry content the text does not. |
| Automatic server-side repair without an operator | A repair is a content mutation; it must be deliberate and audited. |

**Consequences.** Positive: cheap (one `toDelta()` per compaction), catches both the CRLF desync class and silently dropped formatting before search, MCP or export diverge; the note is quarantined rather than corrupted further. Negative: an affected note is read-only until an operator repairs it (a visible incident, by design); the scan is at compaction cadence, so a hostile client's damage can be live for up to `maxDebounce` before detection.

**Verification.** `collab.content-invalid.chaos` (a `ws` test client inserts `\r` and a formatted span; asserts the flag, the stateless message, the audit row and the read-only state; then runs `doctor --repair-content` and asserts the projection matches); `collab.lf-invariant.guard` (guard test on all entry points); `markdown.roundtrip.prop` (A45).

**References.** Digest §1.2 (`toString()` drops attributes; #35), §1.4, §1.6 (server-side enforcement cost); skeleton F1; gap fix "hostile CRDT content". Implemented in `05-collaboration-and-durability.md` and `11-operations-and-deployment.md` (CLI).

### A50 — Loaded-document admission control: explicit budget with refusal, no eviction

**Status.** Accepted (2026-09-11). **ADR file.** `docs/adr/0050-admission-control.md`.

**Context.** All active `Y.Doc`s live in the server process (A17). Digest §2.6 lists the memory budget as an open question; yjs #675 shows multi-second `applyUpdate` and freezes near 9 MB states. No source plan bounded the number or total size of loaded documents, so a burst of opens (or a pathological vault) could exhaust memory and take down collaboration for everyone.

**Decision.** Two environment-configurable budgets: `COLLAB_MAX_LOADED_DOCS` (default 2 000) and `COLLAB_MAX_STATE_BYTES_TOTAL` (default 1 GiB, estimated from `note_docs.snapshot_size` at load time). When admitting a new document would exceed either, `onAuthenticate` throws and the connection is closed with reason `capacity`; the client shows "Server busy — retrying" and retries with the provider's backoff; an alert fires. Idle documents unload through `unloadImmediately: true` (after the writer drains, A21). Live documents are never evicted. Metrics `iridium_docs_loaded` and `iridium_note_state_bytes`; `/readyz` warns at 80 % of either budget.

**Alternatives considered.**

| Alternative | Why rejected |
|---|---|
| LRU eviction of live documents | Evicting a document with connected editors interrupts them and forces a reload storm; refusing new admissions is predictable and affects only newcomers. |
| No limit (rely on `maxPendingDocuments`) | `maxPendingDocuments` bounds concurrent *loads*, not resident documents. |
| Per-vault budgets | Adds policy surface without a demonstrated need; the process-level budget is the OOM protection. |

**Consequences.** Positive: predictable OOM protection; operators see the budget on the dashboard and can size the process; capacity is a visible, alertable condition rather than a crash. Negative: under sustained overload new opens are refused (by design); the byte estimate uses the last compacted size, so a note that grew since compaction is under-counted until the next compaction.

**Verification.** `collab.limits.integration` (open documents up to the budget with a small `COLLAB_MAX_LOADED_DOCS`, assert the next open closes with `capacity` and that unloading one admits one more); `readyz.integration` (80 % warning); the k6 load lane asserts RSS < 1.5 GB at 300 VUs / 60 docs on 4 vCPU (A51).

**References.** Digest §2.6 (memory budget question), §1.2 (yjs #675), §2.2 (`maxPendingDocuments`, `unloadImmediately`); skeleton F15; gap fix. Implemented in `05-collaboration-and-durability.md` and `11-operations-and-deployment.md`.

### A.1 — Single limits policy

**Status.** Accepted (2026-09-11). **ADR file.** `docs/adr/0058-limits-policy.md`.

**Context.** Digest §11.24 records five incompatible sets of size limits across the research topics (WebSocket `maxPayload` 1, 2 or 4 MiB; note caps of 1 000 000 UTF-16 units, 2 MiB, or 2 MB Markdown / 16 MB state; 100 messages per second versus per-minute budgets). A pathological Markdown document or unbounded CRDT growth is a real denial-of-service class (yjs #675; micromark quadratic cases in §7.2), and the spec (§8) requires upload and message size limits. Limits scattered across packages drift.

**Decision.** One policy, expressed as constants in `@iridium/contracts/limits.ts` and enforced at the named points:

| Item | Value | Enforced where |
|---|---|---|
| WebSocket frame `maxPayload` | 2 MiB | `@fastify/websocket` options |
| Single Yjs update | ≤ 1 MiB | `beforeHandleMessage` (close `too-large`) |
| Yjs messages per connection | 200 / 10 s | `beforeHandleMessage` (close `rate-limited`) |
| Awareness messages per connection | 10 / s (excess dropped) | `beforeHandleAwareness` |
| Connections | 20 per user, 50 per IP, 5 000 per process | upgrade `preValidation` |
| Loaded documents / state bytes | 2 000 docs / 1 GiB | `onAuthenticate` (close `capacity`, A50) |
| Note text | soft 1 000 000 UTF-16 units (client blocks pastes; server flags `notes.oversize` at compaction → note read-only until reduced); hard 2 097 152 at create/import/restore/repair | client + server |
| V2 snapshot size | alert > 8 MB; compaction refuses > 64 MB (note read-only, admin alert) | compactor |
| Writer queue | 5 000 updates or 32 MiB → backpressure | `NoteWriter` (A21) |
| Writer batch | 512 updates or 8 MiB of raw update bytes per transaction (`WRITER_BATCH_MAX_UPDATES`, `WRITER_BATCH_MAX_RAW_BYTES`); a merged `note_updates` row ≤ 1 MiB | `NoteWriter` batch assembly, split at `(actor, session, origin)` run boundaries (A16) |
| Compaction debounce / max | 2 000 / 10 000 ms (100 / 500 in integration tests) | Hocuspocus config |
| `flush` / `?fresh=true` | 6 / min per connection, or per principal + note | `onStateless`, REST rate limit |
| Update-log retention after compaction | 7 days | maintenance job |
| Checkpoint cadence | content change ∧ ≥ 10 min (vault setting) + unload/named/restore/import/trash | compactor |
| Ticket TTL / reuse / batch / rate | 60 s / single use / ≤ 50 per request / 300 per min per session, 1 000 per min per IP | `TicketStore`, rate limit |
| Token re-validation | every 15 min ± 3 min jitter; 5 min reply grace | `onTokenSync` |
| REST | authenticated 600/min per principal; unauthenticated 60/min per IP; login 10/min per IP | `@fastify/rate-limit` |
| MCP / PAT | 120/min burst + 3 000/h per token (search costs 3); `/mcp` process ceiling 600/min | `mcp/rate-limit.ts` |
| Markdown projection | 2 MiB source, blockquote depth 32, list indent 64 cols, 20 000 lines/paragraph, 10 s server / 2 s client | `@iridium/markdown` pre-scan + workers |
| Upload | 50 MiB per attachment; import 2 GiB, 50 000 files, depth 64 | `@fastify/multipart`, import worker |
| Body limits | JSON 1 MiB (`/mcp` 1 MiB) | Fastify `bodyLimit` |
| Shutdown drain | 20 s | `main.ts` |

Every value is imported from the contracts package by the enforcing code and by the tests; no literal limit appears elsewhere (a lint `no-magic-numbers` exception list is maintained for this file only). A later section may **add** a cap to `limits.ts` — it must then appear in the `LimitId` union with an enforcement site and in the canonical rendering of `02-system-architecture.md` §"The single limits policy" — but it may never rename one, because the single-source test compares identifiers rather than values and a second spelling of one cap leaves one constant unreferenced and the other outside the union.

**Alternatives considered.**

| Alternative | Why rejected |
|---|---|
| Per-topic numbers left as found in the digest | Contradictory; a 4 MiB `maxPayload` with a 1 MiB update cap, or a 1 MiB payload with a 2 MiB note, cannot both be right. |
| Larger note caps (16 MB state) | yjs #675 shows multi-second loads near 9 MB V1; the 8 MB alert and 64 MB refusal keep loads responsive. |
| Limits configurable per deployment for everything | Most values are protocol invariants that clients and tests depend on; only the few marked as vault or server settings (checkpoint interval, PAT rate, TTLs) are runtime-configurable. |

**Consequences.** Positive: one source of truth shared by client, server, load tests and documentation; every enforcement point has a named close reason or error code; the digest's conflict is closed. Negative: the numbers are engineering defaults derived from yjs #675, crdt-benchmarks and the micromark measurements rather than Iridium-specific measurements — M8's load calibration may revise them (a revision is a new ADR superseding this one).

**Verification.** `collab.limits.integration` (each WebSocket limit triggers its close reason); `tickets.batch-and-limits.integration`; `mcp.rate-limit.mcp`; `markdown.pathological.unit` (pre-scan rejects each cap); `attachments.security.integration` (upload cap); `limits.policy.unit` (a compile-time exhaustive switch over the `LimitId` union, distributed across the enforcing modules, so a constant with no enforcement site does not compile) and `limits.single-source.guard` (no numeric limit exists outside `@iridium/contracts/limits.ts`); `ops.load.slo` at M8.

**References.** Digest §11.24, §1.2 (#675), §7.2 (quadratic cases), §6.2 (OWASP WebSocket message/rate limits); spec §8; plan-risk-first ADR-26; plan-product-dx 029; skeleton §A.1 and F15. Implemented in `05-collaboration-and-durability.md`, `08-markdown-pipeline-import-export.md`, `09-api-reference.md` and `11-operations-and-deployment.md`.

---

## Area 4 — Identity, sessions, and authorization

### A23 — Live revocation: version columns, an in-process bus, a collaboration gateway, epoch checks, no caches

**Status.** Accepted (2026-09-11). **ADR file.** `docs/adr/0023-live-revocation.md`.

**Context.** Spec §4 is explicit: "Revoking access or downgrading a role must affect already-open sessions, not just the next login. The server must stop unauthorized future reads/writes and disconnect or reauthorize affected collaboration sessions." Spec §9 makes it an acceptance row ("Live revocation"). The difficulty is that three credential kinds and two long-lived surfaces are involved at once: a cookie session doing REST, a WebSocket connection that was authorized at upgrade and may live for hours, and a PAT that an agent presents per call. Digest §6.2 records the OWASP requirements that drive the design — authorize every WebSocket *message* and not just the connection, close all of a user's sockets on logout or session expiry, rotate tokens on long-lived connections, deny by default, validate permissions on every request through centralized middleware — and the Hocuspocus 4.7.0 primitives that make it possible: `connection.readOnly`, `onTokenSync` with `connection.requestToken()`, `Hocuspocus.closeConnections(documentName?)`, `hocuspocus.documents`, `document.connections`, and `@hocuspocus/common` `CloseEvents` (Unauthorized = 4401). Three of the four source plans proposed a short-TTL principal cache (15–30 s) to keep per-request cost down; that cache is exactly a 30-second window in which a removed member keeps reading, which the acceptance row forbids. A judge review also found a weakness in the first formulation: collapsing `users.authz_version` and `vault_members.version` into one summed integer makes two independent changes cancel out.

**Decision.** Versioned rows plus an after-COMMIT bus plus an enforcement gateway, with no authorization cache in the MVP.

1. **Version columns.** `users.authz_version INT UNSIGNED` is bumped when the user is disabled, their password changes, an administrator revokes their sessions, or any `vault_members` row for that user is inserted, updated, or deleted. `vault_members.version INT UNSIGNED` is bumped on a role change (it is also the `If-Match` ETag source for membership routes, A13).
2. **`AuthzBus`.** An interface (`apps/server/src/authz/bus.ts`) with an in-process implementation for the MVP and a Redis implementation as the recorded post-MVP path (F9). It publishes **after COMMIT**, never inside the transaction: `user.disabled`, `user.password_changed`, `session.revoked`, `token.revoked`, `membership.removed`, `membership.role_changed`, `vault.archived`, `note.trashed`, `note.purged`.
3. **`CollabGateway`.** Subscribes to the bus and iterates `hocuspocus.documents` → `document.getConnections()`. Membership removal, user disable, or session revocation close every `note:*` and `vault:*` connection belonging to that user or session with `connection.close({code: 4403, reason: 'revoked'})`. A role downgrade or upgrade follows A20 instead of closing. A vault archive closes the vault's connections with reason `vault-archived`. A note trash or purge closes that note's document.
4. **Epoch check per message.** Every connection carries `authzEpoch = {userAuthzVersion, memberVersion}` — **a tuple, never a sum**. `beforeHandleMessage` compares the tuple with the in-process epoch table and re-evaluates from the database on any mismatch, applying the result (close, `readOnly` flip, or continue) before the message is handled.
5. **Token re-validation.** `onTokenSync` is driven by `connection.requestToken()` every 15 minutes ± 3 minutes of jitter per connection (A24 sizes the ticket economy for it).
6. **Per-request evaluation.** REST costs two indexed lookups per request (the session row, then the membership row). MCP costs a fresh `access_tokens` row read plus a membership read per request. There is **no principal or PAT cache in the MVP**; the `PrincipalResolver` interface permits a version-checked cache later, and the version columns are precisely what such a cache would validate against.

Acceptance: closure within 1 s of COMMIT, a reconnect attempt refused, and the next MCP call failing.

**Alternatives considered.**

| Alternative | Why rejected |
|---|---|
| 15–30 s TTL principal cache (three of four source plans) | A bounded window in which a removed member still reads is still a violation of spec §4 and of the "Live revocation" acceptance row. Two indexed lookups on a single-process MVP are the cheaper correctness. |
| Rely on the next login / next connect | The literal text of spec §4 rejects it. |
| Single summed `authz_version` integer on the connection | A membership upgrade and a user-version bump can net to the same number; the tuple cannot collide. |
| Polling the database from each connection on a timer | Latency floor equal to the poll interval, plus N queries per tick; the bus is exact and free in-process. |
| Re-authorizing only at `onAuthenticate` | The connection outlives the decision; OWASP requires per-message authorization on WebSockets (digest §6.2). |

**Consequences.** Positive: revocation is exact, not eventual; the same mechanism serves sessions, tokens, and sockets; the bus boundary is the only thing that has to change for multi-process deployment (Hocuspocus ships `@hocuspocus/extension-redis` 4.7.0 for the document fan-out side). Negative: two extra indexed reads on every REST request and per MCP call (measured in the k6 budgets, and the reason `dbApp` has a pool of 20 — A10); the in-process bus makes single-process a correctness assumption for the MVP, which F9 documents and the interface contains; `beforeHandleMessage` does real work on the hot path, so the epoch table lookup must stay a map read.

**Verification.** `collab.live-revocation.integration` (membership removal, role downgrade, user disable, and session revoke each close the socket within 1 s of COMMIT and refuse the reconnect); `mcp.revocation.mcp` (next MCP call fails after revoke); `collab.epoch-tuple.prop` (property test: no pair of independent version changes produces an equal tuple); `authz.seams.unit` (a grep guard test asserting no principal memoisation outside the interface); k6 `durable_ack_ms` and `get_note` SLOs hold with per-request evaluation.

**References.** Digest §6.2 (OWASP WebSocket and authorization guidance, Hocuspocus hooks), §2.2, §11.15; spec §4, §9; plan-risk-first ADR-12; plan-enterprise ADR-11; judge weakness fix (tuple). Implemented in `04-auth-and-access-control.md` and `05-collaboration-and-durability.md`.

### A24 — Collaboration tickets: single-use 60 s tickets, batch issuance, limits sized to the connection caps

**Status.** Accepted (2026-09-11). **ADR file.** `docs/adr/0024-collab-tickets.md`.

**Context.** The WebSocket needs a credential that is not the session cookie (digest §6.2: tokens must never appear in the WebSocket URL, where they land in proxy access logs; a cross-site WebSocket handshake does not carry `SameSite=Lax` cookies, so cookies are not available to the desktop's `app://iridium` origin anyway) and not a long-lived bearer (the renderer must never hold a reusable credential, A26). Digest §11.13 records the disagreement: Topic 6 wanted single-use tickets, Topics 2 and 4 wanted a short-lived collab JWT from the provider's `token` getter. A gap all four plans shared: with ticket limits of 10–30 per minute, a user with 20 open documents who reconnects after a network blip needs 20 tickets at once and is immediately rate-limited out of their own workspace.

**Decision.** A ticket is `irid_tkt_<id16>_<secret43><crc6>` (the A31 credential format, kind `tkt`), stored SHA-256-hashed in an in-process `TicketStore` (an interface; Redis later per F9), bound to `{sessionId, userId}`, with a 60 s TTL and single use. `POST /auth/collab-tickets {count: 1..50}` issues a batch so one request covers a reconnect with many open documents. Rate limits: 300 tickets/min per session and 1 000/min per IP. Re-validation runs every 15 minutes ± 3 minutes of jitter per connection with a 5-minute server-side grace before a connection that has not answered `requestToken()` is closed. The provider's `token` getter retries 3 times with backoff on 429 or network errors, so a transient ticket-endpoint failure never closes a healthy connection. The ticket travels in the Hocuspocus auth message, never in the URL. The Origin allowlist on upgrade is `PUBLIC_ORIGIN`, `app://iridium`, plus dev origins when `NODE_ENV=development`; an **absent `Origin` is 403 always** — test clients use a `ws` subclass that injects `Origin: <PUBLIC_ORIGIN>` (`@iridium/testkit`, A51), and there is deliberately no bypass environment variable.

**Alternatives considered.**

| Alternative | Why rejected |
|---|---|
| Session cookie on the WebSocket | Not sent on the desktop's cross-site handshake; and a cookie that *is* sent cross-site (`SameSite=None`) is the CSWSH vector (digest §6.2). |
| Short-lived collab JWT (Topics 2/4, plan-agent-first) | A bearer the renderer holds and can replay for its lifetime; revocation then needs a denylist. A single-use ticket is revoked by being used. |
| Ticket in the WebSocket URL query string | Lands in reverse-proxy access logs (digest §6.2 explicitly forbids it). |
| 10–30 tickets/min (all four plans) | A 20-tab reconnect exhausts the budget; the limits are now sized from the A.1 connection caps (20 connections per user) with headroom for retries. |
| Multi-use tickets with a longer TTL | Replayable; single use plus batch issuance gives the same ergonomics without the replay window. |
| An `IRIDIUM_ALLOW_NO_ORIGIN_WS` escape hatch for tests | A production-reachable authentication bypass switch; the test client injects a real `Origin` header instead. |

**Consequences.** Positive: no reusable WebSocket credential exists anywhere; a reconnect storm costs one HTTP request per window; the Origin rule has no exceptions, so there is nothing to misconfigure. Negative: `POST /auth/collab-tickets` is on the reconnect hot path and must be fast and highly available (it is a single indexed insert into an in-memory store); the batch count is a small amplification surface, bounded at 50 and rate-limited; the 5-minute grace means a connection whose token sync fails survives slightly longer than the sync interval suggests (deliberate, and shorter than any session TTL).

**Verification.** `tickets.batch-and-limits.integration` (a second use of one ticket is rejected; a 20-document reconnect succeeds within the limits; the 301st ticket in a minute is 429; a 429 from the ticket endpoint does not close a healthy connection); `security.ws-origin.integration` (missing, foreign, and `app://iridium` origins); `collab.token-sync.integration` (15-minute re-validation with jitter, grace expiry closes).

**References.** Digest §6.2 (OWASP WebSocket security, CSWSH), §2.2 (`onTokenSync`, `requestToken`), §11.13; spec §4, §8; plan-risk-first ADR-10; judges 1, 2; gap fix (batch issuance and limit sizing). Implemented in `04-auth-and-access-control.md`, `05-collaboration-and-durability.md`, `09-api-reference.md`.

### A25 — Awareness and presence: validate identity on every message, server-authoritative participants

**Status.** Accepted (2026-09-11). **ADR file.** `docs/adr/0025-awareness-presence.md`.

**Context.** Spec §5 requires the UI to show connected participants and their cursors; spec §8 forbids treating "CRDT client identifiers or self-reported cursor names as proof of authorship". Yjs awareness is client-authored state broadcast to every peer, so without a server check any client can publish `{user: {id: <someone else>, name: 'CEO'}}` and appear to be that person in every other participant's UI. Digest §1.2 and §11.22 also record the cost and multiplexing questions: awareness updates are small (lib0 varint plus a JSON payload) but frequent, and `sessionAwareness` interacts with provider multiplexing (Topic 5 wanted `sessionAwareness: true` with one provider per tab; Topic 2 wanted one provider per note per window via a registry to avoid duplicate-name errors).

**Decision.** `beforeHandleAwareness` decodes **every** awareness update (lib0 varint plus JSON — cheap) and closes the connection if any state's `user.id !== context.userId`. Awareness carries only `{user: {id}, cursor, mode}`. Names and colours are **never** read from awareness: the UI maps `id → {name, colorHue}` from the server-authoritative stateless message `{t: 'participants', users: [{id, name, colorHue, role}]}`, which is sent to all connections of a document on join and leave. Per-connection awareness is capped at 10 messages/s, with excess **dropped rather than closing the connection** (awareness bursts are normal during fast cursor movement). Load tests budget awareness churn at 4 Hz per virtual user. Authorship for audit events and revisions comes from `connection.context` only. Viewers keep awareness enabled — a null awareness breaks the provider's ping/pong accounting (digest §1.4).

**Alternatives considered.**

| Alternative | Why rejected |
|---|---|
| Sampling or validating only the first awareness message | The impersonation vector stays open for every later message; the per-message decode is cheap enough that there is no reason to gamble. |
| Trusting self-reported names and colours | Directly contradicts spec §8; also makes presence names diverge from the directory after a rename. |
| Dropping awareness for viewers | Breaks the provider ping (digest §1.4) and hides legitimate readers from the participant list. |
| Closing the connection on an awareness rate overrun | Punishes normal fast cursor movement; dropping is the correct back-pressure for a lossy, last-write-wins channel. |
| `sessionAwareness: true` with one provider per tab (Topic 5) | Duplicate document names per window and duplicated traffic; A41's `NoteSessionRegistry` shares one provider per note per window with `sessionAwareness: false`. |

**Consequences.** Positive: impersonation is structurally impossible, not merely discouraged; presence names stay consistent with the directory because they come from it; CPU per connection is bounded by the 10 msg/s cap. Negative: one decode per awareness message on the server hot path (measured in the load tests); the participants list needs a stateless broadcast on every join and leave, which is one extra message per membership change of the document's connection set.

**Verification.** `collab.awareness-identity.integration` (a forged `user.id` closes the connection `awareness-spoof`, with the frame built by hand from lib0 encoding, and names and colours are never read from awareness); `collab.limits.integration` (the 11th message in a second is dropped, the connection survives); `collab.participants.integration` (join and leave produce correct `participants` messages; renaming a user changes presence labels without a reconnect); k6 awareness churn at 4 Hz within the CPU budget.

**References.** Digest §1.2, §1.4, §2.2, §11.22; spec §5, §8; plan-agent-first graft (per-message validation); gap fix (awareness cost). Implemented in `05-collaboration-and-durability.md` and `07-client-applications.md`.

### A26 — Session model: one `sessions` table, two delivery channels, no reusable credential in the renderer

**Status.** Accepted (2026-09-11). **ADR file.** `docs/adr/0026-session-model.md`.

**Context.** Two clients need sessions with very different constraints. The web SPA is served from `PUBLIC_ORIGIN` and can use a cookie; the Electron renderer runs on `app://iridium`, a different origin from the server, where cookies are cross-site. Digest §6.2 gives the requirements: ≥64 bits of CSPRNG entropy, `Secure`, `HttpOnly`, `SameSite`, the `__Host-` prefix, server-enforced idle and absolute timeouts, session-ID regeneration at login and privilege change, logout invalidating server-side with `Cache-Control: no-store`, and never storing tokens in `localStorage`/`sessionStorage`. It also records that better-auth 1.7.4 stores its session token in **plaintext** with no hashing option, which disqualifies it as the session store for an enterprise audit. Digest §11.15 records the desktop disagreement: plan-product-dx (Topic 4) wanted rotating refresh tokens plus 10–15-minute access tokens held by the Electron main process; plan-risk-first (Topic 6) wanted a single desktop session token. Both agreed the renderer holds nothing. Digest §6.2 also documents `safeStorage` behaviour, including that Linux can report a `basic_text` backend that is not real encryption.

**Decision.** One `sessions` table, one secret shape, two delivery channels.

- Secret: 32 CSPRNG bytes; `sessions.secret_hash = SHA-256(secret)`; lookup by the embedded `token_id` (A31 format, kind `ses`) then `timingSafeEqual`.
- **Web**: `__Host-iridium_session=<irid_ses_…>; Secure; HttpOnly; SameSite=Lax; Path=/`, idle 24 h sliding, absolute 14 d.
- **Desktop**: `POST /auth/sessions {client: 'desktop', deviceName}` returns the credential in the response body; it is held **only by the Electron main process**, encrypted with `safeStorage.encryptStringAsync` into `userData/iridium/secrets.bin` keyed by server origin. When `isEncryptionAvailable()` is false, or the Linux backend is `basic_text`, the session is memory-only and the UI shows a visible warning; the admin policy `desktop_update_policy.requireSecureStorage` (published by `GET /desktop/update-policy` as `requireSecureStorage`; it lives in the desktop group, never in `session_policy`) can refuse login outright. Idle 30 d, absolute 90 d.
- The renderer performs REST through the IPC `ApiTransport` → main-process `net.fetch` with the `Authorization` header; tickets are requested over IPC; attachments load through `iridium-attachment://<vault>/<id>` handled in main (A44, A53).
- When `Authorization` is present, cookies are ignored (one principal per request, no ambiguity).
- A new `sessions` row is created on every login (session-ID regeneration by construction). A password change revokes all other sessions. Logout deletes the row, clears the cookie, and responds with `Cache-Control: no-store` and `Clear-Site-Data`.
- **Step-up ("sudo")**: `last_authenticated_at` within 10 minutes is required for token create/rotate/revoke, password and email change, every `/admin/*` mutation, vault archive, and version restore; otherwise `403 step_up_required`, resolved by `POST /auth/reauthenticate`.
- All TTLs are administrator-configurable in the `session_policy` row of `server_settings` — `{webIdleHours, webAbsoluteDays, desktopIdleDays, desktopAbsoluteDays, stepUpMinutes}`, the grouped shape `03-data-model.md` §13.1 fixes — with the environment values (`SESSION_WEB_IDLE_HOURS`, `SESSION_WEB_ABSOLUTE_DAYS`, `SESSION_DESKTOP_IDLE_DAYS`, `SESSION_DESKTOP_ABSOLUTE_DAYS`, `STEP_UP_WINDOW_MIN`) acting as security floors: an administrator may tighten a lifetime but never loosen it past the environment value.

**Alternatives considered.**

| Alternative | Why rejected |
|---|---|
| Refresh token + 15-minute access tokens in the renderer, with CORS for `app://iridium` (plan-product-dx) | Puts a reusable bearer in the renderer — the one place hostile note content executes — and requires a credentialed CORS path. Two token kinds, two expiry rules, two revocation paths, for no gain over main-process custody. |
| better-auth 1.7.4 as the session framework | Stores the session token in plaintext with no hashing option (digest §6.2); also brings an opinionated schema into a database the plan controls exactly. |
| JWT sessions (stateless) | Cannot satisfy A23 (revocation within 1 s) without a denylist, which is a session table with extra steps. |
| Cookies for the desktop too | `app://iridium` → server is cross-site; `SameSite=None` would be required, re-opening CSWSH (digest §6.2). |
| Session secret hashed with argon2 | Session lookup happens on every request; a 256-bit random secret needs no slow KDF (same reasoning as A31). |

**Consequences.** Positive: one session table, one revocation path (A23), one audit actor shape; the renderer never holds a credential, so an XSS in the preview cannot steal one; step-up protects exactly the operations that create or destroy long-lived access. Negative: every desktop REST call crosses IPC to main, so the `ApiTransport` and its zod-validated channels become load-bearing (A53, and the `ipc.origin.guard` guard test); `safeStorage` unavailability on some Linux configurations degrades to memory-only sessions, which the UI must explain; the step-up rule adds a re-authentication dialog to several admin flows (deliberate).

**Verification.** `auth.sessions-web.integration` (idle and absolute expiry enforced server-side; rotation at login; password change revokes others; the `__Host-` prefix, `Secure`, `HttpOnly`, `SameSite=Lax` and `Path=/` attributes); `auth.sessions-desktop.integration` (bearer custody, and the cookie ignored when `Authorization` is present); `auth.step-up.integration` (each listed operation returns `403 step_up_required` outside the 10-minute window); `desktop.attachments-no-token-in-renderer.e2e` (main-process custody; `basic_text` fallback warning); `desktop.preload-surface.guard` (the renderer surface exposes no credential); `logging-redaction.integration` (no session secret reaches a log).

**References.** Digest §6.2 (OWASP session management, `safeStorage`, better-auth plaintext), §4.2, §11.13, §11.15; spec §4, §8; plan-risk-first ADR-09; judges 1, 2, 3. Implemented in `04-auth-and-access-control.md` and `07-client-applications.md`.

### A27 — CSRF for cookie sessions: custom header plus Fetch Metadata plus `SameSite=Lax`

**Status.** Accepted (2026-09-11). **ADR file.** `docs/adr/0027-csrf.md`.

**Context.** Only the web client uses cookies (A26), and it is an API-driven SPA with no HTML `<form>` posts. Digest §6.2 records the OWASP position: stateful apps should normally use synchronizer tokens, but for API-driven sites that cannot use forms the custom-request-header pattern is a recognised defence because a custom header forces a CORS preflight; Fetch Metadata resource isolation rejects unsafe methods when `Sec-Fetch-Site` is cross-site, with a mandatory fallback to `Origin` (then `Referer`) for legacy user agents; and `SameSite` is defence-in-depth only, because `Lax` still sends cookies on top-level safe-method navigations.

**Decision.** Every state-changing route whose principal came from a cookie requires `X-Iridium-Client: web` and `Sec-Fetch-Site ∈ {same-origin, none}`; when `Sec-Fetch-Site` is absent, the `Origin` host — and failing that the `Referer` host — must equal `PUBLIC_ORIGIN`. A failure is `403 csrf_rejected`. The rule applies to multipart uploads as well as JSON. Bearer-authenticated requests skip the check entirely (they carry no ambient credential). A boot-time assertion fails the process unless every route declares `config.auth` (A30) and every mutating route is either CSRF-guarded or marked `bearerOnly`. The SPA is served from `PUBLIC_ORIGIN`, so no CORS configuration exists for cookie-bearing requests.

**Alternatives considered.**

| Alternative | Why rejected |
|---|---|
| `@fastify/csrf-protection` synchronizer tokens | Requires a per-session secret, a token endpoint, token rotation, and client plumbing on every mutation, to defend an API that already cannot be targeted by a form post. The custom-header plus Fetch Metadata pattern is the OWASP-recognised design for this shape. |
| `SameSite=Strict` alone | Still sends cookies on top-level safe-method navigations and breaks normal link-following into the app; OWASP calls `SameSite` defence-in-depth only. |
| Double-submit cookie | A readable cookie pairs badly with `HttpOnly`-only session storage and is weaker against subdomain attackers. |
| Relying on CORS | CORS does not protect simple requests; and with no CORS configuration at all (same-origin SPA) there is nothing to misconfigure. |

**Consequences.** Positive: no CSRF token lifecycle; the check is two header comparisons; the boot-time assertion makes "a new route forgot CSRF" impossible to merge. Negative: a client that strips custom headers (some corporate proxies) breaks — documented in `11-operations-and-deployment.md` with the exact header to allow; `Sec-Fetch-*` absence paths must be tested explicitly because they are the legacy fallback.

**Verification.** `security.csrf.integration` (missing header, cross-site `Sec-Fetch-Site`, foreign `Origin`, missing `Sec-Fetch-Site` with a good and a bad `Referer`, and multipart); `authz.route-policy.boot.guard` (every mutating cookie route is guarded); `toMatchOpenApi(operationId, 403)` (the `403 csrf_rejected` `ProblemDetails` shape).

**References.** Digest §6.2 (OWASP CSRF, Fetch Metadata); spec §4, §8; all four plans agree. Implemented in `04-auth-and-access-control.md` and `09-api-reference.md`.

### A28 — Initial credential delivery and password reset: one-time set-password links

**Status.** Accepted (2026-09-11). **ADR file.** `docs/adr/0028-credential-delivery.md`.

**Context.** Spec §4 says accounts are administrator-managed with no public registration, and spec §10 defers enterprise SSO; e-mail delivery is not a spec §10 item at all but a non-goal the plan fixes for itself (`01-vision-scope-and-principles.md` §4.4). That leaves an unanswered question every plan skipped: how does a new user obtain their first password, and how is a forgotten password reset, without an email service and without an administrator ever knowing a user's password? Administrator-typed temporary passwords mean a plaintext secret passes through a second human and usually through a chat message.

**Decision.** One-time set-password links, delivered out of band by the administrator in the MVP.

- `POST /admin/users` creates the user **without credentials** (no `user_credentials` row) and returns a single-use link token `irid_spl_…` (kind `spl`, A31 format), valid 24 h, stored SHA-256-hashed in `password_setup_tokens`.
- The administrator copies `<PUBLIC_ORIGIN>/set-password#<token>` and delivers it out of band (the fragment keeps the token out of the server's access log and out of `Referer` headers).
- `POST /auth/set-password {token, password}` sets the credential, consumes the link, and audits `user.password.set`.
- `POST /admin/users/:id/reset-password` issues a new link and revokes all of that user's sessions; PATs are deliberately untouched (an administrator-forced password reset is not evidence that the user's integration tokens are compromised, and silently killing an agent's access would be a surprising side effect; `iridium tokens revoke-all --user` is the explicit tool when that is intended).
- The desktop login screen accepts the same link.
- SMTP delivery is a post-MVP seam: the `smtp` group is reserved in `server_settings` and is deliberately absent from the strict `ServerSettings` object until it ships (`09-api-reference.md` §2.15.3).

**Alternatives considered.**

| Alternative | Why rejected |
|---|---|
| Administrator-typed temporary passwords | A plaintext password transits an administrator and a chat system; also needs a `must_change` flag and a second code path in login. |
| `must_change_password` flag on a real credential | Same plaintext exposure, plus an extra state in the login state machine. |
| Requiring SMTP in the MVP | `01-vision-scope-and-principles.md` §4.4 places e-mail delivery outside the MVP as one of the plan's own non-goals, and it adds an infrastructure dependency (and a deliverability support burden) to the first release; the seam is reserved. |
| Token in the query string rather than the fragment | Query strings land in proxy access logs and `Referer` headers. |
| Longer-lived or reusable setup links | A reusable account-takeover link; 24 h single use with an explicit reissue path is the correct trade. |

**Consequences.** Positive: no plaintext password is ever known to anyone but its owner; account creation and password reset share one mechanism and one audit event; adding SMTP later changes only the delivery step. Negative: administrators must hand over links manually in the MVP (documented in the operations runbook); a link that leaks before use is an account takeover until it expires, which is why it is single use, 24 h, fragment-delivered, and audited on consumption.

**Verification.** `setpw-link.integration` (link is single use; expiry enforced; consuming it audits `user.password.set`; a setup token cannot authenticate any other route); `admin.reset-password.integration` (a new link is issued, sessions are revoked, PATs survive); `toMatchOpenApi(operationId, status)` on both routes' responses.

**References.** Digest §6.2 (OWASP authentication and secrets guidance); spec §4, §10; gap fix (no source plan covered it). Implemented in `04-auth-and-access-control.md`, `09-api-reference.md`, `11-operations-and-deployment.md`.

### A29 — Password hashing and login hardening: argon2id via prebuilt napi, versioned pepper, NIST policy, DB-backed throttling

**Status.** Accepted (2026-09-11); **amended 2026-09-13** by spike S13 (`docs/spikes/S13-argon2-calibration.md`, pass): the parameters below are unchanged and stay the `EnvSchema` defaults, which apply to every developer machine and CI runner. The measured production pair is separate — `ARGON2_MEMORY_KIB=131072`, `ARGON2_TIME_COST=6`, p50 213.51 ms on the 4 vCPU reference container against the schema defaults' 47.80 ms — and it is set at the deployment layer, in `infra/compose.prod.yaml` and `docs/ops/configuration.md`, never as a schema default. **ADR file.** `docs/adr/0029-password-hashing.md`.

**Context.** Digest §6.2 verifies the OWASP Argon2id floor (m=19456 KiB, t=2, p=1), that peppers are shared across hashes and must be stored separately from them, and that the PHC string format is what makes parameter upgrades possible later. It also verifies that `@node-rs/argon2` 2.2.1 (Rust/napi-rs, published 2026-09-10) produces PHC-format Argon2 digests, whereas the reference `argon2` 0.45.1 binds to libargon2 through node-gyp. The NIST SP 800-63B-4 and OWASP authentication requirements are also verified: 15 characters minimum without MFA, allow ≥64 characters and any Unicode, no composition or rotation rules, block breached passwords, generic error messages with equalised timing, and per-account throttling. Digest §6.2 records the `rate-limiter-flexible` 11.2.0 login pattern (two limiters, `RateLimiterMySQL` with an in-memory insurance limiter).

**Decision.** `@node-rs/argon2` 2.2.1 with argon2id, `memoryCost 65536` KiB, `timeCost 3`, `parallelism 1`, `hashLength 32`, and `secret = pepper[pepper_version]`, producing a PHC string in `user_credentials.password_hash`. A `needsRehash` result or a pepper-version drift triggers a transparent re-hash on the next successful login. `iridium doctor --argon2` calibrates the host to a 150–300 ms verify (`ARGON2_MEMORY_KIB`, `ARGON2_TIME_COST`). Policy: minimum 15 characters (8 once MFA exists), maximum 128, any Unicode, no composition or rotation rules, checked offline against a bundled top-100k breached-password list. One login path with a dummy verify for unknown users and a generic `invalid_credentials` response. Throttling uses `rate-limiter-flexible` 11.2.0 `RateLimiterMySQL` against a `login_throttle` table: limiter A keyed `email|ip` (5 consecutive failures → 15-minute block, doubling to a 24-hour ceiling), limiter B per IP per day (100), with `RateLimiterMemory` as the insurance limiter if MySQL is unavailable. `UV_THREADPOOL_SIZE=8` is set explicitly because hashing occupies libuv threads.

**Alternatives considered.**

| Alternative | Why rejected |
|---|---|
| `argon2` 0.45.1 (node-argon2) | node-gyp means a C toolchain in the Docker build, on Windows developer machines, and in CI; `@node-rs/argon2` ships prebuilt napi binaries and emits identical PHC output, so the hash format is not a lock-in. |
| bcrypt 6.0.0 | 72-byte input truncation and OWASP's "legacy only" classification. |
| PBKDF2-HMAC-SHA256 | 600 000 iterations for a weaker memory-hardness profile. |
| No pepper | A database-only compromise then yields directly crackable hashes; the pepper lives in the secrets bundle (A47) and is versioned so it can be rotated with `iridium keys rotate pepper`. |
| Composition rules and 90-day rotation | Explicitly rejected by NIST SP 800-63B-4 and OWASP; they reduce entropy in practice. |
| In-memory-only throttling | Lost on restart, which is a trivial bypass; MySQL-backed with a memory insurance limiter survives both restarts and a database blip. |
| An online breach API (e.g. range queries) | An outbound dependency on the login path and a privacy question for an on-premises product; a bundled list is offline and deterministic. |

**Consequences.** Positive: no native toolchain anywhere in the build; parameters and pepper version are both upgradable without a migration because they live in the PHC string; the login path has one shape for existing and unknown users. Negative: the pepper becomes a restore-critical secret (A47 verifies key versions and the restore fails if they mismatch — which is the intended behaviour, because a wrong pepper silently invalidates every password); 150–300 ms per verify is a deliberate CPU cost that `UV_THREADPOOL_SIZE` and the login rate limits bound; the breached-password list adds a few megabytes to the image.

**Verification.** `auth.hasher.unit` (argon2id parameters, versioned pepper, `needsRehash` on parameter or pepper-version drift, transparent re-hash on the next successful login) and `auth.phc.unit` (PHC round trip; an unparseable or unknown-variant hash is a typed failure, never a silent accept); `auth.policy.unit` (15–128 characters, any Unicode, no composition or rotation rules) and `auth.policy.blocklist-hash.unit` (the bundled list is consulted offline by hash prefix and the candidate is never logged); `auth.login-timing.unit` (equalised timing for unknown user versus wrong password, within tolerance); `auth.throttle.integration` (limiter A blocks after 5 failures and doubles; limiter B caps per IP per day; the insurance limiter engages when MySQL is down); `auth.pepper-rotation.integration` (after `iridium keys rotate pepper` old-pepper users still log in and are re-hashed, and a version downgrade refuses to boot); `iridium doctor --argon2` in the M8 operations checklist; `logging-redaction.integration` (no password or hash in logs).

**References.** Digest §6.2 (OWASP password storage and authentication, NIST SP 800-63B-4, `@node-rs/argon2` 2.2.1, `rate-limiter-flexible` 11.2.0), §11.14; spec §8; plan-risk-first ADR-08; judges 1, 2. Implemented in `04-auth-and-access-control.md` and `11-operations-and-deployment.md`.

### A30 — Permission matrix and `authorize()`: one static matrix, one function, 404 for non-members

**Status.** Accepted (2026-09-11). **ADR file.** `docs/adr/0030-permission-matrix.md`.

**Context.** Spec §4 fixes the roles (viewer, editor, vault manager, server administrator), states that permissions apply to the whole vault and are inherited by every child object and by history, search, attachments, and exports, and requires server-side enforcement for REST, collaboration connections and incoming edits, attachments, search, history, and exports — with the explicit rule that "knowledge of a note ID must not grant access". Spec §9's "Vault isolation" row tests it with guessed IDs. Digest §6.2 records the OWASP authorization guidance: deny by default, centralized middleware, never trust client-side checks, never rely on unguessable IDs, fail closed with generic errors. Three credential kinds (session, PAT, CLI) and three surfaces (REST, WebSocket, MCP) must share one decision function or they will diverge.

**Decision.** One static matrix and one function.

- Roles are ordered `viewer < editor < manager`. `users.is_server_admin` is treated as manager on every vault plus the `server:*` permissions — **for user principals only** (A31/F4: admin-implied access never flows into a token).
- Permissions. Read: `vault:read`, `note:read`, `search:read`, `history:read`, `attachment:read`, `export:read`. Editor adds `note:write`, `node:create`, `node:rename`, `node:move`, `node:trash`, `node:restore`, `attachment:write`, `revision:name`. Manager adds `vault:manage_members`, `vault:settings`, `vault:archive`, `history:restore`, `node:purge`, `import:commit`. Server admin adds `server:users`, `server:vaults:create`, `server:settings`, `server:audit:all`, `server:tokens:all`, `server:sessions:all`, `server:jobs`, `server:releases`.
- `authorize(principal, permission, {vaultId?}) → 'allow' | {deny: 'not_found' | 'forbidden' | 'step_up_required'}` is the only decision point.
- Token principals get `scopes ∩ permissionsOf(live explicit role)`, restricted to `vaultId ∈ allowlist`, and gated by the MCP kill switches.
- An archived vault allows reads only. Vaults in `importing` or `deleting` status are invisible.
- Every route declares `config.auth = {permission, vaultFrom: 'params.vaultId' | 'node:params.nodeId' | 'note:params.noteId' | 'attachment:params.attachmentId'}` or `{public: true}` / `{serverAdmin: true}` / `{self: true}`. The vault is resolved before the handler runs, and every query carries `WHERE vault_id = ?`.
- Non-members receive **404** for every vault-scoped resource; members lacking a permission receive **403** (F13).

**Alternatives considered.**

| Alternative | Why rejected |
|---|---|
| Per-handler permission checks | Guarantees drift between REST, MCP, and collaboration; nothing can assert completeness. The boot-time route-policy assertion only works because the policy is declarative. |
| An ABAC or policy-engine dependency (OPA, Cedar, CASL) | The MVP has no per-note ACLs (spec §4) and no customer-defined roles; a static matrix is fully testable and has no policy-language failure mode. The `authorize()` signature is the seam if that changes. |
| 403 for non-members | Confirms a vault or note exists to someone who guessed its ID, failing the "Vault isolation" acceptance row. |
| Role ranks compared numerically at the call site | Invites `>=` bugs; permissions are named and looked up in the matrix. |
| Letting server-admin status flow into token principals | An administrator's agent would read the entire server from one leaked token (F4). |

**Consequences.** Positive: one function to test exhaustively, and one property test asserting `rightsOf(token) ⊆ rightsOf(owner)`; a new route cannot ship without a policy, because the process refuses to boot; the 404 rule is uniform, so there is no resource where the error shape leaks existence. Negative: the 404-for-non-members rule makes some support conversations harder ("the link is broken" versus "you do not have access") — the UI compensates with an explicit "you may not have access to this vault" empty state; the matrix must be edited, and its test updated, for every new capability (deliberate friction).

**Verification.** `authz.matrix.unit` (every role × permission cell, including archived-vault read-only and `importing`/`deleting` invisibility); `authz.route-policy.boot.guard` (every route declares `config.auth`); `authz.vault-isolation.integration` (guessed IDs across REST, WebSocket, MCP, attachments, search, history, export all return 404); `authz.rest-viewer.integration` and `collab.viewer-enforcement.integration` (the "Viewer enforcement" acceptance row); `token.effective-permissions.prop` (token rights are a subset of the owner's live rights); 100 % per-file coverage on `authz/**` (A51).

**References.** Digest §6.2 (OWASP authorization); spec §4, §9; plan-risk-first ADR-11; F13, F4. Implemented in `04-auth-and-access-control.md`, `06-mcp-and-agent-access.md`, `09-api-reference.md`.

### A31 — PAT / integration token model: id-embedded format, SHA-256 at rest, permission-string scopes, mandatory expiry, rotation, per-call access log

**Status.** Accepted (2026-09-11). **ADR file.** `docs/adr/0031-integration-tokens.md`.

**Context.** The brief makes user-granted agent tokens a primary feature: created in the UI, scoped (at minimum vault-scoped and read-only for the MVP), revocable with immediate effect, hashed at rest, and pasted into an agent's MCP configuration. Digest §6.2 verifies the industry patterns: GitHub's format (3-letter prefix, `_` separator so double-click selects the whole token, 30 Base62 random characters, 6 Base62 CRC32 characters enabling offline secret scanning, prefix alone dropping scanner false positives to ~0.5 %), fine-grained PAT lifetime policy (1–366 days, default 366), and rate-limit headers; GitLab's mandatory expiry, `last_used_at` updated at most every 10 minutes, rotation that inactivates the old token immediately while retaining both for audit, and immediate revocation; and Notion's move to a distinct prefix specifically for scanner compatibility. Digest §11.14 records four incompatible formats and three incompatible scope vocabularies across the source plans. Digest §3.2 adds a hard constraint from the MCP SDK: `requireBearerAuth` returns `401 invalid_token` for any `AuthInfo` whose `expiresAt` is unset. A judge review found a gap no plan had closed: a server administrator creating a token would, under a naive "tokens inherit the user's rights" reading, mint a credential that reads every vault on the server.

**Decision.** One credential format for every kind, a fast hash with an id lookup, permission-string scopes, and a hard least-privilege rule for administrators.

- **Format** (all kinds): `irid_<kind>_<id16 base62>_<secret43 base62><crc6 base62>`, `kind ∈ {pat, ses, tkt, spl, oat, ort, oac}` with `scim` the one remaining reserved kind. `oat` (OAuth access token), `ort` (OAuth refresh token) and `oac` (OAuth authorization code) became live kinds with AG1 when G1 was answered yes on 2026-09-12; the format, the hashing and the CRC are identical for all seven, which is the whole point of one credential format. The secret is 32 CSPRNG bytes; the CRC32 covers everything before it. Published scanner regex: `irid_(pat|ses|tkt|spl|oat|ort|oac)_[0-9A-Za-z]{16}_[0-9A-Za-z]{49}`.
- **At rest**: `access_tokens.secret_hash = SHA-256(secret)` (no pepper), looked up by the unique `token_id`, then compared with `timingSafeEqual`.
- **Scopes** are permission strings from A30. The MVP grants one bundle, "Read" = the six read permissions. Write scopes are schema-valid but are never granted and never listed in the UI.
- **Vault scope** is either an explicit `access_token_vaults` allowlist (a subset of the owner's memberships at creation, re-checked at every use) or `all_vaults = 1`, meaning "every vault I am an explicit member of at call time".
- **Server-admin-owned tokens**: token principals never inherit admin-implied access (`isServerAdmin: false`, explicit memberships only); `all_vaults` is disallowed for administrators; creation shows a warning and audits `token.created {admin_owned: true}`.
- **Expiry is mandatory** (`pat_policy.defaultLifetimeDays` 90, ceiling `pat_policy.maxLifetimeDays` 366, `pat_policy.allowNoExpiry` false — the grouped members of the `pat_policy` row of `server_settings`, to which the skeleton's flat spellings `pat_max_lifetime_days` and `pat_allow_no_expiry` map through the table in `03-data-model.md` §13.1) — which also satisfies the SDK's `expiresAt` requirement.
- **Rotation**: `POST /me/tokens/:id/rotate {overlapHours?}` issues a new secret and revokes the old token immediately, unless `overlapHours ≤ pat_policy.rotationOverlapMaxHours` (maximum 24, default 0; the skeleton spells it `pat_rotation_overlap_max_hours`) sets `rotation_overlap_until`.
- **Revocation** sets `revoked_at`; rows are never deleted. `last_used_*` is written asynchronously at most every 10 minutes.
- **Limits**: a per-token bucket of 120/min burst plus the token's own `access_tokens.rate_limit_per_hour`, where a `null` row value means `pat_policy.defaultRateLimitPerHour` (3 000) and the row value is administrative, set only by `PATCH /admin/tokens/:tokenId`; `search_notes` costs 3 points; `x-ratelimit-*` and `retry-after` headers.
- **Logging**: every token-authenticated read writes an `access_log` row; a rejected presentation audits `token.denied`.
- **Verifier**: implements `OAuthTokenVerifier.verifyAccessToken` returning `AuthInfo {token, clientId, scopes, expiresAt (always set), resource, extras: {principal}}`. Since AG1 there are **two verifier instances over the one verification path** (`apps/server/src/auth/tokens/verify.ts`, D04-26), differing only in the `resource` they are constructed with: the `/mcp` instance carries `new URL(PUBLIC_ORIGIN + '/mcp')` and accepts `pat` alone, the `/mcp/connect` instance carries `new URL(PUBLIC_ORIGIN + '/mcp/connect')` and accepts `oat` alone. `clientId` is `` `pat:${id16}` `` for an integration token and `` `oauth:${oauth_clients.client_id}` `` for an OAuth access token.
- The same PAT authenticates the read-only REST routes; a mutation attempt returns `403 token_scope_insufficient`.

**Alternatives considered.**

| Alternative | Why rejected |
|---|---|
| Hash-only lookup, `irid_<type>_<43><6>` with no embedded id (plan-risk-first, plan-enterprise) | Gives no stable display prefix for the UI and no id for `access_log`/rate-limit keys without a second lookup; an indexed `token_id` is O(1) and the secret is still only ever compared in constant time. |
| HMAC-SHA256 with a server pepper (plan-agent-first) | A pepper protects low-entropy secrets; these are 256-bit CSPRNG values where a single SHA-256 is not brute-forceable. It would add a rotation obligation and a restore-critical key for no gain. |
| argon2 for token hashes | Adds 150–300 ms to every agent call; unjustifiable for a 256-bit random secret. |
| `all_vaults` available to everyone including administrators | For an administrator that is "read the whole server", which is exactly the blast radius F4 exists to prevent. |
| Optional expiry for service tokens (digest §3.6 open question) | The MCP SDK rejects an `AuthInfo` without `expiresAt`, and a never-expiring agent credential is the most common enterprise audit finding. The 366-day ceiling plus rotation with overlap covers the legitimate need. |
| Scopes as a bespoke vocabulary (`notes:read`, `vault:<id>:read`) | Three vocabularies existed across the plans (digest §11.14); reusing A30's permission strings means `authorize()` needs no translation layer. |
| Deleting revoked token rows | Destroys the audit trail; `revoked_at` preserves it. |

**Consequences.** Positive: a token can never exceed or outlive its owner, and that is a property test rather than a review note; the format is offline-verifiable by secret scanners and double-click-selectable; one credential format covers sessions, tickets, and setup links, so there is one parser, one CRC check, and one redaction pattern; per-call `access_log` rows make the admin agent-activity view possible (F14). Negative: mandatory expiry creates a renewal obligation for agent owners (mitigated by rotation with overlap and by expiry warnings in the UI); `all_vaults` re-resolves memberships on every call, which is the second indexed read A23 already requires; administrators who want a broad-read agent must be granted explicit memberships, which is visible and auditable (intended).

**Verification.** `tokens.format.unit` (CRC validation, kind parsing, scanner regex matches and rejects near-misses); `tokens.verifier.integration` (expired, revoked, unknown, wrong-vault, `rotation_overlap_until` honoured then refused); `token.effective-permissions.prop` (rights ⊆ owner's live explicit rights, for random membership and scope sets); `tokens.admin-owned.integration` (an administrator's token sees only explicit memberships and cannot set `all_vaults`); `mcp.rate-limit.mcp` (burst, hourly ceiling, `search_notes` cost 3, header shapes); `access-log.integration` (one row per token read, with returned note ids); `mcp.revocation.mcp` (next call fails); 100 % per-file coverage on `contracts/tokens` (A51).

**References.** Digest §6.2 (GitHub/GitLab/Notion token patterns, OWASP secrets), §3.2 (`requireBearerAuth` `expiresAt`, `AuthInfo`), §3.6, §11.14; spec §4, §7; brief requirement 5; plan-risk-first ADR-14; judges 1, 2, 3; gap fix (admin-owned tokens); F4, F14. Implemented in `04-auth-and-access-control.md`, `06-mcp-and-agent-access.md`, `09-api-reference.md`.

---

## Area 5 — MCP and agent access

### A32 — MCP transport and session mode: SDK v2, per-request factory, stateless dual-era, JSON response mode, `reply.hijack()`

**Status.** Accepted (2026-09-11); **amended 2026-09-13** by spike S14 (`docs/spikes/S14-mcp-dual-era-handler.md`, pass): the `reply.hijack()` handoff is confirmed for both eras and the sub-application fallback is not taken, but three statements in this entry were wrong and are corrected below — the host-guard entry is `publicOrigin.hostname` rather than `PUBLIC_HOST`, the route drives the handler's web-standard face rather than `toNodeHandler` (under `toNodeHandler` the SDK answers a thrown factory with its own `-32603` body and `onMcpHostError` is unreachable), and the conformance baseline is not empty. Two measured consequences the M3 code must carry: `responseMode: 'json'` shapes the modern path only, a 2025-era response being `200 text/event-stream`; and after the hijack, headers set with `reply.header()` are never emitted, while helmet's are, because helmet writes to `reply.raw`. **ADR file.** `docs/adr/0032-mcp-transport.md`.

**Context.** The brief makes MCP a primary feature, not an add-on. Digest §3.2 verified the landscape precisely: `@modelcontextprotocol/sdk` 1.30.0 declares `LATEST_PROTOCOL_VERSION = '2025-11-25'` and **cannot serve** the current 2026-07-28 revision, with maintenance ending around January 2027; the v2 SDK (2.0.0, published 2026-07-27) is GA as split packages (`/server`, `/client`, `/core`, `/node`, `/express`, `/fastify`, `/hono`, `/conformance`); `createMcpHandler(factory, {legacy, responseMode, bus})` runs the factory **once per HTTP request** and its default `legacy: 'stateless'` serves 2025-era clients and modern 2026-07-28 clients from the same factory with no sessions; the 2026-07-28 revision **removed** protocol-level sessions and `Mcp-Session-Id`, so an older-era GET or DELETE should answer 405; servers MUST validate `Origin` and return 403 on mismatch (DNS rebinding); requests carry `MCP-Protocol-Version`, `Mcp-Method`, and `Mcp-Name` headers; `toNodeHandler` forwards `req.auth` as `ctx.http.authInfo`; and `createMcpFastifyApp`/`createMcpExpressApp` build their own app, so mounting into an existing app means wiring Host and Origin checks yourself. Digest §3.4 adds two operational traps: Claude Code's 5-minute idle timeout and 60-second first-byte timer, and the fact that any non-`OAuthError` exception in the verifier becomes a 500.

**Decision.** Pins: `@modelcontextprotocol/server` 2.0.0, `@modelcontextprotocol/node` 2.0.0, `@modelcontextprotocol/fastify` 2.0.0 (with `hostHeaderValidation([publicOrigin.hostname])` — the hook compares `new URL('http://' + host).hostname` against its list, so a port-bearing entry refuses the server's own host); development and test only: `/client` 2.0.0, `/conformance` 0.1.16, `@modelcontextprotocol/inspector` 2.6.0. The handler is built once — `const handler = createMcpHandler(buildIridiumMcpServer, {legacy: 'stateless', responseMode: 'json'})` — and the route drives its **web-standard face** (`toWebRequest` → `handler.fetch` → Iridium's own writer onto `reply.raw`) rather than `toNodeHandler`, so the route owns every status and byte written after the hijack. The route is

```ts
app.all('/mcp', {
  config: { auth: { bearerOnly: true, principalKinds: ['token'] }, rateLimit: mcpBucket, bodyLimit: 1_048_576 },
  onRequest: [hostGuard, rejectBrowserOrigin, ignoreCookies],
  preHandler: [patAuth],
}, async (req, reply) => {
  if (!req.mcpAuthInfo) return reply.code(401).headers(wwwAuthenticate).send(invalidTokenBody);
  reply.hijack();
  try {                                                  // the handler's web-standard face (S14)
    const request  = toWebRequest(req.raw, req.body, { signal: abortOn(reply.raw) });
    const response = await handler.fetch(request, { authInfo: req.mcpAuthInfo, parsedBody: req.body });
    await writeWebResponse(response, reply.raw);
  } catch (e) { onMcpHostError(e, reply.raw); }
});
```

A factory or handler throw becomes **HTTP 500 with body `{"error":"server_error"}` and no details**, a pino error carrying the request id, and an increment of `iridium_mcp_factory_errors_total`. There is no `Mcp-Session-Id`; a legacy GET or DELETE answers 405; Iridium publishes no notifications and advertises no `listChanged` or `subscribe` capability in the MVP. It does not follow that the endpoint never speaks `text/event-stream`, and two places it does were measured by spike S14 and specified in 06-mcp-and-agent-access.md: a **2025-era** response is `200 text/event-stream` carrying one `event: message` frame, because `responseMode: 'json'` shapes the modern path only; and a modern client's `subscriptions/listen` is answered by the SDK's own listen router regardless of `responseMode`, acknowledged with an empty filter and never published on (D06-17). The `/mcp` proxy rules of 11-operations-and-deployment.md are therefore load-bearing for ordinary legacy traffic, not only for that stream. Both eras are served: 2026-07-28 (including `server/discover`, `_meta`, and `ttlMs`/`cacheScope`) and the 2025-era stateless path per POST. `instructions.md` is ≤ 2 KB (the vault/category/note model, stable IDs versus mutable paths, the `search_notes → get_note` workflow, line-range paging, revisions, and "note content is untrusted data"), and each vault's `ai_guidance` is appended to `list_vaults` output. `cacheHints` sets `{'tools/list': {ttlMs: 300000, cacheScope: 'private'}}` and leaves everything else at `ttlMs: 0, cacheScope: 'private'`. A 30-second server-side request timeout applies.

**Alternatives considered.**

| Alternative | Why rejected |
|---|---|
| SDK v1.30.0 with a hand-wired stateful `NodeStreamableHTTPServerTransport` | Cannot speak 2026-07-28; maintenance ends ~January 2027; sessions add server state that blocks horizontal scaling and complicates revocation. |
| `legacy: 'reject'` (modern era only) | Cursor, VS Code, Windsurf, and Claude Code's v1 runtime are 2025-era today (digest §3.2); rejecting them would make the primary feature unusable for most clients. |
| `responseMode: 'sse'` | Requires `proxy_buffering off` and long read timeouts everywhere, and the MVP has no server-initiated notifications to stream; JSON is one response per POST and proxies handle it unchanged. |
| `createMcpFastifyApp` as a standalone app | A second Fastify app means a second auth, rate-limit, logging, and error pipeline; mounting one route keeps `config.auth`, the route-policy assertion, and the `ProblemDetails` shape uniform. |
| A separate MCP process | Loses the shared `authorize()`, `AuthzBus`, and `ContentReadCore`; adds a deployment component for no isolation benefit on a single-node MVP. |
| Writing the raw response without `reply.hijack()` | Fastify would also try to serialise and send a reply, corrupting the stream; `hijack()` is the documented handoff. |
| Returning error details on a factory throw | Leaks internals to an unauthenticated-ish surface; the request id in the log is the correlation handle. |

**Consequences.** Positive: both protocol eras work from one code path; no per-client server state, so revocation (A23) and later horizontal scaling are unaffected; the official in-process test path (`handler.fetch`) and the conformance suite are available (A51); `cacheScope: 'private'` everywhere prevents a gateway or client from serving one token's ACL-dependent results to another. Negative: `reply.hijack()` means Fastify's `onSend` and serialisation hooks do not run for `/mcp`, so logging and metrics for that route are emitted explicitly; 2025-era clients get no `list_changed` or `resources/updated` notifications and will keep their last fetched tool list (documented for operators); the 30-second timeout plus Claude Code's 60-second first-byte timer put a hard latency budget on every tool (the k6 `get_note p95 < 300 ms` SLO exists to protect it).

**Verification.** `mcp.dual-era.contract` (in-process `handler.fetch` with `@modelcontextprotocol/client` 2.0.0, default legacy `initialize` and pinned `2026-07-28`); `mcp.conformance.mcp` (`@modelcontextprotocol/conformance` 0.1.16 with a committed `--expected-failures` baseline: the tool drives the legacy leg only and its active suite is written against a reference server's fixtures, so the baseline is those scenarios plus the one Origin check Iridium refuses by policy, and the assertion is zero *unexplained* failures); the same `mcp.dual-era.contract` file asserts a legacy-era GET or DELETE answers 405; `mcp.host-guard.contract` (foreign Host → 403, browser `Origin` → 403); `mcp.factory-error.mcp` (an injected factory throw yields 500 with no details and increments the metric); Inspector 2.6.0 `--cli` smoke; the nightly real-client matrix (Claude Code ≥ 2.1.232 v2 runtime, VS Code, Cursor, bridge) and the proxied-stack header-passthrough test (A48).

**References.** Digest §3.1–§3.5, §11.5, §11.6, §11.16; brief requirement 5; plan-risk-first ADR-13; plan-agent-first §3; judges 1, 2, 3; gap fix (factory-error handling). Implemented in `06-mcp-and-agent-access.md` and `09-api-reference.md` (§D.3).

### A33 — MCP authentication: PAT bearer only, no Protected Resource Metadata in the MVP

**Status.** Superseded by AG1 (2026-09-12). **ADR file.** `docs/adr/0033-mcp-auth.md`.

> **Superseded on 2026-09-12 by AG1 (G1 answered yes).** The Context below remains accurate and is why the MVP's `/mcp` endpoint still advertises no discovery. What changed is that Iridium now also runs an OAuth 2.1 authorization server on a second mount, so both audiences are served at once.

**Context.** This is the sharpest cross-topic tension in the digest (§11.5). The 2026-07-28 specification says authorization is OPTIONAL but that HTTP implementations SHOULD conform to the OAuth 2.1 resource-server model, in which a server MUST publish RFC 9728 Protected Resource Metadata. Against that, digest §3.2 verifies Claude Code issue #59467: when an HTTP MCP server is configured with a static `Authorization: Bearer` header **and** the server advertises OAuth (a 401 carrying `resource_metadata`, or a PRM document naming an authorization server), Claude Code ignores the configured header and exposes only synthetic `authenticate`/`complete_authentication` tools. Digest §3.4 states the consequence plainly: "Do not publish RFC 9728 protected-resource metadata or a `resource_metadata` parameter on the 401 until an OAuth authorization server exists; Claude Code, VS Code and claude.ai will follow it into a failing discovery chain." Topic 6 proposed a middle path (publish PRM without `authorization_servers`); Topic 10 wanted full discovery as the next milestone. The judges took Topic 3's position: for a static-header client, any advertised discovery is an undefined state, and SEP-985-style probing means even a partial document gets followed.

**Decision (as accepted 2026-09-11; the clauses about the MCP surface *as a whole* are superseded, the clauses about `/mcp` stand).** `Authorization: Bearer irid_pat_…` is the only accepted credential on `/mcp`. Cookies are ignored; any browser `Origin` is 403. Missing, invalid, expired, or revoked tokens return `401` with `WWW-Authenticate: Bearer realm="iridium", error="invalid_token"` and a body hint — "create an integration token under Settings › Integrations" — carrying **no** `resource_metadata` parameter, and there is **no** `/.well-known/oauth-protected-resource` document. Scope failures *inside* a tool return `isError: true` rather than HTTP 403, because a 403 triggers client step-up flows that cannot complete without an authorization server. Kill switches: the `mcp_enabled` row of `server_settings`, whose shape is the object `{enabled: boolean}` and never a bare boolean, and the per-vault `vaults.mcp_enabled` column. The OAuth milestone (post-MVP, behind `MCP_OAUTH_ENABLED`) adds `kind='oauth'` rows dispatched by token prefix inside `verifyAccessToken`, a PRM document with `authorization_servers`, the `resource_metadata` parameter, CIMD, and `insufficient_scope` step-up — all additive, with no URL changes.

**What supersedes it (AG1, 2026-09-12).** The MCP surface is mounted twice on one handler, one `buildIridiumMcpServer` factory and one `ContentReadCore`: `/mcp` accepts `irid_pat_…` **only** and advertises no discovery of any kind, and `/mcp/connect` accepts `irid_oat_…` **only** and carries the full RFC 9728 posture — a PRM document at `/.well-known/oauth-protected-resource/mcp/connect`, a `401` whose `WWW-Authenticate` adds `resource_metadata` and `scope`, and `403 insufficient_scope` for a transport-level scope failure. Every clause of the Decision above that names `/mcp` is still literally true of `/mcp`: the challenge header, the `error` value, the cookie and `Origin` refusals, the `isError` treatment of per-argument scope failures and both kill switches are byte-identical to what this ADR specified, which is what makes the split safe for the clients this ADR was written to protect. Four well-known paths — `/.well-known/oauth-protected-resource/mcp`, `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server` and `/.well-known/openid-configuration` — are registered routes that return a genuine `404`, because a `200` at either root path would be found by every client whatever endpoint it was configured with and would defeat the split; the two root AS-metadata paths can only stay `404` because the issuer carries a path component, `<PUBLIC_ORIGIN>/oauth`, and never the bare origin. Access tokens are opaque `irid_oat_…` rows in `access_tokens` with `kind='oauth'`, never JWTs, so revocation stays the next-call property A23 guarantees and there is no signing key, no `jwks_uri` and no key material in the backup set. `MCP_OAUTH_ENABLED` survives as an unmount switch for `/mcp/connect` — a site that wants no OAuth surface at all — and never as a choice between the two audiences. The design is AG1; the protocol surface, the authorization server, the consent screen and the data model are in `06-mcp-and-agent-access.md` (D06-26 … D06-36) and `04-auth-and-access-control.md` (D04-30 … D04-32).

**Alternatives considered.**

| Alternative | Why rejected |
|---|---|
| PRM without `authorization_servers`, 401 without `resource_metadata` (plan-agent-first, plan-product-dx; digest Topic 6) | A discoverable document still invites probing clients into a chain that cannot complete; the spec's own field is OPTIONAL, so omitting the document entirely is conformant and unambiguous. **Verdict corrected 2026-09-12:** it also fails outright, because the 2026-07-28 specification makes `authorization_servers` mandatory with at least one entry (F-2) and the client fallback finds and follows the document regardless of which endpoint the client was configured with (F-3). It was the right answer only while no authorization server existed. |
| Full OAuth 2.1 authorization server in the MVP (digest Topic 10) | ~~No authorization server exists; every target client accepts a static header today; the specification permits custom authentication. It is the first post-MVP epic (G1).~~ **Adopted: G1 answered yes on 2026-09-12; the objections were about the absence of an authorization server, which no longer holds.** Iridium ships one in M3 (AG1), and the coexistence problem the objections pointed at is solved by the two-mount split rather than by declining to build it. |
| HTTP 403 `insufficient_scope` for in-tool scope failures | Sends clients into a step-up flow with no authorization server to step up to; `isError` text is actionable and terminal. |
| Accepting the session cookie on `/mcp` | Creates a CSRF surface on a JSON-RPC endpoint (digest §3.4 explicitly warns against it). |
| Accepting a token in a query string or `X-Api-Key` | Query strings land in access logs; a single `Authorization` header keeps every client's static-header path working, including the Messages API `authorization_token` and claude.ai's approved header name. |
| No kill switch | Operators need a way to stop all agent access without revoking every token (for an incident or a policy change). |

**Consequences.** Positive: Claude Code, Cursor, VS Code, Windsurf, and the Messages API connector all work with a pasted token and nothing else; no discovery chain can half-complete; the OAuth path was designed additively, which is why adopting it changed no URL, no existing token and no line of `authorize()`.

Negative (rewritten 2026-09-12): claude.ai and Claude Desktop custom connectors are now supported natively — that clause of this ADR no longer describes the product, and the `iridium-mcp` bridge is no longer the required path for them (A36). What remains negative is that a site publishes **two** URLs instead of one, so a user who pastes the wrong one into the wrong client gets a `401` rather than a working connection — mitigated by error text on both endpoints that names the other URL, by generating the correct URL in every snippet, and by `iridium doctor --oauth`, which prints both and asserts the four 404s; that a valid PAT presented at `/mcp/connect` is refused on purpose, because "the credential a route accepts is exactly the one its discovery posture advertises" is what the boot assertion can check; and that a cloud connector still needs a publicly reachable HTTPS origin, which is a fact about Anthropic's connectors reaching out from their own servers rather than anything Iridium can change — an intranet-only or air-gapped site still uses the bridge. A user who types the token without the `Bearer ` prefix produces `Authorization: <token>`, which the server must reject with a clear message (tested).

**Verification.** `mcp.auth.mcp` (missing, malformed, prefix-less, expired, revoked, and wrong-vault tokens; exact `WWW-Authenticate` value; absence of `resource_metadata` on the `/mcp` family); `oauth.discovery-split.contract` (the four 404s, the PRM `200` at `/.well-known/oauth-protected-resource/mcp/connect`, the three byte-identical AS-metadata documents, and the exact parameter set of each mount's `401`), which replaces the retired no-discovery contract test; `oauth.audience.contract` (an OAuth token at `/mcp` and a PAT at `/mcp/connect` each `401` with one shared status, header and `error` value, naming the other endpoint only in the body); `mcp.scopes.mcp`; `mcp.fail-closed.mcp` (server-level and vault-level); the nightly `mcp-clients` matrix, whose coexistence row runs the static-header audience against `/mcp` and the OAuth audience against `/mcp/connect` **on one server at the same time** and asserts that a static-header Claude Code session lists the six tools, never exposes `authenticate` or `complete_authentication`, and issues no request to any `/.well-known/` path — the direct regression test for #59467.

**References.** Digest §3.2 (Claude Code #59467, claude.ai connector auth), §3.4, §6.2 (RFC 9728 fields), §11.5; spec §7; brief requirement 5; plan-risk-first ADR-15; judges 1, 2, 3; G1, answered yes on 2026-09-12. The four facts verified on 2026-09-12 that turned this evidence into the opposite conclusion are: **F-3**, a client that finds no `resource_metadata` on the challenge **MUST** fall back to constructing the well-known URIs itself, first `/.well-known/oauth-protected-resource/<path>` and then the root form (MCP specification 2026-07-28, `basic/authorization/authorization-server-discovery`, "Protected Resource Metadata Discovery Requirements"); **F-10**, Claude Code issue #59467 — with a static `Authorization` header configured *and* the server advertising OAuth, the OAuth flow starts **before** the POST that would have carried the header, and there is no logic to skip it (github.com/anthropics/claude-code/issues/59467); **F-11**, the same class is broader than one issue (claude-code #33817, #38972; Cursor probes discovery before sending configured headers; VS Code discarded static headers before 1.124.0 — zuplo.com/learn/mcp/errors/configured-headers-ignored-when-oauth-discovery-present); and **F-12**, the recommended server-side resolution stated verbatim, *"Pick one credential per route and make the server advertise only that one"* and *"Separate routes rather than attempting conditional discovery on a single endpoint"*, because the specification contains no precedence rules — *"Fix this on the server, not in the client."* Discovery is a property of a **URL**, not of a request, which is why no header sniff or `User-Agent` heuristic could have served both audiences from one endpoint. Implemented in `06-mcp-and-agent-access.md` and `04-auth-and-access-control.md`.

### A34 — MCP tools and resources: six read-only tools over `ContentReadCore`, a note template, and a per-vault index resource

**Status.** Accepted (2026-09-11). **ADR file.** `docs/adr/0034-mcp-tools-resources.md`.

**Context.** Digest §3.2 verifies the constraints that shape a tool surface: client tool caps are shared across all configured servers (Cursor ~40 active tools, Windsurf 100, VS Code 128 per request); Claude Code truncates tool descriptions and server instructions at 2 KB, warns at 10 000 output tokens, and persists results above 25 000 tokens to a file; tool names SHOULD be 1–128 characters from `[A-Za-z0-9_.-]` and `tools/list` SHOULD be deterministically ordered; declaring an `outputSchema` makes the SDK throw `InvalidParams` if a handler omits `structuredContent`, and the specification SHOULD also return the serialized JSON as a text block; `McpServer`'s high-level `resources/list` **ignores `request.params.cursor`** and merges every template's full `list()` result, so enumerating notes as resources would blow up large vaults and `@`-mention autocomplete menus; a resource-not-found MUST be `-32602` with `data.uri`, never an empty `contents` array; and `Mcp-Name` mirrors `params.uri`, so non-ASCII resource URIs arrive base64-sentinel encoded — which is why note URIs must use IDs, not titles. Anthropic's own tool-writing guidance (digest §3.2) argues for fewer, consolidated tools. Digest §11.16 records the disagreement on tool names and on whether templates register a `list` callback.

**Decision.** Six read-only tools, snake_case, registered in a deterministic order, each with `title`, `outputSchema`, `structuredContent`, a description ≤ 2 KB, names and parameters within `[A-Za-z0-9_.-]`, and `annotations {readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false}`:

| Tool | Purpose |
|---|---|
| `list_vaults` | Vaults this token may read, with each vault's `ai_guidance` appended. |
| `list_notes` | Enumerate nodes by `path_prefix`, `kinds`, `recursive`, `include_trashed`, with cursor paging. |
| `get_note` | Markdown by `note_id` or `{vault_id, path}`, with `revision`, `lines`, or `heading` selection. |
| `search_notes` | Full-text search within accessible vaults, returning snippets with line numbers. |
| `list_note_revisions` | Revision history for a note. |
| `list_attachments` | Attachment **metadata only**. |

`get_note` returns the Markdown as the text block and **metadata-only** `structuredContent` — a documented deviation from the specification's SHOULD (F7), because duplicating the body doubles token cost. Not-found and forbidden return the **same** `isError` text: "No note with that id or path is available to this token." Resources: `ResourceTemplate('iridium://vault/{vault_id}/note/{note_id}', {list: undefined, complete: {vault_id, note_id (title prefix, ≤ 20 results)}})` with mimeType `text/markdown`, where `?rev=<seq>` pins a revision; plus a static `iridium://vault/{vault_id}` Markdown index (top-level categories and the 50 most recently updated notes, capped at 2 000 entries, with the footer "use list_notes"). A resource not found is `-32602` with `data.uri`. List and search results include `resource_link` blocks. There is **no `fresh` flag on MCP**. `access_log.note_ids JSON` records every note id returned by every call. Tools live in `apps/server/src/mcp/tools/*`, are implemented over `ContentReadCore` (A37), and are unit-tested over an in-memory repository.

**Alternatives considered.**

| Alternative | Why rejected |
|---|---|
| A `get_vault_tree` tool (plan-risk-first, plan-enterprise) | Fully covered by `list_notes(path_prefix, kinds, recursive)`; a seventh tool spends a scarce client tool slot on a narrower view of the same data. |
| A resources-first surface (notes as enumerable resources) | `McpServer`'s `resources/list` ignores cursors and merges every template `list()`, so a 20 000-note vault produces one unbounded response and an unusable autocomplete menu; the Messages API connector supports only tools. |
| Registering the note template **with** a `list` callback (digest Topics 5, 10) | Same unbounded enumeration; `list: undefined` plus completions gives `@`-mention ergonomics without it. |
| Duplicating the note body in `structuredContent` (the spec SHOULD) | Doubles token cost on the single most-called tool; F7 documents the deviation. |
| Distinct error text for forbidden versus missing | Confirms existence to a token that guessed an id, failing the "Vault isolation" acceptance row (A30, F13). |
| An MCP `fresh: true` knob (compaction on demand) | A CPU amplifier reachable by an automated caller; humans get `flush` (A19) and REST gets a rate-limited `?fresh=true` (A38), while MCP instructions state that `get_note` may return a newer `revision` than `search_notes` showed. |
| Attachment bytes over MCP | Binary blobs blow the token budget and the MVP is read-only metadata; deferred with the write-scope work. |

**Consequences.** Positive: six tools fit comfortably inside every client's cap and leave room for other servers; the surface is token-economical; identical not-found and forbidden responses close the ID-probing vector; `resource_link` blocks let agents pivot from a search hit into a resource read without a second tool call. Negative: no note enumeration through `resources/list`, so `@`-mention discovery relies on completions plus the per-vault index resource (documented in `instructions.md`); agents must learn the `search_notes → get_note` workflow, which is why it is stated explicitly in the instructions; annotations are advisory, so `readOnlyHint` does not guarantee auto-approval in any client (digest §3.4) and the plan promises no frictionless approval UX.

**Verification.** `mcp.tools-schema.contract` (deterministic `tools/list` order, name and parameter character set, description size, `outputSchema` conformance on every tool, and the live `tools/list` equal to `packages/contracts/mcp/tools.schema.json`, A3); `mcp.tools.unit` (all six tools over an in-memory `ContentReadCore`: every authorization branch, the Markdown text block, metadata-only `structuredContent`, and `lines`/`heading`/`revision` selection); `mcp.error-texts.unit` (not-found and forbidden share one byte-identical text); `mcp.resources.mcp` (template completions, `?rev=` pinning, `-32602` with `data.uri`, index resource caps); `access-log.integration` (note ids recorded).

**References.** Digest §3.2 (client caps, tool spec, `resources/list` pagination, Anthropic tool guidance, Obsidian/Notion MCP conventions), §3.4, §3.5, §11.16; spec §7; plan-risk-first ADR-13; judges; F7, F13, F14. Implemented in `06-mcp-and-agent-access.md` and `09-api-reference.md` (§D.3).

### A35 — MCP pagination cursors: opaque HMAC-signed cursors bound to token and filter hash

**Status.** Accepted (2026-09-11). **ADR file.** `docs/adr/0035-mcp-cursors.md`.

**Context.** A32 makes the endpoint stateless, so pagination cannot live in server memory. A cursor that is merely an offset or an unsigned JSON blob can be replayed against a different token, a different filter set, or a different vault — which, in a product whose entire value is per-vault ACLs, is an authorization bypass waiting to be discovered. The spec's "Vault isolation" row and A30's 404 rule both apply to paging. Tree mutations during a long enumeration are a second problem: a keyset over derived paths is correct only while the tree is unchanged, and A12 deliberately derives paths rather than storing them.

**Decision.** `apps/server/src/mcp/cursor.ts` emits `base64url(JSON {v: 1, k: 'notes'|'search'|'revisions'|'attachments', a: <after key>, f: sha256(filters), t: tokenId, tv?: treeVersion, exp}) + HMAC-SHA256` using `MCP_CURSOR_KEY`, a dedicated secret included in the backup bundle (A47) and rotatable with `iridium keys rotate cursor`. Expiry is 1 hour. Keysets: `(path, id)` for notes, `(score DESC, note_id)` for search (the query is re-executed and the page filtered server-side), `(revision DESC)` for revisions, `(name, id)` for attachments. A foreign, expired, or mismatched cursor returns `isError` with "cursor invalid or expired — restart from the first page". **Pagination stability:** page 1 of `list_notes` embeds `tree_version`; later pages continue best-effort and set `stale: true` when `tree_version` has changed, with the documented remedy being to restart for a consistent listing. `limit` is capped at 500 for lists and 100 for search. REST uses the same cursor module.

**Alternatives considered.**

| Alternative | Why rejected |
|---|---|
| Offset pagination (`LIMIT ?, ?`) | Skips and duplicates rows under concurrent edits, and degrades on deep pages; a keyset is both correct and indexable. |
| Unsigned cursors | Replayable across tokens, filters, and vaults; signing makes cross-token replay a verification failure rather than a leak. |
| Server-side cursor state (a table or a memory map) | Contradicts A32's statelessness; adds a cleanup job and a shared-state dependency for no benefit. |
| Cursors without a filter hash | A cursor from `path_prefix: '/public'` replayed against `path_prefix: '/hr'` would page through the second tree from the first's position. |
| Snapshot isolation across pages (a consistent tree version enforced server-side) | Would require pinning a tree snapshot per cursor; the honest `stale: true` flag plus a documented restart is simpler and does not hold resources. |
| No expiry | A leaked cursor is a long-lived capability; one hour bounds it, and the token itself is still checked on every request. |

**Consequences.** Positive: cursor replay across tokens, queries, or vaults is impossible; one cursor module serves MCP and REST, so both behave identically; no server state to scale or clean up. Negative: search paging re-executes the query per page and filters server-side, which costs CPU on deep paging (bounded by the 100-item search cap and the per-token rate limit); `MCP_CURSOR_KEY` becomes restore-critical (a rotated or missing key invalidates outstanding cursors — acceptable, and verified by the restore checks in A47); `stale: true` is a contract agents must handle, and `instructions.md` says so.

**Verification.** `mcp.cursor.unit` (signature verification, expiry, filter-hash mismatch, wrong `k`); `mcp.cursor.mcp` (a cursor from token A used with token B is rejected; keyset correctness with concurrent inserts; `stale: true` after a tree mutation; limit caps); `ops.key-rotation.drill` (`iridium keys rotate cursor` invalidates outstanding cursors cleanly with the documented `isError` text).

**References.** Digest §3.2 (`tools/list` and `resources/list` cursor semantics), §3.4, §3.5 (opaque signed cursors bound to token id), §11.16; spec §4, §9; plan-agent-first graft. Implemented in `06-mcp-and-agent-access.md` and `09-api-reference.md`.

### A36 — stdio bridge: a first-party transparent proxy, `iridium-mcp`

**Status.** Accepted (2026-09-11); **confirmed by the owner's answer to G7 on 2026-09-12** — the bridge is not published to the public npm registry — and narrowed in scope by AG1 (2026-09-12), which removes Claude Desktop from the set of clients that require it. The Decision stands unchanged. **ADR file.** `docs/adr/0036-stdio-bridge.md`.

**Context.** Claude Desktop's local configuration is stdio-only, and claude.ai custom connectors require OAuth outside a limited header beta (digest §3.2), so a stdio-to-HTTP bridge was the only path for those surfaces until G1 was answered yes. The bridge is kept and its rationale narrows: it serves stdio-only clients, air-gapped and intranet-only deployments that cloud connectors cannot reach at all — a claude.ai connector is initiated from Anthropic's servers and needs a publicly reachable HTTPS origin — and scripted use. It is no longer the required path for Claude Desktop, which since AG1 can add `https://<origin>/mcp/connect` as a custom connector and sign in. The obvious third-party option is `mcp-remote`, which digest §3.2 flags hard: it changed hands (geelen/Cloudflare → punkpeye/Glama), shipped 100+ versions including 13 on 2026-09-11 alone, and handles user tokens on disk under `~/.mcp-auth`. Two source plans proposed instead to share a tool package between the MCP server and a bridge built on a `RestReadApi`, which would mean two implementations of the same six tools and a second read backend to keep in parity.

**Decision.** A first-party transparent proxy in `packages/mcp-bridge` (Node 24 ESM, built by tsdown into a single file with a shebang, bin name `iridium-mcp`). It uses `serveStdio` from `@modelcontextprotocol/server` and forwards `tools/list`, `tools/call`, `resources/list`, `resources/templates/list`, `resources/read`, and `completion/complete` to the remote `/mcp` through `@modelcontextprotocol/client`'s `StreamableHTTPClientTransport` with `requestInit.headers.Authorization`. Lists are fetched at start and refreshed every 5 minutes. Token sources, in order: `--token-file <path>`, then `IRIDIUM_MCP_TOKEN` — **never** a command-line argument. Flags: `--server <origin>`, `--vault <id>`, `--allow-insecure-http` (development only). It sends `User-Agent: iridium-mcp/<version>`, which lands in `access_log.client_name`/`client_version`, and exits non-zero with a clear message on 401 or 403. It is bundled into the desktop application at `resources/bin/` and downloadable from `/desktop/tools/`. `mcp-remote@0.13.5` is documented only as a pinned alternative. npm publication is G7.

**Alternatives considered.**

| Alternative | Why rejected |
|---|---|
| A shared tool package over a `RestReadApi` (plan-enterprise, plan-product-dx, judge 1) | Two implementations of the six tools, two authorization call sites, two audit surfaces, and era negotiation duplicated locally. A transparent proxy has exactly one implementation and one `access_log`. |
| `mcp-remote` as the recommended bridge | A third-party dependency that handles user tokens on disk, with a 2026 ownership change and an extremely high release cadence (digest §3.2); it remains documented as a pinned alternative for operators who prefer it. |
| Tokens as a command-line argument | Process lists and shell history expose them; `--token-file` and the environment variable are the two supported paths. |
| No bridge (wait for OAuth) | ~~Claude Desktop is a primary target client for a markdown product; the bridge is small and reuses the SDK on both sides.~~ **Premise retired 2026-09-12:** OAuth arrived with AG1, so "wait for OAuth" is no longer a deferral. The bridge is re-justified on its surviving grounds, which OAuth does not reach: a stdio-only client has no HTTP transport to point at either mount; an intranet-only or air-gapped deployment cannot be reached by a cloud connector at all, whatever it advertises; and a scripted or CI use of the tools wants a process it can pipe, not a browser consent round trip. It remains small and reuses the SDK on both sides, which is why keeping it costs little. |
| Bridging over REST instead of `/mcp` | Would bypass MCP-specific behaviour (eras, `_meta`, cache hints, `resource_link` blocks) and require the bridge to re-implement them. |

**Consequences.** Positive: one tool implementation and one audit surface; era negotiation is delegated to the SDK at both ends; `access_log` distinguishes bridge traffic from direct traffic by `client_name`; the bridge ships with the desktop application, so an administrator does not have to approve an npm dependency. Negative: Iridium now ships and maintains a CLI binary, including its pinned SDK versions and its own release step (A52); the 5-minute list refresh means a tool-surface change can take up to 5 minutes to appear in a long-running bridge session (documented); `--allow-insecure-http` exists for development and must be clearly marked (it is refused when the origin is not loopback).

**Verification.** `bridge.parity.contract` (through `StdioClientTransport`: the proxy's `tools/list`, `tools/call`, `resources/*`, and `completion/complete` responses are byte-equal to a direct `/mcp` call for the same token); `bridge.token-sources.unit` (`--token-file` precedence, environment fallback, argument rejected); the same `bridge.parity.contract` file asserts that a 401 or 403 exits non-zero with an actionable message; the nightly real-client matrix includes a bridge lane; `access-log.integration` asserts the bridge's `client_name`.

**References.** Digest §3.2 (Claude Desktop stdio-only, claude.ai connector auth, `mcp-remote` ownership and cadence), §3.4, §3.5; brief requirement 5; judges 2, 3; **G7, answered "no" on 2026-09-12** — the bridge ships bundled with the desktop application and downloadable from `/desktop/tools/`, and is not published to the public registry, which is exactly the Decision above, so nothing in it changes; **G1, answered yes on 2026-09-12** (AG1), which is why the Context no longer calls the bridge the only path for Claude Desktop. Implemented in `06-mcp-and-agent-access.md` and `11-operations-and-deployment.md`.

### A37 — One read model for humans and agents: `ContentReadCore` over committed projections

**Status.** Accepted (2026-09-11). **ADR file.** `docs/adr/0037-content-read-core.md`.

**Context.** Spec §7 requires that "search and export use the same access rules as the application", and spec §4 requires enforcement on REST, collaboration, attachments, search, history, and exports. The failure mode to avoid is three read paths — one for the UI, one for REST, one for MCP — that slowly diverge in what text they return, what authorization they apply, and what revision they claim. Spec §6 also settles where text comes from: the persisted Yjs state is authoritative and Markdown is "the readable text within that state", with cached text recording its source revision and never overwriting newer state.

**Decision.** One module, `apps/server/src/content/read/*`, exporting `listVaults(p)`, `listNodes(p, vaultId, {pathPrefix, kinds, recursive, includeTrashed, cursor, limit})`, `resolveNote(p, {noteId} | {vaultId, path})`, `readNoteMarkdown(p, noteId, {revision?, lines?, heading?})`, `listRevisions`, `search(p, …)`, and `listAttachments(p, vaultId, noteId?)`. `authorize()` (A30) runs **inside every method**, not in the callers. The REST read routes, the MCP tools (A34), and the UI reads all consume it; none of them ever touches the live `Y.Doc`. Every read carries `revision` (the projected seq) and `content_hash`. REST sets `ETag: "<revision>:<hash>"` and honours `If-None-Match` with a 304. `GET /notes/:id/markdown` returns `text/markdown`.

**Alternatives considered.**

| Alternative | Why rejected |
|---|---|
| A separate query path per surface | Guarantees divergence in text, authorization, and revision semantics; the spec's "same access rules" requirement would become a review promise instead of a type. |
| Reading the live `Y.Doc` for "freshness" | Returns uncommitted state, so an agent could read text the server has not durably persisted — contradicting the Saved definition (F2) and spec §6's "must not overwrite newer state" discipline. It also forces every reader to load documents into memory (A50's budget). |
| Rendering Markdown from the Yjs state on demand per read | Duplicates the compaction work on the request path; `note_projections.markdown` already exists and records its revision. |
| Authorization in the route layer only | MCP tools and UI reads would each need their own correct copy; putting it inside the methods makes omission impossible. |

**Consequences.** Positive: byte-identical text under identical authorization across REST, MCP, and export, which is a property test rather than an aspiration; `ETag`/`If-None-Match` gives agents and browsers cheap revalidation; one place to optimise (and one place to cache) for all read traffic. Negative: reads are as fresh as the projection, which is bounded but not instantaneous — A38 defines exactly how fresh and how that is signalled; `ContentReadCore` becomes a wide interface that every read surface depends on, so changes to it are contract changes (A3 regenerates the OpenAPI and MCP schemas).

**Verification.** `content.read-parity.integration` (REST, MCP, and export return byte-identical Markdown and the same `revision`/`content_hash` for the same note and token); `authz.read-core.unit` (every method denies for non-members with `not_found` and for members lacking the permission with `forbidden`); `content.etag.integration` (`If-None-Match` → 304; `ETag` changes exactly when the revision or hash changes); `content.lines-and-heading.unit` (selection semantics and line numbering against the Markdown source).

**References.** Digest §3.5 (MCP reads the committed projection; same ACL filter for UI and agent search), §7.5; spec §4, §6, §7, §9; plan-agent-first graft; judges 2, 3. Implemented in `06-mcp-and-agent-access.md`, `08-markdown-pipeline-import-export.md`, `09-api-reference.md`.

### A38 — Projection freshness and the search contract: bounded lag, human `flush`, rate-limited `?fresh=true`, explicit staleness

**Status.** Accepted (2026-09-11). **ADR file.** `docs/adr/0038-projection-freshness.md`.

**Context.** A37 reads committed projections, which trail the live document by the compaction debounce (A16: 2 000 ms debounce, 10 000 ms maximum). Three gaps existed across all four plans. First, **FULLTEXT visibility**: a search index built from projections can miss text that is already in the live document, and no plan said what the user or agent is told. Second, **title staleness after rename**: if a display title derived from the first H1 is stored, renaming a note leaves stale copies in the search index and in listings. Third, **snippets**: searching a plain-text projection finds matches whose positions do not correspond to Markdown source lines, so a `{line, text}` snippet built from the indexed text would point at the wrong place in the editor. Digest §11.27 also records four competing search-projection shapes that had to collapse into one (resolved in A39).

**Decision.** Projections lag the live document by at most `maxDebounce`. Three freshness tools, each with an explicit cost:

- `GET /notes/:id/markdown?fresh=true` (requires `history:read`, limited to 6/min per principal per note, and a no-op when `projected_seq == head_seq`) runs the compaction job for a loaded document.
- `{t: 'flush'}` on the collaboration socket (A19) is the human path (Ctrl/Cmd+S), answered with `{t: 'projected', seq}` and the pill "Saved · up to date for agents".
- MCP has no freshness knob (A34); `instructions.md` states that `get_note` may return a newer `revision` than `search_notes` showed.

Staleness is signalled, never hidden: every search result carries `revision`, and the UI shows an "index updating" hint for open notes where `projected_seq < head_seq`.

Derived titles are **not stored**. `note_projections.heading_title` holds only the first H1 (NULL when the note has none). The display title is `COALESCE(heading_title, nodes.name)`, computed at read time. A structural rename updates `note_search.title` for that note inside the same transaction when `heading_title IS NULL`.

Snippets: FULLTEXT matches on `note_search.body_text` (plain text), but `{line, text}` snippets are located by a case-insensitive scan of `note_projections.markdown` source lines for the query terms (the first N matching lines), so the line numbers an agent or the UI receives refer to the **Markdown source** and can be used directly with `get_note({lines})` or to place a caret.

**Alternatives considered.**

| Alternative | Why rejected |
|---|---|
| Unbounded or unauthenticated `?fresh=true` | Compaction is CPU- and write-amplifying; an automated caller could force it per request. The permission plus the 6/min cap plus the no-op fast path bound it. |
| Storing a derived display title (first H1) in `nodes` or `note_search` | Two sources of truth for the same string; renames and edits then need a fan-out, and any missed path shows a stale title (the exact gap this ADR closes). `COALESCE` at read time cannot go stale. |
| Building snippets from the plain-text projection | Line numbers would not map to the Markdown source, so "jump to match" and `get_note({lines})` would land in the wrong place. |
| Synchronous projection on every update | Makes every keystroke pay for a parse and destroys the durable-ack latency budget (A19). |
| Hiding staleness (always claiming fresh results) | Agents cannot reason about it, and the "index updating" case is real and bounded; stating it is strictly better than a silent lie. |
| Letting MCP force compaction | A CPU amplifier on an automated surface; the `revision` field plus the instructions text give agents what they actually need. |

**Consequences.** Positive: a bounded, stated freshness contract that both humans and agents can rely on; no derived data can go stale because none is stored; snippet line numbers are directly actionable. Negative: a search immediately after a burst of typing can miss the newest words until the next compaction (mitigated by `flush`, by the "index updating" hint, and by the 10 s `maxDebounce` ceiling); the snippet scan reads `note_projections.markdown` for matched notes, which costs I/O proportional to the page size (bounded by the search limit of 100).

**Verification.** `search.staleness-hint.integration` (results carry `revision`; an open note with `projected_seq < head_seq` is flagged); `content.fresh-flag.integration` (permission, 6/min limit, no-op fast path, and that it does compact a loaded document); `collab.flush.integration` (`flush` → `projected` with the expected seq); `projection.title-after-rename.integration` (rename updates `note_search.title` when `heading_title IS NULL`; display title follows `COALESCE`); `search.snippets.unit` (line numbers address Markdown source lines; verified by feeding them back into `readNoteMarkdown({lines})`); k6 SLO `projection_lag_ms p95 < 12 s`.

**References.** Digest §7.5 (debounced projections in a worker pool; `pipeline_version`), §3.5 (MCP reads committed projections with `revision`), §11.27; spec §6, §7; plan-product-dx graft (`flush`); gap fixes (FULLTEXT visibility, title staleness, snippets). Implemented in `08-markdown-pipeline-import-export.md`, `05-collaboration-and-durability.md`, `09-api-reference.md`.

---

## Area 6 — Content pipeline, search, attachments, and portability

### A39 — Search: InnoDB FULLTEXT over a narrow projection, behind a `SearchIndex` interface

**Status.** Accepted (2026-09-11); **confirmed by the owner's answer to G5 on 2026-09-12** — no CJK ngram support at MVP. The Decision stands unchanged, and the clause that reads "CJK ngram support is G5 (default parser and `innodb_ft_min_token_size=2` until answered)" is now a settled position rather than a default in force: the default InnoDB full-text parser with a two-character minimum token is what 1.0 ships, with no ngram parser and no second index. **ADR file.** `docs/adr/0039-search.md`.

**Context.** Spec §3 requires title and content search within the current vault; spec §4 requires that search results obey vault permissions and that "knowledge of a note ID must not grant access"; spec §8 says infrastructure can initially be one application deployment, MySQL, and attachment storage. An external engine (Meilisearch, Typesense) would add a deployment component, a second backup artifact, and — most importantly — would move the ACL filter out of SQL into application-side post-filtering, which is precisely where isolation bugs live. Digest §11.27 records four competing projection shapes; digest §5.2 confirms that InnoDB FULLTEXT needs `innodb_ft_min_token_size` set at server level (A9 bakes it to 2 and disables the stopword list), and that boolean mode requires server-side query construction because user input contains operator characters.

**Decision.** A narrow table `note_search(note_id, vault_id, title, body_text, revision)` with `FULLTEXT ft_note_search(title, body_text)` created in its own migration, `0020_note_search_fulltext` (A7: one DDL statement per file). The skeleton names that one object twice — `ft_note_search` in the DDL and `ft_title_body` in this row — and decision D03-11 in `03-data-model.md` settles it as `ft_note_search`, which is also the name `iridium repair search` drops and rebuilds; `ft_title_body` names nothing that exists. Queries are built server-side in boolean mode: `+tok*` per token, operator characters escaped, `"phrases"` preserved, `-negation` supported; single-character tokens fall back to a `title LIKE ?` union because they fall below `innodb_ft_min_token_size`. The query parser lives in `@iridium/markdown/search/parseQuery.ts` and supports the `path:` and `file:` operators in the MVP; `tag:` and `line:` are reserved, and the `fm_tags` multi-valued index exists from day one so `tag:` needs no migration later. The ACL filter is `vault_id IN (accessible)` **inside the SQL statement**, never a post-filter. Ranking is `ORDER BY <MATCH … AGAINST score> DESC, note_id ASC` — exactly the keyset cursor `(score DESC, note_id)` of A35, so the ordering and the paging key are the same total order. `updated_at` is returned per hit and a client may sort a page by it, but it does **not** affect ranking: a tie-breaker outside the keyset is not a total order over the result set, so a page boundary inside a score tie would silently drop or duplicate hits — and on the MCP path an agent has no way to notice. Everything sits behind a `SearchIndex {index, remove, query, rebuild}` interface so Meilisearch can replace the implementation post-MVP without touching callers. CJK ngram support is G5 (default parser and `innodb_ft_min_token_size=2` until answered).

**Alternatives considered.**

| Alternative | Why rejected |
|---|---|
| Meilisearch or Typesense in the MVP | A second stateful component to deploy, back up, restore, and secure; ACL filtering moves out of SQL; spec §8 asks for one application plus MySQL plus attachment storage. Kept as the post-MVP path behind the interface. |
| SQLite FTS5 alongside MySQL | A second storage engine to keep consistent with the system of record and to include in the backup set (A47). |
| `LIKE '%term%'` only | No ranking, no phrase handling, full scans on a vault of any size. |
| Indexing `note_projections.markdown` directly | Markdown punctuation pollutes tokens and scores; `body_text` is the plain-text projection with `yaml` and `html` nodes filtered out (digest §7.4). |
| Application-side ACL filtering after an unfiltered search | The isolation bug class the "Vault isolation" acceptance row exists to catch. |
| A wide search table (headings, links, tasks in the same row) | Bloats the FULLTEXT index; those projections live in `note_projections` and `note_links` where they are queried structurally. |

**Consequences.** Positive: no new deployment component; the ACL is a SQL predicate that the isolation test exercises directly; rebuilds are a single job (`iridium reindex`); the interface records the replacement criterion rather than pretending FULLTEXT is forever. Negative: InnoDB FULLTEXT ranking is crude compared with a dedicated engine (no typo tolerance, no configurable synonyms) and `innodb_ft_min_token_size` is a server-level setting, so changing it requires a restart and a rebuild — which is why A9 bakes it before migration 0001; boolean-mode query construction is security-sensitive (operator escaping is unit-tested with a hostile corpus); CJK needs a second index and is deliberately parked at G5.

**Verification.** `search.query-parser.unit` (operator escaping, phrases, negation, `path:`/`file:`, single-character fallback, hostile input); `search.acl.integration` (the "Vault isolation" row: a user's search never returns another vault's notes, including by guessed id); `search.ranking.integration` (score descending then `note_id` ascending, ties broken deterministically, and `updated_at` provably not part of the ordering); `search.rebuild.integration` (`iridium reindex --vault` and `--stale` reproduce the index exactly); `search.staleness-hint.integration` (A38).

**References.** Digest §5.2 (InnoDB FULLTEXT, `innodb_ft_min_token_size`), §7.4 (filter `yaml`/`html` from plain text), §11.27, §3.6; spec §3, §4, §8; plan-risk-first ADR-22; **G5, answered "no" on 2026-09-12**, confirming this ADR's stated default without changing it. A59 additionally requires that the FULLTEXT configuration this decision depends on behaves identically on MySQL 8.4.11 and 9.7.2, which `migrations.parity.integration` and `ops.mysql-config.spec` assert on both images. Implemented in `03-data-model.md` and `08-markdown-pipeline-import-export.md`.

### A42 — Markdown preview and sanitisation pipeline: shared token-to-mdast parser, sanitize-last hast, workers

**Status.** Accepted (2026-09-11); amended 2026-09-20 after S11 executed the recorded markdown-it fallback. The original remark engine failed the representative preview criterion; the replacement passes the declared local gates. Actual pilot measurements remain unavailable. **ADR file.** `docs/adr/0042-markdown-pipeline.md`.

**Context.** One isomorphic pipeline must serve preview, projection, links and import findings without changing Markdown source. The original decision chose remark/micromark for mdast positions and a DOM-free hast sanitizer. S11 measured the complete production pipeline in real Node and Chromium workers, including highlighting, sanitization and the required result transfer. The original engine measured 115.1 ms browser preview p95 at the declared 64 KiB representative p95 size; duplicate-pass and transfer mitigations still measured 109.2 ms. Its 100 KiB Node projection p95 of 206.311 ms met the separate 400 ms target, but did not satisfy the preview switch criterion. The fallback therefore executed. The recorded workload is synthetic and explicitly pilot-representative; no actual pilot corpus was supplied.

The original rejection of markdown-it assumed its HTML renderer was the integration point. M2 instead consumes its token engine and maps tokens directly to mdast with UTF-16 source positions. No HTML reparse, DOM sanitizer or innerHTML sink is required. The same mdast tree continues to feed every projection and the existing hast pipeline.

**Decision.** Keep one DOM-free, Node-free product package, `@iridium/markdown`, running in browser workers and a bounded Piscina 5.3.2 server pool. Normalize line endings and BOM metadata at ingestion; parsing, preview and projection preserve the resulting source string and never serialize Markdown.

The pipeline is admission prescan and source-preserving frontmatter masking → markdown-it 15.0.2 shared token engine → the position-aware adapter in `src/markdown-it/` → mdast with GFM tables, tasks, strikethrough (`singleTilde: false`), footnotes and the linear mdast autolink transform → remark-rehype 11.1.2 → Iridium id, position and link transforms → fixed-registry lowlight 3.3.0 highlighting with highlight.js 11.12.0 → **rehype-sanitize 6.0.0 last**. All 21 specified grammars remain registered; auto-detection is disabled and dataview/query/mermaid/math remain plain text. Raw HTML becomes literal text, never executable elements. The two MVP flavors have identical empty extension hooks.

The pinned `patches/markdown-it@15.0.2.patch` exposes a shared token-only entry, preserving upstream grammar sources and the original root API. It removes unused renderer, URL recoder and linkifier capabilities from the token entry dependency graph; it does not split required payload into uncounted chunks. The AST-based patch generator and upstream API/token differential checks live in the isolated S11 leaf (A2). Retire the patch when an equivalent upstream token entry passes the semantic matrix and complete-worker size gate.

`iridiumSanitizeSchema` retains the explicit tag, attribute and protocol policy, single `user-content-` prefix, position/link data attributes and highlight classes. It permits no inline style or event handlers. YAML uses yaml 2.9.1 core-schema parsing with bounded aliases and unique keys; the raw block is retained and never re-serialized. A future React renderer consumes sanitized hast with `tableCellAlignToStyle: false`; browser-only HTML export/print sinks apply their separate DOMPurify policy. No product preview path uses `dangerouslySetInnerHTML`.

Admission caps and worker termination remain mandatory: the browser deadline is 2 seconds and the server deadline is 10 seconds. The source remains available when derived work fails or is refused. `PIPELINE_VERSION` is **2**, because M1 already persisted version 1. Reindex advances the global marker only after the full rebuild completes; a boot write must never conceal unfinished work.

**Alternatives considered.**

| Alternative | Why rejected |
|---|---|
| Keep remark/micromark after measured mitigations | The complete representative preview remained above 100 ms; favorable repeats did not supersede the retained failure. |
| Use markdown-it HTML output or maintain a second projection parser | Adds an HTML-string sink or a second semantic implementation. Direct token-to-mdast conversion preserves one tree and sanitizer. |
| Copy upstream grammar algorithms into Iridium | Creates a grammar fork and obscures upgrades. The packaging patch shares unchanged upstream rules and verifies the root API and token stream independently. |
| Remove required highlight grammars or hide chunks outside the size total | Changes the feature contract or misstates the payload. The final gate counts every emitted worker and broker script. |
| Safe Terser minification alone | The equivalent compact output still exceeded the 120,000-byte gate; final production measurement uses Vite/Oxc. |
| shiki or a DOM sanitizer as the primary boundary | Larger payload or browser-only capabilities and HTML sinks; sanitize-last hast already serves both worker environments. |
| Any AST-to-Markdown serializer, gray-matter, or parser on the main thread | Serializers rewrite source; gray-matter has unsuitable cache/coercion behavior; untrusted parsing must remain bounded in workers. |

**Consequences.** One positioned mdast tree still serves all derived consumers, and sanitizer behavior and committed output goldens are preserved. The adapter and the narrow upstream packaging patch add explicit maintenance obligations, covered by independent differential checks. A new adversarial case, `**😀**m`, intentionally differs from remark: the fallback follows CommonMark Unicode code-point punctuation rules, leaving that input literal, whereas the old UTF-16 surrogate classification produced emphasis. This exception is recorded and independently tested; equivalence is not claimed for every conceivable input.

The final version-2 run measured preview round-trip p95 **28.8 ms** at 64 KiB, Node projection compute p95 **37.127 ms** at 100 KiB, prescan **389.371 MB/s**, and the complete browser payload **119,566 gzip bytes** (118,794 worker plus 772 broker). The complete curve, unsuccessful runs, stress cases, source provenance and environment are retained. The actual-pilot predicate remains unmeasured, and these local results alone do not establish a milestone exit.

**Verification.** `markdown.commonmark.unit` covers all 652 CommonMark examples; `markdown.golden.unit` fixes mdast, hast, HTML and projection output; `markdown.offsets.prop` and `markdown.body-text-map.prop` verify source coordinates; `markdown.no-rewrite.prop` checks source preservation; `markdown.frontmatter.unit`, `markdown.xss-corpus.unit`, `markdown.sanitize.prop` and `markdown.pathological.unit` exercise frontmatter, hostile input and admission. `markdown.pipeline-version.guard` requires output-affecting changes to advance the persisted version, including the M1-to-M2 1→2 boundary.

The parser patch comparison passed 1,971 root API cases and 657 token/environment cases against the unchanged upstream entry. The final emitted Chromium payload passed 1,464 exact comparisons over 732 sources and both flavors. S11 used warmed real Piscina and Chromium module workers with the production payload and deadlines. The full protocol, samples, retained failures and bounded-sample interpretation are in [S11](../spikes/S11-markdown-engine-cost.md). Future Chromium component, web and Electron preview tests remain required by their owning milestones.

**References.** Original digest §7.1–§7.5 and §11.9–§11.11; spec §3, §7, §8; `08-markdown-pipeline-import-export.md`; [S11 — Markdown engine cost](../spikes/S11-markdown-engine-cost.md); `spikes/s11-markdown/PARSER-PATCH.md`; CommonMark 0.31.2 Unicode punctuation rules.

### A43 — Obsidian syntax in the MVP: detect, report, and index; render as literal text; keep the seam ready

**Status.** Accepted (2026-09-11); **confirmed by the owner's answer to G2 on 2026-09-12** — no read-only rendering of Obsidian syntax at MVP. The Decision stands unchanged, and its closing clause changes meaning without changing wording: the renderer plugin seam ships as the first post-MVP flag *because that is now the decision*, not "unless G2 pulls it forward". Detect, report and index is the whole of the 1.0 commitment on Obsidian syntax. **ADR file.** `docs/adr/0043-obsidian-syntax.md`.

**Context.** Spec §3 says "Obsidian-specific syntax is addressed explicitly during import rather than assumed compatible"; spec §7 says wikilinks, transclusions, callouts, Dataview queries, canvas files, and plugin behaviour "are not presumed equivalent"; spec §10 defers "full Obsidian syntax compatibility". Against that, digest §11.12 records plan-product-dx's argument that wikilinks, callouts, `==highlights==` and `%%comments%%` must render read-only in the first release for the product to feel like an Obsidian successor. Digest §7.2 supplies the facts that make the difference concrete: `[[Note]]` whose inner text matches a reference definition is parsed by remark as text + `linkReference` + text, so detection must scan the **source string** with code spans masked by mdast positions rather than walking text nodes; Obsidian's "shortest path when possible" resolves an unqualified `[[Note]]` by unique basename anywhere in the vault, so an importer that only resolves relative paths reports false broken links; Obsidian's "Strict line breaks" is off by default, so single newlines render as `<br>` and importing with strict CommonMark silently reflows poems and address blocks; Obsidian task syntax treats any character in the brackets as done while GFM accepts only ` ` and `x`; and `remark-obsidian` 1.12.1 is **GPL-3.0**, unusable in a proprietary product (MIT/Apache alternatives exist: `remark-wiki-link` 2.0.1, `@flowershow/remark-wiki-link` 4.0.0, `remark-obsidian-callout` 1.5.1).

**Decision.** Detect, report, and index now; render later. `detectObsidianSyntax()` produces import findings and per-note `obsidian_findings`. `note_links.kind ∈ {markdown, image, wikilink, embed, definition}` with `status ∈ {resolved, ambiguous, broken, external}` exists **from day one**, so backlinks, unresolved-link panes, and rename-impact warnings work over wikilinks even while wikilinks render as literal text. `vaults.markdown_flavor ENUM('gfm','obsidian-compat')`, `vaults.soft_breaks` (remark-breaks 4.0.0, preview only), and `vaults.attachment_folder` (read from `.obsidian/app.json` `attachmentFolderPath` at import) all exist now. The renderer plugin seam — `remarkWikiLink`, `remarkCallout`, `remarkHighlight`, `remarkComment`, written first-party and MIT-clean, with GPL `remark-obsidian` banned by the A52 license scan — is designed but **ships as the first post-MVP flag** unless G2 pulls it forward.

**Alternatives considered.**

| Alternative | Why rejected |
|---|---|
| Render wikilinks, callouts, highlights, and comments read-only in the MVP (plan-product-dx D1) | Four new parsers plus sanitizer schema additions (`details`/`summary`, `mark`) plus basename resolution in the preview worker plus `[[` autocomplete, landing inside the kernel milestones. Spec §10's deferral stands; G2 is the explicit lever if the user wants it. |
| Adopting `remark-obsidian` | GPL-3.0; the license scan in A52 exists partly because of this package. |
| Skipping detection as well | The import report is the product's honesty mechanism (spec §7: "identify unsupported constructs before migration is accepted"), and `note_links` over wikilinks is what makes the rename-impact dialog useful on imported vaults. |
| Rewriting wikilinks into Markdown links at import | A silent content rewrite, forbidden by spec §7 ("Do not silently normalize or discard note content"). |
| Text-node scanning for detection | Misses `[[Note]]` forms that remark parses as `linkReference`, and mis-detects inside code spans; source scanning with mdast-position masking is the verified approach. |
| Defaulting soft breaks on for all vaults | Changes CommonMark semantics for non-imported vaults; it is a per-vault flag set at import and reported. |

**Consequences.** Positive: the kernel milestones stay free of four new parsers; the data model needed for the eventual renderer (link kinds, statuses, flavour, soft breaks, attachment folder) exists from the first migration, so enabling rendering is a renderer change and not a migration; imported vaults get accurate compatibility reports immediately. Negative: an Obsidian user sees `[[Note]]` as literal text in the MVP, which is the most visible product gap and is called out in `01-vision-scope-and-principles.md` and in the import report; `note_links` carries wikilink rows whose targets the renderer does not yet link, so the backlinks pane can reference links the preview does not render (documented behaviour, and it is the correct data).

**Verification.** `obsidian.detect.unit` (wikilink forms including `[[Note|alias]]`, `[[Note#Heading]]`, `[[Note#^blockid]]`, embeds with sizes, callouts with all documented type aliases, tags, block ids, highlights, comments, inline footnotes, math, and mermaid/dataview/dataviewjs/query fences; code-span masking; the `linkReference` case); `obsidian.basename-resolution.unit` (unique basename resolves, duplicates flag `ambiguous`); `transfer.fixtures.integration` (the `@iridium/testkit` Obsidian sample vault with `.obsidian/`, `.trash/`, `.canvas`, CRLF and BOM produces the expected report codes); `links.index.integration` (wikilink rows created with the right kind and status); the `static` job's license-scan step, `scripts/check-licenses.ts` (GPL denylist).

**References.** Digest §7.2 (Obsidian syntax facts, GPL plugin, basename resolution, strict line breaks, task states), §7.5, §11.12; spec §3, §7, §10; judges 1, 2, 3; **G2, answered "no" on 2026-09-12**, confirming this ADR's stated default without changing it — `markdown.flavor-parity.unit` is what holds the seam inert for the whole of 1.0. Implemented in `08-markdown-pipeline-import-export.md` and `07-client-applications.md`.

### A44 — Attachments: content-addressed storage behind a driver interface, served by id, explicit deletion only

**Status.** Accepted (2026-09-11); **confirmed by the owner's answer to G4 on 2026-09-12** — encryption at rest is volume encryption or MySQL transparent data encryption only. The Decision stands unchanged, and its last bullet is now reserved by a settled decision rather than by an open question: `encryption ENUM('none','aes256gcm')` and the key columns exist, are never written with anything but `'none'` in 1.0, and carry no key material into the backup set. **ADR file.** `docs/adr/0044-attachments.md`.

**Context.** Spec §2 defines an attachment as a server-managed file belonging to one vault, referenced from Markdown and protected by that vault's permissions; spec §8 requires upload size limits, safe path handling, and that writable server storage is never exposed to clients. Digest §7.4 records the constraint that shapes the web path: an `<img>` element can never send an `Authorization` header, so a bearer-only API makes attachments unrenderable in the browser unless the endpoint also accepts the `HttpOnly` session cookie (with CSRF protection, satisfied because GET is side-effect free) — and in Electron, a privileged custom scheme handled in the main process keeps the credential out of the renderer (digest §4.2, §7.2 verify the `protocol.registerSchemesAsPrivileged` + `protocol.handle` + `net.fetch` pattern, including CVE-2026-70604: a custom scheme with `supportFetchAPI: true` but without `corsEnabled: true` could be read cross-origin). Digest §11.13 records the disagreement over signed URLs versus cookies. The failure mode to avoid, learned from every wiki product, is "images randomly missing" caused by heuristic orphan collection.

**Decision.** Content-addressed storage, a driver interface, id-based serving with explicit hardening, and no automatic deletion.

- `attachments` has `UNIQUE(vault_id, sha256)`; identical bytes uploaded twice in a vault are one row and one file.
- `StorageDriver {put, get, delete, exists}`: the `fs` driver (default) writes `<ATTACHMENTS_DIR>/<vault_id>/<aa>/<sha256hex>` with an atomic rename; the `s3` driver is optional (`@aws-sdk/client-s3` 3.1131.0; SeaweedFS on a pinned numeric tag in the compose `s3` profile).
- Upload: `POST /vaults/:id/attachments` (multipart, `MAX_UPLOAD_BYTES` 50 MiB per A.1, SHA-256 computed while streaming, MIME sniffed with a detector pinned at M0, allow-list of images/audio/video/pdf/text/office). SVG is stored but always served with `attachment` disposition.
- Download: `GET …/attachments/:id` streams with `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox`, `Content-Disposition: inline` only for `image/png|jpeg|gif|webp|avif`, `Cache-Control: private, max-age=3600`, and `ETag: sha256`.
- Web renders `<img>` through a same-origin cookie GET; Electron renders through `iridium-attachment://` handled in the main process (A53).
- `path_hint` stores the relative path used in Markdown (`<attachment_folder>/<name>`), resolved through `note_links`.
- `DELETE` is refused with the referencing notes listed unless `force` is supplied.
- **No heuristic garbage collection.** `GET /admin/attachments/unreferenced` (no live `note_links` reference and not referenced by any retained revision's Markdown; the scan runs in a worker) produces a list an administrator purges explicitly.
- `encryption ENUM('none','aes256gcm')` and key columns are reserved (G4).

**Alternatives considered.**

| Alternative | Why rejected |
|---|---|
| Path-addressed files (`<vault>/<folder>/<name>`) | A rename or move becomes a storage operation; a backup taken during a move can be inconsistent. Content addressing makes files immutable, so an attachment snapshot taken *after* the database dump is always a superset (A47). |
| Heuristic orphan garbage collection | The "images randomly missing" failure class: a link the heuristic did not understand (a wikilink embed, a link inside a retained revision, a link in an in-flight import) deletes a live file. Listing candidates for an administrator is the correct trade. |
| Short-lived signed URLs for web `<img>` (digest §11.13) | Adds a signing key, a TTL/revocation-lag trade-off, and URLs that leak into browser history and referrers; a same-origin cookie GET is already authenticated, already revocable (A23), and side-effect free. |
| A separate user-content origin | Real defence-in-depth against same-origin content attacks, but it requires a second hostname and certificate in every deployment; `nosniff` plus `CSP: sandbox` plus an `inline` disposition limited to five raster image types covers the MVP, and the separate origin is recorded as post-MVP hardening. |
| Serving SVG inline | SVG is an active-content format; it is stored (so it round-trips through export) but always downloaded. |
| Trusting the client-declared MIME type | Trivially spoofable; the type is sniffed from the bytes. |

**Consequences.** Positive: immutable files make backups consistent without quiescing; de-duplication is automatic within a vault; one driver interface means S3 is a configuration change, not a rewrite; no automated process can delete a referenced file. Negative: unreferenced bytes accumulate until an administrator purges them (an explicit operational task in `11-operations-and-deployment.md`, with a metric); `path_hint` plus `note_links` resolution means a Markdown reference is resolved at render time rather than stored as an id, which is what keeps the source text unrewritten (A42, F1); an attachment referenced only by a retained revision is not collectable, by design.

**Verification.** `attachments.security.integration` (upload cap, MIME sniffing versus declared type, the full response-header set, SVG always `attachment`, traversal attempts in `path_hint`, and the refused `DELETE` that lists the referencing notes with the audited `force` path); `attachments.dedupe.integration` (`UNIQUE(vault_id, sha256)` behaviour and range requests); `attachments.unreferenced-report.integration` (a file referenced only by a retained revision is **not** listed); `authz.vault-isolation.integration` covers attachment reads by guessed id; `desktop.attachments-no-token-in-renderer.e2e` (`iridium-attachment://` renders with no credential in the renderer, `corsEnabled: true` asserted per CVE-2026-70604).

**References.** Digest §7.4 (`<img>` cannot send Authorization), §4.2 and §7.2 (Electron privileged scheme pattern, CVE-2026-70604), §6.2 (upload hardening), §11.13; spec §2, §4, §8; plan-risk-first ADR-23; plan-enterprise GC stance; **G4, answered "volume and database encryption only" on 2026-09-12**, confirming this ADR's stated default: the envelope-encryption columns stay reserved, no attachment key family is introduced, and the posture is documented for operators in `11-operations-and-deployment.md` rather than implemented in the application. Implemented in `08-markdown-pipeline-import-export.md`, `07-client-applications.md`, `09-api-reference.md`.

### A45 — Import and export: a two-phase import job, a streaming export job with a manifest and EOL/BOM restoration

**Status.** Accepted (2026-09-11). **ADR file.** `docs/adr/0045-import-export.md`.

**Context.** Spec §7 requires importing a Markdown directory or ZIP as a new vault while preserving hierarchy and supported attachments, showing a report for filename collisions, unsafe paths, broken references, unsupported files, and Obsidian-specific features, and never silently normalising or discarding note content; and exporting a vault as a folder tree or ZIP of ordinary `.md` files plus attachments with a manifest of note ids, paths, and committed revisions, never overwriting an existing external directory without an explicit decision. Spec §9's "Portability and safety" row requires that Markdown, frontmatter, and code survive a round trip "without unintended changes". F1 explains the tension: the Y.Text of record is LF-only and BOM-free (CodeMirror treats `\r\n` as one position while Y.Text counts two — y-codemirror.next #35 — and micromark mis-offsets after a BOM), so byte fidelity is achieved by **recording** `original_eol` and `had_bom` and **restoring** them on export, not by storing the original bytes. Digest §11.9 records that one source plan wanted literal byte-exact storage instead. The other hazard is archive extraction: zip-slip via absolute paths, `..` segments, symlinks, NUL bytes, reserved Windows names, and over-long path segments.

**Decision.** **Import** is a job with four explicit phases and a commit gate:

1. `POST /imports {target: {newVault: {name}} | {vaultId, parentNodeId}}` — `server:vaults:create` for a new vault, `import:commit` for an existing category (F8).
2. `PUT /imports/:id/upload` — a multipart stream of files from `<input webkitdirectory>` or a user-provided ZIP on the web; the Electron main process zips the chosen folder and uploads it. Caps: 2 GiB, 50 000 files, depth 64 (A.1); staged under `STAGING_DIR/<jobId>`.
3. `POST /imports/:id/scan` — a worker walks the staging area with yauzl streaming and zip-slip guards (absolute paths, `..`, symlinks, NUL, reserved names, segments over 255 bytes → `unsafe_path`; invalid UTF-8 → a finding), then runs `normalizeSource`, `parseNote`, `detectObsidianSyntax`, and `resolveLink`; collisions are detected case-insensitively under `utf8mb4_0900_as_ci`; `.obsidian/**`, `.trash/`, `.canvas`, and `.base` are listed and skipped. The result is a report JSON typed by `@iridium/contracts/import-report.ts` with the closed code set: `filename_collision`, `unsafe_path`, `invalid_utf8`, `broken_link`, `ambiguous_wikilink`, `unsupported_file`, `obsidian_config_skipped`, `obsidian_trash_skipped`, `canvas`, `bases`, `embed`, `block_ref`, `callout`, `tag_invalid`, `math`, `mermaid`, `dataview`, `dataviewjs`, `query_block`, `non_gfm_task_state`, `image_size_syntax`, `inline_footnote`, `deprecated_frontmatter_key`, `soft_break_reliance`, `bom_stripped`, `crlf_normalized`, `too_large`, `too_complex`.
4. `POST /imports/:id/commit {options: {collisions: 'suffix'|'skip'|'abort', softBreaks, attachmentFolder, markdownFlavor}}` — a new vault is created with `status='importing'` and is invisible until flipped to `active`; one transaction per note (node rows, `NoteService.initialize`, `note_revisions(kind='import')`, and the initial projection); attachments are de-duplicated by SHA-256 with `path_hint`; links are re-resolved after all notes exist; the job audits `import.committed` with the report hash. The job is idempotent and resumable. `POST /imports/:id/abort` deletes the staging directory.

**Export** is a job: `POST /vaults/:id/exports {format: 'zip', scope: {vault} | {nodeId}, restoreLineEndings: true, includeAttachments: true}` (requires `export:read`, is audited, and writes an `access_log` row per note). A worker flushes loaded documents, then streams a yazl ZIP built from `note_projections.markdown` at derived paths with EOL and BOM restored, attachments at their `path_hint`, a `manifest.json` (`{format: 'iridium-export/1', vault: {id, name, flavor}, exported_at, notes: [{note_id, path, revision, content_hash, updated_at}], attachments: [{attachment_id, path, sha256, size}], warnings: []}`), and a `README-IRIDIUM.md` listing unsupported constructs. No `.obsidian` directory is produced. `GET /exports/:id/download` expires after 24 h. The Electron main process streams to `showSaveDialog` and never overwrites a non-empty directory without explicit confirmation. A single-note export is just `GET /notes/:id/markdown`. An optional read-only mirror, `iridium mirror --vault --dir`, is driven by `projected_seq`, is never watched, and is never written back.

**Alternatives considered.**

| Alternative | Why rejected |
|---|---|
| Client-side in-memory ZIP with fflate | Does not scale to a 2 GiB, 50 000-file vault, and puts archive parsing (the zip-slip surface) in the renderer. |
| Import as a new vault only (spec §7 literal) | Managers legitimately need to bring a folder into an existing vault; F8 documents the widening, gated on `import:commit`. |
| Committing into a visible vault and cleaning up on failure | A half-imported vault would be browsable, searchable, and MCP-readable mid-import; `status='importing'` makes it invisible until complete. |
| Byte-exact source storage (digest Topic 8, §11.9) | CRLF in Y.Text desynchronises CodeMirror positions (#35) and a BOM breaks micromark offsets and frontmatter detection; metadata-plus-restoration keeps the acceptance row true and is property-tested. |
| Silently normalising without reporting | Spec §7 forbids it; `bom_stripped` and `crlf_normalized` are report codes precisely so the change is visible. |
| Non-streaming ZIP handling (read the archive into memory) | A 2 GiB archive would exhaust the process; yauzl and yazl both stream. |
| A continuously synchronised filesystem mirror | Spec §6 allows only a read-only mirror; bidirectional sync is deferred by spec §10, and `iridium mirror` is explicitly one-way and never watched. |

**Consequences.** Positive: half-imported vaults are never visible; the byte-exact round trip is proven by a property test rather than asserted; the report's closed code set is a typed contract the UI renders and tests assert; export manifests make an export verifiable and diffable. Negative: import is four HTTP steps plus a commit, which is more client work than a single upload (justified by the report gate, which is a product feature); staging storage must be provisioned and cleaned (`staging-data` volume, abort path, and a maintenance job); export reads projections, so it inherits A38's freshness contract and therefore flushes loaded documents first.

**Verification.** `import.unsafe-paths.unit` (absolute paths, `..`, symlinks, NUL, reserved names, over-long segments each produce `unsafe_path` and extract nothing); `import.report.integration` (the Obsidian sample fixture yields the expected code set); `import.commit.integration` (a resumed commit does not duplicate notes, and an `importing` vault is absent from REST, search, and MCP); `markdown.roundtrip.prop` (`export(import(bytes)) === bytes` with CRLF, BOM, tabs, and frontmatter preserved — the "Portability and safety" acceptance row); `export.manifest.integration` (manifest schema and revision accuracy); `export.no-overwrite.e2e` (Electron refuses a non-empty directory without confirmation); `access-log.integration` (per-note export rows).

**References.** Digest §7.2 (BOM and CRLF facts, Obsidian storage layout), §7.4, §7.5, §11.9; spec §7, §9, §10; plan-enterprise and plan-product-dx grafts; judge weakness fixes; F1, F8. Implemented in `08-markdown-pipeline-import-export.md` and `09-api-reference.md`.

---

## Area 7 — Client applications

### A40 — UI framework and state: React 19.3 + TanStack Router/Query + Zustand + Base UI/shadcn v4 + Tailwind 4

**Status.** Accepted (2026-09-11). **ADR file.** `docs/adr/0040-ui-framework.md`.

**Context.** The brief requires **one** shared TypeScript UI that runs in a browser and inside a thin Electron shell — not two UIs. That single constraint disqualifies several otherwise reasonable choices, because the same router, the same storage access, and the same networking layer must work under `https://server` and under `app://iridium`. Digest §4.2 verified the relevant facts: React 19.3.0 (2026-09-09) adds stable `<ViewTransition>`, Fragment refs, and Trusted Types support with no breaking changes; React Router 8.3.1 is ESM-only and "deliberately boring" but TanStack Router 1.170.35 offers fully typed routes and search params with **explicit history types**, where `createMemoryHistory` is the documented choice for non-browser environments — exactly the Electron case; shadcn/ui made Base UI the default primitive library in July 2026 (`@base-ui/react` 1.8.0, MIT, monthly releases by the MUI team that built Radix) while Radix's cadence slowed; shadcn's own `Command` component still wraps `cmdk@1.1.1` (last published 2025-03-14), which **drags Radix into a Base UI application**, whereas Base UI's Autocomplete natively supports `inline` + `open`, a custom `filter`, grouped items, and virtualisation via `@tanstack/react-virtual`; `@headless-tree/core` + `/react` 1.7.0 is the official successor to react-complex-tree and virtualises 100k+ items with any virtualizer; `@dnd-kit/react` is still 0.5.0 pre-1.0 and legacy `@dnd-kit/core` was last published in 2024, while `@atlaskit/pragmatic-drag-and-drop` 3.1.0 is actively maintained and Apache-2.0.

**Decision.** react 19.3.0 and react-dom 19.3.0 with `@vitejs/plugin-react` 6.1.1 and the React Compiler enabled; `@tanstack/react-router` 1.170.35 using `createBrowserHistory` on the web and `createMemoryHistory` in Electron, with typed routes `/login`, `/set-password`, `/` (vault selector), `/v/$vaultId?tab&mode&rev`, `/v/$vaultId/n/$noteId`, `/v/$vaultId/trash`, `/v/$vaultId/settings`, `/settings/{profile,sessions,integrations,appearance}`, `/admin/{users,vaults,tokens,audit,settings,releases,system}`, plus a `toShareUrl()` mapper; `@tanstack/react-query` 5.102.8 with keys `[origin, 'vault', vaultId, …]` invalidated by vault-channel events (A18); zustand 5.0.15 for workspace layout per profile and vault, persisted through `host.storage`; `@base-ui/react` 1.8.0 installed via shadcn 4.21.0 `-b base-ui`; tailwindcss 4.3.3; lucide-react 1.45.0; `@headless-tree/core` + `@headless-tree/react` 1.7.0 with `@tanstack/react-virtual` 3.14.12; `@atlaskit/pragmatic-drag-and-drop` 3.1.0; react-resizable-panels 4.12.4; `@tanstack/react-form` 1.33.5.

The command palette is built on a Base UI Dialog plus Autocomplete over `packages/ui/src/commands/registry.ts` (entries of `{id, title, defaultKeys, scope, when, run}`). That one registry also drives the CodeMirror keymaps, the Electron native menu, and the end-to-end tests, so a command exists in exactly one place.

Product grafts adopted: quick switcher (Mod-O by name, path, or alias; `Shift+Enter` creates), preview versus pinned tabs, `Ctrl+Tab` cycling, split right, the rename-impact dialog driven by `note_links`, backlinks and unresolved-link panes, hover page preview, `host.files.saveText` ("Export my text"), and presence colours from `users.color_hue`.

Performance budgets measured in CI (the table in `10-testing-and-quality.md` §"Client budgets" is authoritative for the values): note open under 300 ms for a 100 KB note, the 10 000-node tree scrolling at 55 fps or better, preview p95 under 100 ms for a 100 KB note, and a renderer bundle of at most 900 KB gzip in total with at most 350 KB gzip in the initial route chunk.

**Alternatives considered.**

| Alternative | Why rejected |
|---|---|
| React Router 8.3.1 | No typed routes or typed search params, and its history handling is browser-centric; TanStack's explicit `createMemoryHistory` is the documented pattern for the Electron renderer, and typed search params matter because `?tab&mode&rev` is real application state. |
| Radix primitives | Still supported by shadcn (`-b radix`) but on a slowed cadence under new maintenance; Base UI is shadcn's default as of July 2026 and is released monthly by the team that originally built Radix. |
| `cmdk` / `cmdk-base` for the palette | `cmdk@1.1.1` pulls four Radix packages into a Base UI application (two primitive libraries in one bundle); `cmdk-base@1.0.0` is a third-party fork. Base UI's Autocomplete covers the requirement natively, including virtualisation. |
| react-arborist 3.16.0 | Bundles its own virtualisation and drag-and-drop, which conflicts with the chosen virtualizer and DnD library; headless-tree leaves both to the application. |
| `@dnd-kit` (0.5.0 or legacy 6.3.1) | Pre-1.0 or unmaintained since 2024; pragmatic-drag-and-drop is maintained and framework-agnostic. |
| Redux Toolkit | Server state is TanStack Query's job and the remaining client state is small (layout, tabs, panes); Zustand is the right size for it. |
| Two separate UIs (web and desktop) | Explicitly forbidden by the brief; also doubles the surface for every authorization, editor, and preview behaviour. |

**Consequences.** Positive: one UI codebase with one router, differing only in the injected history and the `IridiumHost` implementation (skeleton §B.3); typed routes make the deep-link contract (`iridium://open?server=&note=&rev=`) checkable at compile time; one command registry means the palette, keymaps, native menu, and E2E selectors cannot drift. Negative: TanStack Router's typed-route generation is a build step the CI must run (folded into `pnpm gen`, A3); Base UI is a 1.x library on a monthly cadence, so upgrades need review (Renovate plus the component test suite); the 900 KB gzip renderer budget constrains what may be added to the main bundle and forces the preview pipeline into a worker chunk (A42).

**Verification.** `palette.registry.component` (every command has a unique id and a `when` guard; the Electron menu and CodeMirror keymap are generated from it); `gen.drift.guard` (the generated route tree compiles and `toShareUrl()` round-trips); component tests in Vitest Browser Mode with axe-core checks (A55); the client budgets of `perf.workspace.e2e` — note open under 300 ms for a 100 KB note, preview p95 under 100 ms, tree scroll at or above 55 fps on the 10 000-node fixture — plus the deterministic renderer-bundle gate (`scripts/check-bundle-budget.ts` against `bundle-budget.json`), which is the one client budget that blocks a pull request; Playwright web and Electron suites drive the same selectors from the command registry.

**References.** Digest §4.2 (React 19.3, TanStack Router history types, Base UI/shadcn v4, cmdk's Radix dependency, headless-tree, pragmatic-drag-and-drop, library pins), §10.2 (product expectations); brief requirement 2; plan-risk-first ADR-19; plan-product-dx grafts. Implemented in `07-client-applications.md`.

### A41 — Editor stack: CodeMirror 6 with y-codemirror.next and disposable views

**Status.** Accepted (2026-09-11); **amended 2026-09-13** by spike S4 (`docs/spikes/S04-editor-csp-nonce.md`): `y-codemirror.next`'s remote-caret widget writes its colour as a `style` attribute and is the one component a nonce-based `style-src` refuses, so the extension order below calls `yCollab` with a **null** awareness — which switches upstream's `yRemoteSelections` off entirely — and renders remote selections from `packages/editor/src/remote-selections.ts`, a drop-in plugin with the same decorations, class names and awareness contract whose caret writes through the CSSOM. Everything else in this decision stands. **ADR file.** `docs/adr/0041-editor-stack.md`.

**Context.** Spec §3 requires Markdown **source** editing with a separate rendered preview and explicitly rejects "a rich-text editor that repeatedly converts Markdown to an editor-specific document format and back"; spec §5 requires that undo and redo target the current user's operations. Digest §1.2 verified the binding facts: `y-codemirror.next` 0.3.6 provides `yCollab(ytext, awareness, {undoManager})` with remote cursors and a per-client `Y.UndoManager`, and CodeMirror's own `history()` must **not** be installed alongside it (it would undo remote changes); `yUndoManagerKeymap` must be given `Prec.high` so it wins over `defaultKeymap`; y-codemirror.next issue #36 records that rebuilding a view loses the caret unless it is restored from a relative position; and issue #35 is the CRLF desynchronisation that F1 and A22 address. Digest §4.2 adds that CodeMirror injects styles dynamically through style-mod, so a CSP without `style-src 'unsafe-inline'` requires the `EditorView.cspNonce` facet to carry the page nonce.

**Decision.** Exact pins: `@codemirror/state` 6.7.4, `view` 6.43.11, `language` 6.12.4, `commands` 6.11.0, `search` 6.7.2, `autocomplete` 6.20.3, `lang-markdown` 6.5.2, `@lezer/markdown` 1.7.2, `@lezer/common` 1.5.2, `@lezer/highlight` 1.2.3, and `@codemirror/lang-yaml` (pinned at M0, for nested frontmatter highlighting).

Extension order is normative:

```
Prec.high(keymap.of(yUndoManagerKeymap)),
keymap.of(iridiumFormattingKeymap),
markdown({ base: commonmarkLanguage, extensions: [GFM, iridiumFrontmatter], codeLanguages, addKeymap: true, completeHTMLTags: false }),
yCollab(ytext, null, { undoManager }),              // sync + undo only; null awareness
yRemoteSelectionsTheme,                            //   switches upstream's carets off
iridiumRemoteSelections(ytext, provider.awareness), // Iridium's CSSOM caret (S4)
readOnlyCompartment,
keymap.of([...defaultKeymap, indentWithTab]),
search(), highlighting, theme        // EditorView.cspNonce from the page nonce
```

`history()` and `historyKeymap` are **never** installed. `NoteSession {ydoc, ytext, provider, undoManager (captureTimeout 500), lastSelection: YRange | null, saveState}` comes from `@iridium/collab-client` through `NoteSessionRegistry.acquire(noteId)` — one provider per note per window, `sessionAwareness: false`, released 60 s after the last tab closes. There is one `EditorView` per **visible** note; hidden views are destroyed and rebuilt from `ytext.toString()` with the caret restored from a stored relative position (issue #36). A paste guard caps insertions at 1 000 000 UTF-16 units and strips `\r` on paste. Formatting commands are `StateCommand`s implemented with `changeByRange` plus `syntaxTree`, tagged `input.format`: bold, italic, strikethrough, inline code, fenced code, link, headings 1–6, bullet/ordered/task list, toggle checkbox, blockquote, and table.

**Alternatives considered.**

| Alternative | Why rejected |
|---|---|
| A WYSIWYG editor over a document model (Tiptap/ProseMirror, Lexical) | Spec §3 rejects repeated conversion between Markdown and an editor document format; it would also make the Y.Text-of-record design impossible, since the CRDT would hold a rich-text model rather than the Markdown source. |
| CodeMirror's `history()` alongside `yCollab` | Undoes remote participants' edits, violating spec §5. |
| Keeping hidden `EditorState`s alive for every open tab | Memory grows with tab count and every hidden view keeps a live binding; destroying and rebuilding from `ytext` with a restored relative caret is exact and bounded. |
| One provider per tab (`sessionAwareness: true`, digest Topic 5) | Duplicate document names per window and duplicated traffic; the registry shares one provider per note per window (A25). |
| Absolute caret offsets across a rebuild | Remote edits shift absolute positions; a Yjs relative position is the correct anchor (issue #36). |
| Storing formatted spans or attributes in the Y.Text | A22 treats any delta with attributes or embeds as invalid content; the CRDT holds plain Markdown source only. |

**Consequences.** Positive: undo and redo are per-client by construction; the source text is the single model, so no conversion can rewrite it; formatting commands operate on Markdown source and are therefore testable as pure state transformations; the CSP nonce keeps `style-src 'self'` intact, and after the 2026-09-13 amendment the editor owns its caret rendering, so an upstream change to that widget cannot reintroduce a style attribute. Negative: view rebuilds on tab switches must restore selection and scroll correctly, which is a named test rather than an assumption; `Prec.high` ordering and the absence of `history()` are easy to break during refactoring, so a guard test greps for `history(` in the editor package; formatting commands must handle every selection shape, which is where the property tests concentrate.

**Verification.** `editor.undo-isolation.component` (client A's undo never reverts client B's edits, across a reconnect — which is also the behavioural proof that CodeMirror's own `history()` is absent; a `no-restricted-imports` rule in the `static` job keeps `history`/`historyKeymap` out of `packages/editor/**`); `editor.view-lifecycle.component` (hide and show a tab under concurrent remote edits; caret and scroll restored via the relative position); `editor.paste-guard.unit` (1 000 000-unit cap, `\r` stripped); `editor.formatting.prop` (every command on random selections produces valid Markdown and is idempotent where it should be); `editor.csp-nonce.e2e` (no `style-src 'unsafe-inline'` in web or Electron); `collab.lf-invariant.guard` (A51 guard test).

**References.** Digest §1.2, §1.4 (binding pitfalls, issues #35 and #36), §4.2 (`EditorView.cspNonce`), §11.22; spec §3, §5; all four plans agree; F1. Implemented in `07-client-applications.md` and `05-collaboration-and-durability.md`.

### A53 — Electron shell: Electron 44.3.0, three plain build configs, electron-builder 26, generic updater on the server, full hardening, main-only credential custody

**Status.** Accepted (2026-09-11); the packaging, signing and in-application-update clauses are **superseded in part by the owner's answer to G8 (2026-09-12)**, marked inline in the Decision. The hardening, the fuses, the privileged scheme, the IPC discipline and main-only credential custody stand unchanged; the TLS posture is **amended 2026-09-13** by spike S7 (`docs/spikes/S07-electron-enterprise-ca.md`), which promotes the per-profile fingerprint pin from an option beside the OS trust store to the primary documented route on all three operating systems and requires every main-process request to issue on the profile's session. **ADR file.** `docs/adr/0053-electron-shell.md`.

**Context.** Spec §8 requires that note content can never reach Node or unrestricted Electron APIs, with context isolation, sandboxing, and "a narrow, validated preload interface", following Electron's security guidance. Digest §4.2 verified the whole matrix: Electron 44.3.0 embeds Chromium 152 and Node 24.20.0 on an 8-week cadence with three supported majors; Electron 44 adds `net.WebSocket` **in the main process** (which is what makes the Origin fallback below possible); a sandboxed preload gets a `require` limited to a handful of modules, cannot be split across CJS files, and **cannot use ESM at all**, so it must be bundled to a single CommonJS file; the fuse defaults and their correct values are enumerated (`RunAsNode` on → false, `EnableCookieEncryption` off → true, `EnableNodeOptionsEnvironmentVariable` on → false, `EnableNodeCliInspectArguments` on → false, `EnableEmbeddedAsarIntegrityValidation` off → true, `OnlyLoadAppFromAsar` off → true, `GrantFileProtocolExtraPrivileges` on → false); `protocol.registerSchemesAsPrivileged` must run before `ready` and CVE-2026-70604 makes `corsEnabled: true` mandatory alongside `supportFetchAPI: true`; `setCertificateVerifyProc` callback codes are 0 = trust, −2 = reject, −3 = defer; Chromium consults OS enterprise roots but on Linux uses the NSS shared DB (`certutil -d sql:$HOME/.pki/nssdb`); and the tooling matrix is decisive — **electron-vite 5.0.0 cannot run Vite 8** (peers `^5||^6||^7`), electron-vite 6.0.0-beta.1 has had no stable release in five months, Forge 7.11.2 does not include the Vite 8 upgrade while Forge 8 is alpha and ESM-only, and `vite-plugin-electron@1.1.2` supports Vite 8. electron-builder 26.16.1 is published under the `v26` dist-tag while `latest` still points at 26.15.3; electron-updater 6.8.9 is `latest`; Windows `verifyUpdateCodeSignature` embeds a `publisherName` that every **future** update is checked against; Squirrel.Windows cannot auto-update. Digest §4.4 adds that `electron-playwright-helpers`' IPC helpers require `nodeIntegration: true` and `contextIsolation: false`, which this hardening forbids.

**Decision.** Electron 44.3.0 with three plain build configurations — main built by tsdown as ESM (`deps.neverBundle: ['electron']`, with all imports awaited before `whenReady`), preload built by tsdown as a **single CommonJS file** (sandboxed), and the renderer built by the shared Vite config with `base: './'`. `vite-plugin-electron` 1.1.2 is permitted only as a development orchestrator; electron-vite 5/6 and Forge 7/8 are not used. Packaging is electron-builder 26.16.1 (installed from the `v26` tag). **Superseded in part by G8 (answered 2026-09-12):** at 1.0 the targets are `zip` on Windows and macOS and `tar.gz` on Linux, x64 and arm64, unsigned, ad-hoc signed on macOS only so that an arm64 binary will execute; there is no `electron-updater` dependency, no installer, no notarisation and no in-application update. The administrator policy (`disabled | prompt | silent`), the channel, `GET /desktop/update-policy`, the `/desktop/updates/<channel>/` generic feed and its `latest*.yml` generator all ship at 1.0 and are consumed by a version comparison in the main process rather than by an updater. Code signing (Azure Trusted Signing with a fixed `publisherName`, Apple Developer ID with notarisation), the installer set (NSIS assisted + MSI, dmg, AppImage + deb + rpm) and `electron-updater` 6.8.9 with `verifyUpdateCodeSignature` are the post-1.0 desktop distribution epic (12-milestones.md §14.2 epic 14); every seam they need is configured and shipping, so the epic is a configuration change. The `publisherName` is chosen inside that epic, before its first external build, and cannot be changed afterwards without breaking updates for installed clients (07-client-applications.md D07-45). `protocols: [{name: 'Iridium', schemes: ['iridium']}]`; `extraResources: bin/iridium-mcp` (A36).

The renderer loads from `app://iridium/`, registered before `ready` with `registerSchemesAsPrivileged({standard, secure, supportFetchAPI, corsEnabled: true, stream, codeCache})` and served by `protocol.handle` with a traversal guard and an SPA fallback, with a per-load CSP header. `webPreferences {sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInWorker: false, webviewTag: false, navigateOnDragDrop: false, devTools: !app.isPackaged, safeDialogs: true, spellcheck: true, preload, partition: 'persist:iridium'}` is snapshot-tested, and `app.enableSandbox()` is called. `will-navigate` denies; `setWindowOpenHandler` returns `deny` and routes to a validated `shell.openExternal` (https and mailto only); permission and device handlers deny by default (allowing only clipboard sanitized-write, notifications, and fullscreen). IPC channels are named `iridium:<domain>:<verb>`, each handler performing a **synchronous** `event.senderFrame?.origin === 'app://iridium'` check (the Vite dev origin only when unpackaged) plus zod validation from `contracts/desktop-ipc.ts`; the preload exposes fixed wrappers only and strips `event` from forwarded events. Fuses: `runAsNode: false`, `enableCookieEncryption: true`, `enableNodeOptionsEnvironmentVariable: false`, `enableNodeCliInspectArguments: false`, `enableEmbeddedAsarIntegrityValidation: true`, `onlyLoadAppFromAsar: true`, `grantFileProtocolExtraPrivileges: false`, with a separate **test-signed** E2E variant that flips only `enableNodeCliInspectArguments: true`.

Server profiles are `{origin (https only; http requires `--allow-insecure-server`, which disables credential persistence and updates), displayName, pinnedCertSha256?}`. TLS uses the OS trust store (documented per OS, including the Linux NSS `certutil` command) with a per-profile fingerprint pin applied in `setCertificateVerifyProc` **scoped to that host** (0 on match, otherwise −3 to defer); **amended 2026-09-13 by spike S7** — the pin is the primary documented route for a private-CA deployment on all three operating systems, and every main-process request issues on the profile's session so it cannot bypass the pin. Deep links are `iridium://open?server=&note=&rev=` with `iridium://auth/callback` reserved, zod-validated, prompting on an unknown server and never navigating directly. The native menu is generated from the command registry (A40). Import and export file dialogs run in main (A45). `IRIDIUM_E2E=1` disables the updater and the single-instance lock.

**WebSocket Origin** is an M0 spike with a designed fallback: `IpcWebSocket`, a `WebSocketLike` shim in the renderer over `iridium:collab:{open,send,close}`, where the main process opens the real socket with Electron 44's `net.WebSocket` and sends `Origin: app://iridium`; binary frames are forwarded both ways and close codes and reasons are forwarded verbatim. Ticket relay, the CSP `connect-src` (which then drops `wss:`), and the revocation path are unchanged either way.

Cadence policy: adopt a new Electron major within four weeks of release, never ship outside the three-version support window. The electron-builder 27 migration is an explicit post-MVP milestone.

**Alternatives considered.**

| Alternative | Why rejected |
|---|---|
| electron-vite 5 or 6 | 5.0.0 peers on Vite ≤7 and cannot run Vite 8 (A1); 6.0.0-beta.1 has had no stable release in five months. |
| Electron Forge 7 or 8 | 7.11.2 lacks the Vite 8 upgrade; Forge 8 is alpha and ESM-only. Three plain configurations have no framework to wait on. |
| Squirrel.Windows updates | Not supported for auto-update by electron-builder; NSIS with blockmap differential updates is the supported path. |
| Setting `win.azureSignOptions` provisionally at 1.0, with a placeholder or an interim certificate | `publisherName` is recorded in every installed client's `app-update.yml` and verified against every future update, so a provisional value is a commitment made by accident. Shipping unsigned leaves the choice to the epic that can make it properly. |
| A public update service (update.electronjs.org) | Public GitHub repositories only; an internal documentation product serves its own updates from the server it already trusts. |
| Renderer-held tokens (plan-product-dx) | The renderer is where hostile note content runs; A26 keeps custody in main. |
| `electron-playwright-helpers` IPC helpers | Require `nodeIntegration: true` and `contextIsolation: false`, which this hardening forbids; the E2E tests drive the UI and assert IPC effects instead. |
| `app.on('certificate-error')` for the fingerprint pin | A blanket bypass hook; `setCertificateVerifyProc` scoped to the profile's host is the narrow mechanism, and the callback returns −3 (defer to Chromium) rather than a blanket trust. |
| Bundling the CA trust decision into the app | Chromium already consults OS enterprise roots; documenting the per-OS installation (including Linux NSS) is correct, and the optional pin covers the air-gapped self-signed case. |

**Consequences.** Positive: the shell is hardened by construction and the hardening is snapshot-tested, so a regression is a failing test rather than a security review finding; three plain configurations remove an entire class of framework-version blockers; the updater is served by the same server that holds the data, so no third party is in the update path; the `IpcWebSocket` fallback means the Origin question cannot block M5. Negative: Iridium owns the packaging configuration that a framework would otherwise own (three configs, fuses, protocol registration, menu generation); code-signing identities are no longer a dependency of any milestone (G8, 2026-09-12), at the price the plan states rather than hides: an unsigned 1.0 means a SmartScreen prompt on every Windows first launch, a Gatekeeper block and a quarantine attribute on macOS, memory-only credential custody on macOS because the Keychain needs a real signature, Linux deep links inert until the bundle's `.desktop` file is installed, and update integrity resting on a published SHA-256 and on TLS rather than on a signature (07-client-applications.md §7.14.4, 11-operations-and-deployment.md OPS-60). `publisherName` still cannot be changed once installed clients carry it — deferring signing is what leaves that choice clean rather than removing it; the Electron cadence policy commits the project to a major upgrade every eight weeks.

**Verification.** M0 spike `docs/spikes/S03-electron-ws-origin.md` (whether the renderer's WebSocket sends `Origin: app://iridium`; records whether `IpcWebSocket` was adopted); `desktop.web-preferences.guard` and `desktop.preload-surface.guard` (the committed snapshots of A51); `ipc.origin.guard` (every handler rejects a foreign `senderFrame.origin`, synchronously); `desktop.fuses.guard` (the fuse configuration matches the table above, and the test-signed variant differs only in `enableNodeCliInspectArguments`; `release.yml` re-reads the bits off the produced binaries with `npx @electron/fuses read`); `desktop.hardening.e2e` (`will-navigate` and `setWindowOpenHandler` deny; `shell.openExternal` only for https and mailto); `desktop.deep-link-fuzz.e2e` (valid, malformed, and unknown-server links); `desktop.attachments-no-token-in-renderer.e2e` (A44 and A26: `iridium-attachment://` renders with no credential in the renderer, `corsEnabled` asserted per CVE-2026-70604, and `safeStorage` custody including the `basic_text` fallback); `desktop.update-manual.e2e` (policy `disabled|prompt|silent`, the manual-download card with its file name and SHA-256, no Install control, and `updates:install` rejecting with `updates_manual_only`), `desktop.artifact-names.guard` (the 1.0 target set and file names), `desktop.macos-secure-storage.e2e` (the unsigned-macOS credential consequence) and `release.bundle-integrity` (file names, both digests, fuses, ad-hoc macOS signature, `NotSigned` on Windows); the publisher-mismatch refusal returns with the post-1.0 epic; `desktop.tls-pin.e2e` (a per-profile `pinnedCertSha256` accepts the matching certificate, rejects a mismatch, and leaves an unpinned host working); `desktop.hostile-markdown.e2e` (the A42 corpus in the Electron renderer); Playwright `electron` project on ubuntu (xvfb), windows, and macos.

**References.** Digest §4.1–§4.5, §6.2 (`safeStorage`, Electron security checklist), §7.2 (privileged scheme for attachments), §11.13, §11.15, §11.21; spec §8; brief requirement 2; plan-risk-first ADR-19; judges; **G8, answered on 2026-09-12**: "Eventually but doesn't need to be in the initial release. Something that can be bundled and zipped for now is perfectly fine." 1.0 therefore ships six unsigned artefacts per release — `Iridium-<version>-win32-<arch>.zip`, `Iridium-<version>-darwin-<arch>.zip` and `Iridium-<version>-linux-<arch>.tar.gz` for x64 and arm64 — with a published SHA-256 per artefact, and signing, installers and in-application updates become post-1.0 epic 14. Also **AG6, 2026-09-12**: the desktop application is the supported client at 1.0, so this ADR's hardening is the hardening of the *supported* surface rather than of one of two. Implemented in `07-client-applications.md`, `09-api-reference.md` (§D.4), `11-operations-and-deployment.md`.

### A55 — Accessibility, internationalisation, and browser support

**Status.** Accepted (2026-09-11); **superseded in part by AG6 (2026-09-12)** (D13-14), the part being the supported-browsers clause. The accessibility and internationalisation clauses stand unchanged. **ADR file.** `docs/adr/0055-a11y-i18n-browsers.md`.

**Context.** Enterprise procurement questionnaires ask about keyboard accessibility, WCAG conformance, and supported browsers, and none of the source plans except plan-product-dx addressed them. Deciding late is expensive: a tree, a tab strip, and a command palette that were not built keyboard-first cannot be retrofitted cheaply, and hard-coded English strings spread through every component. Digest §10.2 records that enterprise readiness checklists treat accessibility and browser-support statements as standard questionnaire items. Digest §4.2 also notes that the chosen primitives (Base UI, headless-tree with `hotkeysCoreFeature`, pragmatic-drag-and-drop with `keyboardDragAndDropFeature`) provide keyboard behaviour as a first-class feature rather than an add-on.

**Decision.** Every tree node, tab, pane, dialog, and palette element is keyboard-reachable and operable, including drag-and-drop (headless-tree's keyboard drag feature). axe-core checks run inside the component tests (axe-core pinned at M0, A51). Themes are CSS-variable based — light, dark, and system, plus a high-contrast variant — and `prefers-reduced-motion` is respected. All user-visible strings live in `packages/ui/src/i18n/en.ts` with typed keys, so adding a locale is a new table and not a code sweep; no translation is shipped in the MVP. Supported browsers at MVP are current Chrome and Edge (Chromium-class); Firefox and WebKit get nightly smoke tests only and are best-effort. That is G6's default; if the user commits to Firefox and WebKit as supported targets, those lanes become PR-blocking and CodeMirror/WebSocket behaviour differences are fixed in M4.

> **Superseded in part by AG6 (2026-09-12).** The two closing sentences of the Decision above — the Chromium-class support statement and the clause that treats G6 as a lever — are the text as accepted and are kept as record (D13-2); they no longer describe the product. Since 2026-09-12 the desktop application is Iridium's supported client at 1.0, the web host is a development and internal surface running in current Chrome and Edge with no support commitment, and Firefox and WebKit are out of scope entirely: no lane, no best-effort claim, and no question left to answer. This marker covers the "Committing to Firefox and WebKit at 1.0 without lanes" row of the alternatives table below as well, whose reasoning rested on a nightly lane that no longer exists. The accessibility and internationalisation clauses of the Decision stand exactly as written.

**Alternatives considered.**

| Alternative | Why rejected |
|---|---|
| Deferring accessibility to a post-MVP pass | Keyboard reachability is structural; retrofitting a virtualised tree and a tab strip costs more than building them correctly, and the chosen primitives already provide the behaviour. |
| Full WCAG 2.2 AA certification as an MVP gate | A formal audit is an external engagement; the plan commits to automated axe checks plus keyboard completeness, and states that clearly rather than implying certification. |
| Shipping localisation in the MVP | No target locale is known; the typed string table is the cheap seam that makes it additive later. |
| Hard-coding strings and extracting later | Guarantees a large mechanical change and missed strings; the table costs nothing now. |
| Committing to Firefox and WebKit at 1.0 without lanes | An unverified support claim; the nightly smoke lane makes the actual state visible and G6 is the lever to upgrade it. |

**Consequences.** Positive: the plan can answer the standard questionnaire rows with named tests; a locale, a high-contrast theme, or a new browser lane are all additive; `prefers-reduced-motion` and the CSS-variable themes also serve the Electron renderer unchanged. Negative: axe-core checks add time to the component lane and will flag third-party primitive issues that must be triaged rather than ignored; Chromium-only support at MVP is a real limitation stated openly in `01-vision-scope-and-principles.md`; keyboard drag-and-drop for the tree is extra implementation surface (justified — it is also the accessible path for moving notes).

**Verification.** `a11y.axe.component` (axe-core on the tree, tab strip, editor chrome, palette, dialogs, and admin tables); `a11y.keyboard-only.e2e` (create, rename, move, trash, and restore a note using only the keyboard, including a keyboard drag); `guards.i18n.guard` (a guard test asserting no literal user-visible strings outside `i18n/en.ts`); `ui.theme.component` (light, dark, system, and high-contrast render; reduced motion disables transitions); nightly cross-browser smoke (firefox, webkit) reported but non-blocking.

> **Superseded in part by AG6 (2026-09-12).** The nightly cross-browser smoke is gone: the `firefox-smoke` and `webkit-smoke` Playwright projects and the `nightly.yml › browser-smoke` job are deleted, and `guards.non-goals.guard` (case *Cross-browser support*) asserts their absence. The accessibility proofs above stand; the one that gates 1.0 is the supported client's, `desktop.a11y-keyboard-only.e2e`.

**References.** Digest §10.2 (enterprise questionnaire expectations), §4.2 (primitive keyboard support); plan-product-dx graft; G6. Implemented in `07-client-applications.md` and `10-testing-and-quality.md`.

---

## Area 8 — Audit, backup, operations, and the threat model

### A46 — Audit log: same-transaction HMAC chain per `chain_id` with locked chain heads, triggers, a closed vocabulary, and CLI verify/export/archive

**Status.** Accepted (2026-09-11). **ADR file.** `docs/adr/0046-audit-log.md`.

**Context.** Spec §8 requires recording administrative and structural actions using authenticated identities and explicitly forbids treating CRDT client identifiers or self-reported cursor names as proof of authorship. Digest §6.2 verifies the industry conventions: dot-notation actions, `occurred_at`, `actor {id, type, …}`, `targets []`, `context {location, user_agent}`, append-only enforcement through insert-only database privileges, a separate schema, tenant and actor context on every row, and hash/HMAC chaining that makes tampering **detectable** (not preventable). It also records that enterprise questionnaires rank audit-log retention and export immediately after SSO and SCIM. Digest §11.26 records the granularity disagreement: a per-MCP-call audit row (Topic 3), a split between lifecycle events and a high-volume access log (Topic 6), and per-tool-call rows with returned note ids (Topic 10). The subtle correctness problem is the chain itself: computing `prev_hash` by reading the last row without a lock forks the chain under concurrency, producing two rows claiming the same predecessor — which verification then reports as tampering. A second, deeper problem is deadlock: the audit writer takes a lock inside every mutating transaction, so its lock order must be fixed relative to the vault row, the node rows, and the persistence writer.

**Decision.** `AuditWriter.record(trx, event)` runs **inside the mutating transaction**: `SELECT last_id, last_hash FROM audit_chain_heads WHERE chain_id = ? FOR UPDATE` (chain `vault:<id>` for vault-scoped events, `server` otherwise), then `hash = HMAC-SHA256(AUDIT_HMAC_KEY[key_version], prev_hash || canonicalJSON(row))`, then the INSERT, then the head UPDATE.

**Lock order is normative**, declared in `02-system-architecture.md` section "Lock order": owner-generation fence → `vaults` (when structural) → `nodes` → `notes` → `note_docs` → `note_updates` → `note_projections` → `note_search` → `note_links` → `note_revisions` → `trash_entries` → `audit_chain_heads`. All serving writes first hold the captured owner-generation fence. Note persistence then locks the source `nodes` row `FOR SHARE`, the parent `notes` row `FOR UPDATE`, and the `note_docs` row `FOR UPDATE`, in that order. The explicit parent locks account for the locks InnoDB also takes while checking foreign keys on updates and derived rows. The writer does not take the structural vault mutex; structural transactions take `vaults` before the same parent/document order. A joined document/node guard is not a lock-order guarantee. `lockNoteParents()` is the shared boundary for the writer, committed-state capture and reindexing. Audit heads remain last.

Trash fences affected writers, locks the subtree under `withVaultLock()`, and captures its durable binary/text state as a protected `trash` revision before marking nodes deleted. It therefore may lock `note_docs` on a live node. Pending updates cannot resurrect it: the writer checks `deleted_at` under its parent lock, the gateway closes sessions after COMMIT, and authentication/load refuse trashed nodes. Purge closes the already-trashed documents and deletes children in FK-safe order under the vault mutex. `withVaultLock()` refuses a pre-existing child transaction, making a reversed entry order a named error rather than a deadlock. `lock-order.integration` runs eight real workers for thirty seconds and compares the InnoDB deadlock counter as well as transport outcomes.

`BEFORE UPDATE` and `BEFORE DELETE` triggers on `audit_events` raise `SIGNAL SQLSTATE '45000'`; `iridium_app` holds INSERT and SELECT only (A8). The action vocabulary is closed and lives in `@iridium/contracts/audit.ts` (enumerated in `03-data-model.md` §C.9). Operator commands: `iridium audit verify-chain [--chain]` and `iridium audit export --vault --from --to --format jsonl|csv`. Retention (`AUDIT_RETENTION_DAYS`, default 400) is implemented as export-then-archive into `audit_events_archive` (identical DDL, triggers, and grants) by `iridium audit archive` running under the migrator role — **no stored procedure**. Vault managers can see administrative actions taken inside their own vault. The high-volume `access_log` is separate, partitioned monthly by `RANGE COLUMNS(occurred_at)`, carries `note_ids JSON`, `bytes_out`, and client name and version, and is retained 90 days by dropping partitions.

**Alternatives considered.**

| Alternative | Why rejected |
|---|---|
| Per-row `prev_hash` computed without a lock | Forks the chain under concurrent writers; verification then cannot distinguish a fork from tampering. The head row plus `FOR UPDATE` serialises only audit writes, and Iridium's mutation rate is low enough that this is not a bottleneck. |
| Asynchronous audit writes (queue, then persist) | An audit row can be lost while the mutation it describes is committed — the one failure mode an audit log must not have. Same-transaction writing means the mutation rolls back if the audit write fails. |
| One global chain | Every vault mutation would contend on a single head row and every export would carry every vault's history; per-vault chains keep contention and disclosure scoped. |
| A stored procedure for archiving | Introduces DEFINER semantics and `log_bin_trust_function_creators` questions in restore, for logic a CLI command expresses more testably. |
| Application-enforced immutability only | The `iridium_app` role would still technically be able to UPDATE; the triggers plus the grant make "the application physically cannot alter history" a statement a test can prove (A8's `db-grants.integration`). |
| Auditing every read into `audit_events` | Read volume would swamp the chain and slow every mutation behind it; reads go to the partitioned `access_log` (digest §11.26's split, adopted). |
| Free-form action strings | Unqueryable and untestable; a closed vocabulary in `@iridium/contracts/audit.ts` means a typo is a compile error. |

**Consequences.** Positive: every audited event is atomic with the change it describes, so there are no orphan rows in either direction; tampering is detectable per chain and verification is a CLI command a customer can run; the lock order is written down, so deadlocks are a design question answered once rather than an intermittent production incident; the audit and access logs have independent retention and volume profiles. Negative: audit writes serialise per chain, so a bulk operation inside one vault (an import commit) is bounded by that chain's head lock — which is why the import commit writes one summary event with the report hash rather than one event per note; `AUDIT_HMAC_KEY` becomes restore-critical and versioned (A47 verifies key versions and A57 lists `iridium keys rotate audit`); a chain that is legitimately truncated (archive) must record the boundary so verification can start from it.

**Verification.** `audit.chain.integration` (a chain verifies after thousands of concurrent mutations with no forks; an out-of-band row edit — performed as the migrator role — makes `verify-chain` fail at the exact row; the append adds under 5 ms to a mutating transaction); `db-grants.integration` (A8: `iridium_app` cannot UPDATE or DELETE `audit_events`, and the trigger fires); `lock-order.integration` (concurrent structural, trash, and persistence operations produce no deadlock over 200 randomised interleavings); `audit.trash-race.chaos` (a crash between COMMIT and the gateway side-effect leaves no loaded trashed document after restart); `audit.archive.integration` (export-then-archive preserves verifiability across the boundary); `audit.vocabulary.unit` (every emitted action is in the closed set); `access-log.integration` (partition creation ahead of time and retention drop).

**References.** Digest §6.2 (audit schema conventions, append-only privileges, HMAC chaining), §11.26; spec §8; plan-enterprise graft; judges 1, 2, 3; gap fixes (lock order, trash race). Implemented in `03-data-model.md` (§C.9), `04-auth-and-access-control.md`, `11-operations-and-deployment.md`.

### A47 — Backup and restore: dump plus attachments plus an encrypted secrets bundle plus a manifest, with binlog PITR and a blocking `restore --verify`

**Status.** Accepted (2026-09-11). **ADR file.** `docs/adr/0047-backup-restore.md`.

**Context.** Spec §8 requires backing up the database and attachments together with a documented, **tested** recovery procedure, and states that a Markdown export is not a complete backup of accounts, permissions, revisions, attachments, and collaboration state. Spec §9's "Backup recovery" row requires that a clean deployment can restore content, attachments, permissions, and revision history from the documented backup set. The plan adds a requirement the spec implies but does not state: a restore that produces an unauthenticatable or internally inconsistent system must **fail**, not appear to succeed. Three secrets make that non-obvious — the password pepper (A29), the audit HMAC key (A46), and `MCP_CURSOR_KEY` (A35) — because restoring a database without them yields a system where every password is invalid and the audit chain cannot be verified. A trigger detail matters too: `mysqldump` of triggers carries DEFINER clauses, which cause failures or privilege surprises on a fresh instance.

**Decision.** `iridium backup --out <dir>` produces four artifacts:

1. `mysqldump --single-transaction --hex-blob --routines --events --skip-triggers --set-gtid-purged=OFF` run as `iridium_backup` (MySQL Shell `util.dumpInstance` and Percona XtraBackup 9.7 are documented alternatives). **Triggers are deliberately excluded** and re-created by `iridium migrate` during restore, so no DEFINER or `log_bin_trust_function_creators` issue can arise.
2. An attachment-store snapshot (`rsync -a` or bucket replication) started **after** the dump — safe because attachments are content-addressed and immutable (A44), so a later snapshot is always a superset.
3. A secrets bundle encrypted with an operator passphrase (`age`, pinned at M0): password pepper(s), audit HMAC key(s), `MCP_CURSOR_KEY`, attachment key(s), and all key versions.
4. `manifest.json`: server version, schema head, dump SHA-256, attachment count and bytes, audit chain heads, note count and maximum `head_seq`, and key versions.

Binary logs are retained 7 days for point-in-time recovery.

`iridium restore --from <dir> --verify` on a clean deployment: create the database and roles → load the dump → restore attachments → install secrets (**key versions must match the manifest**) → `iridium migrate` (which re-applies triggers and grants and forward-migrates) → then **blocking verification**:

- verify the audit chain for every chain;
- sample-load `note_docs` into throwaway `Y.Doc`s and compare `toString()` hashes against `note_projections.content_hash`;
- confirm every `attachments.storage_key` exists with a matching SHA-256;
- assert the collaboration invariants `head_seq == GREATEST(snapshot_through_seq, COALESCE(MAX(note_updates.seq), 0))` and `snapshot_through_seq <= head_seq` for every note (a violation **fails the restore**; `iridium doctor --repair-heads` is an explicit, audited repair);
- assert `projected_seq == head_seq` for unloaded notes, otherwise run `reindex --stale`;
- compare membership and role counts against the manifest.

Success writes an `admin.backup.verified` audit event and sets the `iridium_backup_last_verified_timestamp` metric. A nightly CI job, `ops.backup-restore.drill`, runs exactly these scripts. The Markdown export is documented as portability, never as backup.

**Alternatives considered.**

| Alternative | Why rejected |
|---|---|
| Dump plus attachments plus manifest only (plan-risk-first) | A restore would come up with unverifiable audit chains and, without the pepper, no user could log in — a backup that cannot authenticate anyone is not a backup. |
| Including secrets in plaintext beside the dump | The backup set becomes a single-file compromise of every credential; the operator passphrase is the minimum separation (digest §6.2: keys kept separate, envelope encryption). |
| Dumping triggers with `mysqldump` | DEFINER clauses break or mis-privilege on a fresh instance; `iridium migrate` owns triggers and grants (A7), so restore re-applies them from migrations. |
| Snapshotting attachments **before** the dump | A file uploaded between the snapshot and the dump would be referenced but missing; content addressing makes the after-order strictly safe. |
| Non-blocking (advisory) verification | An operator would discover the corruption during an incident; blocking verification turns a silent bad restore into a loud failed restore. |
| Automatic `repair-heads` during restore | Silently rewriting durability metadata hides data loss; the repair exists but is explicit and audited. |
| Markdown export as the backup story | Spec §8 rejects it outright; it carries no accounts, permissions, revisions, or collaboration state. |
| XtraBackup as the default | Excellent and documented as an alternative, but it requires a matching server version and filesystem access; `mysqldump` is the lowest-common-denominator path every operator can run. |

**Consequences.** Positive: a restore either produces a fully verified system or fails loudly; the nightly drill means the documented procedure is executed continuously rather than trusted; key versions in the manifest make a pepper or audit-key mismatch a startup-time failure rather than a silent authentication outage. Negative: `--verify` makes restore slower than a plain dump load (deliberate; the sampling rate for the Y.Doc check is configurable); the secrets bundle adds an operator passphrase to the runbook, which must itself be stored somewhere safe (documented in `11-operations-and-deployment.md`); binlog retention adds disk usage that `my.cnf`'s `binlog_expire_logs_seconds=604800` bounds (A9).

**Verification.** `ops.backup-restore.drill` (nightly: back up a populated deployment, restore onto a clean one, run every verification, assert `admin.backup.verified`); `ops.restore-verify.chaos` (each of the blocking invariants and its negative on the same restored deployment: a wrong pepper or audit key version fails the restore, an injected `head_seq` inconsistency fails it and `--repair-heads` fixes it with an audit event, and a deleted blob fails verification); `backup.attachment-superset.integration` (a file uploaded between dump and snapshot is present and referenced); the "Backup recovery" acceptance row is exactly this drill.

**References.** Digest §6.2 (OWASP secrets management, envelope encryption), §5.2 (MySQL dump and XtraBackup facts), §10.2 (enterprise expectations); spec §8, §9; plan-enterprise graft; gap fixes (secrets bundle, trigger exclusion, blocking verification). A59 adds `manifest.mysql_line` and the `restore.mysql_line_downgrade` refusal to the backup set's integrity contract, and names Percona XtraBackup **matched to the server's line** (8.4 or 9.7) as the physical alternative; `mysqldump` remains the shipped path on both. **G4, answered on 2026-09-12** (volume and database encryption only), confirms that the secrets bundle carries no attachment key family: the three secrets this ADR names — the password pepper, the audit HMAC key and `MCP_CURSOR_KEY` — remain the whole of it, and AG1 introduces no fourth, because OAuth credentials are opaque rows rather than signed tokens. Implemented in `11-operations-and-deployment.md` and `03-data-model.md`.

### A48 — Deployment topology: one server container, MySQL, an attachment volume, behind Caddy; hardened production compose; an air-gapped in-process TLS profile

**Status.** Accepted (2026-09-11). **ADR file.** `docs/adr/0048-deployment-topology.md`.

**Context.** Spec §8 requires a repeatable server deployment with database migrations, health checks, and operational logging, states that infrastructure can initially be one application deployment plus MySQL plus persistent attachment storage, and requires that MySQL and writable server storage are never exposed to clients; horizontal scaling is explicitly not an MVP requirement. Digest §6.2 records the prevailing pattern: TLS terminated at a reverse proxy with the Node application on loopback, nginx needing `proxy_http_version 1.1` plus `Upgrade`/`Connection` headers for WebSockets and raised read/idle timeouts for long-lived sockets, and Caddy providing automatic ACME certificates with transparent WebSocket proxying. Digest §3.2 adds an MCP-specific requirement no plan had tested: requests carry `MCP-Protocol-Version`, `Mcp-Method`, and `Mcp-Name` headers, and digest §3.4 warns that these "must pass any WAF or gateway in front of /mcp" — a silently stripped header degrades or breaks the primary feature. Digest §9.2 notes that `turbo prune --docker` previously dropped unknown `pnpm-lock.yaml` settings (issue #12442, fixed), which is why the Docker build installs with `--frozen-lockfile` from the pruned lockfile.

**Decision.** `infra/compose.yaml` for development: `mysql:9.7.2-oraclelinux9` with the baked `my.cnf` and `init/01_roles.sql` (A8, A9), port bound to `127.0.0.1`, plus profiles `s3` (SeaweedFS on a pinned numeric tag) and `full` (the server with Compose Watch).

`infra/compose.prod.yaml` for production: Caddy 2 (pinned tag) with automatic ACME or provided certificates, `reverse_proxy` with WebSocket passthrough, a `/collab` idle timeout of at least 120 s, and `/mcp` with `flush_interval -1`; the server image `ghcr.io/<org>/iridium-server:<version>` running non-root with `read_only: true` rootfs plus `tmpfs /tmp`, `cap_drop: [ALL]`, `no-new-privileges`, resource limits, secrets supplied as files through `*_FILE` variables, volumes `attachments-data`, `staging-data`, `exports-data`, `updates-data`, `depends_on mysql: service_healthy`, and a `HEALTHCHECK` on `/healthz`. An nginx equivalent is documented (`proxy_http_version 1.1`, `Upgrade`/`Connection`, `proxy_buffering off`, `proxy_read_timeout 3600`). **Both proxy configurations forward `Mcp-Method`, `Mcp-Name`, and `MCP-Protocol-Version`, and a nightly test through the proxied stack asserts it.** Node binds `127.0.0.1:4000` with `TRUST_PROXY` set to the proxy CIDR only. The air-gapped profile uses Fastify `https: {key, cert}` (HTTP/1.1) with no proxy. A systemd unit is documented for non-container deployments. The Dockerfile is multi-stage on `node:24.21.0-bookworm-slim` using `turbo prune --docker`, `pnpm install --frozen-lockfile` from the pruned lockfile (verified in CI), `pnpm deploy --prod`, `@node-rs/argon2` prebuilt binaries only, and an SBOM produced by syft with grype scanning (both pinned at M0).

**Alternatives considered.**

| Alternative | Why rejected |
|---|---|
| Kubernetes manifests as the primary deployment | Spec §8 asks for one deployment plus MySQL plus storage; A23's in-process `AuthzBus` and A17's single collaboration process make multi-replica incorrect today. Compose plus a documented systemd unit is honest about that, and F9 records the interfaces that a multi-process topology would swap. |
| Node terminating TLS in production | Loses ACME automation, HTTP/2 for static assets, and operator-familiar access logging; kept only for the air-gapped profile where no proxy is permitted. |
| Exposing MySQL on a host port by default | Spec §8 forbids exposing the database to clients; development binds to `127.0.0.1` and production exposes nothing. |
| A writable container filesystem | `read_only: true` plus explicit volumes makes every writable path deliberate (attachments, staging, exports, updates) and prevents an attacker from persisting anywhere else. |
| Secrets as environment variables | Digest §6.2 discourages it (readable by all processes, leaks into logs and dumps); `*_FILE` reads mounted files and the environment holds only the paths. |
| A public update service for desktop releases | A48 serves `/desktop/updates/<channel>/` from the same server (A53), so no third party is in the update path. |
| Trusting all proxies (`trustProxy: true`) | Lets a client spoof `X-Forwarded-For` and defeat IP-based rate limits (A29, A.1); the CIDR list is explicit. |

**Consequences.** Positive: a clean virtual machine plus `compose.prod.yaml` plus secrets produces a working deployment, and a nightly CI job proves it; the MCP header passthrough test converts a silent, hard-to-diagnose failure mode into a build failure; the hardened container settings are enumerated once and reviewed once. Negative: single-node is a real limitation for availability, and the plan says so rather than implying otherwise; `IRIDIUM_MIGRATE_ON_BOOT` must be turned off for any future multi-instance rollout (A7 documents it); the air-gapped TLS profile is a second serving path that needs its own test lane.

**Verification.** `ops.compose-prod.clean-vm` (nightly: boot `compose.prod.yaml` on a clean machine, reach `/readyz`, log in, edit a note, call `/mcp`); `proxied-stack.headers.mcp` (nightly, through both Caddy and nginx: `Mcp-Method`, `Mcp-Name` and `MCP-Protocol-Version` arrive intact, an absent `Mcp-Method` arrives absent rather than present-and-empty, and a `/collab` connection survives beyond the idle timeout under both proxies); `docker-image` (the image builds from the pruned lockfile with `--frozen-lockfile`, boots as a non-root user with `read_only: true`, writes only to the declared volumes, and answers `/readyz`) together with `supply-chain.sbom` (syft SBOM and grype policy scan on the pushed digest); `ops.trust-proxy.integration` (a spoofed `X-Forwarded-For` from an untrusted source does not change the rate-limit key); the air-gapped in-process TLS profile is exercised as a second mode of `ops.compose-prod.clean-vm`, which boots it without a proxy and drives REST, `/collab` and `/mcp` over Fastify's own `https` listener.

**References.** Digest §6.2 (reverse-proxy pattern, secrets management, `trustProxy`), §3.2 and §3.4 (MCP headers, buffering), §5.2, §9.2 (`turbo prune --docker` lockfile issue); spec §8; plan-risk-first and plan-enterprise grafts; gap fix (header passthrough test). Implemented in `11-operations-and-deployment.md`.

### A49 — Logging, metrics, and health: pino JSON with redaction, prom-client, liveness plus fail-closed readiness, alert rules

**Status.** Accepted (2026-09-11). **ADR file.** `docs/adr/0049-observability.md`.

**Context.** Spec §8 requires operational logging that excludes credentials and unnecessary document content, plus health checks. Digest §6.2 records the OWASP logging requirements (when, where, who, what on every event; always log authentication successes and failures, authorization failures, session events, and administrative actions; never log session ids, tokens, passwords, keys, or connection strings; add tamper detection and copy logs to read-only storage) and confirms pino 10.3.1's `redact` supports paths such as `req.headers.authorization` and `req.headers.cookie`. The readiness question is the sharp one: a process that accepts traffic while migrations are pending, or while `innodb_flush_log_at_trx_commit` is not 1, will violate the durability contract of A19 while reporting healthy.

**Decision.** pino 10.3.1 with `redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]', '*.password', '*.token', '*.secret', '*.markdown', '*.update']`, request ids (honouring `X-Request-Id` behind the proxy), principal **ids only** (never names or emails in log bodies), and named SIEM events: `auth.login.*`, `authz.denied`, `collab.connection.*`, `collab.write.rejected`, `persist.failed|recovered`, `projection.timeout`, `mcp.call`, `job.*`, `backup.*`, `migration.*`. Hocuspocus runs with `quiet: true`. A `logging-redaction.integration` greps captured log output for fixture markers (a known password, a known token, a known note body) and fails if any appears.

`/healthz` reports process liveness and event-loop lag under 1 s. `/readyz` returns a JSON checklist and **fails closed**: both pools ping; `migrations: current` (a pending migration is a hard failure); `innodb_flush_log_at_trx_commit == 1` (a hard failure when `READYZ_STRICT_DURABILITY=true`, otherwise a warning); the attachment store is writable; the writer backlog age is under 30 s with no writer `failed` for more than 60 s (A21); the loaded-document budget is under 100 % (warning at 80 %, A50); the worker pool is responsive; clock skew is under 30 s. During shutdown drain it returns 503.

`/metrics` (guarded by a `METRICS_TOKEN` bearer or an internal CIDR; `@prometheus-io/client` 0.16.1 — `prom-client` is deprecated in favour of it and every mention of that name in this decision means the successor, spike S8, 2026-09-13) exposes `iridium_http_requests_total{route,status}`, `iridium_http_duration_seconds`, `iridium_ws_connections`, `iridium_docs_loaded`, `iridium_persist_latency_seconds`, `iridium_persist_failures_total`, `iridium_persist_queue_depth`, `iridium_persist_backlog_age_seconds`, `iridium_compactions_total`, `iridium_note_state_bytes`, `iridium_projection_duration_seconds{status}`, `iridium_projection_timeouts_total`, `iridium_mcp_calls_total{tool,status}`, `iridium_mcp_factory_errors_total`, `iridium_mcp_rate_limited_total`, `iridium_tokens_active`, `iridium_jobs_total{type,status}`, `iridium_backup_last_verified_timestamp`, `iridium_audit_chain_verified_timestamp`, `iridium_login_failures_total`, and `iridium_db_pool_in_use{pool}`. A Grafana dashboard JSON and alert rules live in `infra/monitoring/`: persist failures above zero for 5 minutes, backlog age over 30 s, a snapshot over 8 MB, a projection timeout rate over 1 %, `/readyz` failing, a backup verified more than 26 hours ago, and a loaded-document budget over 80 %. `@fastify/under-pressure` provides load shedding.

**Alternatives considered.**

| Alternative | Why rejected |
|---|---|
| Unstructured or text logs | Not machine-parseable for SIEM ingestion, and redaction cannot be asserted mechanically. |
| Logging note content or update payloads for debugging | Spec §8 excludes unnecessary document content; the `*.markdown` and `*.update` redaction paths plus the grep test make it structurally hard to add by accident. |
| Advisory-only readiness (always 200) | A pod or container would take traffic with pending migrations or with `innodb_flush_log_at_trx_commit != 1`, breaking A19's durability guarantee while reporting healthy. |
| OpenTelemetry tracing in the MVP | Valuable, but it adds a collector to a single-node deployment; request ids plus the named events cover the operator's diagnostic need, and the logging shape is OTel-compatible later. |
| Unauthenticated `/metrics` | Exposes operational detail (document counts, token counts, failure rates) to anyone who can reach the port. |
| Logging user names and email addresses | Increases the personal-data footprint of logs for no diagnostic gain; ids resolve through the database when needed. |

**Consequences.** Positive: one operator checklist (`/readyz`) answers "is this instance safe to serve?" including the durability setting; redaction is tested rather than reviewed; every alert rule corresponds to a metric that already exists. Negative: fail-closed readiness means a mis-set `innodb_flush_log_at_trx_commit` blocks startup in strict mode — intended, and the reason the flag exists for operators who consciously accept the risk; `/metrics` needs a token or network policy, which is one more deployment setting; the redaction path list must be extended whenever a new secret-bearing field name appears (covered by the grep test).

**Verification.** `logging-redaction.integration` (A51: it boots with a pino destination captured in memory, exercises login, token use, a collaboration session, an import and an error path, then scans every line for the `irid_[a-z]{3}_` credential regex, `Bearer `, `Cookie`/`Set-Cookie`, the fixture note's unique marker and a base64 prefix of a known Yjs update — it needs a live database and socket, so it is an integration test rather than a guard); `readyz.integration` (each checklist item can be individually failed and produces a 503 with the failing key; strict durability behaviour both ways); `healthz.integration` (event-loop lag threshold); `metrics.integration` (every named metric is present after exercising its code path; the guard rejects an unauthenticated scrape); `ops.alerts.unit` (each alert rule's expression evaluates against a recorded metric fixture); shutdown drain test (503 during drain, in-flight requests complete within the 20 s budget of A.1).

**References.** Digest §6.2 (OWASP logging, pino redaction), §5.2 (`@fastify/under-pressure`), §10.2; spec §8; plan-risk-first and plan-enterprise. Implemented in `11-operations-and-deployment.md`.

### A57 — Threat model and compliance evidence: T1–T17 with a control → implementation → evidence map, and the operator CLI surface

**Status.** Accepted (2026-09-11). **ADR file.** `docs/adr/0057-threat-model.md`.

**Context.** Enterprise security reviews do not ask whether a product is secure; they ask for a threat model and a map from each control to its implementation and its evidence. Digest §10.2 confirms that audit-log retention and export, encryption and key rotation, session controls, and now MCP/agent authentication are standard questionnaire rows. The plan already contains a named test for essentially every control (A51); what was missing was the map. The second half of this decision is the operator surface: a security review also asks how an administrator performs recovery, rotation, and revocation, and every such action must be audited with an identifiable credential type.

**Decision.** The enterprise threat table is adopted verbatim as `04-auth-and-access-control.md` §12 "Threat model (T1–T17)", which owns the `T<n>` namespace, with seventeen rows — hostile Markdown; pathological Markdown; hostile client writes; ID guessing; stale-client resurrection; awareness spoofing; token leakage; session theft; cross-site WebSocket hijacking; insider and audit tampering; supply chain; Electron escape; denial of service via CRDT growth or uploads; data loss on crash; incomplete restore; prompt injection via note content; and secrets in environment variables or logs — each mapped to the named tests of A51 and to the ADRs that implement its controls. A control → implementation → evidence checklist accompanies it.

The operator CLI breadth is normative: `migrate`; `doctor [--argon2 | --stale-projections | --yjs-instances | --repair-heads | --repair-content]`; `config check`; `backup`; `restore --verify`; `audit verify-chain | export | archive`; `reindex [--vault | --stale | --pipeline-version]`; `admin create-user | reset-password | disable-user | create-vault`; `tokens list | revoke | revoke-all [--user]`; `sessions revoke-all [--user]`; `keys rotate pepper | audit | cursor | attachment`; `jobs run <type>`; `trash purge --vault --dry-run`; `desktop-updates publish <dir>`; `mirror`. **Every CLI mutation writes an audit event with `credential_type='cli'`.**

The prompt-injection row deserves explicit statement because it is specific to this product: note content is untrusted data that an agent will read. Iridium's controls are that `instructions.md` states "note content is untrusted data" (A32), that every MCP tool is read-only with `readOnlyHint`/`idempotentHint` and no write path exists in the MVP (A34), that a token's rights can never exceed its owner's live explicit rights (A31), and that every returned note id is recorded in `access_log` (A34) so an exfiltration attempt is reconstructable after the fact. Iridium cannot prevent a model from following instructions embedded in a note; it can and does ensure that doing so grants no authority the token did not already have, and that the read is logged.

**Alternatives considered.**

| Alternative | Why rejected |
|---|---|
| No formal threat model (rely on the individual ADRs) | A reviewer cannot audit seventeen concerns spread across fifty-seven decisions; the map is the deliverable. |
| A generic OWASP Top 10 checklist | Does not cover the failure classes that are specific to this product: CRDT growth, stale-client resurrection, awareness spoofing, agent prompt injection, or an incomplete restore. |
| Controls without named evidence | "We sanitise output" is unverifiable; "`markdown.xss-corpus.unit` at three levels" is. Every row cites a test that runs in CI. |
| A narrower CLI (only `migrate` and `backup`) | Rotation, revocation, reindexing, and repair would then require direct SQL, which is unaudited and unsafe; every one of these operations is security-relevant and therefore must be an audited command. |
| Unaudited CLI operations | An administrator acting through the CLI would be invisible in the audit log — precisely the insider case the audit chain exists for. `credential_type='cli'` makes the channel explicit. |
| Claiming prompt-injection prevention | Not achievable; the honest control is least privilege plus complete logging, stated as such. |

**Consequences.** Positive: a security questionnaire can be answered by citing rows rather than writing prose; every control has a test that fails if the control regresses; the CLI is a complete, audited operator surface, so no routine recovery action requires raw SQL. Negative: the table must be maintained as decisions change (a new ADR that touches a control updates its row — enforced by the review checklist in `10-testing-and-quality.md`); the CLI is a substantial surface with its own authorization and audit obligations (it runs with database credentials, so `11-operations-and-deployment.md` documents who may execute it and where).

**Verification.** Each threat row cites its own tests; collectively: `markdown.xss-corpus.unit` and `markdown.pathological.unit` (T1, T2); `authz.rest-viewer.integration`, `collab.viewer-enforcement.integration`, `collab.limits.integration` (T3, T13); `authz.vault-isolation.integration` (T4); `tree.structural-concurrency.integration` and `tree.stale-resurrection.integration` (T5); `collab.awareness-identity.integration` (T6); `tokens.*` and `logging-redaction.integration` (T7, T17); `auth.sessions-web.integration` and `desktop.preload-surface.guard` (T8); `security.ws-origin.integration` (T9); `audit.chain.integration` and `db-grants.integration` (T10); the `static` job's license-scan step (`scripts/check-licenses.ts`), `pnpm audit`, and the `supply-chain.sbom` grype scan (T11); `desktop.fuses.guard`, `desktop.hardening.e2e`, `ipc.origin.guard`, `desktop.web-preferences.guard` (T12); `attachments.security.integration` (T13); `collab.durable-ack.chaos` (T14); `ops.backup-restore.drill` and `restore.*` (T15); `mcp.*` plus `access-log.integration` (T16). A `cli.audit-coverage.integration` test asserts that every CLI mutation command writes an audit event with `credential_type='cli'`.

**References.** Digest §6.2, §10.2 (enterprise readiness and questionnaire expectations), §3.4 (untrusted note content for agents), §9.2 (supply-chain controls); spec §4, §8, §9; plan-enterprise graft; judges 1, 3. Implemented in `04-auth-and-access-control.md` §12 (the threat table itself), `11-operations-and-deployment.md` (the compliance checklist `docs/compliance-checklist.md` and the operator CLI), `10-testing-and-quality.md` (the named evidence) and `14-risks-and-open-questions.md`.

---

## Area 9 — Owner answers to the open questions (2026-09-12)

The project owner answered all eight questions of `14-risks-and-open-questions.md` §G on 2026-09-12. Four answers confirmed the default the ADR already carried and produced no new ADR — G2 (A43), G4 (A44, A47), G5 (A39) and G7 (A36), each recorded in that ADR's **Status** and **References** lines. Four changed a settled decision: G1 and G6 produced the two `AG` ADRs below, G3 produced A59, and G8 amended A53 in place under an inline supersession marker rather than producing an ADR of its own, because it changes one clause of one decision and invents no new mechanism. The three ADRs here are ordered by the question that produced them.

### AG1 — Iridium ships its own OAuth 2.1 authorization server, on a second MCP mount

**Status.** Accepted (2026-09-12). Supersedes A33 in full; narrows the Context and one rejected alternative of A36. **ADR file.** `docs/adr/0060-oauth-authorization-server.md`.

**Context.** A33 refused to advertise any OAuth discovery because a verified client defect turns advertised discovery into a broken login for a statically configured client (F-10: Claude Code issue #59467 starts the OAuth flow *before* it sends the POST that would have carried the configured `Authorization` header, and has no logic to skip OAuth when the header is already set; F-11: the same class covers claude-code #33817 and #38972, Cursor's discovery probe ordering and VS Code before 1.124.0). The cost of that refusal was that claude.ai and Claude Desktop custom connectors — which offer OAuth or a header beta available only to a limited set of organizations, and which expose no per-user static bearer field (F-13, F-14) — could reach Iridium only through the `iridium-mcp` bridge. On 2026-09-12 the owner answered G1 **yes**: the connectors must work natively at MVP. Personal access tokens must keep working for Claude Code, the IDEs, the Messages API, scripts and the bridge **at the same time**, so the coexistence problem A33 identified has to be solved rather than avoided.

Three facts settle how. Discovery is a property of a **URL**, not of a request: a client probes the well-known paths derived from the endpoint URL before it ever sends a credential (F-10), so no header sniff, `User-Agent` heuristic or per-request negotiation can serve both audiences from one endpoint. A protected resource **MUST** publish RFC 9728 metadata with at least one `authorization_servers` entry (F-2), so the "PRM without `authorization_servers`" middle path is no longer conformant. And a client that finds no `resource_metadata` on the challenge **MUST** fall back to constructing the well-known URIs itself, first the path form and then the root form (F-3), so a document at the root is found by every client whatever endpoint it was configured with. The recommended server-side resolution, verbatim, is *"Pick one credential per route and make the server advertise only that one"* and *"Separate routes rather than attempting conditional discovery on a single endpoint"* (F-12). The specification also fixes the surrounding obligations: the AS **MUST** implement OAuth 2.1 and **SHOULD** support Client ID Metadata Documents, with RFC 7591 dynamic registration retained but deprecated (F-5); clients **MUST** send the RFC 8707 `resource` parameter on both the authorization and token requests and servers **MUST** validate that a token was issued for them (F-6); `iss` **SHOULD** be returned on authorization responses including errors, with `authorization_response_iss_parameter_supported: true` advertised (F-7); a `scope` **SHOULD** accompany the `401` challenge and insufficient scope at runtime is a `403` (F-8); and a protected resource **SHOULD NOT** advertise `offline_access` (F-9). Finally, `@modelcontextprotocol/fastify` 2.0.0 ships only `createMcpFastifyApp` and `hostHeaderValidation` — no metadata router, no bearer gate — and the v1 authorization-server helpers are frozen and deprecated with the instruction to use a dedicated identity provider (F-18), so a Fastify application serves these documents from its own routes.

**Decision.** Iridium mounts the identical MCP surface twice — one handler, one `buildIridiumMcpServer` factory, one `ContentReadCore`, one set of tools, cursors, rate limits, `access_log` rows and `authorize()` calls — and gives each mount exactly one credential kind and exactly one discovery posture.

| | `/mcp` — the integration-token endpoint | `/mcp/connect` — the connector endpoint |
|---|---|---|
| Accepted credential | `Authorization: Bearer irid_pat_…` **only** | `Authorization: Bearer irid_oat_…` **only** |
| Audience | Claude Code, Cursor, VS Code, Windsurf, the Messages API connector, `curl`, CI jobs, the `iridium-mcp` bridge, `mcp-remote` with a header | claude.ai and Claude Desktop custom connectors, Claude Code `claude mcp login`, VS Code `oauth`, Cursor `auth`, `mcp-remote --protocol auto` |
| `401` carries `resource_metadata` | no | yes, plus `scope` |
| PRM document | none — `/.well-known/oauth-protected-resource/mcp` returns `404` | `/.well-known/oauth-protected-resource/mcp/connect` returns `200` |
| RFC 8707 canonical URI | n/a — a PAT carries no audience | `<PUBLIC_ORIGIN>/mcp/connect` |

Four well-known paths are **registered routes** that return a genuine `404` with an empty body and no `WWW-Authenticate`, so the route-policy boot assertion sees them and the contract test is asserting a decision rather than an accident: `/.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-protected-resource` (F-3's two fallback steps), and `/.well-known/oauth-authorization-server` and `/.well-known/openid-configuration` (the root RFC 8414 and OIDC forms Claude Code probes next). The root AS-metadata paths can only stay `404` if the issuer carries a path component, so the issuer is `<PUBLIC_ORIGIN>/oauth` and never the bare origin, and neither the issuer nor the canonical resource URI is configurable — both are derived from `PUBLIC_ORIGIN`, so no environment variable can disagree with the served metadata.

The authorization server offers `authorization_code` and `refresh_token` and nothing else; PKCE `S256` is required on every authorization request with no exemption for confidential clients and `plain` refused; the AS metadata document is served byte-identically at `/.well-known/oauth-authorization-server/oauth`, `/.well-known/openid-configuration/oauth` and `/oauth/.well-known/openid-configuration` (F-4's three priorities) and is an OAuth 2.0 Authorization Server Metadata document, not an OpenID Provider configuration. Both served documents are parsed in `oauth.metadata.contract` against the zod schemas exported by `@modelcontextprotocol/core` 2.0.0, so a hand-written field list cannot drift from the specification. There is no `/oauth/introspect`, no `/oauth/userinfo` and no `jwks_uri`.

**Access tokens are opaque `irid_oat_…` rows, not JWTs, and that is the decisive choice.** A self-contained token cannot be revoked before it expires, which contradicts the plan's central guarantee that revocation is a next-call property (A23; `04-auth-and-access-control.md` §7.1 rejects JWTs for sessions on exactly this ground). Opaque rows in `access_tokens` with `kind='oauth'` give one verification path for every credential in the system, immediate revocation with no new mechanism, no signing key to rotate, no `jwks_uri`, no key-distribution story in the backup set, and audience validation by column comparison rather than claim parsing. The specification constrains the token **format** not at all — only that the resource server validate the audience (F-6), which a co-located authorization server and resource server do by reading the row they both wrote. The three new kinds join the one credential format of A31: `oac` (authorization code, 60 s, single use), `oat` (access token, `oauth_policy.accessTokenTtlMinutes`, default 60 minutes) and `ort` (refresh token, sliding 30 days within an absolute 90, rotated on every use with family revocation and an `oauth.refresh.reuse_detected` audit event on reuse).

**Consent is a server-rendered page**, `GET /oauth/consent` from `apps/server/src/oauth/consent-page.ts`, and this is a deliberate, recorded deviation from the one-UI-codebase principle: the page must work before any application bundle has loaded and without the SPA router, it must carry no application JavaScript at all under the nonce CSP, the `request_id` must never enter client state or a history entry the SPA manages, and it is an OAuth browser surface quoted in `service_documentation` rather than part of the workspace. It shares `packages/ui`'s CSS custom properties through the static `/app/assets/tokens.css` so it does not look foreign, and it contains no `<script>` element whatsoever. It shows the escaped, 120-character-truncated client name; one of exactly three identity lines (CIMD publishes its identity at the `client_id` URL; a dynamically registered client carries the ⚠ "Iridium cannot verify who operates it" line; a manually registered client names the administrator and date); the **origin** of the redirect URI and never its full path; the six Read permissions in the same `packages/ui/src/i18n/en.ts` strings the PAT dialog uses, so the two descriptions of one permission cannot diverge; the vault picker the PAT dialog offers, with the "All vaults" radio replaced by the administrator warning and refused with `all_vaults_admin_forbidden`; the sentence "This access refreshes automatically until you revoke it in Settings › Integrations", because an OAuth grant is standing where a PAT expires; and a step-up password field when the session is older than `session_policy.stepUpMinutes`. `logo_uri` is stored but **never rendered** — fetching a remote image there would be an SSRF and tracking vector for a self-registered client. The page is `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY` and `frame-ancestors 'none'`; the single-use, session-bound, ten-minute `request_id` **is** the consent POST's CSRF defence, and that route is a named member of the closed exemption set `authz.route-policy.boot` enumerates.

An OAuth principal is the **same `TokenPrincipal`** a PAT produces, with `tokenKind`, `clientId`, `consentId` and `resource` added, and `authorize()` does not change by one line or one branch — `oauth.principal-parity.prop` is the proof obligation, and if that property ever needs a branch in `authorize()` to hold, the design is wrong. `MCP_OAUTH_ENABLED` survives only as an unmount switch for `/mcp/connect`, never as a choice between the two audiences.

This ADR is implemented by `D06-26` … `D06-36` in `06-mcp-and-agent-access.md` (the two mounts and their one-credential-kind rule, the path-carrying issuer and the four registered `404`s, opaque access tokens, refresh rotation with family-wide reuse revocation, the consent screen and the vault selection made on it, the closed CSRF-exemption set, dynamic registration and its bounds, the unrendered `logo_uri`, the loopback redirect rule, and the transport-level `403`) and by `D04-30` … `D04-32` in `04-auth-and-access-control.md` (the two verifier instances over one verification path, the principal's four new fields with `authorize()` untouched, and the closed CSRF-exemption enumeration).

**Alternatives considered.**

| Alternative | Why rejected |
|---|---|
| One endpoint, discovery advertised conditionally on the presence of an `Authorization` header | F-10: Claude Code probes the well-known URLs *before* sending the request that would carry the header, so there is no request to condition on. It also cannot work for the root-path probe, which is not tied to any endpoint. |
| One endpoint, discovery advertised conditionally on `User-Agent` or `Mcp-Method` | A behaviour that varies by client identity is untestable against clients that have not shipped yet, and `clientInfo` is untrusted display text everywhere else in this plan (D06-23). |
| A deployment-wide switch (`MCP_OAUTH_ENABLED` selecting one posture) | Forces a site to choose between Claude Code and the connectors, which is exactly what the owner's answer forbids: both must work at the same time. The flag is kept, but as an unmount switch for sites that want no OAuth surface at all, not as an either/or. |
| A separate hostname (`connect.iridium.example`) | A second certificate, a second DNS record and a second `PUBLIC_HOST` value for a split a path already expresses. |
| Advertising a PRM without `authorization_servers` (the digest's Topic 6 middle path) | F-2 makes `authorization_servers` mandatory, and F-3's fallback means the document is found and followed regardless. It was the right answer only while no authorization server existed. |
| Self-contained JWT access tokens | Cannot be revoked before expiry, which contradicts A23's next-call revocation guarantee; adds a signing key, a `jwks_uri`, a rotation obligation and a restore-critical key family for no gain, since the authorization server and the resource server are the same process. |
| An off-the-shelf OAuth server library or a dedicated identity provider | F-18's own advice, but it would put a second identity system in a single-container product whose accounts, sessions, step-up and revocation bus already exist; the deprecated v1 SDK helpers are unusable and `@modelcontextprotocol/fastify` carries none. No new OAuth server dependency is added to the workspace. |
| A `@iridium/ui` route for the consent screen | It must render before any bundle loads, under a nonce CSP with no application JavaScript, and must keep `request_id` out of SPA state and history. The deviation is recorded here rather than hidden. |
| Dynamic client registration off by default | claude.ai performs automatic DCR (F-13), so a default of `false` would make "the connectors work out of the box" untrue for any client that does not publish a Client ID Metadata Document. It defaults to **true**, bounded by a per-IP rate limit, an unused-client ceiling, a seven-day sweep, an unverified marking that follows the client everywhere, and an administrator kill switch that also removes `registration_endpoint` from the metadata. |

**Consequences.** Positive: claude.ai and Claude Desktop connectors work natively, which is what the owner asked for; static-header clients are provably unaffected, because the endpoint they are configured against advertises nothing and answers `404` from all four probe paths; one verification path, one principal shape and one `authorize()` serve both credential kinds, so every existing isolation, revocation and rate-limit property extends to OAuth without a second implementation; revocation stays a next-call property for connectors exactly as for tokens; and "the credential a route accepts is exactly the one its discovery posture advertises" is a property a boot assertion checks rather than a convention.

Negative: a site publishes two URLs and a user can paste the wrong one — mitigated by error text on both endpoints naming the other URL, by generating the correct URL in every snippet, and by `iridium doctor --oauth`; a valid PAT is refused at `/mcp/connect` on purpose; the consent screen is the one server-rendered HTML surface in the product; the M3 surface grows by five tables, ten routes and a sweep job; and a cloud connector still requires a publicly reachable HTTPS origin, which is a fact about connectors originating from Anthropic's servers rather than anything Iridium controls — an intranet-only or air-gapped site still uses the bridge (A36).

**Threat coverage.** Redirect-URI manipulation and open redirection: exact-match validation against a registered set with no wildcards, prefix or substring matching, `client_id` and `redirect_uri` validated **before** any redirect is possible so an invalid value renders an error page, the login bounce's `return_to` validated to be a same-origin `/oauth/authorize` path, and the destination origin shown on the consent screen (`oauth.redirect-uri.unit`, `oauth.authorization-code.integration`). Authorization-code interception: PKCE `S256` with no `plain` and no exemption, a 60-second single-use code locked `FOR UPDATE` at exchange and bound to `client_id`, `redirect_uri`, `resource` and the authorizing `session_id`, and a replayed code revoking every token minted from it with an `oauth.code.replayed` audit event (`oauth.pkce.unit`, `oauth.authorization-code.integration`). Confused deputy: the RFC 8707 `resource` parameter required on both requests, compared against `access_tokens.resource` at verification, with Iridium never forwarding a received token and never accepting one it did not issue (`oauth.audience.contract`, `mcp.verifier.dispatch.unit`). Client impersonation: a CIMD `client_id` is a URL whose document must name itself, a dynamically registered client is marked unverified on the consent screen, in the token list and in the admin console, and `logo_uri` is never rendered (`oauth.cimd.unit`, `oauth.consent-page.integration`). SSRF through the CIMD fetch: HTTPS only, a resolved-address allowlist that refuses loopback, link-local, RFC 1918, RFC 6598, unique-local, multicast and the cloud metadata addresses, a socket pinned to the checked address so a rebinding second lookup cannot move it, at most one redirect, and 32 KiB / 5 s caps (`oauth.cimd.unit`). Token replay: opaque 256-bit secrets over HTTPS, SHA-256 at rest with `timingSafeEqual`, one-hour access tokens, refresh rotation with family revocation on reuse, and the published scanner regex extended to `oat`, `ort` and `oac` (`oauth.refresh-rotation.integration`, `tokens.format.unit`, `logging-redaction.integration`). Open-registration abuse: the rate limit, the unused-client ceiling, the sweep, `application_type` required, no secret issued to a public client, and the kill switch (`oauth.dcr.integration`). Consent phishing and clickjacking: `frame-ancestors 'none'`, step-up re-authentication, the destination origin, the ⚠ line and `Referrer-Policy: no-referrer` (`oauth.consent-page.integration`, `oauth.consent.integration`). Discovery hijack of static-header clients: the two-mount split and the four 404s (`oauth.discovery-split.contract`, the nightly `mcp-clients` matrix). Audit flooding from a broken connector: `oauth.authorize.denied` bounded to one row per `(client_id, reason)` per ten minutes, while `oauth.refresh.reuse_detected` and `oauth.code.replayed` are never bounded (`audit.bounded-failures.integration`). The threat model gains rows **T18–T20**. No new secret is introduced, so the encrypted secrets bundle, `iridium keys rotate|promote|status` and `restore --verify` are unchanged.

**Verification.** M3: `oauth.discovery-split.contract`, `oauth.metadata.contract`, `oauth.audience.contract`, `oauth.insufficient-scope.contract`, `oauth.authorization-code.integration`, `oauth.token-endpoint.integration`, `oauth.refresh-rotation.integration`, `oauth.revoke-endpoint.integration`, `oauth.consent.integration`, `oauth.consent-page.integration`, `oauth.dcr.integration`, `oauth.sweep.integration`, `oauth.cimd.unit`, `oauth.pkce.unit`, `oauth.redirect-uri.unit`, `oauth.scope-mapping.unit`, `oauth.principal-parity.prop`, `oauth.revocation.mcp`, and spike **S15** (`docs/spikes/S15-oauth-connector-flow.md`), which drives a real claude.ai and a real Claude Desktop custom connector by hand once, records which registration mechanism each uses, confirms that no request to any of the four 404 paths returns anything but `404`, and re-runs the static-header matrix against `/mcp` with both products still configured. M4: `authorized-apps.component`, `oauth.connector.e2e`. M7: `admin.oauth-clients.integration`, `admin.oauth-consents.integration`, `oauth-client-list.component`. Standing: the nightly `mcp-clients` job, whose three halves are the static-header audience against `/mcp`, the OAuth audience against `/mcp/connect`, and both configured at once against one server.

**References.** Owner's answer to open question G1, 2026-09-12 ("Yes."); MCP specification 2026-07-28, `basic/authorization` and `basic/authorization/authorization-server-discovery` (F-1 … F-9); github.com/anthropics/claude-code/issues/59467 and #33817, #38972, and zuplo.com/learn/mcp/errors/configured-headers-ignored-when-oauth-discovery-present (F-10, F-11, F-12); digest §3.1, §3.2, §6.1, §6.2, §10.2, §11.5 (F-13 … F-20). Supersedes A33; narrows A36. Builds on A23 (live revocation), A30 (`authorize()`), A31 (credential format), A32 (transport) and A26 (sessions and step-up). Implemented in `06-mcp-and-agent-access.md`, `04-auth-and-access-control.md`, `03-data-model.md`, `09-api-reference.md`, `07-client-applications.md`, `10-testing-and-quality.md`, `11-operations-and-deployment.md` and `12-milestones.md`.

### A59 — MySQL 8.4 LTS and 9.7 LTS as equal required targets

**Status.** Accepted (2026-09-12). **ADR file.** `docs/adr/0059-mysql-dual-lts.md`. **Supersedes.** A9 in full; the MySQL lane assignment of A52.

**Context.** The project owner made MySQL 8 a requirement on 2026-09-12 while asking that modern MySQL stay supported. A9 had made 9.7 primary and 8.4 an advisory nightly lane. MySQL 8.0 reached end of life on 2026-04-30 (last release 8.0.46); 8.4 LTS is supported to 2029-04-30 (extended 2032-04-30) and 9.7 LTS to ~2034-04-21; 9.0–9.6 and the 26.x line are innovation releases with roughly three months of support each; upgrades hop LTS to LTS (digest §5.2, §9.2, §10.2, §11.8).

**Assumption.** "MySQL 8" is read as **8.4 LTS**, because 8.0 is end of life and 8.4 is the only supported 8.x line. If 8.0 was meant literally, the floor drops below `CREATE TRIGGER IF NOT EXISTS` (8.0.29+), `my.cnf` needs a per-line variant, and the product would ship onto an unpatched engine — that returns to the owner as a question rather than being decided here.

**Decision.** Two required targets, no primary. `mysql:8.4.11` is the compatibility floor and the image every unset selector resolves to (`IRIDIUM_MYSQL_IMAGE`, `MYSQL_TAG`); `mysql:9.7.2-oraclelinux9` is the reference production image in `compose.prod.yaml` and `docs/ops/deployment.md`. 8.0, 9.0–9.6 and 26.x are refused at boot (`config.mysql_unsupported`, exit `2`; `IRIDIUM_ALLOW_UNTESTED_MYSQL` downgrades the refusal to a permanent `/readyz` `mysql_version: warn`). Every statement the product executes must have identical semantics on both, with the floor at 8.4.11 and no use of a construct 8.4 deprecates — which retires the "8.0.13-compatible" subset, since `migrate ensure-guards` already needs 8.0.29+. `ci.yml`'s `integration` and `chaos-core` jobs become two-entry matrices, all four checks required on `main` from M0, and the nightly `mysql-84` job is deleted. `manifest.json` records `mysql_line` and a restore never crosses an LTS line downwards. The rule is held by `db.dialect-floor.guard`, the `db.version-floor.boot` refusal, the matrices and `migrations.parity.integration`.

**Alternatives considered.**

| Alternative | Why rejected |
|---|---|
| Keep 9.7 primary with a merge-blocking 8.4 lane | A declared primary makes the other engine the one nobody develops against; the defect then arrives as a red required check rather than as a failing local test. Making the floor the default an unset selector resolves to costs nothing and moves detection into the development loop. |
| 8.4 only | Discards the owner's "support modern" and forces every site through an 8.4 → 9.7 hop inside the product's life. |
| MySQL 8.0 as the floor | End of life 2026-04-30; no security patches; below `CREATE TRIGGER IF NOT EXISTS`. |
| Certify innovation releases too | ~3 months of support each; `mysql:latest` is that line, which is why it is never used. A non-blocking nightly `mysql-innovation` lane gives early warning without a support claim. |
| Ship both 8.4 and 9.7 client tools in the runtime image | Two dump paths, and the less-exercised one fails in a drill. One 9.7.2 client, proven against both servers. |
| Allow a cross-line restore downgrade behind a flag | A 9.7 dump loaded into 8.4 produces a database that loads and is wrong. The pre-upgrade backup was taken on the older line and restores onto it cleanly, so the override would only make the wrong thing possible. |

**Consequences.** Positive: two supported engines with one tested schema; a portability defect fails in the development loop; the produced schema is compared between engines rather than each statement merely compiled; a cross-line restore downgrade becomes impossible rather than merely discouraged; sites that standardise on 8.4 (and their DBAs) are served without a second product. Negative: runner-minutes for `integration` and `chaos-core` double (wall-clock does not — matrix entries run in parallel); the `VALUES(col)` upsert form must be rewritten to the row alias; branch protection carries four database checks instead of two; and every future SQL construct must be checked against the floor, which is what the guard's denylist exists to make cheap.

**Verification.** M0: `db.dialect-floor.guard`, `migrations.parity.integration`, `db.version-floor.integration` and `migrations.integration` green on both matrix entries; `ops.mysql-config.spec` boots the shipped `my.cnf` on both and asserts equal resolved variables. M1: `db.auth-plugin.integration` and `db-grants.integration` (including the `MYSQLDUMP_ARGV`-against-both-servers assertion) on both. M8: `ops.cross-line-restore.drill`, the `restore.mysql_line_downgrade` case of `ops.restore-verify.chaos`, and `ops.compose-prod.clean-vm` once per line.

**References.** Digest §5.2, §9.2, §10.2, §11.8; owner's answer to open question G3 (2026-09-12); MySQL 8.0 reference manual for `CREATE TRIGGER IF NOT EXISTS` (8.0.29+) and for the deprecation of the `VALUES()` function. Implemented in `03-data-model.md`, `10-testing-and-quality.md`, `11-operations-and-deployment.md` and `12-milestones.md`.

### AG6 — Supported clients at 1.0: the desktop application; the web host is a development and internal surface

**Status.** Accepted (2026-09-12). Supersedes the supported-browsers clause of A55 and the cross-browser smoke lane of A52. **ADR file.** `docs/adr/0061-supported-clients.md`.

**Context.** A55 committed to "current Chrome and Edge (Chromium-class); Firefox and WebKit get nightly smoke tests only and are best-effort", with open question G6 as the lever to upgrade that. On 2026-09-12 the project owner answered G6 with "We can ignore browser for now — the primary MVP is desktop." That answer is broader than the question: it does not choose browsers, it re-prioritises the product. The brief's item 2 still requires both a web UI and an Electron desktop app from **one** shared UI codebase, and the browser host is how that codebase is developed and how the component and web end-to-end suites run, so the answer cannot be implemented by deleting `apps/web`.

**Decision.** The desktop application is Iridium's supported client at 1.0. The web host remains — built, served at `/app/*`, hardened under the nonce CSP, and covered by a merge-blocking `chromium` end-to-end lane and the Vitest Browser Mode component project — as a development and internal surface with no support commitment at 1.0; it runs in current Chrome and Edge. Firefox and WebKit are out of scope entirely: the `firefox-smoke` and `webkit-smoke` Playwright projects and the `nightly.yml › browser-smoke` job are removed, and their absence is asserted by `guards.non-goals.guard` (case *Cross-browser support*, non-goal id `cross-browser-support`). Where a spec §9 acceptance row is proven in both hosts, the Electron proof gates 1.0 and the browser proof is a development signal: `docs/acceptance-map.json` carries `gating: true` on that layer, rule 7 of `guards.acceptance-map.guard` requires the gating test to be selected by a merge-blocking lane, the Electron specs that discharge a row carry `@smoke`, and Concurrent editing, Viewer enforcement and Live revocation retire at M5 rather than M4. The single UI codebase, the `IridiumHost` seam, the three host implementations, `apps/web`'s place in the server image, every web-specific security control and the milestone order (M4 before M5) are unchanged.

**Assumption recorded with the decision.** The owner's answer named a priority, not a matrix. The plan reads it as a change of commitment rather than a deletion, for the two reasons above. If the owner meant that `apps/web` should not ship at all, that is a larger change and returns as a question.

**Alternatives considered.**

| Alternative | Why rejected |
|---|---|
| Delete `apps/web` and the browser host | Contradicts brief item 2, removes the surface the component and web E2E suites run on, and would require re-building a browser host to develop the UI at all. It would also make the `IridiumHost` seam untestable against two real implementations, which is the mechanism that keeps one codebase honest. |
| Keep the Firefox and WebKit nightly smoke lanes as "free information" | A nightly lane nobody is accountable for is an implicit support claim and a source of failures that are triaged into silence. Out of scope means no lane, and the non-goal guard makes that checkable. |
| Keep retiring rows on the M4 browser proof and treat the desktop specs as renditions | Would let 1.0 be declared on evidence from a host the project does not support. The desktop host is also the one holding the session credential, so viewer enforcement, revocation and durability are exactly what has to be proven there. |
| Reorder the milestones so the desktop shell comes first | The shell mounts the shared UI bundle; there is nothing to wrap before M4 exists. Priority is not build order. |
| Demote the web `chromium` lane to nightly since the host is unsupported | It is how the shared UI is tested; demoting it would slow every UI regression's discovery to a day and would rot the very codebase the desktop client ships. |

**Consequences.** Positive: the project's support claim is now true and testable; the acceptance rows are gated on the client people actually run; two CI lanes and a tag's second meaning disappear; the deployment documentation can answer "what do I install?" in one sentence. Negative: the merge-blocking `e2e-electron` job grows, because acceptance specs that used to be nightly now run on three operating systems per pull request — the answer to a critical-path problem is sharding the `electron` project, never demoting a gating proof; three spec §9 rows now retire one milestone later, which makes M4's exit record shorter and M5's longer; and the web host now ships with no support commitment, which must be stated plainly to operators rather than left to inference (`11-operations-and-deployment.md`, "Supported clients").

**Verification.** `guards.non-goals.guard` (case *Cross-browser support*: exactly three Playwright projects, no Firefox/WebKit selector anywhere, no `browser-smoke` job, no `@smoke` tag under `apps/e2e/web/`); `guards.acceptance-map.guard` rule 7 (every gating proof selected by a merge-blocking lane); `desktop.three-instances.e2e`, `desktop.viewer-readonly.e2e`, `desktop.revocation-while-open.e2e`, `desktop.durable-save.e2e`, `desktop.hostile-markdown.e2e`, `desktop.open-note.e2e` (the gating proofs); `desktop.a11y-keyboard-only.e2e` (the accessibility commitment in the supported client); `ui.unsupported-browser.component` (the feature-floor page's copy); `host.contract.component`, `host.contract.e2e` and `desktop.host-contract.e2e` (unchanged — the one-codebase requirement is still proven in both hosts).

**References.** Owner answer to open question G6, 2026-09-12; brief item 2; A55, A52, A53, A40; spec §10 (mobile clients). Implemented in `01-vision-scope-and-principles.md` §4.6, `07-client-applications.md` §9.3, `10-testing-and-quality.md`, `11-operations-and-deployment.md`, `12-milestones.md`.

---

## Index of decisions

Every row of the skeleton decision table has exactly one ADR above, and Area 9 adds the three ADRs the owner's answers of 2026-09-12 produced (AG1, A59, AG6), which the index carries after `A.1`. This index is the lookup other sections cite: the id is stable, the title is the ADR heading (shortened), and the last column names the plan section(s) that implement the decision. A superseded entry is never removed: its row either names the ADR that replaced it or, where an owner answer changed the decision, states the position in force and names the question, so a reader who arrives with a stale citation lands on the current answer. Ordered by id, with the Area 9 ids last.

| Id | Title | Area | Implemented in |
|---|---|---|---|
| A1 | Monorepo toolchain: pnpm + Turborepo, TypeScript 7 native, oxlint/oxfmt, tsdown, Vite 8 | 1 | `02-system-architecture.md`, `10-testing-and-quality.md` |
| A2 | Mutation-testing lane isolated with its own TypeScript 6 alias | 1 | `10-testing-and-quality.md` |
| A3 | Contracts-first code generation with CI drift checks | 1 | `09-api-reference.md`, `10-testing-and-quality.md` |
| A4 | Node.js 24 LTS as the single runtime | 1 | `02-system-architecture.md`, `11-operations-and-deployment.md` |
| A5 | Fastify 5 as the single HTTP host for REST, `/collab`, and `/mcp` | 2 | `02-system-architecture.md`, `09-api-reference.md` |
| A6 | zod 4 everywhere; OpenAPI 3.1 generated, committed, linted, fuzzed | 2 | `09-api-reference.md`, `10-testing-and-quality.md` |
| A7 | Kysely + kysely-ctl + kysely-codegen; forward-only migrations; fail-closed readiness | 2 | `03-data-model.md`, `11-operations-and-deployment.md` |
| A8 | Least-privilege MySQL roles: `iridium_app`, `iridium_migrator`, `iridium_backup` | 2 | `03-data-model.md`, `11-operations-and-deployment.md` |
| A9 | MySQL 9.7 LTS primary, 8.4 LTS certified; baked `my.cnf` — **superseded by A59** | 2 | `03-data-model.md`, `11-operations-and-deployment.md` |
| A10 | mysql2 with two Kysely instances: `dbApp` and `dbPersist` | 2 | `02-system-architecture.md`, `03-data-model.md` |
| A11 | Entity IDs: UUIDv7 in `BINARY(16)`, canonical strings on every wire | 2 | `03-data-model.md`, `09-api-reference.md` |
| A12 | Tree model: adjacency list, real root row, derived paths, per-vault mutex | 2 | `03-data-model.md`, `09-api-reference.md` |
| A13 | Optimistic concurrency: `version` CAS and `If-Match` on REST | 2 | `03-data-model.md`, `09-api-reference.md` |
| A14 | Yjs v13 stable set, one module instance, one first-party import point | 3 | `02-system-architecture.md`, `05-collaboration-and-durability.md` |
| A15 | Yjs state storage: V2 compacted snapshot plus V1 append log | 3 | `03-data-model.md` (§C.5), `05-collaboration-and-durability.md` |
| A16 | Per-update append log, compaction in the per-note FIFO, separate checkpoints | 3 | `05-collaboration-and-durability.md`, `03-data-model.md` (§C.5) |
| A17 | Hocuspocus 4.7.0 embedded as the `Hocuspocus` class inside Fastify | 3 | `05-collaboration-and-durability.md`, `02-system-architecture.md` |
| A18 | Vault realtime channel `vault:<vaultId>`, never persisted | 3 | `05-collaboration-and-durability.md`, `07-client-applications.md` |
| A19 | The "Saved" acknowledgement protocol | 3 | `05-collaboration-and-durability.md`, `09-api-reference.md` (§D.2), `07-client-applications.md` |
| A20 | Role change on a live connection: `readOnly` flip, client re-attach on upgrade | 3 | `05-collaboration-and-durability.md`, `07-client-applications.md` |
| A21 | Per-document persistence serialisation and backpressure: `NoteWriter` | 3 | `05-collaboration-and-durability.md` |
| A22 | Hostile CRDT content detection at compaction, flag, and repair CLI | 3 | `05-collaboration-and-durability.md`, `11-operations-and-deployment.md` |
| A23 | Live revocation: version columns, `AuthzBus`, `CollabGateway`, epoch tuple, no caches | 4 | `04-auth-and-access-control.md`, `05-collaboration-and-durability.md` |
| A24 | Collaboration tickets: single-use 60 s, batch issuance, sized limits | 4 | `04-auth-and-access-control.md`, `05-collaboration-and-durability.md`, `09-api-reference.md` |
| A25 | Awareness and presence: per-message identity validation, server-authoritative participants | 4 | `05-collaboration-and-durability.md`, `07-client-applications.md` |
| A26 | Session model: one `sessions` table, two delivery channels, main-only desktop custody | 4 | `04-auth-and-access-control.md`, `07-client-applications.md` |
| A27 | CSRF: custom header plus Fetch Metadata plus `SameSite=Lax` | 4 | `04-auth-and-access-control.md`, `09-api-reference.md` |
| A28 | Initial credential delivery and password reset: one-time set-password links | 4 | `04-auth-and-access-control.md`, `09-api-reference.md`, `11-operations-and-deployment.md` |
| A29 | Password hashing and login hardening: argon2id, versioned pepper, DB-backed throttling | 4 | `04-auth-and-access-control.md`, `11-operations-and-deployment.md` |
| A30 | Permission matrix and `authorize()`: one matrix, one function, 404 for non-members | 4 | `04-auth-and-access-control.md`, `06-mcp-and-agent-access.md`, `09-api-reference.md` |
| A31 | PAT / integration token model: format, hashing, scopes, expiry, rotation, access log | 4 | `04-auth-and-access-control.md`, `06-mcp-and-agent-access.md`, `09-api-reference.md` |
| A32 | MCP transport: SDK v2, per-request factory, stateless dual-era, JSON, `reply.hijack()` | 5 | `06-mcp-and-agent-access.md`, `09-api-reference.md` (§D.3) |
| A33 | MCP authentication: two mounts, one credential kind each; discovery on `/mcp/connect` only (superseded A33's no-PRM posture, G1) | 5 | `06-mcp-and-agent-access.md`, `04-auth-and-access-control.md` |
| A34 | MCP tools and resources: six read-only tools, note template, per-vault index | 5 | `06-mcp-and-agent-access.md`, `09-api-reference.md` (§D.3) |
| A35 | MCP pagination cursors: HMAC-signed, token- and filter-bound | 5 | `06-mcp-and-agent-access.md`, `09-api-reference.md` |
| A36 | stdio bridge: first-party transparent proxy `iridium-mcp` | 5 | `06-mcp-and-agent-access.md`, `11-operations-and-deployment.md` |
| A37 | One read model for humans and agents: `ContentReadCore` | 5 | `06-mcp-and-agent-access.md`, `08-markdown-pipeline-import-export.md`, `09-api-reference.md` |
| A38 | Projection freshness and the search contract | 5 | `08-markdown-pipeline-import-export.md`, `05-collaboration-and-durability.md`, `09-api-reference.md` |
| A39 | Search: InnoDB FULLTEXT over a narrow projection behind `SearchIndex` | 6 | `03-data-model.md`, `08-markdown-pipeline-import-export.md` |
| A40 | UI framework and state: React 19.3, TanStack Router/Query, Zustand, Base UI, Tailwind 4 | 7 | `07-client-applications.md` |
| A41 | Editor stack: CodeMirror 6 with y-codemirror.next, disposable views | 7 | `07-client-applications.md`, `05-collaboration-and-durability.md` |
| A42 | Markdown pipeline: shared token-to-mdast parser, sanitize-last hast, workers | 6 | `08-markdown-pipeline-import-export.md`, `07-client-applications.md` |
| A43 | Obsidian syntax in the MVP: detect, report, index; render post-MVP | 6 | `08-markdown-pipeline-import-export.md`, `07-client-applications.md` |
| A44 | Attachments: content-addressed, driver interface, id-served, explicit deletion | 6 | `08-markdown-pipeline-import-export.md`, `07-client-applications.md`, `09-api-reference.md` |
| A45 | Import and export: two-phase import job, streaming export with manifest | 6 | `08-markdown-pipeline-import-export.md`, `09-api-reference.md` |
| A46 | Audit log: same-transaction HMAC chain, locked heads, triggers, closed vocabulary | 8 | `03-data-model.md` (§C.9), `04-auth-and-access-control.md`, `11-operations-and-deployment.md` |
| A47 | Backup and restore: dump, attachments, secrets bundle, manifest, blocking verify | 8 | `11-operations-and-deployment.md`, `03-data-model.md` |
| A48 | Deployment topology: server container, MySQL, attachment volume, Caddy, air-gapped profile | 8 | `11-operations-and-deployment.md` |
| A49 | Logging, metrics, health: pino redaction, prom-client, fail-closed `/readyz` | 8 | `11-operations-and-deployment.md` |
| A50 | Loaded-document admission control: explicit budget, no eviction | 3 | `05-collaboration-and-durability.md`, `11-operations-and-deployment.md` |
| A51 | Testing harnesses: one runner per layer, real infrastructure, `@iridium/testkit` | 1 | `10-testing-and-quality.md` |
| A52 | CI: `ci.yml` / `nightly.yml` / `release.yml`, pinned actions, license scan | 1 | `10-testing-and-quality.md`, `11-operations-and-deployment.md` |
| A53 | Electron shell: Electron 44.3.0, three plain configs, electron-builder 26, full hardening; 1.0 distribution is unsigned bundles (G8) | 7 | `07-client-applications.md`, `09-api-reference.md` (§D.4), `11-operations-and-deployment.md` |
| A54 | Client/server compatibility: `apiVersion`, `minClientVersion`, additive-only, N-1 | 1 | `09-api-reference.md`, `07-client-applications.md`, `12-milestones.md` |
| A55 | Accessibility, internationalisation, and browser support — the browser-support clause **superseded by AG6** | 7 | `07-client-applications.md`, `10-testing-and-quality.md` |
| A56 | Milestone ordering: risk-first with enterprise foundations in M0/M1 | 1 | `12-milestones.md` |
| A57 | Threat model and compliance evidence: T1–T17 and the operator CLI surface | 8 | `04-auth-and-access-control.md` §12, `11-operations-and-deployment.md`, `10-testing-and-quality.md`, `14-risks-and-open-questions.md` |
| A.1 | Single limits policy | 3 | `05-collaboration-and-durability.md`, `08-markdown-pipeline-import-export.md`, `09-api-reference.md`, `11-operations-and-deployment.md` |
| AG1 | Iridium ships its own OAuth 2.1 authorization server, on a second MCP mount | 9 | `06-mcp-and-agent-access.md`, `04-auth-and-access-control.md`, `03-data-model.md`, `09-api-reference.md`, `07-client-applications.md`, `10-testing-and-quality.md`, `11-operations-and-deployment.md`, `12-milestones.md` |
| A59 | MySQL 8.4 LTS and 9.7 LTS as equal required targets | 9 | `03-data-model.md`, `10-testing-and-quality.md`, `11-operations-and-deployment.md`, `12-milestones.md` |
| AG6 | Supported clients at 1.0: desktop supported, web host a development and internal surface, Firefox/WebKit out of scope | 9 | `01-vision-scope-and-principles.md`, `07-client-applications.md`, `10-testing-and-quality.md`, `11-operations-and-deployment.md`, `12-milestones.md` |

### Decisions settled by the owner's answers of 2026-09-12

These ADRs were accepted with a stated default; where the question has since been answered the row records the answer and the ADR's own text carries the supersession. All eight questions of `14-risks-and-open-questions.md` §G were answered on 2026-09-12, so no decision in this log depends on an open question any more; the table is kept because it is the shortest path from a question to the ADRs its answer moved. Four answers confirmed the default, and their ADRs are unchanged apart from a **Status** line recording the confirmation.

| Question | ADRs affected | Answer of 2026-09-12, and where the consequence lives |
|---|---|---|
| G1 — native claude.ai / Claude Desktop OAuth connectors at MVP | A33, A36 | **Answered yes, 2026-09-12.** Iridium ships an OAuth 2.1 authorization server in M3; `/mcp/connect` carries discovery, `/mcp` does not. See AG1. |
| G2 — read-only Obsidian-syntax rendering at MVP | A43, A42 | **Answered no, 2026-09-12** — confirms the default. Detection, reporting and `note_links` indexing are the whole of the 1.0 commitment; the renderer seam stays inert, held there by `markdown.flavor-parity.unit`. |
| G3 — MySQL 8.4 LTS as a required target | A9, A52 | **Answered "MySQL 8 is a requirement", 2026-09-12.** Two equal required targets, read as 8.4 LTS and 9.7 LTS (the reading is stated as an assumption). A9 is superseded by A59, which records the answer and the assumption it rests on; A52's `mysql-84` nightly job is deleted and `integration` and `chaos-core` become two-entry matrices. |
| G4 — attachment encryption at rest | A44, A47 | **Answered "volume and database encryption only", 2026-09-12** — confirms the default. The envelope-encryption columns stay reserved, no attachment key family enters the secrets bundle, and the posture is documented for operators. |
| G5 — CJK search at MVP | A39, A9 | **Answered no, 2026-09-12** — confirms the default. The default InnoDB parser with `innodb_ft_min_token_size=2`, no ngram parser and no second index; A59 additionally requires the setting to behave identically on both MySQL lines. |
| G6 — browser support commitment at 1.0 | A55, A52 | **Answered 2026-09-12 → AG6.** Desktop application supported at 1.0; web host a development and internal surface on Chrome and Edge; Firefox and WebKit out of scope |
| G7 — publish `@iridium/mcp-bridge` to npm | A36, A52 | **Answered no, 2026-09-12** — confirms the default: bundled with the desktop application and served from `/desktop/tools/`, never published to the public registry. Note the interaction with G1: the bridge is no longer the required route for Claude Desktop, and its rationale narrows to stdio-only clients, air-gapped and intranet-only sites, and scripted use. |
| G8 — desktop distribution at 1.0 | A53, A52 | **Answered 2026-09-12: unsigned zipped bundles at 1.0** — `zip` (win32, darwin) and `tar.gz` (linux), x64 and arm64, published SHA-256 per artefact, no installer and no in-application updater; signing, installers and updates are post-1.0 epic 14 |

---

## Decisions made in this section

The skeleton settles every technical choice recorded above. Writing the log required a small number of additional conventions that the skeleton does not cover. They are listed here so the finalizer can merge them into the plan's conventions and so `12-milestones.md` can seed them at M0.

| Id | Decision | Rationale |
|---|---|---|
| D13-1 | ADR files live at `docs/adr/NNNN-<slug>.md`, where `NNNN` is the skeleton id zero-padded to four digits (`A7` → `docs/adr/0007-kysely-migrations.md`). The limits policy `A.1` has no number of its own in the skeleton and takes the next free file number, `docs/adr/0058-limits-policy.md`, so no two files collide. The repository seeds all 58 files at M0, each containing the corresponding entry from this section verbatim. | A stable, sortable path per decision means code comments and commit messages can cite `docs/adr/0019-saved-ack-protocol.md` and the reader lands on the exact text. Zero-padded numbering keeps directory order equal to id order. Seeding at M0 (rather than writing ADRs as work proceeds) keeps the repository and the plan identical from the first commit. |
| D13-2 | Status vocabulary for ADRs is exactly `accepted`, `superseded by A<nn>`, `deprecated`. An accepted ADR's **Decision** text is never edited; a change is a new ADR that supersedes it, and the superseded file gains a one-line pointer at the top. Every ADR in this revision is `Accepted (2026-09-11)`. | Editing a decision in place destroys the record of what was actually built and why, which is the only reason the log exists. Supersession keeps the history append-only, matching the audit-log philosophy of A46. |
| D13-3 | The 58 decisions are grouped into the eight areas listed in "Areas" (repository/toolchain/delivery; HTTP and data layer; collaboration and durability; identity and authorization; MCP and agent access; content pipeline, search, attachments, portability; client applications; audit, backup, operations, threat model). Ids are **not** renumbered to match the grouping. | Reading fifty-eight flat entries is not usable; grouping by subsystem matches how an implementer approaches the codebase. Keeping the skeleton ids untouched means every cross-reference from every other section stays valid. |
| D13-4 | Spike documents live at `docs/spikes/S<nn>-<slug>.md`, one per M0/M1 spike, using the id and slug the register in 14-risks-and-open-questions.md assigns, and each must record the outcome **and** whether the ADR's recorded fallback was taken (for example `docs/spikes/S03-electron-ws-origin.md`, `docs/spikes/S01-onloaddocument-v2-apply.md`, `docs/spikes/S05-stryker-vitest5.md`, `docs/spikes/S06-k6-yjs-bundle.md`, `docs/spikes/S02-fastify-websocket-hocuspocus.md`). | Several ADRs (A15, A51, A53, A2) are accepted with an explicit fallback. A spike that does not record which branch was taken leaves the codebase in an undocumented state. |
| D13-5 | Test names follow `<area>.<subject>.<layer>` (for example `authz.vault-isolation.integration`, `collab.durable-ack.chaos`, `markdown.roundtrip.prop`), and the layer segment is never omitted. This log **cites** names, it does not coin them: every name in a Verification field exists in the named test inventory of `10-testing-and-quality.md`, and `scripts/check-test-name-references.ts` fails the `static` job on any `<area>.<subject>.<layer>` token in the plan or under `docs/` that is absent from `docs/acceptance-map.json`, printing the canonical spelling from that section's "Superseded spellings" table. The ADR's *Verification* field stays normative about **what** is proven; `10-testing-and-quality.md` is normative about the file name, the project and the lane. Where the evidence is a CI step rather than a spec file (the license scan, `gen-drift`, Schemathesis, Redocly lint), this log names the step and its script instead. | The verification fields would be worthless without concrete test names, but two sections must not both own the test inventory. Separating "what is proven" from "what the file is called" resolves it — and making the citation mechanically checkable is what stops the two from drifting again. The earlier "names here are proposals" formulation produced exactly that drift: several names in this log existed nowhere else in the plan, two of them shadowing real tests under a third spelling, so a reviewer could not tell whether a Verification line pointed at one test or two. |
| D13-6 | An administrator-forced password reset (A28) revokes sessions but deliberately leaves integration tokens intact; killing an agent's access is the separate, explicit `iridium tokens revoke-all --user`. | A forced reset is usually operational (a forgotten password), not a compromise signal. Silently breaking every agent integration as a side effect would be surprising and would push administrators toward not resetting passwords. When compromise *is* suspected, one extra explicit command is correct. |
| D13-7 | `iridium audit archive` (A46) writes a chain-boundary marker so `verify-chain` can start from the archive boundary and still verify both the archived and live segments; the boundary row's hash is recorded in `audit_events_archive` and in the backup manifest. | Without a recorded boundary, a legitimate archive is indistinguishable from a truncation attack, which would make the first post-retention verification fail and train operators to ignore the check. |
| D13-8 | `iridium restore --verify` (A47) samples `note_docs` for the Y.Doc round-trip check at a configurable rate (`RESTORE_VERIFY_SAMPLE`, default 100 % up to 5 000 notes, then 10 %); the sample rate and the note count checked are recorded in the `admin.backup.verified` audit event. | Loading every note into a throwaway `Y.Doc` is the most expensive verification step. Sampling keeps a large restore tractable while recording exactly how much was proven, so an operator can demand 100 % when it matters. |
| D13-9 | `packages/ui`'s TanStack Router route-tree generation is a step of the root `pnpm gen` (A3), so a route change that is not regenerated fails the `gen-drift` CI job like any other contract change. | Typed routes are a wire contract for deep links (`iridium://open?server=&note=&rev=`) and share URLs; drift in them belongs in the same check as OpenAPI and MCP schema drift rather than in a separate mechanism. |
| D13-10 | The accessibility commitment (A55) is stated as "keyboard-complete, axe-core-checked, high-contrast and reduced-motion aware", explicitly **not** as WCAG 2.2 AA certification. Any certification is an external engagement recorded as a post-MVP item. | A plan must not imply a conformance claim it has not audited. Naming the automated checks and the keyboard guarantee is verifiable and honest, and it is what the questionnaire rows in `11-operations-and-deployment.md` cite. |
| D13-11 | The prompt-injection control statement (A57, T16) is that Iridium cannot prevent a model from following instructions embedded in note text; its controls are least privilege (A31: a token never exceeds its owner's live explicit rights), read-only tools with no MVP write path (A34), the "note content is untrusted data" line in `instructions.md` (A32), and complete `access_log` recording of every returned note id (A34). | Claiming prevention would be false and would discourage the controls that actually bound the damage. Stating the boundary makes the security review productive and tells the implementer which properties are load-bearing. |
| D13-12 | The "Decision-id prefixes" table near the top of this log is the complete registry of per-section decision-id prefixes, including the two that predate the dominant `D<NN>-<n>` form (`ARCH-` in 02, `OPS-` in 11) and the superseded spellings still present in older cross-references (`D3-` for `D03-`, `D-05-` for `D05-`, `TQ-` for `D10-`). A decision id introduced from here on uses `D<NN>-<n>` with a two-digit section number. | This log is the only file that merges all fourteen decision tables, so it is where a reader arrives holding an unfamiliar id. Without a registry there is no derivable rule connecting `ARCH-19` or `OPS-43` to a section, and renumbering the two legacy prefixes would silently break every cross-reference written before it. Recording them as aliases keeps the existing citations resolvable while fixing the rule for new ids. |
| D13-13 | An owner answer that changes a settled decision becomes an ADR in **Area 9**. It takes an `AG<n>` id, numbered after the open question it answers, when it changes several ADRs in part (AG1, AG6), and the next free `A<nn>` when it supersedes one skeleton ADR in full (A59, superseding A9). An `AG<n>` id has no number to derive a file name from, so it takes the next free number under `docs/adr/` in the order the answers are recorded: `docs/adr/0060-oauth-authorization-server.md` for AG1 and `docs/adr/0061-supported-clients.md` for AG6, with `0059-mysql-dual-lts.md` taken by A59 and `0058-limits-policy.md` already held by `A.1` (D13-1). An answer that confirms a default produces no ADR and is recorded in the **Status** and **References** lines of the ADRs it confirms. The G1 change specification called AG1 "ADR-15a" before this convention existed; the spelling is retained here as an alias so a citation written against that specification resolves. | Eight answers landing on one day would collide under any scheme that numbers them in arrival order, and a reader who meets `AG6` can tell instantly which question produced it. Using a plain `A<nn>` for a full replacement keeps the log readable by subsystem: a reader of Area 2 who reaches A9 is told which ADR replaced it, and the replacement is numbered in the same series as the thing it replaces. Recording the "ADR-15a" alias costs one sentence and prevents a dangling citation. |
| D13-14 | The ADR status vocabulary gains a fourth form, `Superseded in part by <id> (<date>)`, which **must** name the clause it covers (A52: the `nightly.yml` cross-browser and MySQL 8.4.11 lanes; A53: the packaging, signing and update clauses; A55: the supported-browsers clause). A partial supersession marks the superseded clause inline in the Decision text under a **Superseded …** marker rather than deleting it, so the text as accepted and the text that replaced it are both readable. A **Status** line may also record that an owner answer *confirmed* a decision, which changes nothing else in the entry. | The answers of 2026-09-12 produced the log's first decisions that are wrong in one clause and right in every other: A52's job list, A53's packaging paragraph and A55's browser sentence. Marking those ADRs `superseded` outright would discard correct, cited decisions; editing the clause silently would destroy the record D13-2 exists to protect. Naming the clause is what makes the status checkable — a reader can see whether the part they are relying on is the superseded one. |
| D13-15 | Where two of the 2026-09-12 answers mint a section-level decision id in the same file, or where a specification's proposed id is already in use, the id moves to the next free number in that section, and the claimant whose id is cited by name in another file's normative text keeps the number it was given. That resolves to: `D07-43`/`D07-44`/`D07-45` and `OPS-60`/`OPS-61` for G8 (both cited in A53 above), `D07-46` and `OPS-64` for G6, `OPS-62`/`OPS-63` and `D10-42` for G3, `D09-29` for G8 (because `D09-28` already exists), and `D12-17` for G6 with `D12-18` for G8 (because `D12-14` already exists). The ids G1 mints — `D04-30` … `D04-32` and `D06-26` … `D06-36` — collide with nothing and stand as specified. | The four change specifications were written independently and each allocated ids from the counts it could see, so three files were handed the same numbers twice and three proposed numbers were already taken. This log is the only file that merges all fourteen decision tables (D13-12), so it is where the collision has to be resolved; resolving it anywhere else would leave two files disagreeing about what `OPS-60` means. Preserving the id that another file's normative text already cites keeps every written cross-reference resolvable, and moving the other claimant costs nothing because no text cites it yet. |

---

## Index of section-level decisions

The ADRs above record the decisions the plan is founded on. While writing the sections, their authors also had to settle 431 narrower questions that the decision skeleton did not reach: a column width, a lock order, a message name, a naming convention. Each is recorded in full, with its rationale, in the "Decisions made in this section" table at the end of the file named below. This index exists so that a decision can be found from its identifier alone, and so that no section-level decision is invisible from here.

Identifier forms differ by section: `D<section>-<n>` in most files, `ARCH-<n>` in `02-system-architecture.md`, `OPS-<n>` in `11-operations-and-deployment.md`, and `TQ-<n>` alongside `D10-<n>` in `10-testing-and-quality.md`. The forms are stable: a decision is never renumbered once it appears in this index. Decision text is abridged here; the owning file carries the full statement and its rationale.

| Id | Recorded in | Decision |
|---|---|---|
| D01-01 | `01-vision-scope-and-principles.md` | Prose vocabulary for note history: "revision" is a number, "checkpoint" is a row, "version" is the user-facing word. Across every section, *revision* means the per-note `seq` of a committed update… |
| D01-02 | `01-vision-scope-and-principles.md` | `Principal` is a closed discriminated union of exactly three kinds — `user`, `token`, `system` — with no anonymous kind. Every route declares the kinds it accepts (`config.auth.principalKinds`); ad… |
| D01-03 | `01-vision-scope-and-principles.md` | Actor attribution for server-originated writes. A content write that a person requested records that person: `note_updates.actor_type = 'user'` with their `actor_id` for… |
| D01-04 | `01-vision-scope-and-principles.md` | `vaults.status = 'deleting'` is reachable only by the aborted-import teardown and the root-row quarantine. The two writers are `POST /imports/:jobId/abort` (and the `transfer_cleanup` job when… |
| D01-05 | `01-vision-scope-and-principles.md` | There is no separate operator persona or role. The operator is the server administrator acting at the host shell through the `iridium` CLI; the CLI grants no capability the admin API lacks, and eve… |
| D01-06 | `01-vision-scope-and-principles.md` | Viewers participate in presence. A viewer's connection keeps awareness enabled, is validated per message like any other, and is listed in `participants` with `role: 'viewer'`. |
| D01-07 | `01-vision-scope-and-principles.md` | 01 owns the `P<n>` and `F<n>` handles. `P1–P8` are the core principles, `P9–P16` the supporting rules, and `F1–F15` the deviations (matching skeleton §F). Other sections cite `F<n>` and the skeleto… |
| D01-08 | `01-vision-scope-and-principles.md` | "MVP" means precisely the release Changesets tags `1.0.0` at the exit of M8, and its three definitions are kept in agreement. The capability list (4.1), the literal first-milestone gate (4.2) and t… |
| D01-09 | `01-vision-scope-and-principles.md` | The vocabulary discipline in 7.7 is binding on prose, UI strings and code comments. The avoided phrasings ("save the note" as a REST operation, "synced" for saved, unqualified "snapshot", "version"… |
| D01-10 | `01-vision-scope-and-principles.md` | The non-goals beyond spec §10 listed at the end of 4.4 are binding, not indicative. Agent write access of any kind, browsers outside current Chrome and Edge, enterprise single sign-on, MCP notifica… |
| D01-11 | `01-vision-scope-and-principles.md` | The tree and login-hardening limits are rows of the single limits policy, with these constant names. `TREE_MAX_DEPTH = 64`, `NODE_NAME_MAX_BYTES = 255` and `VAULT_NAME_MAX_CHARS = 120` are enforced… |
| D01-12 | `01-vision-scope-and-principles.md` | One naming authority for limit constants: the constant column of 02-system-architecture.md's canonical rendering of the limits policy. Every section — this one included — cites those identifiers ve… |
| D01-13 | `01-vision-scope-and-principles.md` | Test names are written in 10-testing-and-quality.md's canonical `<name>.<project>` form everywhere in the plan. The project or lane segment (`.unit`, `.component`, `.integration`, `.prop`, `.chaos…` |
| D01-14 | `01-vision-scope-and-principles.md` | The desktop application is Iridium's supported client at 1.0; the web host is a development and internal surface with no support commitment; Firefox and WebKit are out of scope entirely. §4.6 is th… |
| D01-15 | `01-vision-scope-and-principles.md` | Iridium is source-available under the Elastic License 2.0 (SPDX `Elastic-2.0`), not open source. Personal use and a company's internal commercial use are free and unrestricted, including self-hosting for its own staff on a public address; providing Iridium to third parties as a hosted or managed service is not permitted, whether or not it is charged for. The bar does not expire, which is why the Elastic License was chosen over BSL 1.1 and the FSL, whose grants convert to Apache-2.0. AGPL-3.0 was rejected because it permits competing hosting outright. The `LICENSE` file is the authority; `package.json` and the OpenAPI document's `info.license` carry the SPDX identifier. Dependency licensing is unaffected and stays governed by D10-12/D10-15. |
| ARCH-01 | `02-system-architecture.md` | `buildApp()` modes have fixed semantics: `container` listens on `BIND_ADDRESS:PORT`, drains on SIGTERM/SIGINT, runs the scheduler; `child` listens on an ephemeral port reported on stdout as… |
| ARCH-02 | `02-system-architecture.md` | A single `ReadinessState` (`starting → not_ready ↔ ready`) in `ops/readiness.ts` gates all non-ops routes with 503 `not_ready` + `Retry-After: 5` while migrations are pending, a fail-closed readine… |
| ARCH-03 | `02-system-architecture.md` | Network keys are `BIND_ADDRESS` (default `127.0.0.1`) and `PORT` (4000); the only accepted `Host` is `PUBLIC_HOST`, derived from `PUBLIC_ORIGIN` (no multi-host allowlist), enforced with 421… |
| ARCH-04 | `02-system-architecture.md` | `/metrics` is protected by `METRICS_TOKEN` (bearer) or `METRICS_ALLOW_CIDRS`; `METRICS_ENABLED=true` without either is a configuration error |
| ARCH-05 | `02-system-architecture.md` | Two piscina pools: `projectionPool` (`PROJECTION_WORKERS = max(1, cpus-1)`, 10 s task timeout, terminate + respawn) for `@iridium/markdown` `project()`, and `transferPool` (`TRANSFER_WORKERS = 1`… |
| ARCH-06 | `02-system-architecture.md` | Shutdown sequence: readiness → `not_ready`; `{t:'closing', reason:'shutdown', graceMs: 2000}` to note connections and immediate close of vault connections; close remaining sockets; drain every… |
| ARCH-07 | `02-system-architecture.md` | `GET /` responds 302 to `/app/` |
| ARCH-08 | `02-system-architecture.md` | Configuration is environment-only with the canonical key set in this section (no config file); parsing happens once in `config/env.ts`; `no-process-env` is enforced outside `config/`; `bytes` value… |
| ARCH-09 | `02-system-architecture.md` | Secrets that rotate are keyrings `<NAME>_V<n>` (`AUTH_PASSWORD_PEPPER_V<n>`, `AUDIT_HMAC_KEY_V<n>`, `MCP_CURSOR_KEY_V<n>`, reserved `ATTACHMENT_KEY_V<n>`); the *current* version is recorded in… |
| ARCH-10 | `02-system-architecture.md` | Environment values for editable policy are floors of strictness: `SettingsStore` computes `tighten(envFloor, adminValue)` per field and rejects laxer admin values with 422 `validation_failed`; rete… |
| ARCH-11 | `02-system-architecture.md` | No `AsyncLocalStorage`: request context travels as an explicit `CallContext` (`requestId`, `log`, `principal`, `credential`, `client`, `clock`); read services take a `Principal`, mutating services… |
| ARCH-12 | `02-system-architecture.md` | `ProblemDetails.type` is `urn:iridium:problem:<code>`; `instance` is the request path; `errors[]` accompanies `validation_failed`; `X-Request-Id` is echoed on every response; the code→status table… |
| ARCH-13 | `02-system-architecture.md` | UUIDv7 generator with a per-millisecond monotonic 12-bit counter and Web Crypto randomness in `@iridium/contracts/ids.ts`; id schemas accept mixed case and normalise to lowercase; `db/ids.ts` is th… |
| ARCH-14 | `02-system-architecture.md` | Request ids are UUIDv7; an inbound `X-Request-Id` is honoured only from a `TRUST_PROXY` address and only when it matches `^[A-Za-z0-9._-]{8,128}$`; the id is echoed on the response and stored in au… |
| ARCH-15 | `02-system-architecture.md` | Logging contract: pino fields and the SIEM `event` grammar `<domain>.<object>.<verb>` as tabulated; `disableRequestLogging` with one `http.request` line per response; child loggers per request/conn… |
| ARCH-16 | `02-system-architecture.md` | All limits are constants in `@iridium/contracts/limits.ts`, and the "Constant in `limits.ts`" column of the limits table in this section is the plan's sole naming authority for those identifiers: e… |
| ARCH-17 | `02-system-architecture.md` | `camelCase` on REST, WebSocket stateless and IPC payloads; `snake_case` on MCP tool I/O, resource URIs and cursors; database columns `snake_case`; case translation only in `mcp/tools/*.ts` and the… |
| ARCH-18 | `02-system-architecture.md` | Application-set timestamps rendered as RFC 3339 UTC with millisecond precision; `clock` injected; boot writes `schema_meta.iridium_version`, `api_version`, `min_client_version` |
| ARCH-19 | `02-system-architecture.md` | Every singleton interface (`AuthzBus`, `EpochTable`, `TicketStore`, `ConsentRequestStore`, `RateLimitStore`, `SearchIndex`, `StorageDriver`, `SettingsStore`, `JobScheduler` claim protocol) ships wi… |
| ARCH-20 | `02-system-architecture.md` | `DATABASE_BACKUP_URL` (backup role) exists alongside `DATABASE_URL` (app role) and `DATABASE_MIGRATE_URL` (migrator role); `serve` opens only the app role unless `IRIDIUM_MIGRATE_ON_BOOT=true`; CLI… |
| ARCH-21 | `02-system-architecture.md` | Repo-wide TypeScript strictness adds `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` to the skeleton's `erasableSyntaxOnly`, `verbatimModuleSyntax`, `isolatedDeclarations`, `target es2024` |
| ARCH-22 | `02-system-architecture.md` | CLI exit codes are the single seven-code contract of OPS-16 (11-operations-and-deployment.md), restated here because this section's boot and drain paths use it: `0` success or a verified no-op, `1…` |
| ARCH-23 | `02-system-architecture.md` | One transaction helper, `withTransaction(db, ctx, fn)`, opens every transaction, forbids nesting by type, and returns collected `effects` that run only after COMMIT; no HTTP, `StorageDriver`, worke… |
| ARCH-24 | `02-system-architecture.md` | `withTransaction` retries `ER_LOCK_DEADLOCK` (1213) and `ER_LOCK_WAIT_TIMEOUT` (1205) up to 3 times with 20–200 ms jittered backoff for transactions declared `idempotent: true`; every pooled connec… |
| ARCH-25 | `02-system-architecture.md` | `EnvSchema` reserves the prefixes `IRIDIUM_TEST_*`, `IRIDIUM_PROP_*`, `IRIDIUM_CHAOS_*`, `IRIDIUM_E2E_*`, `IRIDIUM_FIXTURE_*`, `IRIDIUM_COVERAGE_*` and the exact names `IRIDIUM_MYSQL_IMAGE`… |
| ARCH-26 | `02-system-architecture.md` | The `IridiumHost` behavioural contract is runner-agnostic data, not a shared test file: `hostContractCases(): Array<{ name; run(host, assert): Promise<void> }>` is iterated by… |
| ARCH-27 | `02-system-architecture.md` | The documentation surfaces are ordinary Iridium-registered routes, not plugin defaults: `GET /openapi.json` (operationId `meta.openapi`) and `GET /docs` (`meta.docs`) are registered by the `rest` p… |
| ARCH-28 | `02-system-architecture.md` | One redacted-configuration rendering for every surface: each secret prints as `<set: versions v1,v2; sha256:ab12cd34>` (eight hex characters of the SHA-256 of the material), a file-sourced value ad… |
| ARCH-29 | `02-system-architecture.md` | The two hosts of `@iridium/ui` carry different commitments and identical mechanisms: the Electron host is the supported client at 1.0 and the web host is a development and internal surface (01 §4.6… |
| D03-01 | `03-data-model.md` | When `Y.encodeStateVector(doc)` exceeds the declared `VARBINARY(4096)`, the writer stores a zero-length `note_updates.sv_after` / `note_docs.snapshot_sv`. The degradation lives in one named… |
| D03-02 | `03-data-model.md` | Add the grant matrix check to `iridium doctor --db-roles` (the flag name of the CLI inventory in `11-operations-and-deployment.md`), render `docs/ops/db-grants.sql` from the same grant matrix with… |
| D03-03 | `03-data-model.md` | `access_log` partition maintenance (`REORGANIZE`/`DROP PARTITION`) runs under the migrator role on `dbMaint`, the table carries a `p_overflow VALUES LESS THAN (MAXVALUE)` catch-all, and `/readyz` c… |
| D03-04 | `03-data-model.md` | `attachments.path_hint` is `VARCHAR(760)`, not `VARCHAR(1024)` |
| D03-05 | `03-data-model.md` | `audit_events.chain_id` for a vault is `'vault:' + 32 lowercase hex characters` (no hyphens), produced only by `chainIdForVault()` |
| D03-06 | `03-data-model.md` | Job lifecycle: the status transition is the claim (`WHERE id = ? AND status = 'queued'`), `locked_at` heartbeat every 30 s, `JOB_LOCK_TIMEOUT` 15 minutes for reclaiming a stale `running` row… |
| D03-07 | `03-data-model.md` | The audit pre-image is `prev_hash (32 raw bytes) \|\| utf8(canonicalJSON(payload))` where `canonicalJSON` is RFC 8785 (JCS) and `payload` includes the predecessor's `prev_id` but not the row's own `id` |
| D03-08 | `03-data-model.md` | No `ON DELETE CASCADE` anywhere; four explicit hard-delete paths with a fixed statement order (§1.4); attribution columns (`created_by`, `uploaded_by`, `actor_id`, …) and the evidence tables delibe… |
| D03-09 | `03-data-model.md` | `resolvePolicy(key)` merges the `EnvSchema` baseline with the `server_settings` row field by field, taking whichever value is stricter, with the direction (`min`/`max`/logical AND) declared per fie… |
| D03-10 | `03-data-model.md` | Retention constants the skeleton left open: `SESSION_ROW_RETENTION_DAYS` 30 (and consumed/expired setup links after 30 days), `JOB_RETENTION_DAYS` 30, `ACCESS_LOG_PARTITION_LEAD_MONTHS` 3 |
| D03-11 | `03-data-model.md` | The FULLTEXT index on `note_search (title, body_text)` is named `ft_note_search` |
| D03-12 | `03-data-model.md` | `fm_tags` entries longer than 64 characters and `fm_aliases` entries longer than 255 characters are dropped from the projection and reported with the existing `tag_invalid` finding; the raw values… |
| D03-13 | `03-data-model.md` | `note_projections.heading_title` and `note_search.title` hold the first H1 flattened to plain text and truncated to 255 characters at a grapheme-cluster boundary |
| D03-14 | `03-data-model.md` | `notes.last_edited_by`, `last_edited_at`, `size_chars`, `oversize`, `content_invalid`, `last_checkpoint_at` and `updated_at` are written by the compaction transaction in one `UPDATE notes`, never b… |
| D03-15 | `03-data-model.md` | One invariant register (`I-01` … `I-26`) implemented once in `apps/server/src/db/invariants.ts` and consumed by `iridium doctor`, `iridium restore --verify` and the three model property suites |
| D03-16 | `03-data-model.md` | `iridium_app`'s DML is narrowed below `A8`'s blanket "DML on all tables" on four tables — `access_log` `SELECT, INSERT`; `note_updates` no `UPDATE`; `note_revisions` `UPDATE (id)` only (a column-sc… |
| D03-17 | `03-data-model.md` | Unpublishing a desktop release is a soft withdrawal (`withdrawn_at`, `withdrawn_by`, set under a `withdrawn_at IS NULL` predicate) that regenerates `latest*.yml` without the version and keeps the r… |
| D03-18 | `03-data-model.md` | `note_links` carries `line INT UNSIGNED NOT NULL` (1-based Markdown source line of the reference start, from the mdast `position.start.line`) in addition to `start_offset`/`end_offset` |
| D03-19 | `03-data-model.md` | `export_jobs` carries `include_trashed TINYINT(1) NOT NULL DEFAULT 0` |
| D03-20 | `03-data-model.md` | `import_jobs.stats` has one field set, defined in §11.3: `upload {files, bytes, sha256\|null}` and `replaced` written during `phase='uploading'`, and… |
| D03-21 | `03-data-model.md` | `iridium_backup` additionally holds `REPLICATION SLAVE`, `BACKUP_ADMIN` and `SHOW_ROUTINE` globally, and the grant verification — `db-grants.integration.test.ts` assertion (e) and… |
| D03-22 | `03-data-model.md` | `system.audit.archived` is part of the closed audit vocabulary (§12.6), written on the `server` chain by the archive path with `{chain_id, from_id, to_id, rows, export_path, export_sha256}` |
| D03-23 | `03-data-model.md` | MySQL 8.4 LTS (`mysql:8.4.11`) and MySQL 9.7 LTS (`mysql:9.7.2-oraclelinux9`) are equal required targets; 8.4.11 is the compatibility floor and the default of every unset image selector; the dialec… |
| D03-24 | `03-data-model.md` | Two columns the OAuth design (§4A) touches deviate from the shape it would otherwise imply, and both deviations are deliberate: `access_tokens.refresh_id` carries no foreign key to… |
| D04-01 | `04-auth-and-access-control.md` | Per-user session cap of 20 live sessions per kind, enforced in `SessionIssuer.issue()`; the oldest by `last_seen_at` is revoked with `revoked_reason='replaced'`. A desktop login with the same… |
| D04-02 | `04-auth-and-access-control.md` | Set-password links travel in the URL fragment (`/set-password#<token>`), and issuing a new link supersedes every outstanding link of that user by setting `expires_at = now`. |
| D04-03 | `04-auth-and-access-control.md` | `ARGON2_CONCURRENCY` semaphore (default 4) in `auth/credentials/hasher.ts`, in addition to `UV_THREADPOOL_SIZE=8`. |
| D04-04 | `04-auth-and-access-control.md` | Password inputs are NFC-normalised before length checks and before hashing, at set and at verify; the policy additionally rejects a candidate containing the user's email local part (≥ 4 chars) or t… |
| D04-05 | `04-auth-and-access-control.md` | Peppers are versioned as `AUTH_PASSWORD_PEPPER_V<n>[_FILE]` with `schema_meta.pepper_version` naming the current one; boot fails when the current version, or any `pepper_version` present in… |
| D04-06 | `04-auth-and-access-control.md` | Channel binding of sessions: a `kind='web'` session is accepted only from the cookie, a `kind='desktop'` session only as a bearer. |
| D04-07 | `04-auth-and-access-control.md` | `POST /auth/reauthenticate` and `POST /me/password` consume login limiter A on a wrong password, and an administrator reset clears limiter A for that `email_key` across all IPs. |
| D04-08 | `04-auth-and-access-control.md` | `authorize()` is a single async function with an explicit `AuthzScope` that may carry a pre-loaded vault row and membership, and `PERMISSION_SCOPE` makes a missing or superfluous `vaultId` a thrown… |
| D04-09 | `04-auth-and-access-control.md` | Step-up is evaluated last, after existence and permission. |
| D04-10 | `04-auth-and-access-control.md` | Token principals are refused on step-up routes with `403 token_scope_insufficient`, never `403 step_up_required`. |
| D04-11 | `04-auth-and-access-control.md` | `accessibleVaultIds(principal, {permission, surface})` is the only way a cross-vault query obtains its ACL, and the role filter is derived from the matrix rather than hard-coded as… |
| D04-12 | `04-auth-and-access-control.md` | `allowArchived` route flag, permitted only on the two routes of `ALLOW_ARCHIVED_ROUTES` (`POST /vaults/:vaultId/unarchive`, `GET /vaults/:vaultId/audit`) — the escape hatch and the one read whose p… |
| D04-13 | `04-auth-and-access-control.md` | The in-process epoch table holds entries only for users with live `/collab` connections; it is seeded at `onAuthenticate`/`onTokenSync` from the rows those hooks already read, updated by… |
| D04-14 | `04-auth-and-access-control.md` | `AuthzBus` fan-out is synchronous and after COMMIT, with per-subscriber `try/catch`, a dedicated error metric, and a fixed subscriber order (`EpochReconciler` → `CollabGateway` → `TicketStore` → te… |
| D04-15 | `04-auth-and-access-control.md` | `CollabGateway` keeps its own document→vault index (maintained in `afterLoadDocument`/`afterUnloadDocument`) so a revocation sweep performs no database query. |
| D04-16 | `04-auth-and-access-control.md` | Bounded failure auditing: `user.login.failed`, `token.denied`, `collab.connection.rejected`, `mcp.access.denied` and `oauth.authorize.denied` are deduplicated per key per window (60 s for… |
| D04-17 | `04-auth-and-access-control.md` | `user.login.failed` records a salted hash of the submitted address and names the account in `actor_display` only when it exists. |
| D04-18 | `04-auth-and-access-control.md` | Job authorization is re-evaluated at run and at download, from the recorded principal rebuilt against live memberships, not only at enqueue. |
| D04-19 | `04-auth-and-access-control.md` | `POST /me/tokens/revoke-all` exists alongside the admin route, offered in the settings UI next to a password change. Contract, so the other surfaces can carry it verbatim… |
| D04-20 | `04-auth-and-access-control.md` | Set-password link redemption is throttled on the link id (`spl:<token_id>\|<ip>`, 5 per 24 h) in addition to the per-IP route limit. |
| D04-21 | `04-auth-and-access-control.md` | `system` principals are constructed only by the job scheduler, migrations, the CLI and `openServerEdit()`, always with a job name, and the CLI additionally records `onBehalfOf` when an operator ide… |
| D04-22 | `04-auth-and-access-control.md` | The CSRF guard accepts `X-Iridium-Client ∈ {web, desktop}`, applies the Fetch-Metadata/`Origin`/`Referer` comparisons to `web` only, rejects a `desktop` value that arrives with a `Cookie` header or… |
| D04-23 | `04-auth-and-access-control.md` | `auth/sessions/verify.ts` exports two entry points over one shared row check — `verifySession(raw, channel)` for HTTP and `loadLiveSession(sessionId)` for `/collab` after ticket consumption — with… |
| D04-24 | `04-auth-and-access-control.md` | The per-user `/collab` cap of 20 counts document connections and is enforced in `onAuthenticate` (after the ticket binds a user), refusing one document with `rate-limited` while the socket keeps sy… |
| D04-25 | `04-auth-and-access-control.md` | A WebSocket close is never an authority on session validity; only a REST `401` is. A `revoked` close triggers exactly one `GET /auth/me`, and only that call's `401` erases the desktop `secrets.bin…` |
| D04-26 | `04-auth-and-access-control.md` | One bearer-verification module and one symbol: `apps/server/src/auth/tokens/verify.ts` exporting `verifyToken(raw, { surface: 'mcp' \| 'rest' })`, wrapped (never duplicated) by… |
| D04-27 | `04-auth-and-access-control.md` | Attachment bytes are the one authenticated response with a private cache window, and it is stated rather than papered over: §8.9 documents the ≤ 3 600 s replay, the clients evict on a 4403… |
| D04-28 | `04-auth-and-access-control.md` | `bearerOnly` is the primary mechanism that keeps a browser session off `/mcp` — and, identically, off `/mcp/connect`; `ignoreCookies` is defence in depth, and neither may be dropped. Fastify merges… |
| D04-29 | `04-auth-and-access-control.md` | A23's "no caches on the authorization path" is about principal, membership and token state; the `SettingsStore` is not an exception to it. The server-wide MCP switch is read as… |
| D04-30 | `04-auth-and-access-control.md` | `verifyToken` accepts both `irid_pat_` and `irid_oat_` and takes the route's canonical URI as a `resource` option; the credential kind a route accepts is declared as `config.mcpAudience` and assert… |
| D04-31 | `04-auth-and-access-control.md` | `authorize()` is unchanged by the authorization server, and a branch on `tokenKind` inside `authz/` is a defect that `oauth.principal-parity.prop` fails on. Consent and client liveness are credenti… |
| D04-32 | `04-auth-and-access-control.md` | The CSRF exemption set becomes a closed, enumerated constant (`CSRF_EXEMPT_ROUTES`) asserted at boot, instead of the single special case `/mcp`. |
| D05-01 | `05-collaboration-and-durability.md` | A writer batch is split into contiguous `(actor, session, origin)` runs; each run becomes one `note_updates` row (`seq = head+1 … head+N`) and the transaction performs a single `head_seq` CAS to… |
| D05-02 | `05-collaboration-and-durability.md` | The global `WriterScheduler` does round-robin at batch granularity (a writer releases its pool slot after one batch or one compaction job and re-queues at the back of the ready ring); writers in… |
| D05-03 | `05-collaboration-and-durability.md` | `NoteWriter` leaves `backpressure` only when the queue is below half of both bounds (hysteresis), then restores per-connection `readOnly` from role and broadcasts `role`. |
| D05-04 | `05-collaboration-and-durability.md` | A `HeadSeqCasViolation` puts the writer into `failed` permanently (no retry) and requires the audited `iridium doctor --repair-heads`. |
| D05-05 | `05-collaboration-and-durability.md` | The client re-requests `{t:'baseline'}` once after 5 s in `syncing` with `unsynced === 0`, and again on every provider `synced` event. |
| D05-06 | `05-collaboration-and-durability.md` | A document refused with `capacity` is retried by the client per document with 5 s → 60 s backoff, rather than surfacing as a terminal error. |
| D05-07 | `05-collaboration-and-durability.md` | Compaction requests coalesce into the pending job with trigger strength `debounce < flush < unload`; the strongest wins. |
| D05-08 | `05-collaboration-and-durability.md` | An update whose transaction origin is not one of the four known origins is never persisted; it is counted and logged once per document. |
| D05-09 | `05-collaboration-and-durability.md` | An update for a note flagged `content_invalid` is persisted only when its origin is `repair`; anything else is answered `persist-failed {reason:'content_invalid', retryInMs:0}`. |
| D05-10 | `05-collaboration-and-durability.md` | Revision thinning keeps the newest row per bucket and additionally never removes a row at the current `head_seq`, a row referenced by `restored_from_revision_id`, or a row whose `content_hash` diff… |
| D05-11 | `05-collaboration-and-durability.md` | `iridium doctor --repair-content` writes a `pre_restore` revision labelled `pre-repair`, supports `--dry-run` (unified diff, no writes) and `--actor`, and does not write a `restore` revision; forma… |
| D05-12 | `05-collaboration-and-durability.md` | `CheckpointMsg` carries an optional `label` (present for `kind:'named'`), and the graceful-shutdown `closing` message uses `graceMs: 2000` — the value 02-system-architecture.md ARCH-06 fixes — with… |
| D05-13 | `05-collaboration-and-durability.md` | The `participants` list is capped at 64 entries (most recently active) and collapses multiple connections of one user into one entry. |
| D05-14 | `05-collaboration-and-durability.md` | Above `SNAPSHOT_REFUSE_BYTES` (64 MB) the `note_docs.snapshot` blob is refused — step 1 of the compaction transaction is skipped, `snapshot_through_seq` stays where it was, and the projection, the… |
| D05-15 | `05-collaboration-and-durability.md` | Every sequence counter (`head_seq`, `snapshot_through_seq`, `projected_seq`, `note_updates.seq`, `note_revisions.seq`, `note_projections.revision`) is a JS `number` per 03-data-model.md §1.3; Kysel… |
| D05-16 | `05-collaboration-and-durability.md` | `insertChunked()` in `@iridium/crdt` (`INSERT_CHUNK_MAX_BYTES` = 256 KiB, split at code-point boundaries) is the only way first-party code inserts a large string into a `Y.Text`, and… |
| D05-17 | `05-collaboration-and-durability.md` | `SaveState` carries one member per close-reason policy (`revoked`, `unauthorized`, `capacity`, `vault-archived`, `too-large`, `trashed`, `closed`) instead of folding six reasons into a terminal… |
| D05-18 | `05-collaboration-and-durability.md` | The 10/s awareness cap is enforced pre-dispatch in the `/collab` plugin (`peekFrame`, `MessageType.Awareness` only, bucket keyed `(socket, documentName)`), not in `beforeHandleAwareness`. |
| D05-19 | `05-collaboration-and-durability.md` | D03-01's zero-length degradation lives in three named `@iridium/crdt` exports (`SV_STORED_MAX_BYTES`, `storedSv`, `recordedSv`) used by the writer, the compactor and the loader; the wire always car… |
| D05-20 | `05-collaboration-and-durability.md` | `enqueueCompaction`/`compactNow` reject with `CompactionUnavailable` when the writer is in `retrying`/`failed`/`backpressure` and with `CompactionTimeout` after `COMPACTION_AWAIT_TIMEOUT_MS` (15 s… |
| D05-21 | `05-collaboration-and-durability.md` | A version restore is a single writer-FIFO job (`{kind:'restore'}`, `enqueueRestore`/`captureAndRestore`) that captures the text, writes `pre_restore`, applies `prefixSuffixDiff` and writes… |
| D05-22 | `05-collaboration-and-durability.md` | `NoteTrashedDuringWrite` puts the writer into a terminal `trashed` state, and step 0 of the compaction transaction writes nothing for a note whose `nodes.deleted_at` is set (job resolves… |
| D05-23 | `05-collaboration-and-durability.md` | A compaction transaction always reaches COMMIT and always runs the checkpoint step and the single `UPDATE notes`; only the step that genuinely cannot run is skipped (the projection on an invalid sc… |
| D05-24 | `05-collaboration-and-durability.md` | A `baseline` with no attached writer is answered from `persistence.baselineOf(noteId)` (`note_docs.head_seq` plus the last `sv_after`), and only a failure of that read is answered… |
| D05-25 | `05-collaboration-and-durability.md` | `SaveStateInput` carries `closeVia: 'close-frame' \| 'auth-denied' \| null`, so the one reason string `rate-limited` can carry two policies: a CLOSE(7) frame (the 200-messages-per-10 s cap) backs off… |
| D05-26 | `05-collaboration-and-durability.md` | `packages/collab-client/src/save-state.ts` exports the memoryless `saveState(i: SaveStateInput)` and the accumulator `reduceSaveInput(prev, ev: SaveEvent)`; `now` enters only through a `tick` event… |
| D05-27 | `05-collaboration-and-durability.md` | The Electron fallback never passes `ElectronHost.collab.webSocketFactory` to Hocuspocus. `@iridium/collab-client` wraps it in… |
| D05-28 | `05-collaboration-and-durability.md` | The graceful-shutdown order in "Server restart and recovery" is canonical for the collaboration side and is mirrored, not re-derived, by 02-system-architecture.md ARCH-06 and 11-operations-and-depl… |
| D06-01 | `06-mcp-and-agent-access.md` | Add one ProblemDetails code, `token_not_rotatable` (`409`), returned when `POST /me/tokens/:id/rotate` targets an already revoked or expired token. |
| D06-02 | `06-mcp-and-agent-access.md` | Add the agent-activity and token-detail routes, with the route ids the route-policy assertion and the OpenAPI document use: `GET /me/tokens/:tokenId` (`me.tokens.get`)… |
| D06-03 | `06-mcp-and-agent-access.md` | Deduplicate `token.denied` audit rows to one per `token_id` and `mcp.access.denied` rows to one per `(token_id, vault_id, reason)` per 10 minutes — `vault_id` NULL when no vault was named, `tool` r… |
| D06-04 | `06-mcp-and-agent-access.md` | Fix the constants this section introduces: `PAT_MAX_ALLOWLIST_VAULTS` 200, `AI_GUIDANCE_MAX_CHARS` 4 000, `MCP_MAX_RESOURCE_LINKS` 50, `PAT_RATE_LIMIT_PER_HOUR_MIN` 60 and… |
| D06-05 | `06-mcp-and-agent-access.md` | Hourly rate-limit accounting: `search_notes` and REST search cost 3 points, other tool calls / `resources/read` / `completion/complete` cost 1, and `tools/list`, `resources/list`… |
| D06-06 | `06-mcp-and-agent-access.md` | `GET /notes/:id/markdown?fresh=true` is refused for token principals with `403 token_scope_insufficient`, even though the Read bundle contains `history:read`; the route itself stays PAT-enabled. |
| D06-07 | `06-mcp-and-agent-access.md` | Scope-to-tool registration map: `vault:read` → `list_vaults`, `list_notes`; `note:read` → `get_note`; `search:read` → `search_notes`; `history:read` → `list_note_revisions`; `attachment:read` →… |
| D06-08 | `06-mcp-and-agent-access.md` | Tool output additions beyond D.3: `list_vaults` adds `status` and the owner's live `role`; `get_note` adds `head_revision`, `slice_reason`, `projection_status` (the `note_projections.status` vocabu… |
| D06-09 | `06-mcp-and-agent-access.md` | All agent-visible failure texts live in one module, `apps/server/src/mcp/errors.ts`, and are asserted by `mcp.error-texts.unit.spec`. |
| D06-10 | `06-mcp-and-agent-access.md` | Cursor encoding: `base64url(json).base64url(HMAC-SHA256 truncated to 16 bytes)`; payload `{v,k,a,f,t,tv?,exp}` with `f` = the first 32 hex characters of the filter hash; keyset encodings `path` + U… |
| D06-11 | `06-mcp-and-agent-access.md` | `AccessLogWriter` batches on the `onResponse` hook: flush at most every 2 s or every 200 rows (the cadence `03-data-model.md` states with the column), bounded queue of 10 000 rows, drop-oldest on o… |
| D06-12 | `06-mcp-and-agent-access.md` | Add five metrics to the A49 registry: `iridium_mcp_tool_errors_total{tool}`, `iridium_token_auth_failures_total{reason}` (`malformed`, `unknown_id`, `secret_mismatch`, `revoked`, `expired`… |
| D06-13 | `06-mcp-and-agent-access.md` | `iridium-mcp` CLI contract: flags `--server`, `--token-file`, `--vault`, `--allow-insecure-http`, `--log-file`, `--timeout-ms`, `--version`, `--help`; token sources `--token-file` then… |
| D06-14 | `06-mcp-and-agent-access.md` | Bridge distribution: one build artefact, `dist/iridium-mcp.mjs`, published both as `resources/bin/iridium-mcp.mjs` in the desktop package and as `GET /desktop/tools/iridium-mcp-<version>.mjs` with… |
| D06-15 | `06-mcp-and-agent-access.md` | Two structural guards: `apps/server/src/mcp/` may not import `@iridium/crdt`, `collab/`, or any mutating service (boundary rule plus `mcp.no-write-imports.unit.spec`); and `verifyToken` — still the… |
| D06-16 | `06-mcp-and-agent-access.md` | Documentation set produced with M3: `docs/agents/{claude-code,claude-desktop,cursor,vscode,windsurf,claude-ai,messages-api,custom-clients}.md`, `docs/agents/tools-reference.md` (generated from… |
| D06-17 | `06-mcp-and-agent-access.md` | The factory passes an explicit `capabilities` block (`tools:{listChanged:false}`, `resources:{listChanged:false, subscribe:false}`, `completions:{}`) and the handler sets `keepAliveMs: 15_000` and… |
| D06-18 | `06-mcp-and-agent-access.md` | `AuthInfo.extras` is the only channel across the Fastify↔SDK boundary: `{principal, call: McpCallRecord, rateLimited?, serverDisabled?}`. `chargeRateLimit` writes `rateLimited`, `mcpKillSwitch` wri… |
| D06-19 | `06-mcp-and-agent-access.md` | The two kill switches answer differently and are read from different places: `server_settings.mcp_enabled = false` → HTTP `503 {"error":"mcp_disabled",…}` with `Retry-After: 60` from the… |
| D06-20 | `06-mcp-and-agent-access.md` | Rate-limit enforcement points on `/mcp`: `config.rateLimit = mcpBucket` is `{enabled: false}`; the per-IP failure budget is *checked* by `mcpIpGate` in `onRequest` and *consumed* by `patAuth` on ev… |
| D06-21 | `06-mcp-and-agent-access.md` | The note resource template stays the bare `iridium://vault/{vault_id}/note/{note_id}` (A34); `readNoteResource` re-parses the URI with `new URL(uri)`, reads `rev` from `searchParams`, and validates… |
| D06-22 | `06-mcp-and-agent-access.md` | The token REST surface uses the camelCase DTOs of `09-api-reference.md` (`Token`, `Snippet`, `AccessLogEntry`) rather than a second snake_case schema; this section adds `TokenStatusSchema`… |
| D06-23 | `06-mcp-and-agent-access.md` | `client_name`/`client_version`/`last_client` come from `_meta['io.modelcontextprotocol/clientInfo']` on the modern era when the client sends it, and from the `User-Agent` otherwise — including on e… |
| D06-24 | `06-mcp-and-agent-access.md` | The degraded read (`projection_status !== 'ok'`) is the one `isError` result that carries a complete `structuredContent`, and `get-note.ts` validates that payload against the tool's `outputSchema`… |
| D06-25 | `06-mcp-and-agent-access.md` | The MCP handler is constructed inside `withConsoleToPino(baseLog, fn)` (`apps/server/src/ops/console-to-pino.ts`), which routes `console.warn`/`console.error` to pino for the duration of `fn`; the… |
| D06-26 | `06-mcp-and-agent-access.md` | Two MCP mounts, one credential kind each: `/mcp` accepts integration tokens and advertises no discovery; `/mcp/connect` accepts OAuth access tokens and advertises discovery. The two share one handl… |
| D06-27 | `06-mcp-and-agent-access.md` | The OAuth issuer is `<PUBLIC_ORIGIN>/oauth` and never the bare origin, so the root `/.well-known/oauth-authorization-server` and `/.well-known/openid-configuration` stay `404`; all four `404`s are… |
| D06-28 | `06-mcp-and-agent-access.md` | OAuth access tokens are opaque `irid_oat_…` rows in `access_tokens` with `kind='oauth'`, not JWTs, and there is no `jwks_uri`, no `/oauth/introspect` and no `/oauth/userinfo`. |
| D06-29 | `06-mcp-and-agent-access.md` | Refresh tokens rotate on every use, with family-wide revocation on reuse: the presented row is marked `rotated_at`, a new row joins the same `family_id`, and presenting an already-rotated or revoke… |
| D06-30 | `06-mcp-and-agent-access.md` | The vault selection for an OAuth grant is made on the consent screen, stored on `oauth_consents` / `oauth_consent_vaults`, and copied into `access_token_vaults` at every issuance and every refresh. |
| D06-31 | `06-mcp-and-agent-access.md` | The consent screen is a server-rendered page from `apps/server/src/oauth/consent-page.ts`, not a `@iridium/ui` route, and contains no `<script>` element at all. |
| D06-32 | `06-mcp-and-agent-access.md` | `POST /oauth/consent`, `POST /oauth/token`, `POST /oauth/revoke`, `POST /oauth/register` and `POST /mcp/connect` join `POST /mcp` in a closed, enumerated CSRF-exemption set, `CSRF_EXEMPT_ROUTES`, w… |
| D06-33 | `06-mcp-and-agent-access.md` | Dynamic client registration is on by default, bounded by `OAUTH_DCR_PER_IP_PER_HOUR` 10, `OAUTH_MAX_UNUSED_CLIENTS` 1 000, a 7-day sweep of clients that never completed an authorization, a mandator… |
| D06-34 | `06-mcp-and-agent-access.md` | `logo_uri` is stored on `oauth_clients` and never rendered. |
| D06-35 | `06-mcp-and-agent-access.md` | Loopback redirect URIs accept `127.0.0.1`, `[::1]` and the hostname `localhost`, at any port, with the path, query and fragment matching exactly. |
| D06-36 | `06-mcp-and-agent-access.md` | Transport-level scope failures on `/mcp/connect` answer `403` with `WWW-Authenticate: Bearer error="insufficient_scope", scope="…", resource_metadata="…"`; per-argument scope failures inside a tool… |
| D07-01 | `07-client-applications.md` | Three host implementations — `BrowserHost`, `ElectronHost`, `MemoryHost` — with one parameterised `host.contract.spec.ts` executed against all three (Vitest Browser Mode, Playwright chromium, Playw… |
| D07-02 | `07-client-applications.md` | `ApiTransport` is a single `request()` method over plain JSON DTOs returning `{status, headers, body}`, with `ETag` surfaced to callers and non-2xx mapped to a typed `ApiError` carrying… |
| D07-03 | `07-client-applications.md` | UI state is split into exactly five Zustand stores (`workspaceStore` persisted through `host.storage`, `uiStore`, `sessionStore`, `presenceStore`, `commandStore`), and document state lives outside… |
| D07-04 | `07-client-applications.md` | `format.inlineCode` is bound to Mod-Backquote, not Mod-E; Mod-E remains the source/reading toggle and Mod-Shift-E the split toggle. |
| D07-05 | `07-client-applications.md` | The Electron menu template is built in main from the static manifest in `@iridium/contracts/commands.ts`; the renderer publishes only runtime state (enabled/checked/visible) through… |
| D07-06 | `07-client-applications.md` | Desktop UI preferences use the renderer's own `localStorage` inside the `persist:iridium` partition with the same key prefix as the web; there is no `storage:*` IPC channel. |
| D07-07 | `07-client-applications.md` | Desktop attachment uploads use a dedicated `iridium:files:uploadAttachment` channel taking either `{kind:'path'}` (from `webUtils.getPathForFile`) or `{kind:'bytes'}` (clipboard images), and downlo… |
| D07-08 | `07-client-applications.md` | The history diff is computed with jsdiff (`diff`, exact version pinned at M0 with a license check) at line granularity with word-level intra-line refinement, executed in the preview worker. |
| D07-09 | `07-client-applications.md` | The server answers bare `GET /set-password` and `GET /login` with `302` to `/app/set-password` and `/app/login`; the token stays in the URL fragment. |
| D07-10 | `07-client-applications.md` | The CSP nonce is injected into `index.html` by literal placeholder substitution (`__IRIDIUM_CSP_NONCE__`) performed by the server per request, with a boot assertion that the placeholder exists in t… |
| D07-11 | `07-client-applications.md` | Trusted Types (`require-trusted-types-for 'script'`) is not enabled at MVP; it is an M8 evaluation item. |
| D07-12 | `07-client-applications.md` | Exactly one preview worker per window, shared by all panes, the history diff and hover previews, with a per-note request queue and newer-request cancellation. |
| D07-13 | `07-client-applications.md` | Clicking a task checkbox dispatches the same `toggleCheckbox` source edit on the source line named by the enclosing `li`'s `data-offset`, identically in reading and split mode. Interactivity is a r… |
| D07-14 | `07-client-applications.md` | Scroll sync anchors on `data-line` attributes via a cached sorted array and binary search, is bidirectional, and is suppressed by a `programmaticScroll` guard and during pointer drags. |
| D07-15 | `07-client-applications.md` | At most 12 live `NoteSession`s per window; additional open tabs become dormant (provider detached, read-only snapshot shown) in least-recently-focused order, and a tab with unsaved changes is never… |
| D07-16 | `07-client-applications.md` | The desktop shell runs exactly one `BrowserWindow`; profile switching reloads it; additional windows are post-MVP. |
| D07-17 | `07-client-applications.md` | No runtime i18n library: a typed `en.ts` table plus a small `t()` helper and the `Intl` APIs, with a lint rule banning literal strings in JSX. |
| D07-18 | `07-client-applications.md` | Build targets are `chrome150` (web) and `chrome152` (desktop renderer); unsupported browsers are detected by feature test, never by user-agent, and are shown a static dependency-free page. |
| D07-19 | `07-client-applications.md` | The renderer bundle budget blocks the pull request (a deterministic, byte-exact assertion over the Vite manifest); the timing budgets are measured on every pull request as warning annotations and b… |
| D07-20 | `07-client-applications.md` | The accessibility commitment is stated as keyboard-complete operation, zero serious or critical axe-core findings, and high-contrast and reduced-motion support, with manual NVDA and VoiceOver passe… |
| D07-21 | `07-client-applications.md` | Remote (`https:`) images in note content follow the vault's `load_external_images` setting (default `click`: a placeholder card with the host name, "Load image", "Open image in browser" and "Copy U… |
| D07-22 | `07-client-applications.md` | The hover page preview fetches the committed projection (`GET /notes/:noteId/markdown?lines=1-30`, the route's 1-based inclusive range form) and caches it for 60 s per note, rather than opening a c… |
| D07-23 | `07-client-applications.md` | Non-image attachments are only ever saved to a user-chosen path; the desktop never opens a downloaded file with the OS handler, and SVG is never displayed inline. |
| D07-24 | `07-client-applications.md` | Browser tabs coordinate through `BroadcastChannel('iridium')` carrying only event kinds (`signed-out`, `signed-in`, `vault-archived`), with a `storage`-event fallback. |
| D07-25 | `07-client-applications.md` | No service worker, no offline cache, no PWA install path at MVP. |
| D07-26 | `07-client-applications.md` | `iridium:api:request` carries a renderer-generated `requestId` and `iridium:api:abort {requestId}` cancels the in-flight `net.fetch`, so `AbortSignal` semantics survive the IPC boundary. |
| D07-27 | `07-client-applications.md` | `app.on('login')` is handled only for proxy authentication (modal dialog, credentials not persisted); server `401`s are never answered by it. |
| D07-28 | `07-client-applications.md` | A TLS failure screen shows the presented certificate's SHA-256 fingerprint and requires the administrator-supplied fingerprint to be pasted and matched before a per-profile pin is stored. There is… |
| D07-29 | `07-client-applications.md` | `app.addRecentDocument` (OS recent-documents list) is not used. |
| D07-30 | `07-client-applications.md` | The only native context menu is the spell-check suggestion menu (shown when `params.misspelledWord` is non-empty); every other context menu is rendered by the shared UI. |
| D07-31 | `07-client-applications.md` | `GET /meta` additionally publishes `policies` (`passwordMinLength`, `passwordMaxLength`, `patMaxLifetimeDays`, `patAllowNoExpiry`, `patRotationOverlapMaxHours`) alongside the `limits` object (… |
| D07-32 | `07-client-applications.md` | `defaultKeys` in the command manifest is `{ electron, web }`, and the browser-reserved chord set (Mod-N, Mod-Shift-N, Mod-W, Mod-Shift-T, Ctrl-Tab, Ctrl-Shift-Tab, Mod-1…9, and Mod-Alt-←/→ on macOS… |
| D07-33 | `07-client-applications.md` | The client owns the preview worker's `VaultIndexSnapshot`: built from the nodes and attachments listings on vault open, keyed `(treeVersion, attachmentsVersion)`, patched from every `tree-changed`… |
| D07-34 | `07-client-applications.md` | When one note is mounted in both panes, exactly one `EditorView` owns awareness — the focused one — through an `awarenessCompartment`; the other is built with `awareness: null`, which omits the rem… |
| D07-35 | `07-client-applications.md` | The packaged `app-update.yml` carries a placeholder feed URL; `updater.ts` calls `autoUpdater.setFeedURL` with `feedUrl` from `GET /desktop/update-policy` before every check and refuses a `feedUrl…` |
| D07-36 | `07-client-applications.md` | Every tree context-menu entry is a `CommandId` from the manifest, enforced by `commands.menu-coverage.spec`; `node.move`, `export.open` and `export.note` are added to the manifest for the entries t… |
| D07-37 | `07-client-applications.md` | The desktop attachment handler re-emits the shared `FORWARDED_ATTACHMENT_HEADERS` list (`@iridium/contracts/attachments.ts`, 08 §9.4) verbatim — content headers, cache/ETag pair, range pair and the… |
| D07-38 | `07-client-applications.md` | Every command any section invokes exists in the manifest of 3.5: `attachment.insert` (palette and context menu), `tab.moveLeft` / `tab.moveRight` (Mod-Shift-←/→) and `zoom.in` / `zoom.out` /… |
| D07-39 | `07-client-applications.md` | Desktop sign-out, profile removal and an unrecoverable `401` clear the `persist:iridium` partition's cookies, cache storage, IndexedDB, WebSQL and service workers, and never its `localStorage`; the… |
| D07-40 | `07-client-applications.md` | A collaboration close is never an authority on session validity. The desktop credential is destroyed only by a REST `401`; `@iridium/collab-client` answers a terminal `revoked`/`unauthorized` close… |
| D07-41 | `07-client-applications.md` | The policy string printed in 6.2 is the single normative web CSP. 02-system-architecture.md §B, 10-testing-and-quality.md's `security.headers` assertion and 12-milestones.md's M4 row reference it i… |
| D07-42 | `07-client-applications.md` | The agent-activity surfaces of 06-mcp-and-agent-access.md D06-02 render inside this chapter's existing route shapes: `/admin/agent-activity` joins the typed admin route set, the per-token drawer an… |
| D07-43 | `07-client-applications.md` | The 1.0 desktop client is distributed as six unsigned bundles — `zip` on Windows and macOS, `tar.gz` on Linux, x64 and arm64, named `Iridium-<version>-<win32\|darwin\|linux>-<arch>.<ext>` — downloade… |
| D07-44 | `07-client-applications.md` | `UpdateState` gains `manual-download {version, notes, mandatory, artifacts}`; `host.updates.check()` derives it by comparing `GET /desktop/update-policy`'s `latest.version` with `app.getVersion()`… |
| D07-45 | `07-client-applications.md` | The post-1.0 signing epic fixes the Windows `publisherName` before its first external build. It is a single-valued, immutable configuration item committed in `apps/desktop/build/publisher.json`, as… |
| D07-46 | `07-client-applications.md` | The Electron shell is the supported client at 1.0 and the web host is a development and internal surface (01 §4.6). Section 9.3 renders the matrix; section 6 is unchanged in substance; the Electron… |
| D07-47 | `07-client-applications.md` | The OAuth consent screen at `/oauth/consent` is the single, bounded exception to "every user-facing screen is a `@iridium/ui` route": it is server-rendered (06-mcp-and-agent-access.md D06-31), cont… |
| D07-48 | `07-client-applications.md` | The Integrations page renders two client enums rather than one: `SnippetClientSchema` for clients that send an integration-token header (`<origin>/mcp`) and `ConnectorClientSchema` for clients that… |
| D08-01 | `08-markdown-pipeline-import-export.md` | `toBodyText` emits a monotonic `TextRun[]` map (plain-text offset → source offset) that is not persisted; snippet location is two-stage — a source-line scan first, then a worker-side re-projection… |
| D08-02 | `08-markdown-pipeline-import-export.md` | `body_text` is built by a first-party walker instead of `mdast-util-to-string`: `yaml` and `html` skipped, `code`/`inlineCode` included, `image` alt included, a `\n` separator emitted after every b… |
| D08-03 | `08-markdown-pipeline-import-export.md` | Two additional pre-scan caps, named in the convention of the canonical limits table: `MARKDOWN_FOOTNOTE_REFS_MAX = 10_000` and `MARKDOWN_BRACKETS_MAX = 200_000` |
| D08-04 | `08-markdown-pipeline-import-export.md` | Note text is never Unicode-normalized; NFC folding applies only to derived keys (tags, aliases, link path fold key, snippet comparison) |
| D08-05 | `08-markdown-pipeline-import-export.md` | Unpaired surrogates are replaced with U+FFFD during normalization, alongside U+0000 |
| D08-06 | `08-markdown-pipeline-import-export.md` | UTF-16 BOM inputs are decoded as UTF-16 and reported; strict UTF-8 decoding is the default and `options.invalidUtf8 = 'replace'` is an explicit operator decision |
| D08-07 | `08-markdown-pipeline-import-export.md` | `original_eol = 'mixed'` is declared not byte-restorable: export writes LF and emits `eol_mixed_normalized` in the manifest, the report and `README-IRIDIUM.md` |
| D08-08 | `08-markdown-pipeline-import-export.md` | Link path resolution folds with `NFC` + `toLowerCase()`, matching `uq_sibling`'s `utf8mb4_0900_as_ci`; the database unique index stays the authority at import commit |
| D08-09 | `08-markdown-pipeline-import-export.md` | Basename and alias ("shortest path") resolution applies to wikilinks only; standard Markdown links resolve by path |
| D08-10 | `08-markdown-pipeline-import-export.md` | Cross-note fragments are recorded but never validated; only same-note anchors are checked |
| D08-11 | `08-markdown-pipeline-import-export.md` | `VaultIndexSnapshot` is an array-based, structured-cloneable payload cached by `(vaultId, tree_version, attachmentsVersion)`; the browser copy is built from `GET /vaults/:vaultId/nodes` +… |
| D08-12 | `08-markdown-pipeline-import-export.md` | Editor-inserted attachment references are percent-encoded relative paths (spaces as `%20`, plus `()[]#?%`); angle-bracket destinations are not used |
| D08-13 | `08-markdown-pipeline-import-export.md` | The Obsidian detector runs on every projection (not only at import); its code vocabulary is a superset of the closed import-report list; findings are capped (20 sampled per note in… |
| D08-14 | `08-markdown-pipeline-import-export.md` | The importer reads exactly two values from `.obsidian/app.json` (`attachmentFolderPath`, `strictLineBreaks`) as wizard suggestions, and proposes `markdown_flavor = 'obsidian-compat'` when the folde… |
| D08-15 | `08-markdown-pipeline-import-export.md` | Staged sources are read through one `StagedSource` interface: ZIP via streaming yauzl, uploaded files via a content-addressed staging tree plus append-only `manifest.jsonl` |
| D08-16 | `08-markdown-pipeline-import-export.md` | Upload is batched (≤ 200 files or 64 MiB per request) and idempotent per relative path; re-uploading a path replaces the staged entry |
| D08-17 | `08-markdown-pipeline-import-export.md` | Classification is explicit and nothing is silent: `.md`/`.markdown` are notes, `.mdx`/`.txt`/unknown types are reported `unsupported_file`, noise files (`.DS_Store`, `Thumbs.db`, `desktop.ini`… |
| D08-18 | `08-markdown-pipeline-import-export.md` | A directory and a note file whose names fold equally (`Notes/` vs `Notes.md`) are a real collision, reported as `filename_collision` with `detail.kind='note_vs_category'` and handled by the chosen… |
| D08-19 | `08-markdown-pipeline-import-export.md` | Import commit resumption is content-addressed: an entry is skipped when a live node exists at the target path, `notes.initialized_at` is set, and the `kind='import'` revision hash matches the stage… |
| D08-20 | `08-markdown-pipeline-import-export.md` | At most one active import per target vault, and every job call is restricted to `jobs.requested_by` or a server administrator; PATs can never drive a transfer |
| D08-21 | `08-markdown-pipeline-import-export.md` | Export entry names replace Windows-illegal characters (`: * ? " < > \|`) with `_`, de-duplicate with ` (2)` suffixes, and record every substitution as a `path_sanitized` manifest warning |
| D08-22 | `08-markdown-pipeline-import-export.md` | Export is a per-note committed snapshot after flushing loaded documents; a `tree_version` change during the walk adds `tree_changed_during_export`; packaging is deterministic (fixed entry order, de… |
| D08-23 | `08-markdown-pipeline-import-export.md` | Exports exclude trashed notes by default and preserve empty categories as directory entries; `includeTrashed: true` (needs `history:read`, persisted as `export_jobs.include_trashed`) writes them at… |
| D08-24 | `08-markdown-pipeline-import-export.md` | Attachment acceptance: sniffed MIME wins; text types may be accepted by extension when the bytes are valid UTF-8; OOXML/ODF are accepted only after a container peek confirms `[Content_Types].xml`/… |
| D08-25 | `08-markdown-pipeline-import-export.md` | Attachment serving adds single-range support, `Cross-Origin-Resource-Policy: same-origin`, `X-Permitted-Cross-Domain-Policies: none`, `Referrer-Policy: no-referrer` and `Vary: Authorization`, and a… |
| D08-26 | `08-markdown-pipeline-import-export.md` | Deletion is soft; bytes are removed only by `iridium attachments purge`, which re-checks live links, other rows sharing the hash, and retained revision markdown.… |
| D08-27 | `08-markdown-pipeline-import-export.md` | `iridium mirror` keeps its own `.iridium-mirror.json` state, only ever touches files it wrote, and refuses a non-empty directory without `--adopt` |
| D08-28 | `08-markdown-pipeline-import-export.md` | Frontmatter index normalization caps: tags ≤ 64 characters and ≤ 200 entries, aliases ≤ 255 characters and ≤ 100 entries, NFC-folded and lowercased for tags; the raw block is never rewritten |
| D08-29 | `08-markdown-pipeline-import-export.md` | The highlighting registry is a fixed set of 21 grammars with an explicit alias map and `plainText` for `mermaid`, `math`, `dataview`, `dataviewjs`, `query`, `base`, `canvas`; no auto-detection, no… |
| D08-30 | `08-markdown-pipeline-import-export.md` | The sanitizer schema replaces (never extends) `tagNames`, `attributes`, `protocols`, `ancestors` and `required`: 30 elements, no `data-*` wildcard, no `style`/`name`/`target`/`rel`, ids only under… |
| D08-31 | `08-markdown-pipeline-import-export.md` | A valid same-note anchor is stored as `status='resolved'` with `resolved_node_id = from_note_id`; an anchor whose fragment matches none of the note's own headings is `broken`; every "who links here… |
| D08-32 | `08-markdown-pipeline-import-export.md` | The limits table of `02-system-architecture.md` §7 is the sole naming authority for `@iridium/contracts/limits.ts`; this section introduces no synonym, and `prescan` gains an explicit… |
| D08-33 | `08-markdown-pipeline-import-export.md` | `note_links` stores `line` (1-based source line of the reference start, from mdast `position.start.line`) next to `start_offset`/`end_offset` |
| D09-1 | `09-api-reference.md` | The `ProblemDetails.code` vocabulary adds twelve codes to the skeleton's list: `unauthenticated` (401, missing or unknown credential, distinct from `invalid_credentials` which is a *login* failure)… |
| D09-2 | `09-api-reference.md` | `ProblemDetails` carries exactly four optional extension members beyond RFC 9457: `current` (409/428), `errors[]` (`validation_failed`), `references[]` (`attachment_referenced`), `retryAfterMs` (… |
| D09-3 | `09-api-reference.md` | Paginated list responses use one envelope, `{items, nextCursor?}`, with route-specific extras (`treeVersion`, `stale`, `query`, `retention`) named per route; `nextCursor` is absent at the end of a… |
| D09-4 | `09-api-reference.md` | Every route gets a stable `operationId` of the form `<domain>.<verb>`, listed in §2.18, and a contract test asserts the markdown table, `openapi.json` and the boot-time route policy agree. |
| D09-5 | `09-api-reference.md` | ETag strategy per resource class: strong `"<version>"` on version-carrying metadata resources (the `If-Match` validator), strong `"<revision>:<contentHash>"` on note Markdown, strong… |
| D09-6 | `09-api-reference.md` | Boolean query parameters are parsed with `z.stringbool()` accepting only the literals `true` and `false`; anything else is `422 validation_failed`. |
| D09-7 | `09-api-reference.md` | `PATCH /nodes/:nodeId` takes `dryRun` and always returns `affectedLinks`, and a read-only twin `GET /notes/:noteId/rename-impact` exists for viewers. |
| D09-8 | `09-api-reference.md` | Additional REST routes required by surfaces the skeleton names but does not route: `GET /vaults/:vaultId/attachments/:attachmentId/meta` (already in the skeleton's table), `GET /admin/vaults` (the… |
| D09-9 | `09-api-reference.md` | There is no `DELETE /admin/users/:userId` in MVP; `status='deleted'` is reserved for a later erasure flow and disabling is the supported removal. |
| D09-10 | `09-api-reference.md` | `ServerSettings` is exposed as one grouped document with a single `version` (the maximum of the underlying `server_settings` row versions) for `If-Match`, written under one transaction with per-row… |
| D09-11 | `09-api-reference.md` | `/readyz` returns the same JSON body with `200` and `503`, and `GET /admin/system` embeds it as `readiness`. Its `status` and per-check vocabulary is `ok`/`warn`/`fail`, and `ReadyzCheckName` is ex… |
| D09-12 | `09-api-reference.md` | `/collab` stateless payloads are capped at 4 KiB and a malformed or unknown client payload closes the connection with `protocol-error`; a client ignores unknown server message types and unknown fie… |
| D09-13 | `09-api-reference.md` | `vault:<uuid>` `tree-changed` batches are capped at 500 changes; a larger transaction (an import commit) broadcasts `changes: []` with the new `treeVersion`, which means "refetch". |
| D09-14 | `09-api-reference.md` | MCP `list_note_revisions` returns a `retention_note` string and `GET /notes/:noteId/revisions` returns a `retention` object describing the thinning policy. |
| D09-15 | `09-api-reference.md` | MCP `get_note` includes `projection_status` in `structuredContent`, and a note whose projection failed still returns its Markdown with an `isError` explanation rather than nothing. |
| D09-16 | `09-api-reference.md` | `iridium:api:request` restricts `path` to `/api/v1/…` (no absolute URLs, no `..`), strips `authorization` and `cookie` from renderer-supplied headers, and filters response headers to an allow-list… |
| D09-17 | `09-api-reference.md` | `iridium-attachment://<vaultId>/<attachmentId>` requires both segments to be canonical UUIDs and forwards only `Content-Type`, `Content-Length`, `ETag`, `Accept-Ranges` and `Content-Range`. |
| D09-18 | `09-api-reference.md` | Deprecation is signalled with `Deprecation`, `Sunset` and `Link: rel="deprecation"` headers plus `X-Iridium-Deprecated-Fields`, counted in `iridium_http_requests_total{deprecated="true"}`, and kept… |
| D09-19 | `09-api-reference.md` | `GET /meta` is the single definition of every client-visible bound, in exactly these spellings… |
| D09-20 | `09-api-reference.md` | `NoteSummary` carries `fmTags` and `fmAliases` on every note row of every tree and node listing, read from `note_projections` in the same statement, rather than behind a `detailed` variant. |
| D09-21 | `09-api-reference.md` | A filesystem path never crosses the desktop bridge for imports: `pickImportSource` returns an opaque `sourceId` and main keeps the `sourceId → absolute path` map. The one channel that accepts a ren… |
| D09-22 | `09-api-reference.md` | `note_revisions.id` is serialised as a JSON number on REST (`Revision.id`) and as a decimal string on MCP (`revision_id`); `revision` (= `note_updates.seq`) is a number on both. |
| D09-23 | `09-api-reference.md` | The server-wide MCP kill switch answers HTTP `503 {"error":"mcp_disabled"}` before the SDK runs for every method except `tools/call`, which is answered `200` with the canonical `isError` text; an M… |
| D09-24 | `09-api-reference.md` | The save-state machine has exactly one normative definition, and it is not here: 05-collaboration-and-durability.md owns the ordered rule table (states, conditions, first-match order) and §3.9 owns… |
| D09-25 | `09-api-reference.md` | `iridium:event:session-changed` carries exactly `{state, me, origin}` — no `reason` discriminator, and the member is `state`, never `status`. `revoked` is a `CollabCloseReason` (§3.6), not a sessio… |
| D09-26 | `09-api-reference.md` | The three `/collab` caps of skeleton §A.1 keep their values (20 / 50 / 5 000) and are enforced at two points, because they count two different things: the per-user cap of 20 document connections (o… |
| D09-27 | `09-api-reference.md` | `GET /admin/system` reports `storage.volumes: Record<'attachments'\|'staging'\|'exports'\|'updates', {freeBytes, totalBytes}>` from the same 60 s `statfs` sampler that feeds… |
| D09-28 | `09-api-reference.md` | `packages/contracts/src/collab.ts` has exactly one normative definition, and it is the zod block in 05-collaboration-and-durability.md; §3.2, §3.4 and §3.5 render it under the same exported names (… |
| D09-29 | `09-api-reference.md` | `GET /desktop/update-policy` publishes `latest.artifacts[]` (`platform`, `arch`, `name`, `url`, `sizeBytes`, `sha256`) and `desktop_releases.files[]` — mirrored by `GET /admin/releases` and… |
| D09-30 | `09-api-reference.md` | `/oauth/*` is the second documented exemption from the `ProblemDetails` envelope, alongside the two MCP mounts, and it is exactly as narrow: `/oauth/token`, `/oauth/revoke` and `/oauth/register` an… |
| D09-31 | `09-api-reference.md` | The OAuth endpoints, the four metadata documents and the four deliberate `404` paths live outside `/api/v1`, at `/oauth/*` and `/.well-known/*`, and are enumerated in the second table of §2.18 rath… |
| D10-1 | `10-testing-and-quality.md` | Name the plan's own testable properties HP-1…HP-5 (Saved truthfulness, restart recovery, revocation timing, hostile-content inertness, limits enforcement) and give the spec's section 9 rows stable… |
| D10-2 | `10-testing-and-quality.md` | Tag every test with `[spec:<row-id>]` / `[hp:HP-n]` / `[area:<name>]` in the top-level `describe` (Playwright: `{ tag: ['@spec-…','@hp-n','@area-…'] }`), commit `docs/acceptance-map.json` with a… |
| D10-3 | `10-testing-and-quality.md` | Test file naming `<area>.<subject>.<layer>.spec.ts[x]` with `layer ∈ {unit, component, integration, prop, chaos, contract, mcp, e2e, guard, drill}`, and fixed locations per layer; `drill` is collec… |
| D10-4 | `10-testing-and-quality.md` | Split `component` into its own Vitest project (Browser Mode) and run it only on ubuntu in CI; keep Windows on `unit` (where the path, filename, EOL and name-collation logic lives). |
| D10-5 | `10-testing-and-quality.md` | Standard environment knobs: `IRIDIUM_TEST_SEED`, `IRIDIUM_TEST_FUZZ_TOKEN`, `IRIDIUM_TEST_HOST_CONTRACT_REPORTS`, `IRIDIUM_PROP_RUNS`, `IRIDIUM_PROP_DB_RUNS`, `IRIDIUM_PROP_DB_COMMANDS`… |
| D10-6 | `10-testing-and-quality.md` | Add a test-only HTTP namespace `/__test__` (`POST/DELETE /__test__/faults`) for arming fault points at runtime, gated on `NODE_ENV === 'test'`, declared in the route policy as `auth: 'test-only'`… |
| D10-7 | `10-testing-and-quality.md` | A `Clock` interface in `@iridium/contracts` injected everywhere server-side, a `ManualClock` in the testkit, and `guards.no-direct-date.guard.spec.ts` banning `Date.now()`/`new Date()`/bare… |
| D10-8 | `10-testing-and-quality.md` | `corruptDeliberately(kind, args)` is the only sanctioned raw-SQL write in tests, and `guards.no-raw-sql-in-tests.guard.spec.ts` bans all others. |
| D10-9 | `10-testing-and-quality.md` | `assertNoteInvariants` and `assertAuditChain` run in `afterEach` for the `integration`, `property` and `chaos` projects. |
| D10-10 | `10-testing-and-quality.md` | `openapi.coverage.contract.spec.ts` fails when a documented `(operationId, status)` pair is never exercised across the whole run, aggregated in `merge-reports`. |
| D10-11 | `10-testing-and-quality.md` | Keep committed per-`apiVersion` wire baselines under `apps/server/test/contract/baselines/<apiVersion>/` and enforce skeleton A54's additive-only rule mechanically in… |
| D10-12 | `10-testing-and-quality.md` | Implement the license scan as an in-repo `scripts/check-licenses.ts` over the production dependency closure, with the allowlist/denylist of skeleton A52 and an `scripts/license-exceptions.json` who… |
| D10-13 | `10-testing-and-quality.md` | The renderer bundle budget is the only PR-blocking performance gate; timing budgets are advisory on PRs and blocking in the nightly `perf` job. |
| D10-14 | `10-testing-and-quality.md` | Commit `apps/server/test/load/baseline.json` and fail the nightly load job on a > 20 % p95 regression even when no threshold is breached; re-baseline only by explicit commit. |
| D10-15 | `10-testing-and-quality.md` | Quarantine discipline: `apps/e2e/QUARANTINE.md` with owner + issue, a hard ceiling of 5 entries, none allowed to cover an acceptance row or hard property, plus a nightly `flake-hunt` job (… |
| D10-16 | `10-testing-and-quality.md` | Extend the coverage gates beyond skeleton A51 with `apps/server/src/audit/` at 95/90 per file and `packages/markdown/src/sanitize/` at 100 % per file, and extend Stryker's mutate scope to… |
| D10-17 | `10-testing-and-quality.md` | Fixture policy: synthetic data only, loaded through product paths, committed fixtures capped at 5 MB with provenance files for vendored corpora, large corpora generated from a printed seed… |
| D10-18 | `10-testing-and-quality.md` | Performance trend artifacts as `reports/perf/*.jsonl` plus `scripts/perf-trend.ts` rendering into the nightly job summary; no external dashboard. |
| D10-19 | `10-testing-and-quality.md` | Add a non-blocking nightly `node-26` lane for the `unit` and `integration` projects. |
| D10-20 | `10-testing-and-quality.md` | Name and specify the full guard-test set (`one-boot-path`, `no-mocks-outside-unit`, `no-sleep`, `no-direct-date`, `no-raw-sql-in-tests`, `fault-registry`, `error-shape`, `i18n`, `no-inner-html`… |
| D10-21 | `10-testing-and-quality.md` | "Inventory completeness" is the single authority mapping every test name used anywhere in the plan to a file, a project and a tag; `scripts/build-acceptance-map.ts` generates… |
| D10-22 | `10-testing-and-quality.md` | Two property budgets — `PROP` (`numRuns` 200 PR / 5 000 nightly, 60 s interrupt) for pure files in the `unit` project and `PROP_DB` (200 × 60 PR / 5 000 × 300 nightly, failure on interrupted runs, separate PR/nightly deadlines)… |
| D10-23 | `10-testing-and-quality.md` | The acceptance map phases each layer by `sinceMilestone`; CURRENT records the last exit, `IRIDIUM_TEST_TARGET_MILESTONE` selects a validation target, and `[area:<name>]` is a legal requirement tag. |
| D10-24 | `10-testing-and-quality.md` | The `chaos` project keeps the production collaboration debounce (`COLLAB_DEBOUNCE_MS=2000`, `COLLAB_MAX_DEBOUNCE_MS=10000`); only the `integration` project and the Playwright `webServer` use 100 /… |
| D10-25 | `10-testing-and-quality.md` | A chaos iteration is its own Vitest case (`it.for(range(IRIDIUM_CHAOS_ITERATIONS))`), so the project's `testTimeout: 180_000` bounds one iteration; CH-14 and CH-15 declare `{ timeout: 600_000 }` at… |
| D10-26 | `10-testing-and-quality.md` | Every route-enumerating test reads its route set from both `app.routes()` and `packages/contracts/openapi/openapi.json` and asserts the two sets are equal before exercising any member (… |
| D10-27 | `10-testing-and-quality.md` | The merge-blocking set is milestone-phased for lanes that have no tests yet (`chaos-core` from M1, `e2e-web` from M4, `mutation-scoped` from M1; `e2e-electron` from M0 via `desktop.launch.e2e`), th… |
| D10-28 | `10-testing-and-quality.md` | Acceptance row 9 (`backup-recovery`) is owned by `nightly.yml › backup-restore-drill` and by `release.yml › drill`, never by `ci.yml`; that one job runs all five operator rehearsals (… |
| D10-29 | `10-testing-and-quality.md` | The contracts name-and-id primitives are four canonical names — `contracts.paths.unit`, `contracts.paths.prop`, `contracts.ids.unit`, `contracts.ids.prop` — one subject in two layers each… |
| D10-30 | `10-testing-and-quality.md` | The move/rename link warning is proven by four named tests in four layers — `tree.rename-impact.unit` (the pure summariser), `tree.rename-impact.integration` (the three routes' payloads and the pre… |
| D10-31 | `10-testing-and-quality.md` | Viewer enforcement, live revocation and durable saving each gain an Electron acceptance spec at M5 — `desktop.viewer-readonly.e2e`, `desktop.revocation-while-open.e2e`, `desktop.durable-save.e2e` —… |
| D10-32 | `10-testing-and-quality.md` | One merge-blocking `guards.non-goals.guard` asserts every declared non-goal against the built inventories — registered routes, MCP tools and resources, CLI commands, client host capabilities and co… |
| D10-33 | `10-testing-and-quality.md` | Single-process document ownership is enforced by a boot lease: `SELECT GET_LOCK(ownerLockName, 0)` on one dedicated `dbPersist` connection held for the process's lifetime, released after t… |
| D10-34 | `10-testing-and-quality.md` | `docs/acceptance-map.json` carries a third id namespace, `ruleId`, generated from "Specified rules outside the nine rows", and `guards.acceptance-map.guard` gains rule 6: every listed rule must nam… |
| D10-35 | `10-testing-and-quality.md` | The vault-settings floor rule is the same rule as the server-settings floor rule: a value weaker than its environment baseline is `422 validation_failed` with `errors[0].code='below_env_floor'`, an… |
| D10-36 | `10-testing-and-quality.md` | An evidence cell names a test, never a lane, a runner or a phrase. Every entry in the hard-property table, the "Hard properties → required layers" table, the nine-row overview and the specified-rul… |
| D10-37 | `10-testing-and-quality.md` | `docs.spikes.spec` is specified here — file, project, lane, tag and assertions — while its *name* and its template stay owned by 14-risks-and-open-questions.md D14-11. The file is… |
| D10-38 | `10-testing-and-quality.md` | A test specified here carries a milestone of record even before 12-milestones.md schedules it. The seven tests found with no exit-table entry — the six content read-model tests and… |
| D10-39 | `10-testing-and-quality.md` | Vault isolation of note history is one named case per surface family, not a route in the enumeration. `authz.vault-isolation.integration` gains the case *foreign-vault revision history* covering ev… |
| D10-40 | `10-testing-and-quality.md` | The Playwright project list is exactly `setup`, `chromium`, `electron`; the `firefox-smoke` and `webkit-smoke` projects and the `nightly.yml › browser-smoke` job are removed, and their absence is a… |
| D10-41 | `10-testing-and-quality.md` | `docs/acceptance-map.json` entries carry `gating: true` for the layer that gates 1.0, and `guards.acceptance-map.guard` gains rule 7: every gating test must be selected by a merge-blocking lane. Th… |
| D10-42 | `10-testing-and-quality.md` | `ci.yml`'s `integration` and `chaos-core` jobs are two-entry matrices over `mysql:8.4.11` and `mysql:9.7.2-oraclelinux9`, both `integration` entries required on `main` from M0 and both `chaos-core…` |
| OPS-01 | `11-operations-and-deployment.md` | A Compose `ops` profile runs the same image as a one-shot container with no ports, holding the migrator and backup credentials and `entrypoint: ["iridium"]`; the `server` service holds the migrator… |
| OPS-02 | `11-operations-and-deployment.md` | Production network topology is fixed: a Compose network declared `internal: true` with a fixed `/24`, Caddy on a pinned address, the server and MySQL with no published ports, and `TRUST_PROXY` set… |
| OPS-03 | `11-operations-and-deployment.md` | The container health probe is `dist/healthcheck.mjs` (emitted by the same tsdown build) rather than `curl`, and `tini` is PID 1 |
| OPS-04 | `11-operations-and-deployment.md` | The runtime image ships one set of MySQL client tools (`mysqldump`, `mysql`, `mysqlbinlog`), the signed `9.7.2-1.el9` client RPM on both release architectures, pinned by SHA-256 and verified release key; amended 2026-09-20 because the Debian APT source has no ARM64 packages. See [OPS-04](../adr/ops-04-mysql-client-packaging.md). |
| OPS-05 | `11-operations-and-deployment.md` | The systemd unit is `Type=notify`, with a dependency-free `sd_notify` implementation in `apps/server/src/ops/sd-notify.ts`; `READY=1` is sent only after the first non-failing `/readyz` evaluation a… |
| OPS-06 | `11-operations-and-deployment.md` | `iridium config check` is the first `ExecStartPre` and the first step of every runbook |
| OPS-07 | `11-operations-and-deployment.md` | The env schema in "Configuration and secrets" is the authoritative superset for operations. The network keys `BIND_ADDRESS` (default `127.0.0.1`, skeleton A48's "Node binds `127.0.0.1:4000`") and… |
| OPS-08 | `11-operations-and-deployment.md` | Secrets are encrypted with the age format produced in-process by the reference TypeScript implementation (`age-encryption`, pinned at M0 with a licence check), not by shelling out to an `age` binary |
| OPS-09 | `11-operations-and-deployment.md` | The secret bundle contains every configured version of each keyring — peppers, audit HMAC keys, cursor keys, reserved attachment keys — as a version→key map plus the promoted versions, and delibera… |
| OPS-10 | `11-operations-and-deployment.md` | `iridium keys status`, `iridium keys export`, and `iridium keys verify-bundle` are added, and rotation is the two-command split of ARCH-09: `keys rotate <kind>` writes a key file and touches no dat… |
| OPS-11 | `11-operations-and-deployment.md` | Roles are created by `infra/docker/mysql/init/01_roles.sh` (a shell script reading the three `*_PASSWORD_FILE` secrets) — this replaces the skeleton A48 artefact name `init/01_roles.sql`, because t… |
| OPS-12 | `11-operations-and-deployment.md` | A fourth Kysely instance `dbMaint` (pool 1, lazily created, migrator role) exists alongside `dbApp`, `dbPersist`, and the CLI-only `dbBackup` |
| OPS-13 | `11-operations-and-deployment.md` | Migrations that rebuild a table or build a large index carry a leading `-- iridium: long-running` comment. The boot path never applies them (readiness reports… |
| OPS-14 | `11-operations-and-deployment.md` | `iridium migrate ensure-guards` re-applies the audit triggers and table grants idempotently without touching `kysely_migration`; `restore` always calls it, and `doctor --triggers` recommends it |
| OPS-15 | `11-operations-and-deployment.md` | If the process dies between applying a migration and writing its `system.migration.applied` event, the next `migrate` run backfills the missing events by diffing `kysely_migration` against the audi… |
| OPS-16 | `11-operations-and-deployment.md` | One exit-code contract for the whole CLI and for `serve`: `0` success, `1` internal error, `2` config/usage, `3` refused precondition, `4` pre-flight integrity failure, `5` verification failure… |
| OPS-17 | `11-operations-and-deployment.md` | Mutating repairs live in an explicit `iridium repair heads\|content\|checkpoints\|projections\|attachments\|tree\|search` group; `doctor --repair-heads` and `doctor --repair-content` remain documented al… |
| OPS-18 | `11-operations-and-deployment.md` | `iridium users …` and `iridium vaults …` are registered aliases over the canonical `admin` group (`admin create-user`, `admin reset-password`, `admin disable-user`, `admin create-vault`, plus… |
| OPS-19 | `11-operations-and-deployment.md` | CLI mutations record `actor_type='system'`, `credential_type='cli'`, and `context = {os_user, host, request_id, argv_shape}` (the command path with all values elided); the optional… |
| OPS-20 | `11-operations-and-deployment.md` | The prom-client catalogue is extended beyond the skeleton list with `iridium_build_info`, `iridium_docs_loaded_max`, `iridium_collab_state_bytes[_max]`, `iridium_collab_admission_refused_total`… |
| OPS-21 | `11-operations-and-deployment.md` | `infra/monitoring/alerts.yml` is a Prometheus rule file in which every rule names a runbook that exists; `ops.alert-rules.spec.ts` runs `promtool check rules` plus one unit test per rule against a… |
| OPS-22 | `11-operations-and-deployment.md` | `/metrics` returns 404 when neither `METRICS_TOKEN` nor `METRICS_ALLOW_CIDR` is configured |
| OPS-23 | `11-operations-and-deployment.md` | `/healthz` deliberately performs no database work, the container `HEALTHCHECK` uses it, and readiness instead refuses new `/collab` upgrades while `db_persist` fails |
| OPS-24 | `11-operations-and-deployment.md` | The readiness checklist adds `mysql_version` (OPS-62), `grants`, `key_versions`, `projection_workers`, `tls_cert`, and `access_log_partitions` (03 D03-03 / I-20) to the skeleton's set — sixteen checks, including `collab_owner_lease`. |
| OPS-25 | `11-operations-and-deployment.md` | The backup set is five artefacts (dump, attachments, archived binlogs, `secrets.age`, `manifest.json`), written all-or-nothing with a `.failed-<ts>` rename on any error, indexed in… |
| OPS-26 | `11-operations-and-deployment.md` | The dump is taken with `--source-data=2` (binlog coordinates recorded as a comment) and `--max-allowed-packet=1G`, and is streamed through `zstd -${BACKUP_ZSTD_LEVEL} -T${BACKUP_ZSTD_THREADS}` (OPS… |
| OPS-27 | `11-operations-and-deployment.md` | `restore --verify` has nine named invariants — eight fail-closed (exit `5`), with `projection_freshness` and the stale-projection case of `collab_loadability` as warnings that schedule… |
| OPS-28 | `11-operations-and-deployment.md` | Backups are scheduled by a systemd timer or cron, never by the in-process job scheduler |
| OPS-29 | `11-operations-and-deployment.md` | Release notes carry the operator flags `[migration]`, `[long-running]`, `[config]`, `[api]`, `[key]`, `[proxy]`, `[breaking-ops]`, and `release.yml` fails when a release contains migrations without… |
| OPS-30 | `11-operations-and-deployment.md` | Rollback is a decision tree, not a single procedure: no migrations → revert the image; expand-only migrations → revert the image and set `IRIDIUM_ALLOW_NEWER_SCHEMA=true`; contract or rewriting mig… |
| OPS-31 | `11-operations-and-deployment.md` | Three named sizing profiles (Evaluation / Team / Department) with explicit MySQL, heap, worker, pool, and admission-budget values, plus a per-table storage growth model; the admission budget and th… |
| OPS-32 | `11-operations-and-deployment.md` | The `audit_events` BEFORE UPDATE trigger signals unconditionally, while BEFORE DELETE signals unless the session variable `@iridium_audit_archive = 1`, which only `iridium audit archive` sets, only… |
| OPS-33 | `11-operations-and-deployment.md` | `access_log` partition maintenance follows 03-data-model.md D03-03 exactly: months are added by `REORGANIZE PARTITION p_overflow` (never `ADD PARTITION`, which a `MAXVALUE` partition forbids) up to… |
| OPS-34 | `11-operations-and-deployment.md` | Every scheduled job has a cadence, a role, `iridium_job_last_success_timestamp{type}`, and an `IridiumJobStale` alert at twice its cadence; jobs refuse to start while `/readyz` reports… |
| OPS-35 | `11-operations-and-deployment.md` | The enterprise checklist admits only two kinds of evidence — an automated check (test name or CI job) or a shipped artefact — and ends with a declared-gaps table naming each missing control and the… |
| OPS-36 | `11-operations-and-deployment.md` | Every runbook uses one six-heading template (Symptoms / What the system is already doing / Triage / Resolution / Verification / Follow-up) and carries two global prohibitions: never weaken durabili… |
| OPS-37 | `11-operations-and-deployment.md` | Single-note recovery follows an explicit ladder (incident backup → `doctor --heads` → `repair heads` → revision restore through the audited REST path → scratch-database recovery of the Markdown → f… |
| OPS-38 | `11-operations-and-deployment.md` | `docs/runbooks/cli.md` is generated from the command definitions (`iridium --help --json`) and `cli.contract.spec.ts` asserts the generated inventory matches the committed documentation |
| OPS-39 | `11-operations-and-deployment.md` | Commands added beyond A57's breadth list: `version`, `migrate status\|to\|ensure-guards\|grants --print`, `audit chain-status`, `access-log export`… |
| OPS-40 | `11-operations-and-deployment.md` | Closed binary logs are archived over the protocol — `mysqlbinlog --read-from-remote-server --raw --result-file <out>/binlog/` — which adds `REPLICATION SLAVE` to the `iridium_backup` grant list of… |
| OPS-41 | `11-operations-and-deployment.md` | The `ops` service mounts the host's `./secrets` directory read-write at `/secrets`, and `--secrets-dir` defaults to it (`/etc/iridium/secrets` under systemd). A `--secrets-dir` on the read-only roo… |
| OPS-42 | `11-operations-and-deployment.md` | Backup runs and restore drills are two different alerts on two different sources: `iridium backup --textfile-out <path>` writes `iridium_backup_last_success_timestamp`, `iridium_backup_bytes`, and… |
| OPS-43 | `11-operations-and-deployment.md` | `infra/docker/mysql/my.cnf` omits `default_authentication_plugin` (removed in MySQL 8.4.0; an unknown variable makes `mysqld` exit) in favour of `authentication_policy = caching_sha2_password`, omi… |
| OPS-44 | `11-operations-and-deployment.md` | One drain sequence, described once: 05-collaboration-and-durability.md owns the collaboration steps, 02-system-architecture.md the HTTP edge, and this section mirrors them. Connections close (4205)… |
| OPS-45 | `11-operations-and-deployment.md` | `init/01_roles.sh` additionally grants `BACKUP_ADMIN, SHOW_ROUTINE ON *.*` to `iridium_backup` — two more explicitly declared additions to skeleton A8's list, alongside OPS-40's `REPLICATION SLAVE…` |
| OPS-46 | `11-operations-and-deployment.md` | `iridium_job_interval_seconds{type}` joins the catalogue, published at boot from the scheduler's own table even when `JOBS_ENABLED=false`, and `IridiumJobStale` is… |
| OPS-47 | `11-operations-and-deployment.md` | Every rule in `alerts.yml` carries `annotations.iridium_doctor: instant \| prometheus-only`; `iridium doctor --alerts` scrapes `http://127.0.0.1:${PORT}/metrics` with `METRICS_TOKEN` (or reads… |
| OPS-48 | `11-operations-and-deployment.md` | The reference topology states how a scraper reaches `/metrics`: a dedicated Caddy `handle /metrics` route restricted with `remote_ip` to the monitoring CIDR (`respond 404` otherwise) with… |
| OPS-49 | `11-operations-and-deployment.md` | The shipped proxy configurations are validated, not just illustrated: `read_timeout`/`write_timeout` never appear inside Caddy's `transport http` (they are not transport options), no global… |
| OPS-50 | `11-operations-and-deployment.md` | Load shedding is configured from `PRESSURE_MAX_HEAP_BYTES` (default `floor(0.9 × v8.getHeapStatistics().heap_size_limit)`, measured at boot) and `PRESSURE_MAX_EVENT_LOOP_DELAY_MS` (1 000), with a… |
| OPS-51 | `11-operations-and-deployment.md` | Dump compression is `BACKUP_ZSTD_LEVEL` (12) and `BACKUP_ZSTD_THREADS` (2), the `ops` service carries `deploy.resources.limits` `cpus: "2.0"` / `memory: 2g`, and the backup timer adds `Nice=10` /… |
| OPS-52 | `11-operations-and-deployment.md` | Backup artefact 2 is `rsync -a --delete --link-dest <newest existing set>/attachments`; a set's attachment directory is a full logical copy and a near-zero incremental physical one; the off-host co… |
| OPS-53 | `11-operations-and-deployment.md` | `manifest.json` records `mysql_settings` (`innodb_ft_min_token_size`, `innodb_ft_enable_stopword`, `innodb_ft_server_stopword_table`, `character_set_server`, `collation_server`… |
| OPS-54 | `11-operations-and-deployment.md` | Any command whose correctness depends on MySQL session state checks out a dedicated connection for its whole run, sets the state on it, and clears it in a `finally` before release — destroying the… |
| OPS-55 | `11-operations-and-deployment.md` | `restore --verify-only` is defined as "run the nine invariants against the database the role URL points at, loading nothing" — the step after a manual load or a PITR replay. Proving a *backup set*… |
| OPS-56 | `11-operations-and-deployment.md` | Every committed `infra/` file boots as committed: the only placeholders allowed are the operator's `<org>` and `<digest>` in the server image reference, the Caddy pin lives as `CADDY_TAG`/… |
| OPS-57 | `11-operations-and-deployment.md` | The scheduled backup entry points are `infra/backup/backup.sh` (timer/cron: `umask 077`, timestamped `--out`, `flock -n`, `--textfile-out`, then `exec iridium backup … "$@"`) and… |
| OPS-58 | `11-operations-and-deployment.md` | `PROJECTION_WORKERS` defaults to `max(1, min(os.availableParallelism(), cgroupQuota()) - 1)`, where `cgroupQuota()` reads `/sys/fs/cgroup/cpu.max` (v2) or `cpu.cfs_quota_us`/`cpu.cfs_period_us` (v1… |
| OPS-59 | `11-operations-and-deployment.md` | This section's decision ids are `OPS-<nn>`, two digits, and are defined to be the same identifiers as `D11-<nn>` in the plan's dominant `D<NN>-<n>` scheme; the legacy prefix is retained rather than… |
| OPS-60 | `11-operations-and-deployment.md` | Desktop bundle integrity at 1.0 is SHA-256, lowercase hex, published three ways from one computation: `GET /desktop/updates/<channel>/SHA256SUMS` in `sha256sum` format… |
| OPS-61 | `11-operations-and-deployment.md` | Rolling a desktop fleet forward at 1.0 is the eight-step "Runbook: rolling a desktop fleet forward (1.0)", ending in the existing `minClientVersion` mechanism rather than a new one; a centrally man… |
| OPS-62 | `11-operations-and-deployment.md` | The `db` plugin reads `SELECT VERSION()` at boot and refuses to start unless the server is `8.4.x` (≥ 8.4.11) or `9.7.x` (≥ 9.7.2), exiting `2` with `config.mysql_unsupported` and printing the end-… |
| OPS-63 | `11-operations-and-deployment.md` | `manifest.json` records `mysql_line`, and `iridium restore` refuses to load a set into an older LTS line (`restore.mysql_line_downgrade`, exit `4`, no override); forward cross-line restore (an 8.4… |
| OPS-64 | `11-operations-and-deployment.md` | Deployment documentation states the supported clients in one table ("Supported clients"), reproduced verbatim in `docs/ops/deployment.md`: the desktop application is supported at 1.0, the web host… |
| D12-1 | `12-milestones.md` | Each milestone exit from M1 onward is tagged `v0.<N>.0` (`v0.1.0` at M1 through `v0.8.0` at M8's release candidate, then `v1.0.0` at M8 exit), cut by hand at the exit rather than by Changesets' `git-tag` (amended 2026-09-13), with one fixed version acr… |
| D12-2 | `12-milestones.md` | `release.yml` builds and publishes the server image (with SBOM and provenance) for every milestone tag from M1 onward, not only for `1.0.0`. No artefact is signed at 1.0 (G8); `release.yml` produce… |
| D12-3 | `12-milestones.md` | The Stryker `break` threshold ramps 70 (M1–M2) → 75 (M3–M7) → 80 (M8) on the mutated globs, and may only rise. |
| D12-4 | `12-milestones.md` | Every milestone exit from M1 onward writes `apps/server/test/fixtures/upgrade/v0.<N>.0/{dump.sql.gz, attachments/, manifest.json}` from that milestone's seeded dataset using `mysqldump` under the… |
| D12-5 | `12-milestones.md` | M0 spikes S1, S2 and S14 share one throwaway harness under `apps/server/test/spikes/`, which is deleted when M1's kernel replaces it. Spike code never becomes product code; a spike's outcome is a w… |
| D12-6 | `12-milestones.md` | M1 ships no user interface. If a visual demonstration is wanted at M1 it reuses the spike S4 Vitest Browser Mode page against the M1 server; no throwaway UI enters `@iridium/ui`, `apps/web` or… |
| D12-7 | `12-milestones.md` | Each §G question is bound to the entry of the milestone whose work it changes (table 13.1). If one were unanswered at that gate, the skeleton's default would be implemented, the alternative would b… |
| D12-8 | `12-milestones.md` | Every milestone exit writes `docs/milestones/M<N>-exit.md` with the fields of table 13.2 and is reviewed before the tag is cut. |
| D12-9 | `12-milestones.md` | `main` is protected from M0 and the required-check set equals the `ci.yml` job names, growing per table 13.3 and never shrinking. The set is exactly the union of the due entries of table 13.3 and 1… |
| D12-10 | `12-milestones.md` | No runtime feature flag is used to sequence milestones. An unfinished surface is simply not registered, and `GET /meta` `features[]` is the only capability signal a client may branch on. The settle… |
| D12-11 | `12-milestones.md` | The four proofs that cannot be automated are recorded under `docs/acceptance/` with artefact hashes, exact versions and the reviewer's role, and referenced from the milestone exit record (table 13.4). |
| D12-12 | `12-milestones.md` | Where the skeleton is terse about test names (`markdown.*`, `admin.*.integration`, the conformance and Inspector smokes, the packaged smoke, the component suite), this document fixes the exact name… |
| D12-13 | `12-milestones.md` | Offline-first editing is placed twelfth in the post-MVP roadmap, after the scaling epic, and is explicitly listed with its seams. |
| D12-14 | `12-milestones.md` | Test names in this document are always spelled `<name>.<layer>` using the layer segments of 10-testing-and-quality.md's file-name convention. Precedence is fixed in one order: the skeleton's spelli… |
| D12-15 | `12-milestones.md` | §4.4 is the single spike register for the whole plan: it carries the same ids, the same `Runs at` assignments and the same `docs/spikes/S<nn>-<slug>.md` filenames as the register in 14-risks-and-op… |
| D12-16 | `12-milestones.md` | CURRENT records the last exit; the effective validation target can enforce the next exit before that pointer advances. CI defaults to at least M1 and never targets an earlier milestone than CURRENT. |
| D12-17 | `12-milestones.md` | A spec §9 row proven in more than one host is retired at the milestone of its desktop proof, not its browser proof: Concurrent editing, Viewer enforcement and Live revocation move from M4 to M5, an… |
| D12-18 | `12-milestones.md` | Desktop code signing, installers and in-application updates are roadmap epic 14, entered when the two signing identities are provisioned rather than after epic 13, and they gate nothing in M0–M8. T… |
| D12-19 | `12-milestones.md` | Post-MVP epic numbers are stable identifiers, not positions. When §G-1's answer removed the OAuth epic from §14.2 the remaining epics kept their numbers, so the roadmap has no epic 1, and the epic… |
| D12-20 | `12-milestones.md` | M1 retains its explicit authenticated Schemathesis-light gate over M1 routes with a non-admin editor and 50 examples per operation; M2 expands that coverage. Full 500-example profiles are not an additional M1 exit gate. |
| D13-1 | `13-decision-log.md` | ADR files live at `docs/adr/NNNN-<slug>.md`, where `NNNN` is the skeleton id zero-padded to four digits (`A7` → `docs/adr/0007-kysely-migrations.md`). The limits policy `A.1` has no number of its o… |
| D13-2 | `13-decision-log.md` | Status vocabulary for ADRs is exactly `accepted`, `superseded by A<nn>`, `deprecated`. An accepted ADR's Decision text is never edited; a change is a new ADR that supersedes it, and the superseded… |
| D13-3 | `13-decision-log.md` | The 58 decisions are grouped into the eight areas listed in "Areas" (repository/toolchain/delivery; HTTP and data layer; collaboration and durability; identity and authorization; MCP and agent acce… |
| D13-4 | `13-decision-log.md` | Spike documents live at `docs/spikes/<slug>.md`, one per M0/M1 spike, and each must record the outcome and whether the ADR's recorded fallback was taken (for example… |
| D13-5 | `13-decision-log.md` | Test names follow `<area>.<subject>.<layer>` (for example `authz.vault-isolation.integration`, `collab.durable-ack.chaos`, `markdown.roundtrip.prop`), and the layer segment is never omitted. This l… |
| D13-6 | `13-decision-log.md` | An administrator-forced password reset (A28) revokes sessions but deliberately leaves integration tokens intact; killing an agent's access is the separate, explicit `iridium tokens revoke-all --user`. |
| D13-7 | `13-decision-log.md` | `iridium audit archive` (A46) writes a chain-boundary marker so `verify-chain` can start from the archive boundary and still verify both the archived and live segments; the boundary row's hash is r… |
| D13-8 | `13-decision-log.md` | `iridium restore --verify` (A47) samples `note_docs` for the Y.Doc round-trip check at a configurable rate (`RESTORE_VERIFY_SAMPLE`, default 100 % up to 5 000 notes, then 10 %); the sample rate and… |
| D13-9 | `13-decision-log.md` | `packages/ui`'s TanStack Router route-tree generation is a step of the root `pnpm gen` (A3), so a route change that is not regenerated fails the `gen-drift` CI job like any other contract change. |
| D13-10 | `13-decision-log.md` | The accessibility commitment (A55) is stated as "keyboard-complete, axe-core-checked, high-contrast and reduced-motion aware", explicitly not as WCAG 2.2 AA certification. Any certification is an e… |
| D13-11 | `13-decision-log.md` | The prompt-injection control statement (A57, T16) is that Iridium cannot prevent a model from following instructions embedded in note text; its controls are least privilege (A31: a token never exce… |
| D13-12 | `13-decision-log.md` | The "Decision-id prefixes" table near the top of this log is the complete registry of per-section decision-id prefixes, including the two that predate the dominant `D<NN>-<n>` form (`ARCH-` in 02… |
| D13-13 | `13-decision-log.md` | An owner answer that changes a settled decision becomes an ADR in Area 9. It takes an `AG<n>` id, numbered after the open question it answers, when it changes several ADRs in part (AG1, AG6), and t… |
| D13-14 | `13-decision-log.md` | The ADR status vocabulary gains a fourth form, `Superseded in part by <id> (<date>)`, which must name the clause it covers (A52: the `nightly.yml` cross-browser and MySQL 8.4.11 lanes; A53: the pac… |
| D13-15 | `13-decision-log.md` | Where two of the 2026-09-12 answers mint a section-level decision id in the same file, or where a specification's proposed id is already in use, the id moves to the next free number in that section… |
| D14-01 | `14-risks-and-open-questions.md` | Identifier namespaces are fixed and non-overlapping: `R-T`/`R-P`/`R-O` risks, `S` spikes, `ASM` assumptions, `G` the questions this plan put to the owner and the decisions that answered them… |
| D14-02 | `14-risks-and-open-questions.md` | The risk register is a machine-checked repository artefact: `docs/risks/register.yaml` is the source, `pnpm gen` renders `docs/risks.md`, and `risks.registry.spec.ts` (in the `static` CI job) asser… |
| D14-03 | `14-risks-and-open-questions.md` | Milestone risk gates: a milestone exits only when every risk whose "Retired at" names it is retired with links to the green runs, or explicitly deferred by the product owner with a recorded reason… |
| D14-04 | `14-risks-and-open-questions.md` | Every question's working default is encoded as a named flag, constant, CI lane or reserved column, never as an implicit assumption in code; when the question is answered, the encoding is inverted o… |
| D14-05 | `14-risks-and-open-questions.md` | `collab.clientid-stable.chaos` is committed in M1 regardless of whether Hocuspocus issue #845 reproduces: it types past `maxDebounce`, records observed `clientID`s, and asserts the Saved transition… |
| D14-06 | `14-risks-and-open-questions.md` | Monitored risks are re-evaluated on named trigger events, not on a calendar: `docs/dependency-watch.md` lists the events per risk, Renovate labels map a dependency to its risk id, and a fired trigg… |
| D14-07 | `14-risks-and-open-questions.md` | Assumption guards: each `ASM` row names the test, `/readyz` field or `iridium doctor` assertion that detects its violation; assumptions with no possible automated guard carry `verifiable: false` an… |
| D14-08 | `14-risks-and-open-questions.md` | `iridium doctor --stats` reports per-table row counts and bytes, `note_updates` rows per note per day, revision and checkpoint counts, snapshot size distribution, oversize notes, partition inventor… |
| D14-09 | `14-risks-and-open-questions.md` | Every Hocuspocus hook body is wrapped by a `withHookGuard` helper that can never reject (it converts failures into writer failure states, metrics and structured log events), asserted by… |
| D14-10 | `14-risks-and-open-questions.md` | Every metric-backed trigger in the register maps to an alert rule in `infra/monitoring/alerts.yml` carrying `annotations.risk`, asserted in both directions by `monitoring.alerts.spec`; this section… |
| D14-11 | `14-risks-and-open-questions.md` | Spike notes are gating artefacts: `docs/spikes/S<nn>-<slug>.md` with the fixed heading set (Question, Why it blocks, Pinned versions, Method, Result, Decision, Fallback executed, Follow-ups), check… |
| D14-12 | `14-risks-and-open-questions.md` | A release tag requires a green `ops.backup-restore.drill` from the most recent nightly run, a non-stale `iridium_backup_last_verified_timestamp`, and a verified audit chain; `release.yml` che… |
| D14-13 | `14-risks-and-open-questions.md` | Risks still open at the 1.0 tag are listed in `docs/risks.md` under "Accepted residual risk at 1.0", signed off by the product owner and security lead, and handed to the M8 external security review… |
| D14-14 | `14-risks-and-open-questions.md` | Likelihood and impact are scored with the scales defined in this section, re-scored only at a milestone gate, and every re-score is recorded in that gate's record with its reason. A risk whose *def… |
| D14-15 | `14-risks-and-open-questions.md` | An owner answer that goes further than the question asked is recorded with three parts: the answer in the owner's own words, the reading applied marked explicitly as an assumption, and the place th… |

Per file: 01 14, 02 29, 03 24, 04 32, 05 28, 06 36, 07 48, 08 33, 09 31, 10 42, 11 64, 12 20, 13 15, 14 15.

## D10-33 amendment: collaboration owner lease scope (2026-09-17)

**D10-33 amendment, 2026-09-17 — schema scope.** MySQL advisory-lock names are server-wide, so a constant name incorrectly excludes independent deployments and per-worker test schemas. `ownerLockName` is `iridium_collab_owner:` followed by the 43-character unpadded base64url SHA-256 digest of the canonical schema name read on the reserved connection. The complete name is 64 ASCII characters. Resolve that name through `information_schema.SCHEMATA WHERE SCHEMA_NAME = DATABASE()` so MySQL's database-name comparison rules apply. There is no caller-selected lock key or environment override. Servers using the same schema still compete for exactly one lease; separate schemas can serve concurrently. The reservation, zero wait, readiness retry, denial, and drain ordering remain unchanged. The source exposes the resolved name as `lease.lockName` for diagnostics. Acquisition failures and shutdown racing acquisition must return the reserved connection without leaving a lock held.
Verification: `collab.owner-lease.unit`, `collab.owner-lease.integration`, and the existing pending-migration case in `readyz.integration`; `kernel.smoke.integration` covers recovery after a killed owner. The full multi-process kill matrix remains the M1 exit requirement of `collab.second-process-refused.chaos`.

ADR mirror: [D10-33](../adr/d10-33-collaboration-owner-lease.md).

## OPS-12 amendment: serving SQL deadlines (2026-09-17)

**OPS-12 amendment, 2026-09-17: serving SQL deadlines.** `dbApp` and `dbPersist` enforce `DB_QUERY_TIMEOUT_MS` (default 10 000 ms, integer range 1 through 2 147 483 647) independently for each pool acquisition and SQL command. The mysql2 adapter destroys a connection before propagating `PROTOCOL_SEQUENCE_TIMEOUT`, removes its occupied slot and preserves that failure on subsequent commands. A late acquisition is released; idle reserved owner connections are not expired. A failed COMMIT has an unknown outcome, so the adapter does not retry it or claim rollback; saved acknowledgement and recovery continue to rely on committed replay and head-sequence checks. Maintenance and backup pools keep their separate long-running policies. The black-hole outage campaign exposed the missing bound: a TCP connection can remain open indefinitely while traffic stops, and the pinned driver's query-timeout callback does not itself destroy that connection.

ADR mirror: [OPS-12](../adr/ops-12-serving-sql-deadlines.md).

## D10-33 amendment: standby product traffic (2026-09-17)

**D10-33 amendment, 2026-09-17: standby product traffic.** A serving process without the schema owner lease exposes operational endpoints but refuses product traffic, including committed REST reads, with `503 not_ready`; `/collab` retains `4503 no-owner-lease`. This supersedes the earlier allowance for committed REST reads on a standby. A second process accepting authorization mutations would update its own process-local epoch table without fencing the active owner's sockets. The one-owner deployment therefore hands all product traffic to the active owner, retries acquisition through readiness, and enables the standby only after ownership is established. Operator session-revocation commands are executed by that owner or under an exclusively acquired offline owner lease; asynchronous notification alone is insufficient for the immediate post-COMMIT write guarantee.

ADR mirror: [D10-33](../adr/d10-33-collaboration-owner-lease.md).

## D10-33 amendment: outage recovery observation (2026-09-20)

Status: accepted, amended 2026-09-20.

The first complete remote matrices expose a conflict in CH-6: its 30 s recovery assertion predates
the ownership-loss exception, whose automatic document and socket retries may wait up to 60 s and
30 s respectively (05). In run `35478972790`, MySQL 8.4 job `105993370481`, two clients save after
readiness recovers and the third is still disconnected in that retry window. Keep 30 s for an
intact owner. After an observed owner-lease loss, allow 75 s from database restoration: 60 s for
the document ladder, one 5 s readiness tick and 10 s for admission and durable save. Socket retries
proceed independently. The test must use the unchanged product retry policies, original documents
and undo managers, prove every edit commits once, and retain its 180 s overall deadline. This is
an explicit acceptance-deadline amendment, not a claim that the original run passed.

ADR mirror: [D10-33](../adr/d10-33-collaboration-owner-lease.md).

## D04-14 amendment: owner-executed authorization changes (2026-09-17)

`AuthzBus` starts subscribers synchronously in fixed order and offers acknowledged completion. Existing-principal authorization mutations fence admission and drain already accepted writer updates before COMMIT. Separate CLI session revocation is durable intent executed by the serving owner, with the same shared owner-generation lock and an atomic durable result. Unknown outcomes retain the admission fence until a locking read proves the previous transaction ended; CLI commands read their durable result and REST recovery independently checks every actual connection's session, user and membership. A rolled-back change does not invent a revocation event. Ordinary collaboration messages retain their zero-I/O path.

Every mutating HTTP request captures its immutable ownership fence before asynchronous authentication. Its business transaction takes the shared generation lock first, so a queued old request cannot adopt a successor's generation, while takeover waits for already admitted transactions to finish. Writers, compaction, direct edits and repair retain their own captured generation for the same reason.

ADR mirror: [D04-14](../adr/d04-14-owner-executed-session-revocation.md). Proofs: `authz.mutations.unit`, `authz.session-command-fence.unit`, `authz.session-revocations.unit`, `rest.ownership.unit`, `cli.live-revocation.integration`, `collab.owner-lease.integration`, and `collab.revocation-race.chaos`.

## D05-06 amendment: transient collaboration dependency failures (2026-09-17)

A classified database acquisition, SQL timeout or transport failure during authentication, permission revalidation or document load yields `unavailable` (4503). A lost ownership generation yields `no-owner-lease`; actual missing or revoked credentials and absent or corrupt documents keep their existing refusals. The client maps `unavailable` to `disconnected` and re-attaches with the existing 5 s to 60 s backoff while retaining its document, undo and pending edits. It does not infer session expiry or probe `/auth/me` from this refusal. The 200-connection latency campaign exposed the previous terminal `note-not-found` mapping after pool acquisition timed out.

ADR mirror: [D05-06](../adr/d05-06-transient-collaboration-failures.md). Proofs: `collab.persistence-hook.unit`, `collab.auth-hook.unit`, `close-policy.unit`, `save-state.unit`, `save-state.machine.prop`, and `note-session.unit`.

## D12-20: Schemathesis milestone scope (2026-09-17)

The original M1 exit table (§5.4 of `12-milestones.md`) explicitly requires a clean light run, while §6.2 and §13.3 describe its introduction at M2. Preserve the explicit M1 exit requirement: use all checks and phases with 50 examples per shipped M1 operation, a non-admin editor, and admin/test-only paths excluded. The separate administrator performs fixture setup and schema export only. M2 expands that existing gate to its new route set. Full 500-example administrator and outsider profiles remain distinct nightly coverage and add no M1 exit requirement. This resolves the contradictory schedule without inventing an unauthenticated M1 substitute or claiming a run that has not happened.

ADR: [D12-20](../adr/d12-20-schemathesis-milestone-scope.md). Proofs: `schemathesis.light.contract` and `testkit.schemathesis.unit`.


## M1 independent-review amendments (2026-09-18)

**OPS-12, superseded in part on 2026-09-18.** The 2026-09-17 SQL-deadline amendment above allowed 1 ms and did not order lock waits before the driver deadline. The supported minimum is now 2000 ms. Both serving pools set InnoDB and metadata lock waits to `floor(DB_QUERY_TIMEOUT_MS / 2000)` seconds; transaction scopes only lower and then restore that baseline. A server lock refusal reaches `503 busy`; a command timeout with an unknown outcome remains `503 unavailable`. `db.lock-timeout.integration` proves server lock refusal, complete rollback and physical-connection reuse at the default and minimum for both pools on both required engines. `db.query-deadline.unit` separately proves that an uncertain COMMIT deadline is preserved as unknown; the live lost-result recovery case is `collab.commit-reconcile.integration`.

**OPS-11 / D03 grant evidence, amended.** Applied migration history is not grant evidence. Forward `0054_grants_provenance` reapplies the full matrix and stores applied/skipped fingerprints under `schema_meta.acl.<table>`; serving-role critical privilege probes fail readiness ahead of provenance warnings. A DBA repair can recover a failure to a warning without rewriting a historical skip. M1 does not claim the future `doctor --db-roles` verifier exists. `db.grants-provenance.integration` proves the upgrade, withheld GRANT OPTION, missing accounts and effective-privilege failures/recovery on both engines.

**D05-16 / D05-18, amended.** Chunked insertion refuses an enclosing Yjs transaction; server repair uses a fenced gateway method outside `DirectConnection.transact`. Awareness accounting validates the entire bounded multiplexing key before retention and bounds active windows per physical socket with expiry independent of authentication. These replace the earlier descriptions that allowed nested chunking or unbounded raw document keys.

**D05 persistence recovery, clarified.** A live writer retains the exact submitted attempt across an unknown COMMIT outcome. Advanced heads reconcile only against byte- and attribution-identical durable rows while holding the current generation fence and head lock; unexplained divergence still fails closed. Unload intent survives every asynchronous read and retries while idle; the failure log is emitted once per failure episode. Historical mutation score reuse is labelled as reuse; reopening M1 requires a fresh full configured run with no reused mutant results.

**D10 / D12 acceptance and client lifetime, clarified.** Guards enforce every scheduled due name in the complete test inventory, not only acceptance rows. Explicit feature-owner milestones govern later work, and CI targets M1 before the last-exited marker changes. M1 owns `NoteSessionRegistry` kernel lifetime; M4 integrates desktop tabs and their idle release. Session-route method/principal validation runs before policy-variant early returns, public routes cannot satisfy admin step-up, and token writes remain refused at both boot and request time.

**ARCH-19 REST store, implemented.** M1 binds the production REST limiter to the bounded `InMemoryRateLimitStore` through `FastifyFixedWindowStore`. Fixed windows and per-route isolation preserve the installed adapter's behavior; the clock is injected, resolved maximum changes retain the same counter, and each store retains at most `REST_RATE_LIMIT_CACHE_MAX_ENTRIES` (5000) least-recently-used keys. The generic consume/reset contract and actual HTTP adapter are both exercised. Persistent login-failure throttling and the ticket IP budget retain their existing owners.

**A54 client compatibility, implemented.** Forward migration `0055_min_client_version` seeds the release-controlled floor without replacing an existing value. `GET /api/v1/meta` and the gate read the committed `schema_meta.min_client_version`; there is no stale in-process floor. A presented well-formed semantic version below it receives `426 client_outdated` with the current floor as detail, on reads and writes. An absent header preserves existing non-Iridium callers; malformed explicit versions receive the existing `422 validation_failed`. Authentication and CSRF precede this lookup, operational endpoints preserve their liveness contracts, and GET meta remains the discovery exemption. The API-version response header is emitted for early refusals too.

**D10 mutation report isolation, clarified.** Stryker's project walker does not consult `.gitignore`. Root `reports/` contains output artifacts and sealed historical checkouts, so it is excluded from sandbox inputs. The installed ProjectReader comparison proves the same 85 configured mutation sources and 149 selected unit files before and after this output-only exclusion; 8696 historical artifact files are removed from the copy. Mutation globs, test selectors, thresholds, concurrency and deadlines are unchanged. These counts describe that comparison's checkpoint; the fresh runner recaptures the final source inventory.

**A51 resource and milestone selection, amended.** Ordinary test forks default to `UV_THREADPOOL_SIZE=8` before Node starts and at most `min(4, availableParallelism())` workers. CI sets the same libuv pool, and the mutation entrypoint sets it before its child process starts because Stryker uses worker threads. Retry, pressure thresholds, property budgets and coverage thresholds are unchanged. The requested target milestone, never earlier than CURRENT, governs due tests and exit coverage; CI defaults to M1 while CURRENT still names M0, then never downgrades an exited milestone.


### A19 amendment (2026-09-18): deletion-aware Saved acknowledgements

A real held-COMMIT regression found that a pure deletion leaves Yjs state-vector clocks unchanged, so the vector-only Saved predicate could accept its old baseline after transport acknowledgement. The v1 `persisted` message now requires `ds`, a fixed lowercase SHA-256 fingerprint of the canonical Yjs delete set, captured beside the vector for the same accepted update. Saved and the close warning require vector dominance plus exact delete-set fingerprint equality. Retried batches retain their captured pair; unloaded baselines replay a complete committed prefix. No SQL column or CRDT metadata is added. This pre-release protocol correction ships the server and clients together. The runtime adapter and hostile/missing witness tests live beside the existing protocol tests, with real held-COMMIT deletion coverage in `collab.deletion-durability.integration`.

The same review moves repair's pre-restore revision into the writer FIFO. It snapshots an independently replayed committed prefix under the owner fence and head check, then refuses the repair before mutation if the live document changed while awaiting that checkpoint. Comparison includes the delete set, so a deletion-only change cannot escape the check.


## D10-25 amendment: nightly chaos runner budget (2026-09-20)

The first remote nightly `35475597877` cancels serial chaos job `105984200183` at its four-hour
deadline. Preserve that failure and every scenario, iteration count and per-case deadline.
Both supported engines now divide the complete chaos project into four Vitest file shards,
with a three-hour target and 240-minute deadline per shard. The M1 inventory partitions all
14 files exactly once into groups of 4, 4, 3 and 3; the long revocation and durability files
fall on different runners. All shards must pass, and fail-fast remains disabled.
The other-engine property and Schemathesis campaigns also run independently instead of
skipping after an earlier failure; their existing 300-minute deadlines and budgets stay intact.
This supersedes the original two-job suggestion, whose grouping retains both longest files
together. Selection verification alone does not establish a passing nightly.

ADR mirror: [D10-25](../adr/d10-25-nightly-chaos-budget.md).

Scheduled nightlies remain serialized. Manual rehearsals use independent concurrency groups
to validate a repaired captured commit while preserving an older run's unfinished evidence.


### OPS-04 amendment (2026-09-20): exact SBOM component identity

Retain the signed client RPM's version/file-ownership database and license/README beside
the three extracted MySQL executables. Metadata-only RPM installation disables package
scripts and triggers; the RPM tool stays in the extraction stage. The first Grype scan
identified the bare executable as `mysql 9.7`, losing its actual `9.7.2` patch revision.
Syft's authoritative OS-package ownership replaces that heuristic with the exact signed
package metadata. No vulnerability is suppressed or waived. Runtime assembly applies
available Debian package updates and removes unused npm/Corepack/Yarn from the Node base,
fixing the scan's high findings in bundled npm dependencies and `libpcre2-8-0`.
The release's Grype high-severity, fix-available gate remains unchanged.

ADR mirror: [OPS-04](../adr/ops-04-mysql-client-packaging.md).

### D10-6 amendment (2026-09-20): select the acknowledged revision at the wire fault

Status: accepted. The second remote nightly's fourth chaos shards (`106018032722` /
`106018032782`, run `35488088005`) each fail 397 durable-ack cases. Nightly database latency
allows a real client's baseline probe to receive an older committed acknowledgement before
the new edit commits. Both the next-frame observation and an unqualified post-ack kill can
therefore select the wrong revision.

The two existing wire faults accept an optional runtime-only `ack: { noteId, afterSeq }`
selector. Validation and lifetime consumption remain in the one fault registry; the socket
passes the decoded frame's actual note and sequence synchronously after sending it. Nonmatching
frames leave the point armed. The client observation uses the same committed sequence floor.
The selector changes neither the protocol nor production behavior, and does not disable the
client's baseline probe or change the latency, crash methods, iteration counts or durability
assertions. Other points reject it; spawn-time serialization cannot silently omit it.

At maximum injected SQL latency, a separate diagnostic records an uncommitted new revision,
live process and no fired fault or persistence error when the old 30-second observation ends.
Nightly CH-1 allows 90 seconds to observe the acknowledgement within the unchanged 180-second
case deadline; normal CI remains 30 seconds. Product statement and retry deadlines are unchanged.

ADR mirror: [D10-6](../adr/d10-6-targeted-ack-faults.md). Regression proofs:
`ops.faults.unit`, `testkit.fault-registry.unit`, `routes.test-namespace-absent.integration`
and `collab.durable-ack.chaos`.

## ARCH-02 amendment: readiness probe lifecycle (2026-09-20)

Concurrent HTTP, boot and periodic readiness callers share one complete serial evaluation.
The next call after completion starts a fresh scan; failed outcomes do not become a persistent
cache, and completion during drain cannot reopen admission. This prevents the five-second
recheck from multiplying database borrowers during slow or blackholed connections. All check
names, order, thresholds and fail-closed decisions remain unchanged.

Fastify's plugin/onReady timeout is explicitly 60 seconds in every server mode. CH-16's
up-to-500 ms database latency makes the sixteen-check initial scan exceed the framework's
ten-second default. The new bound matches the existing child startup handshake; listening
still follows complete boot, and the chaos scenario, iterations and case deadline are unchanged.

ADR mirror: [ARCH-02](../adr/arch-02-readiness-probe-lifecycle.md). Regression proofs:
`ops.readiness.unit`, `ops.shutdown.unit`, `readyz.integration`,
`collab.second-process-refused.chaos` and `collab.db-outage.chaos`.

### OPS-04 amendment (2026-09-20): both published platforms are measured

Status: accepted. Release scans select AMD64 and ARM64 explicitly using Syft's and Grype's
platform settings at the same pushed manifest-index digest. Separate reports prevent one
architecture's evidence from overwriting the other; each retains the `high` / `only-fixed`
gate. The action inputs pin Syft 1.52.0 and Grype 0.119.0 to the exact preflight tools rather
than action-bundled defaults. Image hygiene executes the server version/commit and shipped MySQL client on both
platforms, and artifact upload retains partial reports on failure. An implicit native-platform
scan cannot certify both published images. `guards.release-policy.guard` rejects missing,
disabled or weakened platform scans and colliding SBOM artifact names.

ADR mirror: [OPS-04](../adr/ops-04-mysql-client-packaging.md).

## OPS-12 amendment: InnoDB timeout-sweep margin (2026-09-20)

The supported minimum for `DB_QUERY_TIMEOUT_MS` is now **3000 ms**. The default remains
10 000 ms, the maximum remains 2 147 483 647 ms, and serving lock waits remain
`floor(DB_QUERY_TIMEOUT_MS / 2000)` seconds. This is a pre-release configuration-boundary
correction; explicit values below 3000 are rejected rather than silently clamped.

MySQL 8.4.11 and 9.7.2 check expired InnoDB lock waits in a once-per-second sweep. A nominal
one-second lock wait can therefore be reported near two seconds, leaving no response margin
under the former two-second command minimum. Actual Actions check
[106060922722](https://github.com/Mythikos/iridium/actions/runs/35504070807/job/106060922722)
observes `PROTOCOL_SEQUENCE_TIMEOUT` instead of `ER_LOCK_WAIT_TIMEOUT` in the held audit-head
case. Its failed run and the previously passing runs remain unchanged.

The new minimum reserves one second each for the lock wait, the regular sweep, and delivery
of the refusal. Scheduler or network stalls and multiple waits may still exhaust the total
command budget; those remain `503 unavailable`, and an uncertain COMMIT is never described
as rolled back. No failure mapping, driver destruction, retry policy or test assertion is
weakened. Maintenance/backup commands and idle owner reservations retain their own policies.

`db.session-policy.unit` checks the sweep and response allowance at the minimum and other
budget boundaries; its new regression fails with zero remaining margin under the old minimum.
`config.env.unit` rejects the old range. `audit.bounded-failures.integration` and
`db.lock-timeout.integration` retain exact server 1205, transaction rollback, connection reuse,
chain verification and caller-owned exact-once retry assertions on both supported engines.

Primary implementations: [MySQL 8.4.11](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/lock/lock0wait.cc#L1353)
and [MySQL 9.7.2](https://github.com/mysql/mysql-server/blob/mysql-9.7.2/storage/innobase/lock/lock0wait.cc#L1353).

ADR mirror: [OPS-12](../adr/ops-12-serving-sql-deadlines.md).

### OPS-04 amendment (2026-09-20): the release runner owns a multi-platform image store

Status: accepted. The first tagged release builds and scans both platforms, but the hosted
runner's Docker 28.0.4 classic overlay2 store cannot load ARM64 after AMD64 under the same
manifest-index digest: Docker refuses to overwrite that digest before ARM64 executes.
The release runner now uses the official, commit-pinned Docker setup action with Docker
29.8.1 and the containerd snapshotter explicitly enabled, followed by QEMU and Buildx.
The shared image-hygiene action still executes both server identities and shipped 9.7 clients
at the original immutable index digest; its version and full source-commit comparisons remain
mandatory. No platform or assertion is removed.

The read-only `release-image-check.yml` workflow can execute that same hygiene action against
an existing product tag and image digest after a workflow repair. It checks a detached copy
of the tagged tree through the existing release-policy inspector, and records the source
commit separately from the workflow commit. It cannot build, publish or move tags. Its result
supplements the original tagged-tree verification, SBOMs and scans; it does not relabel an
earlier failed release as green or supply those other proofs. Both run IDs belong in the
release evidence. The original tag and image digest remain unchanged.

Primary source: [Docker's GitHub Actions multi-platform image-store guidance](https://docs.docker.com/build/ci/github-actions/multi-platform/).
