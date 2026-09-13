# M0 exit record

Written per 12-milestones.md §13.2 (decision D12-8) at the exit of milestone M0 on 2026-09-13.

| Field | Content |
|---|---|
| Commit and tag | The milestone commit is `71915f5` (`feat: land milestone M0 (contracts, crdt, testkit, server core, infra, codegen, spikes)`, on top of the bootstrap commit `90a3ec6`). This record and the four spike notes that name that commit land in the following commit, which carries the tag `v0.0.0`. |
| Milestone pointer | `docs/milestones/CURRENT` reads `M0` — set at bootstrap and unchanged, because `CURRENT` names the last exited milestone and M0 is the first. M1 work begins without touching it; the M1 exit advances it. |
| Exit tests | No continuous-integration run exists yet: the repository has no remote at M0, so every lane of `ci.yml` was run locally on the milestone commit's tree on 2026-09-13 (Windows 11, Node 24.21.0 through mise, pnpm 12.4.1, Docker Desktop). The table below names each exit test of §4.6 with the command that proved it. The first push to a remote must show `static`, `unit (ubuntu-latest, windows-latest)`, `integration (mysql:8.4.11, mysql:9.7.2-oraclelinux9)`, `e2e-electron (ubuntu, windows, macos)` and `merge-reports` green before branch protection is enabled (§13.3). |
| Cross-cutting gates | See "Gates" below. |
| Spec rows | None retired; §4.7 lists none for M0. Coverage extended: none — the acceptance rows begin at M1. |
| Spikes | S1 pass, S2 pass, S3 pass, S6 pass, S8 pass, S14 pass. S4, S5, S7 and S13 fail with their recorded fallbacks executed by commit `71915f5` (each note's "Fallback executed" section names it; `docs.spikes.guard` asserts the reference). |
| ADRs | None numbered anew. Amended: A2 (2026-09-13: `tooling/api-codegen` as the second consumer of the TypeScript 6 alias, the mutation lane's own Vitest 4 companions); A52 / D10-12 (BlueOak-1.0.0 added to the licence allowlist); A15's "order of magnitude" claim re-measured by S1 (1.6–1.75×); R-T22 re-scored by S6. |
| Open questions | None of the eight §G questions was reopened. Raised after 2026-09-12: **which licence, if any, the OpenAPI document should declare** — Redocly's `info-license` rule warns while `info.license` is absent; the default carried forward is "none declared, warning tolerated" until the owner names one. |
| Deferred items | (1) `apps/server/src/authz/route-policy.ts` has no unit-project coverage, so the mutation lane scores it 0 %; M1's authz work adds it before the M1 mutation gate. (2) `@fastify/swagger` registers inside the `rest` plugin at M1; until then `src/ops/openapi.ts` is reached only by the `pnpm gen` export and is listed in `knip.jsonc`. (3) The declared-ahead dependency lists in `knip.jsonc` shrink as milestones import their packages; the M1 exit review deletes the entries knip's hints report. (4) The two unused `securitySchemes` Redocly warns about become used with M1's routes. (5) `minimumReleaseAgeExclude` in `pnpm-workspace.yaml` empties after 2026-09-14. |
| Known risks carried forward | R-T10 now has two isolated consumers of the TypeScript 6 alias (A2 amendment). R-T22 is re-scored: k6 2.2.0's `crypto.getRandomValues` fills one byte per element, so every k6 script assigns `Y.Doc.clientID` itself (S6). S1 measured the V2 snapshot at 1.6–1.75× smaller than V1, not an order of magnitude; A15's sizing assumptions are adjusted in 05. S2 recorded that document-level closes never transport the 4403 codes through the provider and that the root rate limiter and Host guard run on upgrades. S14 recorded that a thrown MCP factory is answered by the SDK itself under `toNodeHandler`, which is why the web-standard face is adopted. |

## Exit tests (§4.6)

| Test | Proved by |
|---|---|
| `deps.single-instance.guard` | `pnpm exec vitest --run --project guard` — 11 tests, pass |
| `authz.route-policy.boot.guard` | guard project — 17 tests, pass; `readyz.integration` on both images exercises the boot assertion |
| `config.env.unit` | `pnpm exec turbo run test` — 43 tests, pass |
| `turbo boundaries` | `pnpm exec turbo boundaries` — 409 files in 20 packages, no issues; a violating import fails the step (probed with a throwaway `react` import under apps/server during the gate) |
| `tokens.format.unit`, `tokens.format.prop`, `tokens.verify.unit`, `authz.matrix.unit`, `contracts.ids.unit`, `contracts.ids.prop`, `contracts.paths.unit`, `contracts.paths.prop` | unit project — 170 contracts tests, pass |
| `crdt.codec.prop`, `crdt.dominates.prop`, `crdt.prefix-suffix-diff.prop`, `crdt.guards.unit` | unit project — 53 crdt tests, pass |
| `migrations.integration` | `IRIDIUM_MYSQL_IMAGE=mysql:8.4.11` and `mysql:9.7.2-oraclelinux9`, `--project integration --project contract --project mcp --project property` — 42 tests each, pass |
| `db.dialect-floor.guard` | guard project — 4 tests, pass |
| `migrations.parity.integration` | both integration lanes — pass |
| `db.version-floor.integration` | both integration lanes — pass (refuses `mysql:8.0` and an innovation release with exit 2) |
| `readyz.integration` | both integration lanes — 16 tests, pass |
| `desktop.webPreferences.guard` | guard project — 4 tests, pass |
| `desktop.launch.e2e` | `pnpm exec playwright test --project=electron --grep @smoke` against the built server with `IRIDIUM_MIGRATE_ON_BOOT=true` on a bare `mysql:8.4.11` — 2 passed |
| `gen.drift.guard` | `pnpm gen` twice: every artefact `current` on the second run; `pnpm gen:check` is meaningful from this commit on |
| `docker-image` | `docker build -f infra/docker/server.Dockerfile -t iridium-server:ci .` — 514 MB image; `docker run … iridium-server:ci migrate status` → `{"status":"current","applied":48}` |
| `docs.spikes.guard` | guard project on the exit-record commit — pass (fails by design on `71915f5` alone, because a `fail` note must name the commit that executed its fallback, and that commit cannot name itself) |

## Gates (§3, as run on 2026-09-13)

| Gate | Result |
|---|---|
| `pnpm install --frozen-lockfile` | pass |
| `pnpm exec turbo run build check-types lint test` | 55 tasks, pass, 0 lint warnings |
| `pnpm exec tsc -b --builders 8` | pass |
| `pnpm exec oxlint -c oxlint.config.ts --type-aware .` | pass |
| `pnpm exec oxfmt --check .` | pass |
| `pnpm exec knip --production` | pass |
| `pnpm exec turbo boundaries` | pass |
| `pnpm exec redocly lint … --extends recommended` | valid; 3 warnings (`info-license`; two `securitySchemes` unused until M1's routes) |
| `node scripts/check-licenses.ts` … `check-test-name-references.ts`, `build-acceptance-map.ts --check` | pass |
| `pnpm audit --audit-level high` | pass (3 moderate findings in Stryker's `typed-rest-client` → `qs`, tooling only) |
| `pnpm dedupe --check` | pass |
| Mutation lane (`pnpm --filter @iridium/mutation run mutation`) | 72.95 % over the full register, above `break` 70; packages 84.8 %, `route-policy.ts` 0 % (deferred item 1) |
| Component project | no test files yet (M4) |
