# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Iridium is an internal, self-hosted documentation platform that merges the vault-and-Markdown workflow of Obsidian with the simultaneous multi-author editing of Google Docs, and gives AI agents first-class, read-only access to the vaults through the Model Context Protocol (MCP). Everything runs against one Node server with MySQL behind it; the client is one React application that runs both in the browser and inside a hardened Electron shell, and the Electron desktop application is the supported client at 1.0.

The development plan in `docs/plan/` (README plus `01`–`15`) **is the specification**. Every settled decision has an ADR under `docs/adr/`, mirrored from `docs/plan/13-decision-log.md`, which is the authoritative record. When the plan says what to build, build what it says; when the tree and the plan diverge, amend the plan in the same change and say why. Do not invent scope the plan does not name.

## Architecture

One Node 24 process built on Fastify 5 owns all input and output:

- **REST API** under `/api/v1` — the only content write path, validated by zod schemas from `@iridium/contracts`, documented by a generated OpenAPI 3.1 document.
- **Collaboration WebSocket** at `/collab` — Hocuspocus 4.7 embedded as a library over Yjs 13. "Saved" means a MySQL transaction containing the user's edits has committed *and* the server has broadcast a state vector that dominates the client's.
- **MCP** on two mounts — `/mcp` for `irid_pat_` integration tokens (no discovery advertised) and `/mcp/connect` for `irid_oat_` OAuth 2.1 tokens (full discovery, issuer `<PUBLIC_ORIGIN>/oauth`). Agents read committed content at a named revision, never live CRDT state.
- **Ops surface** — `/healthz`, `/readyz` (fail-closed readiness checklist), `/metrics`; a CLI (`serve`, `migrate status|up|to`, `config check`, `version`) in the same binary.

One UI codebase, two hosts: `@iridium/ui` (React 19) is mounted by `apps/web` (Vite, `BrowserHost`) and by `apps/desktop` (Electron 44, `app://iridium` privileged scheme, `ElectronHost`) behind the single `IridiumHost` seam. The renderer never holds credentials; Electron IPC exposes a narrow typed bridge (`window.iridium`) whose surface is generated and snapshot-tested.

A single `authorize()` over a single `Principal` union serves REST, the WebSocket and MCP alike. One limits table (`packages/contracts/src/limits.ts`) governs every payload, document size, queue depth and rate limit.

## Technology Stack

Every version is an exact pin in the `catalog:` of `pnpm-workspace.yaml`.

- **Runtime**: Node 24.21.0 (`devEngines` downloads it), pnpm 12.4.1, Turborepo 2.10 with `boundaries` tags, TypeScript 7.0.2 (native compiler; no JS compiler API)
- **Server**: Fastify 5.12, zod 4.6, Kysely 0.29 + mysql2 3.24, Hocuspocus 4.7, `@modelcontextprotocol/*` 2.0, pino, `@node-rs/argon2`, `@prometheus-io/client`
- **Database**: MySQL 8.4.11 **and** 9.7.2 — equal required targets, both merge-blocking; 8.0 is refused at boot
- **CRDT**: Yjs 13.6, lib0, y-protocols — imported only by `@iridium/crdt` (one module instance repo-wide, enforced)
- **Client**: React 19.3, Vite 8 (Rolldown), CodeMirror 6 + y-codemirror.next, unified/remark/rehype, Base UI, TanStack Router/Query, zustand, Tailwind 4
- **Desktop**: Electron 44.3, tsdown for main/preload, electron-builder for the (unsigned, zipped) 1.0 bundles
- **Quality**: Vitest 5 (projects `unit`, `guard`, `component`, `integration`, `property`, `chaos`, `contract`, `mcp`), Playwright 1.63, fast-check 4, Testcontainers + Toxiproxy, Stryker 10 (on Vitest 4.1.11 inside `tooling/mutation` only), oxlint 1.82 + tsgolint, oxfmt, knip, Redocly, k6 2.2 for the load lane
- **Codegen**: `pnpm gen` — OpenAPI export and lint, `openapi-typescript` client types, kysely-codegen schema diff, MCP tool schema, desktop IPC typings, msw skeleton, `docs/non-goals.json`, `docs/acceptance-map.json`

## Repository Layout

pnpm workspaces `apps/*`, `packages/*`, `tooling/*`, `spikes/*`. Each workspace declares a boundary tag in its `turbo.json`; `turbo boundaries` and oxlint `no-restricted-imports` enforce the table in `docs/plan/02-system-architecture.md` ("Boundary tags and allowed dependencies").

```
apps/
  server/        @iridium/server        tag server   REST, /collab, /mcp, jobs, CLI; tsdown → dist/main.mjs; Docker image
  web/           @iridium/web           tag app      Vite entry mounting @iridium/ui with BrowserHost
  desktop/       @iridium/desktop       tag app      Electron shell: src/main, src/preload (index.cts), src/renderer
  e2e/           @iridium/e2e           tag app      Playwright projects: setup, chromium, electron
packages/
  contracts/     @iridium/contracts     tag core     zod schemas, ids, errors, authz matrix, token format, LIMITS (zod is its only runtime dep)
  crdt/          @iridium/crdt          tag iso      the only importer of yjs/lib0/y-protocols: note doc, V1/V2 codec, dominance, chunked insert
  markdown/      @iridium/markdown      tag iso      unified pipeline: normalize, parse, sanitize, project, restore
  api-client/    @iridium/api-client    tag iso      openapi-fetch over generated types; FetchTransport / IpcTransport
  collab-client/ @iridium/collab-client tag iso      NoteSession, SaveStateMachine, vault channel
  editor/        @iridium/editor        tag browser  CodeMirror 6 + y-codemirror.next binding
  markdown-react/@iridium/markdown-react tag browser hast → React preview
  ui/            @iridium/ui            tag browser  the React application and the IridiumHost seam
  mcp-bridge/    @iridium/mcp-bridge    tag node     iridium-mcp stdio ⇄ Streamable HTTP proxy, bundled with the desktop app
  testkit/       @iridium/testkit       tag node     the single harness entry point (MySQL/Toxiproxy fixtures, clients, matchers, fixtures)
tooling/
  tsconfig/, oxlint-config/            shared bases and lint fragments
  mutation/                             Stryker lane with its own TypeScript 6 alias and Vitest 4.1.11 family
  api-codegen/                          hosts openapi-typescript on the TypeScript 6 alias (no sources)
  sql/           @iridium/sql-policy    forbidden-constructs denylist and the committed schema fingerprint
spikes/
  s04-editor-csp/                       a throwaway spike harness; tag spike — nothing may depend on it
docs/
  plan/  adr/  spikes/  ops/  milestones/  spec/
scripts/                                the pnpm gen pipeline and the static CI checks (Node runs the .ts files natively)
infra/                                  compose.yaml, compose.prod.yaml, docker/server.Dockerfile, MySQL my.cnf and init/01_roles.sh, Caddy
```

## Coding Standards

### TypeScript

- The shared bases in `tooling/tsconfig/` are strict and non-negotiable: `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `verbatimModuleSyntax`, `erasableSyntaxOnly`, `isolatedModules`. Compiled packages also build with `isolatedDeclarations`.
- Consequences to write by: no `enum`, no `namespace`, no constructor parameter properties (declare the field and assign it); `import type` for types; relative imports carry the `.ts` extension; exported values in compiled packages carry an explicit type annotation when inference would spread or infer a type (`isolatedDeclarations`); index access yields `T | undefined` and is handled, not asserted.
- No `any`, no non-null assertions to silence the checker, no `@ts-nocheck`, no `@ts-ignore`. Narrow from `unknown` at every boundary (JSON, environment, wire payloads) with zod or an explicit guard.
- Prefer explicit return types on exported functions. Prefer `readonly` for data that is not meant to change. Prefer discriminated unions over optional fields for state.
- Errors are typed and carry a remedy: a thrown error names the file, key or value that was wrong and what to do about it. Scripts exit `0` on pass, `1` on a check failure, `2` on a usage or environment error.

### Lint, format and comments

- oxlint (`oxlint.config.ts`, type-aware in CI) and oxfmt are the only style authorities. Never hand-format; run `pnpm exec oxfmt <paths>`. Lint must be clean with **zero warnings**, not just zero errors.
- A disable directive always carries its reason on the same line: `// eslint-disable-next-line no-await-in-loop -- probes are sequential by design`. Never disable a rule for a whole file. `no-await-in-loop` is fixed by `Promise.all` when the awaits are independent and by a reasoned directive when the order matters.
- `process.env` is read only in `apps/server/src/config/**` and `main.ts` (invariant 3). Numeric limits live only in `@iridium/contracts/limits.ts` (invariant 6; `limits.single-source.guard` has an allow-list file for reviewed exceptions). No `console` outside the CLI and scripts.
- Banned imports per tag: `node:*`, `electron`, `react` and DOM globals in `core`; `node:*` (except type-only), `electron`, `react` in `iso`; `node:*`, `electron` in `browser`; `yjs`/`lib0`/`y-protocols` anywhere but `packages/crdt`. `setTimeout` sleeps are banned in test files.
- Comments explain *why* and cite the plan section or decision that decides it (`(03-data-model.md §2)`, `(A14)`, `(D12-5)`). Module headers state what the module owns and what it deliberately does not. Write comments and documentation as the maintainers' own work; no tool attribution anywhere in the tree.

### Modules and exports

- Export only what something consumes. A barrel re-exports what is reached through it, nothing more. An export that exists only for tests carries a real doc comment ending in `@internal`, naming the suite that reads it (knip runs in production mode and ignores `@internal`).
- Dead code is deleted, not kept "for later"; the plan and git history hold what a later milestone needs. Code the plan schedules for a later milestone is not written ahead, except the empty boot-step stubs and the declared-ahead dependency graph that `12-milestones.md §4.2` asks for.
- One boot path: `buildApp({ mode })` is the only construction site of the Fastify instance; the modes differ only in listening, signals and the scheduler (invariant 1, `guards.one-boot-path.guard`).

### Tests

- File name `<area>.<subject>.<layer>.spec.ts[x]`, layer in `{unit, component, integration, prop, chaos, contract, mcp, e2e, guard, drill}`. The top-level `describe` title **is** the test's name in `docs/acceptance-map.json` and carries its requirement tag: `[spec:<row-id>]` for spec rows, `[hp:HP-n]` for hard properties, `[area:<area>]` otherwise (the exact vocabulary is the "Requirement tags" row of `10-testing-and-quality.md`). Names are lower-case kebab segments; `docs.spikes.spec` is the one literal exception.
- Every test name written in `docs/` must be a key of the acceptance map (`node scripts/check-test-name-references.ts`); adding a test means adding its inventory row to `10-testing-and-quality.md` and regenerating the map with `pnpm gen`.
- Unit and pure property tests live beside the source under `src/`; server integration/chaos/contract/mcp/property trees under `apps/server/test/<project>/`; repository-wide guards under `apps/server/test/guards/`. Guards never pass vacuously: a guard proves in-file that it refuses the shape it exists to catch.
- Eventual state is awaited with `expect.poll` or the testkit's `waitFor`; time is a `ManualClock`; network faults come from Toxiproxy toxics. `vi.mock` only in `unit` and `component`, only for I/O adapters and host seams. Snapshots are file snapshots for golden artefacts; inline snapshots stay under one line.
- Property budgets come from `@iridium/testkit`'s `PROP` / `PROP_DB` (mirrored in `packages/<pkg>/test/prop-budget.ts` where the testkit cannot be imported); `numRuns` is never lowered; arbitraries import `fast-check`, the runner glue imports `@fast-check/vitest`.
- Coverage thresholds (12-milestones.md §3) are one gate, evaluated by the `merge-reports` CI job from the M1 exit onward; the mutation lane runs the unit project only.

### Dependencies

- Every external version is an exact pin in the catalog and referenced as `"<pkg>": "catalog:"`; workspace packages as `"workspace:*"`. The catalog carries only versions a manifest declares; pins for later milestones stay in `02-system-architecture.md`'s dependency table until declared.
- `overrides` pin one copy of yjs, lib0, y-protocols, `@codemirror/state`, `@codemirror/view`, `@types/node`, fast-check and axe-core. `allowBuilds` is an explicit allow/deny list; an unlisted install script fails the install until reviewed. `minimumReleaseAge` is three days, with dated, exact exclusions only.
- Keep pnpm's default peer resolution (`resolvePeersFromWorkspaceRoot` true). The mutation lane isolates Vitest 4.1.11 by declaring its whole companion family through the `mutation` named catalog. The TypeScript 6 alias appears in exactly two leaf manifests (`tooling/mutation`, `tooling/api-codegen`); `guards.mutation-lane.guard` asserts it.
- `knip.jsonc` carries per-workspace `ignoreDependencies` for the dependencies declared ahead of their milestone; delete an entry the moment product code imports the package. Never add an ignore to hide a real finding.
- Only the lead of a change runs `pnpm install`; parallel workers never write the lockfile. Note that `pnpm exec <tool>` triggers an install when manifests changed.

### Commits and branches

- Conventional Commits, enforced by commitlint through lefthook: `feat(collab): add saved-ack protocol`. Header under 100 characters, body lines under 100 characters, no time or effort estimates anywhere.
- No `Co-Authored-By` trailers, no "Generated with" footers, no tool credits in commits, pull requests, comments or documentation.
- `main` is the protected trunk. Milestone tags are `v0.<N>.0`, cut by hand on the exit-record commit after the required CI checks are green; `release.yml` skips `v0.0.0`.
- A failed spike's note must name the commit that executed its fallback, and a commit cannot name itself: land the milestone commit first, then a docs commit that writes `commit <sha>` into the notes and `docs/milestones/M<N>-exit.md`.

## Key Design Principles

1. **Saved means committed.** The client's save indicator turns on only after the server's transaction committed and its broadcast state vector dominates the client's. Persistence is a per-note FIFO writer with a head-sequence compare-and-swap; the V2 snapshot plus V1 append log is the durable form.
2. **One authorization core.** Knowing an identifier grants nothing; every REST route declares `config.auth`, and the boot assertion refuses to start with an undeclared route.
3. **Agents read committed content, never live CRDT state.** MCP tools and the read-only REST surface share one read core that returns Markdown at a named revision.
4. **The Yjs state is authoritative and is never rebuilt from Markdown.** A document is initialized once (`new Y.Doc(` only in `@iridium/crdt`, the initial-state path and tests) and loaded from its persisted binary afterwards.
5. **Markdown source is preserved byte for byte.** Line endings and BOMs are normalized once at import and restored on export from recorded metadata.
6. **Rendered notes are untrusted content.** Sanitization on the parsed tree is the single security boundary; parsing runs in workers under hard caps; the renderer runs under a nonce-only CSP.
7. **Everything has a limit** and every refused request produces its documented reason.
8. **Two MySQL lines, both required.** Every statement has identical semantics on 8.4.11 and 9.7.2; the `tooling/sql` denylist and the schema-parity test enforce it.
9. **An architectural rule that no test enforces is a comment.** The invariants in `02-system-architecture.md` are each paired with a guard; add the guard with the rule.

## Development Commands

```bash
pnpm install                                   # pnpm 12.4.1 downloads Node 24.21.0 itself (or `mise install`)
pnpm turbo run build check-types lint test     # the everyday gate (unit + guard + component per package)
pnpm exec turbo boundaries                     # package boundary rules
pnpm exec oxfmt --check . && pnpm exec knip --production
pnpm gen                                       # regenerate every generated artefact (needs Docker for the kysely step; --skip-db without)
pnpm gen:check                                 # the same, failing on drift (what CI runs)

# Test lanes (Docker is needed for integration/property/chaos/contract/mcp)
pnpm test:unit  |  pnpm test:guard  |  pnpm test:component
IRIDIUM_MYSQL_IMAGE=mysql:8.4.11 pnpm test:integration     # also run with mysql:9.7.2-oraclelinux9
pnpm e2e:electron                              # Playwright electron project against the built server
pnpm mutation                                  # Stryker lane, run alone

# Run what exists
docker compose -f infra/compose.yaml up mysql   # MySQL with the shipped my.cnf and roles
pnpm --filter @iridium/server run iridium migrate up   # needs DATABASE_MIGRATE_URL and the keyring env
pnpm --filter @iridium/server run iridium serve        # http://127.0.0.1:4000/readyz
pnpm --filter @iridium/desktop dev                     # the Electron shell
docker build -f infra/docker/server.Dockerfile -t iridium-server:local .
```

`pnpm --filter <pkg> exec <its-own-bin>` never works (a package's own bin is not on its own path); use the `run iridium` script form. Static CI checks live in `scripts/check-*.ts` and are run as `node scripts/<name>.ts` from the repository root.

## Database

MySQL only, two required lines. Kysely migrations `0001`–`0048` under `apps/server/migrations/` run through the server's own migrator under `GET_LOCK('iridium_migrate', 60)`; `apps/server/src/db/schema.ts` is hand-written and diffed against `kysely-codegen` output by `pnpm gen`. Three roles (`iridium_app`, `iridium_migrator`, `iridium_backup`) are created by `infra/docker/mysql/init/01_roles.sh`; migration `0034_grants` applies the table-level grant matrix and skips with a logged warning when the migrator holds no `GRANT OPTION` or the accounts do not exist. The schema, roles and the SQL dialect floor are `docs/plan/03-data-model.md`.

## API Surface

Documented in `docs/plan/09-api-reference.md` and generated into `packages/contracts/openapi/openapi.json` from the live route set (never hand-written). At M0 the server serves only `/healthz`, `/readyz`, `/metrics` and the root redirect; the `/api/v1` route tree, `/collab` and the two MCP mounts arrive with M1–M3. Every non-2xx response is an RFC 9457 problem document with a closed error-code list; every request carries `X-Iridium-Client`.

## Configuration

The server reads its environment once, in `apps/server/src/config/env.ts` (`EnvSchema`): every documented key with default and floor is in `docs/plan/11-operations-and-deployment.md` and, as it lands, `docs/ops/configuration.md`. Secrets accept `*_FILE` twins; signing keys are versioned keyrings (`AUTH_PASSWORD_PEPPER_V1`, `AUDIT_HMAC_KEY_V1`, `MCP_CURSOR_KEY_V1`). Unknown `IRIDIUM_*` keys are fatal; `IRIDIUM_FAULT` is accepted only under `NODE_ENV=test`; `IRIDIUM_E2E` is rejected by name (only the desktop process reads it). `scripts/check-env-lists.ts` keeps `apps/server/turbo.json`'s env list and the schema keys equal in both directions. `UV_THREADPOOL_SIZE` and the production argon2 pair come from the deployment environment (`infra/compose.prod.yaml`), never from the process.

## Security Notes

- Tokens are `irid_<kind>_<id16>_<secret43><crc6>`; one verifier; sessions are `__Host-` cookies with CSRF protection on every mutating route.
- The desktop shell runs with context isolation, sandbox, fuses and the `app://iridium` scheme; the renderer has no Node and no credentials; the preload exposes exactly the generated `window.iridium` surface (snapshot-tested).
- Rendered content is sanitized on the hast tree; the CSP is nonce-only (`style-src` is never relaxed; the S4 spike records why).
- Argon2id for passwords (`65536`/`3` defaults, `131072`/`6` in production); the licence allowlist, the audit-chain HMAC and the update-log integrity rules are in `docs/plan/04` and `10`.
- Report vulnerabilities per `SECURITY.md`.

## Working With the Plan

- Read `docs/plan/README.md` first, then the milestone in progress in `docs/plan/12-milestones.md`; its exit criteria (§N.6) and the cross-cutting gates (§3) are the definition of done. `docs/milestones/CURRENT` names the last exited milestone.
- Spikes are bounded experiments with a written verdict (`docs/spikes/S<nn>-<slug>.md`, eight fixed headings, `pass` or `fail`, never `open`); spike harnesses are throwaway (D12-5) and nothing may depend on them.
- When a finding changes a decision, amend the entry in `13-decision-log.md` (status line, dated) and mirror it in the ADR file, then the sections that repeat it; the plan is kept true, not archived.
- Every milestone exit writes `docs/milestones/M<N>-exit.md` before its tag.

## Current Project Status

- **M0 (repository bootstrap, harnesses, spikes): exited on 2026-09-13** — milestone commit `71915f5`, exit record `docs/milestones/M0-exit.md`. The tag `v0.0.0` is cut after the first green CI run on a remote.
- **Not yet built**: everything a user would call the product. M1 (auth, vaults, the note kernel with collaborative saving, headless) is next, then M2 structure and search, M3 MCP and OAuth, M4 the web UI and editor, M5 the desktop client, M6 import/export and attachments, M7 the admin console, M8 operations hardening and the 1.0 release.
- Open items carried in the exit record: unit coverage for `apps/server/src/authz/route-policy.ts` before the M1 gate; `@fastify/swagger` registration in the rest plugin at M1; the OpenAPI document's licence (owner decision); emptying `minimumReleaseAgeExclude` after 2026-09-14.

Refer to `docs/plan/README.md` for the reading guide and `docs/plan/13-decision-log.md` for every settled decision.
