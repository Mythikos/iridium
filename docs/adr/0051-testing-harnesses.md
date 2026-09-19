# A51 — Testing harnesses: one runner per layer, real infrastructure, one boot path, `@iridium/testkit`

**Status:** Accepted (2026-09-11); the `integration` project's single MySQL image is **superseded in part by A59 (2026-09-12)**: the project runs as a two-entry matrix over `mysql:8.4.11` and `mysql:9.7.2-oraclelinux9`, with an unset `IRIDIUM_MYSQL_IMAGE` resolving to the floor. **Amended 2026-09-13:** the coverage numbers in the Decision below are unchanged, but they are **enforced for the M1 exit and its rehearsals onward** rather than at M0 — the root `vitest.config.ts` applies `coverage.thresholds` only when the job sets `IRIDIUM_COVERAGE_GATE=1` and the effective test target is past M0 (`IRIDIUM_TEST_TARGET_MILESTONE` when set; otherwise the last exited milestone in CURRENT), because the M0 tree deliberately contained the empty stubs of every M1+ boot step and the placeholder packages, so the aggregate would measure stubs and the 100 %-per-file rule on `apps/server/src/authz/**` could not hold while `route-policy.ts` was reached only by its boot guard. CI defaults the target to at least M1 while CURRENT still records M0, so the M1 gate is enforced before the pointer advances. The M0 exit record reports the merged numbers without gating on them, and "a threshold is never lowered" applies from the first exit that enforces them (10-testing-and-quality.md, "Coverage").

## Context

The spec's nine acceptance rows (spec §9) are statements about durability, authorization, and convergence under failure; they cannot be proven with mocks. The digest verified the exact behaviours the tests must pin: Hocuspocus's `SyncStatus` precedes persistence (§8.2, §2.2), there is no store retry (§11.4), and Yjs's own convergence harness is the reference model (§8.2). Vitest 5.0.0 is eight days old with a `V4` fallback; Playwright 1.63 adds test locks; Testcontainers 12.1 needs an explicit image string; k6's ability to run bundled yjs/lib0 is unvalidated (§8.2).

## Decision

Vitest 5.0.0 (+ `@vitest/coverage-v8`, `@vitest/browser-playwright`, `@vitest/ui` 5.0.0; `V4` 4.1.11 only for the mutation lane per A2) with `test.projects`: `unit` (ubuntu + windows, `pool: forks`, `sequence.shuffle` with the seed printed), `component` (Browser Mode chromium via `playwright()` provider, vitest-browser-react 2.3.0, axe-core pinned at M0), `integration` (Testcontainers 12.1.0 `MySqlContainer(process.env.IRIDIUM_MYSQL_IMAGE ?? 'mysql:8.4.11')` on tmpfs, per-worker schemas, in-process `buildApp({mode:'in-process'})`), `property` (fast-check 4.10.0 + @fast-check/vitest 0.5.0; `numRuns 200` on PR, 5 000 + soak nightly), `chaos` (child-process server, `@testcontainers/toxiproxy` 12.1.0 / toxiproxy 2.12.0, and the `IRIDIUM_FAULT` registry active only when `NODE_ENV=test`: `store.throw`, `store.crash-before-commit`, `store.crash-after-commit-before-ack`, `store.slow:<ms>`, `compact.throw`, `ws.drop-after-ack`, `auth.slow:<ms>`), `contract` (`toMatchOpenApi(operationId, status)` on ajv 8.20.0 + swagger-parser 13.0.0; Schemathesis 4.26.1), `mcp` (in-process `handler.fetch` for both eras, `@modelcontextprotocol/conformance` 0.1.16 with an empty expected-failures baseline, Inspector 2.6.0 `--cli`). Playwright 1.63.0 projects `setup` / `chromium` (4 shards, test locks) / `electron` (ubuntu xvfb, windows, macos with `shogo82148/actions-setup-mysql@v1` `9.7`). k6 2.2.0 with bundled yjs/lib0 (M0 spike; fallback: a Node worker generator on `@iridium/collab-client`) with SLOs `ws_connecting p95 < 500 ms`, `yjs_propagation_ms p95 < 250 ms`, `durable_ack_ms p95 < 1 s`, `projection_lag_ms p95 < 12 s`, MCP `get_note p95 < 300 ms`, RSS < 1.5 GB at 300 VUs / 60 docs on 4 vCPU. `@iridium/testkit` provides `startTestEnv`, `startServer({mode:'in-process'|'child'})`, `NoteClient` (a `ws` subclass injecting `Origin: <PUBLIC_ORIGIN>`), `vaultChannelClient`, `restClient`, `mcpClient(token, era)`, fixtures (demo vault; Obsidian sample vault with `.obsidian/`, `.trash/`, `.canvas`, CRLF, BOM; hostile corpus; CommonMark 0.31.2 JSON; msw handlers). Policies: Vitest `retry: 0`; Playwright `retries: 2` in CI only, with traces; coverage v8 global 85/85/80/85 (lines/functions/branches/statements), 100 % per-file on `auth/**`, `authz/**`, `contracts/{tokens,paths,authz}`, 95/90 on `collab/persistence/**` and `@iridium/crdt`. Guard tests (grep- or snapshot-based, collected by path into their own `guard` project and run first in the `static` job): `deps.single-instance.guard`, `collab.initial-state-only-path.guard` (`new Y.Doc(` only inside `@iridium/crdt`, `collab/persistence/initial-state.ts`, and tests), `collab.no-reinit.guard` (`getText('content').insert` only inside `NoteService.initialize`, restore, repair), `collab.lf-invariant.guard`, `limits.single-source.guard`, `authz.route-policy.boot.guard`, `authz.no-mcp-admin-implied.guard`, `ipc.origin.guard`, `desktop.preload-surface.guard`, `desktop.web-preferences.guard`, `desktop.fuses.guard`. Three invariants the skeleton lists alongside them — DB grants, awareness identity and log redaction — need a live database or a live socket, so they ship as `db-grants.integration`, `collab.awareness-identity.integration` and `logging-redaction.integration` in the `integration` project rather than as guards.

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| Jest | Second transform pipeline next to Vite; no Browser Mode; slower on ESM-only packages. |
| WebdriverIO for Electron | Playwright's `_electron.launch` is the path Electron's own testing guide recommends, and it shares the web E2E runner. |
| Artillery for load | Its `ws` engine documents no binary frames or message assertions; Yjs sync is binary. |
| jest-openapi / vitest-openapi | Stale (2022/2023); an ajv + swagger-parser matcher is a few dozen lines and tracks OpenAPI 3.1. |
| Pact | Consumer-driven contracts across teams; Iridium's clients live in the same repository and are generated from the same OpenAPI document (A3). |
| Mocks for MySQL / network faults | The acceptance rows are about real commits and real socket failures. |
| `electron-playwright-helpers` IPC helpers | Require `nodeIntegration: true, contextIsolation: false`, incompatible with A53. |

## Consequences

Positive: every acceptance row maps to a named test (`10-testing-and-quality.md`); durability is proven under injected faults on both sides of `COMMIT`; both MCP eras are exercised through the deployed handler; `@iridium/testkit` is the only test harness, so `buildApp()` is the only boot path. Negative: integration and chaos lanes need Docker (Linux runners only); Vitest 5 is very new (breaking-change list in digest §8.2 — `clearMocks` default true, un-awaited assertions fail, `test.sequential` removed — adopted deliberately); the k6 bundling spike may fail (fallback recorded); Playwright retries mask flakiness only in CI and only with traces attached.

## Verification

This ADR is itself the verification framework; its own checks: M0 exit (all Vitest projects and Playwright projects run empty-green on ubuntu + windows, Electron launch on three OSes), `docs/spikes/S06-k6-yjs-bundle.md`, `docs/spikes/S05-stryker-vitest5.md`, coverage thresholds enforced in `merge-reports`.

## References

Digest §8.1–§8.5, §11.21, §2.2 (`SyncStatus` timing), §11.4 (no store retry); plan-risk-first ADR-20 + §9; plan-product-dx §9.3 testkit graft; plan-enterprise ADR-28. Implemented in `10-testing-and-quality.md`.

---

Source: docs/plan/13-decision-log.md, decision A51. This file is a faithful copy of that entry's Status, Context, Decision, Alternatives considered, Consequences, Verification and References fields; the decision log remains the authoritative, continuously-maintained record (status supersessions are recorded there first).

## M1 amendment (2026-09-18)

Test forks default to `UV_THREADPOOL_SIZE=8` before Node starts and at most `min(4, availableParallelism())` workers. CI and the mutation child process use the same pool setting; Stryker's worker threads require the environment in their parent before startup. Retry, load-shedding thresholds, property budgets and coverage thresholds remain unchanged.

The requested target milestone governs due names and exit coverage before `CURRENT` changes. CI defaults to M1 while `CURRENT` still names M0 and refuses to target an earlier milestone than the last exited one. Every scheduled name in the complete acceptance inventory must identify a selected, correctly tagged suite; unexplained unscheduled rows are rejected. A fresh mutation proof must distinguish newly executed mutants from reused results and retain its actual input provenance.

Source: `docs/plan/13-decision-log.md`, M1 independent-review amendments, A51 and D10/D12.
