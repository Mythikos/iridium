# M0 exit record

Formal closure recorded on 2026-09-20 (UTC), before the M1 exit.
The original bootstrap implementation was `71915f5`; the remote proves the cumulative tree at
commit `efa6de83b0cb5b28bc069cc32544787a89471f74`, including the already-landed M1 kernel and CI repairs.
This record is the second commit of the landing sequence. Hand-cut marker `v0.0.0` targets
the commit adding this formal section; it publishes no artifacts. `CURRENT` remains `M0`.

The passing source run is [CI 35485518914](https://github.com/Mythikos/iridium/actions/runs/35485518914). These are actual Actions check-run IDs,
including both required database engines and all three Electron runners.

| Required check | Check-run ID | Result |
|---|---|---|
| `static` | [106011045588](https://github.com/Mythikos/iridium/actions/runs/35485518914/job/106011045588) | Pass |
| `unit (ubuntu-latest)` | [106011279899](https://github.com/Mythikos/iridium/actions/runs/35485518914/job/106011279899) | Pass |
| `unit (windows-latest)` | [106011279963](https://github.com/Mythikos/iridium/actions/runs/35485518914/job/106011279963) | Pass |
| `integration (mysql:8.4.11)` | [106011279897](https://github.com/Mythikos/iridium/actions/runs/35485518914/job/106011279897) | Pass |
| `integration (mysql:9.7.2-oraclelinux9)` | [106011279895](https://github.com/Mythikos/iridium/actions/runs/35485518914/job/106011279895) | Pass |
| `e2e-electron (ubuntu-latest)` | [106011279966](https://github.com/Mythikos/iridium/actions/runs/35485518914/job/106011279966) | Pass |
| `e2e-electron (windows-latest)` | [106011279943](https://github.com/Mythikos/iridium/actions/runs/35485518914/job/106011279943) | Pass |
| `e2e-electron (macos-latest)` | [106011279900](https://github.com/Mythikos/iridium/actions/runs/35485518914/job/106011279900) | Pass |
| `merge-reports` | [106015500694](https://github.com/Mythikos/iridium/actions/runs/35485518914/job/106015500694) | Pass |

### Current exit proofs

| Named exit tests | Due lane | Remote proof |
|---|---|---|
| `deps.single-instance.guard` | `static` | [35485518914](https://github.com/Mythikos/iridium/actions/runs/35485518914) |
| `authz.route-policy.boot.guard` | `static` + `integration` | [35485518914](https://github.com/Mythikos/iridium/actions/runs/35485518914) |
| `config.env.unit` | `unit` | [35485518914](https://github.com/Mythikos/iridium/actions/runs/35485518914) |
| `turbo boundaries` (a step of the `static` job, not a spec file) | `static` | [35485518914](https://github.com/Mythikos/iridium/actions/runs/35485518914) |
| `tokens.format.unit`, `tokens.format.prop`, `tokens.verify.unit`, `authz.matrix.unit`, `contracts.ids.unit`, `contracts.ids.prop`, `contracts.paths.unit`, `contracts.paths.prop` | `unit` [ubuntu, windows] (the pure `.prop` files run in the same project at the `PROP` budget — 200 runs in this CI run) | [35485518914](https://github.com/Mythikos/iridium/actions/runs/35485518914) |
| `crdt.codec.prop`, `crdt.dominates.prop`, `crdt.prefix-suffix-diff.prop`, `crdt.guards.unit` | `unit` (pure package properties) | [35485518914](https://github.com/Mythikos/iridium/actions/runs/35485518914) |
| `migrations.integration` | `integration (mysql:8.4.11)` and `integration (mysql:9.7.2-oraclelinux9)`, both required | [35485518914](https://github.com/Mythikos/iridium/actions/runs/35485518914) |
| `db.dialect-floor.guard` | `static` | [35485518914](https://github.com/Mythikos/iridium/actions/runs/35485518914) |
| `migrations.parity.integration` | `integration (mysql:8.4.11)` and `integration (mysql:9.7.2-oraclelinux9)` | [35485518914](https://github.com/Mythikos/iridium/actions/runs/35485518914) |
| `db.version-floor.integration` | `integration` | [35485518914](https://github.com/Mythikos/iridium/actions/runs/35485518914) |
| `readyz.integration` | `integration` | [35485518914](https://github.com/Mythikos/iridium/actions/runs/35485518914) |
| `desktop.web-preferences.guard` | `static` | [35485518914](https://github.com/Mythikos/iridium/actions/runs/35485518914) |
| `desktop.launch.e2e` | `e2e-electron` [ubuntu, windows, macos] | [35485518914](https://github.com/Mythikos/iridium/actions/runs/35485518914) |
| `gen.drift.guard` | `static` | [35485518914](https://github.com/Mythikos/iridium/actions/runs/35485518914) |
| `docker-image` (a workflow gate rather than a spec file, so it carries no layer suffix — 10-testing-and-quality.md owns its lane) | `integration` (the job's `docker build -f infra/docker/server.Dockerfile -t iridium-server:ci .` step, which the `container`-mode suites need); release publishing begins at M1 and is not an M0 proof | [35485518914](https://github.com/Mythikos/iridium/actions/runs/35485518914) |


The same run proves build/types/lint on Linux and Windows; static format, Knip, boundaries, dependency
identity, generated artifacts, licenses, registry audit, environment lists and acceptance inventory;
and the image build plus non-root/read-only-root runtime smoke on each MySQL line. All 55 cumulative
migrations include and revalidate M0's original 48. Coverage is measured under the stricter M1 gate
in `merge-reports`; M0 itself had no enforced coverage or mutation threshold.

The first actual nightly is [35475597877](https://github.com/Mythikos/iridium/actions/runs/35475597877).
Its observed failures, remaining status and repairs are tracked in [remote-ci.md](remote-ci.md).
There was no earlier nightly history; this is not a claim of established green nightly health.
The three-consecutive-failure exit rule has no three-run window yet.

### Decisions and carried work

- Spec rows: none retired at M0. The cumulative headless proofs belong to M1.
- Spikes: S1/S2/S3/S6/S8/S14 pass; S4/S5/S7/S13 fail with their recorded fallback implemented in
  `71915f5`. The required three-OS Electron run completes S3's remote Origin/launch proof.
- ADRs and risks: the original A2/A15/A52 and R-T10/R-T22 dispositions remain in the preserved
  record below. CI runner and dependency-lifecycle corrections are documented in the remote log.
- Questions: D01-15 records the owner's Elastic License 2.0 choice, including the OpenAPI SPDX
  identifier. The earlier unspecified-license warning is resolved. The owner still needs to clarify
  any literal MySQL 8.0 requirement; the supported engines remain 8.4 and 9.7.
- Deferred: branch protection and PR workflow await an owner instruction restoring them. Work is
  committed directly to main. M1's pending changeset is consumed only after this predecessor closes.
- Outstanding as directed: local macOS Electron (no local macOS environment) and a fresh local
  `pnpm audit` (egress approval). Remote macOS and remote static audit results are separately proven
  above and do not relabel either local limitation as completed.

The following dated candidate and local measurements are retained as history. Statements that
formal exit was pending describe those earlier reviews; the formal closure above supersedes them.

## Preserved candidate record

Prepared on 2026-09-13 as an M0 exit candidate using the fields of 12-milestones.md §13.2 (D12-8), and revised after local review. Formal exit remains pending: a green remote required-check run and `v0.0.0` are not verified. Remote attempts are now recorded in [remote-ci.md](remote-ci.md); the owner has deferred branch protection under the direct-main rule. The dated results below are historical local validation; local macOS Electron remains outstanding. Current local revalidation is recorded in [M1-progress.md](M1-progress.md).

## Review (2026-09-17)

**M0 is locally revalidated, but formal sign-off remains pending.** The reviewed tree is `492d870` plus the existing M1 work in progress and the corrections below. At that review there was no Git remote, remote CI run, branch protection, or `v0.0.0` tag. Linux clean-clone and Linux/macOS Electron results cannot be inferred from Windows or Docker results. `CURRENT` remains `M0`; M1 work is authorized and recorded in [M1-progress.md](M1-progress.md).

| Current evidence | Result |
|---|---|
| `pnpm exec turbo run build check-types lint test --output-logs=errors-only` | 57/57 tasks successful, including valid cache hits; `reports/m0-m1-validation.log` |
| Full TypeScript project build, root type-aware lint, formatting, production Knip and package boundaries | Pass; boundary scan covers 791 files in 20 packages |
| Entire guard project | 173/173 tests in 14 files pass; generation drift, boot path, migrations dialect, dependency identity and acceptance-map checks included |
| MySQL matrix | 76/76 tests in 10 files pass **on each** of `mysql:8.4.11` and `mysql:9.7.2-oraclelinux9`. Covers all five M0 database suites plus kernel, lease, awareness, password-link and text-projection regressions. Logs: `reports/milestone-matrix-84.log`, `reports/milestone-matrix-97.log` |
| Windows Electron smoke | 4 passed. The actual Electron renderer preserves `Origin: app://iridium` over HTTP/WS and HTTPS/WSS across navigation/reload. No Linux/macOS or application API connectivity claim |
| Production image | Build succeeds with frozen pruned install and the version-bound Hocuspocus patch. `infra/docker/runtime-smoke.ts` passes on both MySQL images: image-default UID/GID 10001, read-only root filesystem (`EROFS` probe), only documented writable mounts, `/readyz` HTTP 200 with healthy core checks, and `migrate status` current with 48 applied. Overall readiness retains the existing `access_log_partitions` warning. Logs: `reports/m0-runtime-84-verified.log`, `reports/m0-runtime-97-verified.log`. The runtime gate is now wired into both integration CI entries |
| Supply-chain and metadata gates | License scan, high-severity audit threshold, dedupe, bundle budget, exclusion hygiene, environment lists and test-name references pass. Audit reports 3 moderate advisories and no high/critical advisories |
| OpenAPI lint | Valid with 60 warnings (missing license and unused component declarations); warning cleanup and complete contract coverage remain M1 work |

Corrections from this review include the expired `minimumReleaseAgeExclude` entries, an outdated readiness expectation, the two-argument Vitest assertion lint rule, complete explicit-file coverage in the sequence guard, and the missing container runtime and repeatable Electron Origin gates. The M1 kernel proof also corrected child startup/shutdown cleanup, schema-scoped ownership, concurrent password-link issuance, awareness handling, and monotonic projection assignment order.

Coverage and mutation scores in the historical table below were **not rerun or re-certified** for the unfinished M1 tree. The M1 exit requires its complete test, coverage, mutation and chaos gates. No remote run, release tag or milestone exit was manufactured by this review.

## Historical record (2026-09-13)

| Field | Content |
|---|---|
| Commit and tag | The milestone commit is `71915f5` (`feat: land milestone M0 (contracts, crdt, testkit, server core, infra, codegen, spikes)`, on top of the bootstrap commit `90a3ec6`). `ef51fdc` added this record and the commit references in the four failed-spike notes; the exit review's fixes (six missing M0 tests, the `check-env-lists` gate, the coverage-gate wiring, the release floor) follow in the next commit. The tag `v0.0.0` is cut by hand on that commit once the first push to a remote shows the §13.3 required checks green; it is not cut before, because §13.2 asks this record to cite the CI runs and none exists until then. |
| Milestone pointer | `docs/milestones/CURRENT` remains `M0`, its bootstrap value. Although the plan defines this pointer as the last exited milestone, that existing value does not establish completion of M0's formal prerequisites. M1 rehearsal and implementation do not advance it. |
| Exit tests | No continuous-integration run exists yet: the repository has no remote at M0, so the available Windows and Docker checks were run locally on 2026-09-13 (Windows 11, Node 24.21.0 through mise, pnpm 12.4.1, Docker Desktop). The table below names each exit test of §4.6 with the command that proved it. The first push must show `static`, `unit (ubuntu-latest, windows-latest)`, `integration (mysql:8.4.11, mysql:9.7.2-oraclelinux9)`, `e2e-electron (ubuntu, windows, macos)` and `merge-reports` green before branch protection is enabled (§13.3); the three-operating-system criteria (`desktop.launch.e2e`, S3's Origin verdict) are proven on Windows only until then. |
| Cross-cutting gates | See "Gates" below. |
| Spec rows | None retired; §4.7 lists none for M0. Coverage extended: none — the acceptance rows begin at M1. |
| Spikes | S1 pass, S2 pass, S3 pass (Windows; the register's three-OS claim is completed by the first `e2e-electron` matrix run), S6 pass, S8 pass, S14 pass. S4, S5, S7 and S13 fail with their recorded fallbacks executed by commit `71915f5` (each note's "Fallback executed" section names it; `docs.spikes.spec` asserts the reference). |
| ADRs | None numbered anew. Amended on 2026-09-13: A2 (`tooling/api-codegen` as the second consumer of the TypeScript 6 alias; the mutation lane's own Vitest 4 companions); A52 / D10-12 (BlueOak-1.0.0 added to the licence allowlist); A15's "order of magnitude" claim re-measured by S1 (1.6–1.75×); R-T22 re-scored by S6; §3's coverage thresholds stated as a `merge-reports` gate enforced from the M1 exit; the milestone tags stated as hand-cut `v0.<N>.0` with `release.yml` floored above `v0.0.0`. |
| Open questions | None of the eight §G questions was reopened. Raised after 2026-09-12: **which licence, if any, the OpenAPI document should declare** — Redocly's `info-license` rule warns while `info.license` is absent; the default carried forward is "none declared, warning tolerated" until the owner names one. |
| Deferred items | (1) `apps/server/src/authz/route-policy.ts` has no unit-project coverage: the mutation lane scores it 0 % and the per-file 100 % rule would fail; M1's authz work adds the unit spec before the M1 exit, where the coverage gate first applies. (2) `@fastify/swagger` registers inside the `rest` plugin at M1; until then `src/ops/openapi.ts` is reached only by the `pnpm gen` export and is listed in `knip.jsonc`. (3) The declared-ahead dependency lists in `knip.jsonc` shrink as milestones import their packages; the M1 exit review deletes the entries knip's hints report. (4) The two unused `securitySchemes` Redocly warns about become used with M1's routes. (5) `minimumReleaseAgeExclude` in `pnpm-workspace.yaml` empties after 2026-09-14. (6) S5's follow-up on the checker's program scope is applied; the spike harnesses under `apps/desktop/spikes/` and `apps/server/spikes/` are deleted at M5 and M1 respectively (12 §4.4). |
| Known risks carried forward | R-T10 now has two isolated consumers of the TypeScript 6 alias (A2 amendment). R-T22 is re-scored: k6 2.2.0's `crypto.getRandomValues` fills one byte per element, so every k6 script assigns `Y.Doc.clientID` itself (S6). S1 measured the V2 snapshot at 1.6–1.75× smaller than V1, not an order of magnitude; A15's sizing assumptions are adjusted in 05. S2 recorded that document-level closes never transport the 4403 codes through the provider and that the root rate limiter and Host guard run on upgrades. S14 recorded that a thrown MCP factory is answered by the SDK itself under `toNodeHandler`, which is why the web-standard face is adopted. The merged coverage at M0 (below) is far under the §3 numbers because the tree carries every later boot step as an empty stub; the gate is armed at the M1 exit. |

## Exit tests (§4.6 and the M0 rows of the acceptance map)

| Test | Proved by |
|---|---|
| `deps.single-instance.guard` | `pnpm exec vitest --run --project guard` — pass |
| `authz.route-policy.boot.guard` | guard project — pass; `readyz.integration` on both images exercises the boot assertion |
| `config.env.unit` | `pnpm exec turbo run test` — 43 tests, pass |
| `turbo boundaries` | `pnpm exec turbo boundaries` — 409 files in 20 packages, no issues; a violating import fails the step (probed with a throwaway `react` import under apps/server during the gate) |
| `tokens.format.unit`, `tokens.format.prop`, `tokens.verify.unit`, `authz.matrix.unit`, `contracts.ids.unit`, `contracts.ids.prop`, `contracts.paths.unit`, `contracts.paths.prop` | unit project — 170 contracts tests, pass |
| `crdt.codec.prop`, `crdt.dominates.prop`, `crdt.prefix-suffix-diff.prop`, `crdt.guards.unit` | unit project — 53 crdt tests, pass |
| `migrations.integration` | `IRIDIUM_MYSQL_IMAGE=mysql:8.4.11` and `mysql:9.7.2-oraclelinux9`, `--project integration --project contract --project mcp --project property` — 42 tests each, pass |
| `db.dialect-floor.guard` | guard project — pass |
| `migrations.parity.integration` | both integration lanes — pass |
| `db.version-floor.integration` | both integration lanes — pass (refuses `mysql:8.0` and an innovation release with exit 2) |
| `readyz.integration` | both integration lanes — 16 tests, pass |
| `app.boot-modes.integration` | integration lane on `mysql:8.4.11` — pass (the three modes from one `buildApp`, identical route tables and plugin order) |
| `desktop.web-preferences.guard` | guard project — pass (renamed from `desktop.webPreferences.guard` at the exit review, per the plan's kebab-case name grammar) |
| `desktop.launch.e2e` | `pnpm exec playwright test --project=electron --grep @smoke` against the built server with `IRIDIUM_MIGRATE_ON_BOOT=true` on a bare `mysql:8.4.11` — 2 passed |
| `gen.drift.guard` | guard project — pass (runs `scripts/gen.ts --check --skip-db`; every artefact current) |
| `guards.acceptance-map.guard` | guard project — pass (every M0 entry of `docs/acceptance-map.json` resolves to a spec whose `describe` title is the name) |
| `guards.one-boot-path.guard`, `guards.mutation-lane.guard`, `limits.single-source.guard` | guard project — pass |
| `docs.spikes.spec` | guard project on the exit-record commit — pass (fails by design on `71915f5` alone, because a `fail` note must name the commit that executed its fallback, and that commit cannot name itself) |
| `check-env-lists` (a `static` step) | `node scripts/check-env-lists.ts` — the `EnvSchema` keys and `apps/server/turbo.json`'s `env` lists agree in both directions |
| `docker-image` | `docker build -f infra/docker/server.Dockerfile -t iridium-server:ci .` — 514 MB image; `docker run … iridium-server:ci migrate status` → `{"status":"current","applied":48}` |

## Gates (§3, as run on 2026-09-13)

| Gate | Result |
|---|---|
| `pnpm install --frozen-lockfile` | pass |
| `pnpm exec turbo run build check-types lint test` | pass, 0 lint warnings |
| `pnpm exec tsc -b --builders 8` | pass |
| `pnpm exec oxlint -c oxlint.config.ts --type-aware .` | pass |
| `pnpm exec oxfmt --check .` | pass |
| `pnpm exec knip --production` | pass |
| `pnpm exec turbo boundaries` | pass |
| `pnpm exec redocly lint … --extends recommended` | valid; 3 warnings (`info-license`; two `securitySchemes` unused until M1's routes) |
| `node scripts/check-licenses.ts` … `check-env-lists.ts`, `check-test-name-references.ts`, `build-acceptance-map.ts --check` | pass |
| `pnpm audit --audit-level high` | pass (3 moderate findings in Stryker's `typed-rest-client` → `qs`, tooling only) |
| `pnpm dedupe --check` | pass |
| Coverage (merged `unit` + `component` + `integration (mysql:8.4.11)` blobs, `vitest --merge-reports=.vitest-reports --coverage`) | lines 64.02 %, statements 63.86 %, branches 53.84 %, functions 64.2 % — recorded, not enforced: §3's thresholds are armed by `IRIDIUM_COVERAGE_GATE=1` in `merge-reports` from the M1 exit onward |
| Mutation lane (`pnpm --filter @iridium/mutation run mutation`) | 72.95 % over the full register, above `break` 70; packages 84.8 %, `route-policy.ts` 0 % (deferred item 1) |
| Component project | no test files yet (M4) |
