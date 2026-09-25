# A3 — Contracts-first code generation with CI drift checks

**Status:** Accepted (2026-09-11).

## Context

Iridium has four wire surfaces (REST, WebSocket stateless messages, MCP, desktop IPC) consumed by three clients (web, Electron, bridge) and by external agents. Hand-maintained client types drift silently. The product-dx plan proposed an in-house Storybook-like workbench (`apps/workbench`) as a contract surface; the judges rejected it as unverified tooling in the bootstrap milestone.

## Decision

`@iridium/contracts` (zod 4.6.2 only) is the single source of wire contracts. A root `pnpm gen` runs, in order: (1) `apps/server` boots in `in-process` mode and writes `packages/contracts/openapi/openapi.json` via `app.swagger()` (OpenAPI 3.1, with `links` so Schemathesis can run stateful fuzzing), then `@redocly/cli 2.52.1 lint`; (2) openapi-typescript 7.13.0 emits `packages/api-client/src/generated/paths.d.ts`, consumed by openapi-fetch 0.17.0; (3) kysely-codegen 0.20.0 generates types from a migrated database and diffs them against the hand-written `apps/server/src/db/schema.ts`; (4) `packages/contracts/mcp/tools.schema.json` is emitted from the zod tool schemas and a test asserts the live `tools/list` (both eras) equals it in deterministic order; (5) desktop IPC typings for `window.iridium` are generated from `contracts/desktop-ipc.ts`; (6) an msw 2.15.0 handler skeleton is generated from `openapi.json` for component tests. CI runs `pnpm gen && git diff --exit-code` (the `static` job's `pnpm gen:check` step).

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| Hand-maintained client types and MCP schema JSON | Drift is invisible until a client breaks; no build failure. |
| In-house workbench `apps/workbench` (product-dx 021) | Unverified tooling in M0; component tests run in Vitest Browser Mode instead (A51). |
| Storybook | No verified Vite 8 Storybook version in the digest. |
| Separate schema languages per surface (TypeBox for REST, JSON Schema for MCP) | One schema language (A6) is what makes (4) and (5) trivial. |

## Consequences

Positive: any change to a route, stateless message, tool, or IPC channel is a build failure until the generated artifacts are regenerated and committed; the OpenAPI document is an executable contract (A6's `toMatchOpenApi`, Schemathesis). Negative: `pnpm gen` needs a database for step (3) (Testcontainers MySQL in CI; documented local `compose.yaml`); generated files are committed, so reviewers see large diffs on contract changes (accepted — that visibility is the point).

## Verification

The `static` job's `pnpm gen:check` step; `mcp.tools-schema.contract` (M3); `rest.route-index.contract` (M2); Redocly lint; kysely-codegen diff step (M0).

## References

Digest §8.2 (OpenAPI tooling status), §5.2 (`@fastify/swagger` dynamic mode), §3.2 (deterministic `tools/list`); plan-product-dx §2.6/§9.4 (graft source); judges 1–3. Implemented in `09-api-reference.md` and `10-testing-and-quality.md`.

---

Source: docs/plan/13-decision-log.md, decision A3. This file is a faithful copy of that entry's Status, Context, Decision, Alternatives considered, Consequences, Verification and References fields; the decision log remains the authoritative, continuously-maintained record (status supersessions are recorded there first).
