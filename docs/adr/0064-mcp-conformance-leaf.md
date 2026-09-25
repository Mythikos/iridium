# AG11 — The MCP conformance tools return as a dev-only harness leaf; third-party clients stay outside the workspace

**Status:** Accepted (2026-09-24), answering G11. Supersedes in part the removal of `@modelcontextprotocol/conformance` and `@modelcontextprotocol/inspector` from the catalog recorded in `12-milestones.md` §4.2 step 3 (2026-09-13), and A32's development-and-test pins clause.

## Context

A32 and A51 name `@modelcontextprotocol/conformance` 0.1.16 and `@modelcontextprotocol/inspector` 2.6.0 for the `mcp` project, and the M0 bootstrap removed both from the catalog. Conformance 0.1.16 bundles `@modelcontextprotocol/sdk` 1.x, the SDK line A32 rejected for the product, so returning it without a boundary would let a v1 SDK resolve beside the v2 packages. The nightly matrix (AG10) also runs `mcp-remote` and Claude Code, which are third-party clients rather than dependencies of anything the project ships. The owner answered G11 on 2026-09-24 and approved the registry egress the install needs.

## Decision

`@modelcontextprotocol/conformance` 0.1.16 and `@modelcontextprotocol/inspector` 2.6.0 are catalog pins declared only as `devDependencies` of the private leaf workspace `tooling/mcp-conformance` (`@iridium/mcp-conformance`), which has no sources beyond a README. Its boundary tag is the new `harness`, declared in the root `turbo.json` with `dependencies.allow []` and `dependents.allow []`, so it depends on no workspace and no workspace may depend on it, and `knip.jsonc` carries a source-less entry for it as it does for `tooling/api-codegen`. It is the single workspace in which `@modelcontextprotocol/sdk` 1.x may resolve, and the workspace count becomes 24. The lead installs it once under the registry egress approved on 2026-09-24 and reviews, at that install, an `allowBuilds` entry for every install script in its closure, the minimum release age, strict peer dependencies, the no-downgrade trust policy, `pnpm audit --audit-level high`, `pnpm dedupe --check` and the licence allowlist over the closure. The leaf stays inside the one blocking `pnpm audit --audit-level high`, because it executes in CI with a live credential; a high advisory in its closure is remedied, in order, by moving the pin, by a parent-scoped pnpm override that leaves product closures untouched, or by a dated ignore entry with owner, issue and expiry (D10-15). The licence scan's scope, the production closures of the shipped packages, is unchanged, because nothing from the leaf ships. The `mcp` project runs both tools through one `@iridium/testkit` helper, `packages/testkit/src/mcp/toolchain.ts`, which resolves each bin by file path from the leaf's manifest and spawns it with `process.execPath`, following `scripts/lib/tools.ts` — never `npx` and never `pnpm exec` from a Vitest worker; a person reproduces a run with `pnpm --filter @iridium/mcp-conformance exec conformance …` or `… exec mcp-inspector …`.

The confinement's scope is the pnpm workspace, `pnpm-lock.yaml` and every workspace source. `guards.mcp-sdk-confinement.guard` parses `pnpm-lock.yaml` and the sources and fails when any `@modelcontextprotocol/sdk@1.*` snapshot is reachable from an importer other than the leaf, when any importer depends on `@iridium/mcp-conformance`, when any source outside the leaf imports `@modelcontextprotocol/sdk`, when a `pnpm-workspace.yaml` glob or a workspace manifest reaches `apps/e2e/mcp-clients/clients`, or when a `node_modules` directory exists there; it proves in-file that it refuses a poisoned lockfile, a poisoned importer and a poisoned source. The import bans themselves — `sdk-v1` banned everywhere — are rows of the restricted-imports owner table, checked by `guards.restricted-imports.guard`.

`mcp-remote@0.13.5` and `@anthropic-ai/claude-code` are never workspace dependencies: no catalog entry, no workspace manifest and no `pnpm-lock.yaml` line, so they stay out of knip, the product licence scan and `guards.non-goals.guard`'s dependency inventory. They are pinned by a committed npm manifest and lockfile outside every workspace glob, `apps/e2e/mcp-clients/clients/{package.json, package-lock.json}`, whose integrity hashes cover the whole closure and which the formatter ignores; that lockfile is never installed in the checkout. `nightly.yml` alone copies it to `$RUNNER_TEMP/mcp-clients` and runs `npm ci --ignore-scripts` there, then `npm rebuild <pkg>` only for a package whose install script `versions.json` records as reviewed. The harness reads that directory from `IRIDIUM_TEST_MCP_CLIENTS_DIR` and runs a rendered `npx -y mcp-remote@0.13.5 …` snippet verbatim with it as the working directory and `npm_config_offline=true`, so `npx` resolves the installed package and any would-be fetch fails the row. Secrets reach only the steps and rows that need them. The `mcp-remote` version is one exported constant, `MCP_REMOTE_VERSION` in `apps/server/src/mcp/snippets.ts`, used by both `mcp-remote` templates; `guards.mcp-client-versions.guard` asserts that it, the `versions.json` row and the clients lockfile agree, and that Claude Code's `versions.json` version equals the lockfile's.

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| The `tooling` boundary tag | Every tag in the root `turbo.json` allows `tooling` as a dependency, so `turbo boundaries` would not refuse a workspace depending on the SDK-v1 leaf. |
| Running the tools with `npx` | Resolves a package outside the committed lockfile at run time and fetches from the registry in CI. |
| `mcp-remote` and Claude Code as catalog entries | Brings third-party clients, one of them carrying SDK v1, into the workspace, the lockfile, knip and the licence scan of a product that does not ship them. |
| Installing the clients lockfile in the checkout | A `node_modules` under the checkout is within reach of workspace tooling and breaks the confinement the guard asserts. |

## Consequences

Positive: the conformance suite and the Inspector smoke run at pinned versions from the lockfile with no registry fetch in CI; SDK v1 is confined to one leaf nothing can depend on; the third-party clients are pinned by integrity hash without entering the product's dependency graph. Negative: a 24th workspace and a second, npm, lockfile to maintain; the leaf's closure carries install scripts and advisories that are reviewed like any other.

## Verification

`guards.mcp-sdk-confinement.guard`, `guards.restricted-imports.guard`, `guards.mcp-client-versions.guard`, `mcp.conformance.mcp` (the tool resolved from the leaf) and the `static` job's `pnpm audit --audit-level high`.

## References

Owner's answer to open question G11 and the registry egress approval, 2026-09-24 (`14-risks-and-open-questions.md` §G); A32, A51; `12-milestones.md` §4.2 step 3. Implemented in `02-system-architecture.md`, `06-mcp-and-agent-access.md`, `10-testing-and-quality.md`, `12-milestones.md`, `14-risks-and-open-questions.md` and `docs/repository-guide.md`.

---

Source: docs/plan/13-decision-log.md, decision AG11. This file is a faithful copy of that entry's Status, Context, Decision, Alternatives considered, Consequences, Verification and References fields; the decision log remains the authoritative, continuously-maintained record (status supersessions are recorded there first).
