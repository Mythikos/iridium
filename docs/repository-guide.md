# Iridium repository guide

The single source of operating guidance for working in this repository. `CLAUDE.md` and `AGENTS.md` both point here and carry nothing of their own: guidance is added, corrected and removed in this file, so every agent and every contributor reads the same rules.

Keep it that way: when something here is wrong or missing, correct it here rather than in either pointer file. Where this guide and the plan disagree, the plan wins and this file is fixed in the same change.

## Project Overview

Iridium is an internal, self-hosted documentation platform that merges the vault-and-Markdown workflow of Obsidian with the simultaneous multi-author editing of Google Docs, and gives AI agents first-class, read-only access to the vaults through the Model Context Protocol (MCP). Everything runs against one Node server with MySQL behind it; the client is one React application that runs both in the browser and inside a hardened Electron shell, and the Electron desktop application is the supported client at 1.0.

The development plan in `docs/plan/` (README plus `01`–`15`) **is the specification**. Every settled decision has an ADR under `docs/adr/`, mirrored from `docs/plan/13-decision-log.md`, which is the authoritative record. When the plan says what to build, build what it says; when the tree and the plan diverge, amend the plan in the same change and say why. Do not invent scope the plan does not name.

## Working With the User

- **Never provide time or effort estimates.** No "30 minutes", "half a day", no tiering proposals by duration, and no choosing between approaches by which is faster to implement. Describe scope by what changes (files, mechanism, risk surface) and compare approaches by their technical trade-offs: correctness, dependencies, complexity, future flexibility. If asked how long something takes, say that an AI cannot reliably predict that and describe the scope instead. The plan itself carries no estimates, and neither do commits, pull requests or documents.
- **Choose the solution that is best for the codebase, never the quick fix.** A localized workaround is not an option when a principled fix exists; risk is a reason to test carefully, not to pick the lesser change.
- **The plan is the specification.** Implement what it says; when the tree must diverge, amend the plan in the same change and say why; when it is silent, say so and record the choice.
- **Preserve the existing working tree.** Read the current diff before editing, build on the work already present, and never revert or overwrite an unrelated change. Files on disk may be another agent's work in flight.
- **Parallel agents take independent, bounded tasks.** Give each one explicit path ownership so edits cannot overlap; a stream that needs a change outside its paths describes it rather than making it. Integration, review, and every shared dependency or lockfile change stay with the lead.

## Architecture

One Node 24 process built on Fastify 5 owns all input and output:

- **REST API** under `/api/v1` — the only content write path, validated by zod schemas from `@iridium/contracts`, documented by a generated OpenAPI 3.1 document.
- **Collaboration WebSocket** at `/collab` — Hocuspocus 4.7 embedded as a library over Yjs 13. "Saved" means a MySQL transaction containing the user's edits has committed *and* the server has broadcast a state vector that dominates the client's and a canonical delete-set fingerprint that equals the client's.
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

These are the maintainer's programming standards, applied to this repository. Where a general rule and an established TypeScript convention conflict, the TypeScript convention takes precedence, in the same way the C# convention does in a C# project; each such case is called out below with its reason. Anything the toolchain enforces (oxfmt, oxlint, the TypeScript bases, the guards) is not a matter of taste in a pull request: fix the code, not the rule.

### Code formatting

- **The formatter owns whitespace.** oxfmt (`.oxfmtrc.jsonc`: 2-space indentation, 100 columns, single quotes, semicolons, trailing commas, sorted imports) formats every source file; never hand-format and never argue with its output. The general standard prefers tabs, 200-column lines and Allman braces; the TypeScript convention (2 spaces, K&R braces, a ~100-column width) takes precedence here, and Allman braces are unsafe in JavaScript in any case: `return` followed by a newline and `{` returns `undefined` through automatic semicolon insertion.
- **Spacing**: one space after each comma; one space on both sides of binary, relational, logical and assignment operators; none around unary operators. oxfmt applies all of this.
- **Blank lines**: one blank line separates logical blocks inside a function (after a guard clause, between an `if` block and the next statement) and top-level members of a module or class; no blank line between tightly coupled lines that form one unit (a declaration and the statement that uses it, consecutive related assignments). Import groups are separated by one blank line (Node built-ins, external packages, workspace packages, relative), which `sortImports` enforces.
- **Line breaks**: a statement, a signature or a call stays on one line until the formatter's width breaks it; do not break lines for style. Do not align code vertically with extra spaces.
- **Sections**: the language has no `#region`; group related members with a one-line comment header (`// ---- the three routes ----`) only where a module is long enough to need a map, and keep the header hugging what it introduces.
- **Resource scope**: there is no braced `using` block. A resource with a lifetime (a database handle, a container, a socket, a timer) is released in `finally` or by an explicit `close()` the owner calls, and the owner is one object; never rely on garbage collection to release it.

### Naming

- **Descriptive names everywhere.** No one- or two-character identifiers except loop counters and conventional generics (`T`, `K`).
- **PascalCase**: classes, interfaces, type aliases, React components, and enum-like `as const` objects' types.
- **camelCase**: functions, methods, local variables, parameters, properties. (The general standard uses PascalCase for methods; the TypeScript convention is camelCase and takes precedence.)
- **Private members**: ECMAScript private fields and methods (`#connection`, `#tick()`), not an underscore prefix; the runtime enforces the privacy the `_` prefix only signals. Static private state is `static #name`.
- **Constants**: module-level constants are `UPPER_SNAKE_CASE` (`LIMITS`, `DB_ROLES`, `REQUIRED_MYSQL_IMAGES`); a class-private constant is a `static readonly` member declared at the top of the class.
- **UI elements**: a variable or ref that holds a DOM node or a component instance says so (`saveButtonRef`, `titleInput`, `treePane`).
- **Files**: kebab-case (`route-policy.ts`, `prefix-suffix-diff.ts`); tests `<area>.<subject>.<layer>.spec.ts`.
- **Wire and database names** follow the plan: snake_case columns and JSON fields as `03-data-model.md` and `09-api-reference.md` state them; never rename a wire field to fit a code style.

### Constants and configuration

- Shared constants live in one owning module and are imported from it, the way every numeric limit lives in `@iridium/contracts/limits.ts` (invariant 6; `limits.single-source.guard` fails on a stray literal). Group related constants in one frozen object (`Object.freeze({...}) as const`) rather than loose exports.
- Instance-specific constants are private and declared at the top of their class or module.
- `const` always; `let` only when reassignment is the point; never `var`. Frozen objects and `readonly` arrays for shared data.
- Prefer environment-defined values over literals: anything an operator may tune is an `EnvSchema` key (`apps/server/src/config/env.ts`) read once in `config/`, never `process.env` elsewhere (invariant 3).

### Classes and modules

- Modules of functions are the default unit; a class exists to own state with a lifetime (a readiness registry, a ticket store, a note writer). A class that owns state has an explicit constructor that receives its dependencies; no service locators, no globals.
- Never expose mutable fields: `readonly` properties or accessors, and `#private` for everything internal.
- No mutable module-level state except an explicitly named registry the module owns (and then it is `#private` behind functions); no global variables of any kind.
- Initialize every variable at declaration; prefer discriminated unions to nullable fields for state.
- Follow KISS, YAGNI, DRY, single responsibility and least astonishment. A duplicated block is extracted when the second copy appears, not the third.

### Concurrency (the Node counterpart of the threading rules)

- The event loop is never blocked: CPU-bound work (argon2, Markdown projection, compaction) runs in worker threads through piscina, and worker pools are bounded.
- Every promise is awaited or explicitly handed off: `typescript/no-floating-promises` and `no-misused-promises` are errors. A background task has an owner that awaits it, a cancellation path and a bounded queue; nothing is fired and forgotten.
- Shared mutable state across awaits is guarded by design (a per-note FIFO writer with a head-sequence compare-and-swap, `GET_LOCK` for cross-process work), not by hoping interleavings are benign. Timers are injected (`Clock`), never global.
- Sequential loops of awaits are either made concurrent with `Promise.all` when independent or carry a reasoned `no-await-in-loop` directive when the order matters.

### Commenting

- Comments follow the indentation of the code they describe. Inline comments explain an ambiguous or complex line; block comments explain a module, class or function.
- JSDoc/TSDoc (`/** … */`) on every exported function, class and type, with parameter and return descriptions where they are not self-evident and `@internal` on exports that exist for tests.
- Comments explain *why*, cite the plan section or decision that decides it (`(03-data-model.md §2)`, `(A14)`, `(D12-5)`), and never restate the code. A module header says what the module owns and what it deliberately does not.
- Write everything as the maintainers' own work: no tool attribution in comments, commits, pull requests or documentation.

### Error handling

- Exceptions are for exceptional conditions, never for control flow; an expected outcome is a returned discriminated union (`{ applied: false, skipped: 'no_grant_option' }`), not a thrown error.
- Overusing `try`/`catch` is as bad as not using it: catch where the error can be handled or translated (a boundary, an adapter), let it propagate elsewhere, and never swallow one.
- Validate at system boundaries — request bodies, environment, files, wire payloads, tool arguments — with zod or an explicit guard; trust the types inside.
- A thrown error is a named class, carries the file, key or value that was wrong and states the remedy. Scripts exit `0` on pass, `1` on a check failure, `2` on a usage or environment error.

### TypeScript specifics

- The shared bases in `tooling/tsconfig/` are strict and non-negotiable: `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `verbatimModuleSyntax`, `erasableSyntaxOnly`, `isolatedModules`; compiled packages also build with `isolatedDeclarations`.
- Consequences: no `enum`, no `namespace`, no constructor parameter properties (declare the field and assign it); `import type` for types; relative imports carry the `.ts` extension; exported values in compiled packages carry an explicit type annotation where inference would spread; index access yields `T | undefined` and is handled, not asserted.
- No `any`, no non-null assertions to silence the checker, no `@ts-nocheck`, no `@ts-ignore`. Explicit return types on exported functions.
- Lint must be clean with **zero warnings**. A disable directive always carries its reason on the same line (`// eslint-disable-next-line no-await-in-loop -- probes are sequential by design`); never disable a rule for a whole file. `no-console` outside the CLI and scripts.
- Banned imports per boundary tag: `node:*`, `electron`, `react` and DOM globals in `core`; `node:*` (except type-only), `electron`, `react` in `iso`; `node:*`, `electron` in `browser`; `yjs`/`lib0`/`y-protocols` anywhere but `packages/crdt`. `setTimeout` sleeps are banned in test files.
- Export only what something consumes; a barrel re-exports what is reached through it. Dead code is deleted, not kept for later; the plan and git history hold what a later milestone needs.
- One boot path: `buildApp({ mode })` is the only construction site of the Fastify instance (invariant 1).

### Tests

- File name `<area>.<subject>.<layer>.spec.ts[x]`, layer in `{unit, component, integration, prop, chaos, contract, mcp, e2e, guard, drill}`. The top-level `describe` title **is** the test's name in `docs/acceptance-map.json` and carries its requirement tag: `[spec:<row-id>]` for spec rows, `[hp:HP-n]` for hard properties, `[area:<area>]` otherwise (the exact vocabulary is the "Requirement tags" row of `10-testing-and-quality.md`). Names are lower-case kebab segments; `docs.spikes.spec` is the one literal exception.
- Every test name written in `docs/` must be a key of the acceptance map (`node scripts/check-test-name-references.ts`); adding a test means adding its inventory row to `10-testing-and-quality.md` and regenerating the map with `pnpm gen`.
- Unit and pure property tests live beside the source under `src/`; server integration/chaos/contract/mcp/property trees under `apps/server/test/<project>/`; repository-wide guards under `apps/server/test/guards/`. Guards never pass vacuously: a guard proves in-file that it refuses the shape it exists to catch.
- Eventual state is awaited with `expect.poll` or the testkit's `waitFor`; time is a `ManualClock`; network faults come from Toxiproxy toxics. `vi.mock` only in `unit` and `component`, only for I/O adapters and host seams. Snapshots are file snapshots for golden artefacts; inline snapshots stay under one line.
- Property budgets come from `@iridium/testkit`'s `PROP` / `PROP_DB` (mirrored in `packages/<pkg>/test/prop-budget.ts` where the testkit cannot be imported); `numRuns` is never lowered; arbitraries import `fast-check`, the runner glue imports `@fast-check/vitest`.
- Deliberate raw SQL writes use named, logged operations in `@iridium/testkit`'s `db/corrupt.ts`; metadata SQL uses its read-only `db/inspect.ts` helpers. Preserve the caller's real transport, role and transaction, and keep assertions in the spec. The AST guard rejects raw Kysely tags/escapes and statically resolved mutating transport calls in specs/support without a spec allowlist. Direct `SELECT`/`SHOW` assertions and explicit read-session coordination remain allowed; existing environment lifecycle helpers own schema provisioning/reset/import, never an alternate product seeder.
- Coverage thresholds (12-milestones.md §3) are one gate, evaluated by the `merge-reports` CI job whenever the effective test target is M1 or later. `CURRENT` remains the last exited milestone; the mutation lane runs the unit project only.

### Dependencies

- Every external version is an exact pin in the catalog and referenced as `"<pkg>": "catalog:"`; workspace packages as `"workspace:*"`. The catalog carries only versions a manifest declares; pins for later milestones stay in `02-system-architecture.md`'s dependency table until declared.
- `overrides` pin one copy of yjs, lib0, y-protocols, `@codemirror/state`, `@codemirror/view`, `@types/node`, fast-check and axe-core. `allowBuilds` is an explicit allow/deny list; an unlisted install script fails the install until reviewed. `minimumReleaseAge` is three days, with dated, exact exclusions only.
- Keep pnpm's default peer resolution (`resolvePeersFromWorkspaceRoot` true). The mutation lane isolates Vitest 4.1.11 by declaring its whole companion family through the `mutation` named catalog. The TypeScript 6 alias appears in exactly two leaf manifests (`tooling/mutation`, `tooling/api-codegen`); `guards.mutation-lane.guard` asserts it.
- `knip.jsonc` carries per-workspace `ignoreDependencies` for the dependencies declared ahead of their milestone; delete an entry the moment product code imports the package. Never add an ignore to hide a real finding.
- Only the lead of a change runs `pnpm install`; parallel workers never write the lockfile. `verifyDepsBeforeRun: error` makes `pnpm run` and `pnpm exec` refuse stale installed dependencies. Run an explicit `pnpm install --frozen-lockfile` before workspace tasks; those tasks must not trigger competing implicit installs.

### Version control

- Trunk-based development: `main` is always deployment-ready. **Commit and push directly to `main`; do not open a pull request, and do not create a branch, until told to change this rule.** The pull-request workflow this project will eventually use is not in force: it buys nothing while there is one author and no branch protection, and a session that imposes it is adding ceremony rather than following the standard. When the rule changes, this line changes with it, and branches are then named `<type>/<short-description>`, mirroring the commit type.
- Conventional Commits, enforced by commitlint through lefthook: `feat(collab): add saved-ack protocol`. Header under 100 characters, body lines under 100 characters, no time or effort estimates anywhere.
- No `Co-Authored-By` trailers, no "Generated with" footers, no tool credits in commits, pull requests, comments or documentation.
- The repository carries `README.md`, `.gitignore`, `CONTRIBUTING.md` and `SECURITY.md`; keep them current.
- Milestone tags are `v0.<N>.0`, cut by hand on the exit-record commit after the required CI checks are green; `release.yml` skips `v0.0.0`. A failed spike's note must name the commit that executed its fallback, and a commit cannot name itself: land the milestone commit first, then a docs commit that writes `commit <sha>` into the notes and `docs/milestones/M<N>-exit.md`.

## Key Design Principles

1. **Saved means committed.** The client's save indicator turns on only after the server's transaction committed and its broadcast state vector dominates the client's and its canonical delete-set fingerprint equals the client's. Persistence is a per-note FIFO writer with a head-sequence compare-and-swap; the V2 snapshot plus V1 append log is the durable form.
2. **One authorization core.** Knowing an identifier grants nothing; every REST route declares `config.auth`, and the boot assertion refuses to start with an undeclared route.
3. **Agents read committed content, never live CRDT state.** MCP tools and the read-only REST surface share one read core that returns Markdown at a named revision.
4. **The Yjs state is authoritative and is never rebuilt from Markdown.** A document is initialized once (`new Y.Doc(` only in `@iridium/crdt`, the initial-state path and tests) and loaded from its persisted binary afterwards.
5. **Markdown source is preserved byte for byte.** Line endings and BOMs are normalized once at import and restored on export from recorded metadata.
6. **Rendered notes are untrusted content.** Sanitization on the parsed tree is the single security boundary; parsing runs in workers under hard caps; the renderer runs under a nonce-only CSP.
7. **Everything has a limit** and every refused request produces its documented reason.
8. **Two MySQL lines, both required.** Every statement has identical semantics on 8.4.11 and 9.7.2; the `tooling/sql` denylist and the schema-parity test enforce it.
9. **An architectural rule that no test enforces is a comment.** The invariants in `02-system-architecture.md` are each paired with a guard; add the guard with the rule.

## Documentation Lookup

Reach for the Context7 MCP server for current library, framework, SDK, API, CLI-tool and cloud-service documentation whenever that behaviour bears on the task — including for technologies you know well, because a pinned version here may not be the one you learnt.

1. Call `resolve-library-id` with the library name and the concrete question, unless an exact `/org/project` identifier is already known.
2. Choose the match by name, relevance, documentation coverage and source reputation, preferring a version-specific identifier when the catalog pins a version. Retry with a better name or question when the matches are wrong.
3. Call `query-docs` with the chosen identifier and one complete question scoped to a single concept; ask about distinct concepts separately unless their interaction is the question.
4. Answer and implement from the fetched documentation, citing the version. Prefer it to a web search for anything library-specific.

Refactoring, scripts written from scratch, business-logic debugging, code review and general programming concepts need none of this unless an external library's behaviour is material.

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

MySQL only, two required lines. Kysely migrations `0001`–`0055` under `apps/server/migrations/` run through the server's own migrator under `GET_LOCK('iridium_migrate', 60)`; `apps/server/src/db/schema.ts` is hand-written and diffed against `kysely-codegen` output by `pnpm gen`. Three roles (`iridium_app`, `iridium_migrator`, `iridium_backup`) are created by `infra/docker/mysql/init/01_roles.sh`. Forward migration `0054` records the current table-grant matrix's applied or skipped provenance under `schema_meta` keys `acl.<table>` without rewriting prior migration history. A missing `GRANT OPTION` or account records a skip: readiness retains an unverified warning, while rolled-back probes fail readiness for demonstrably missing critical application privileges. A DBA applies `docs/ops/db-grants.sql`; M1 retains historical skip metadata rather than claiming a reserved repair command exists. The schema, roles and SQL dialect floor are in `docs/plan/03-data-model.md`; the operator procedure is in `docs/plan/11-operations-and-deployment.md`.

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

- Read `docs/plan/README.md` first, then the milestone in progress in `docs/plan/12-milestones.md`; its exit criteria (§N.4; §4.6 for M0) and the cross-cutting gates (§3) are the definition of done. `docs/milestones/CURRENT` names the last exited milestone.
- Spikes are bounded experiments with a written verdict (`docs/spikes/S<nn>-<slug>.md`, eight fixed headings, `pass` or `fail`, never `open`); spike harnesses are throwaway (D12-5) and nothing may depend on them.
- When a finding changes a decision, amend the entry in `13-decision-log.md` (status line, dated) and mirror it in the ADR file, then the sections that repeat it; the plan is kept true, not archived.
- Every milestone exit writes `docs/milestones/M<N>-exit.md` before its tag.

## Milestone Status

- `CURRENT` names the last formally exited milestone and is **M0**. [M0-exit.md](milestones/M0-exit.md) records its complete remote matrix and `v0.0.0` marker.
- M1 is implemented and versioned at `0.1.0`. The [exit candidate](milestones/M1-exit.md) remains provisional: commit `2d62b99` failed its own MySQL 9.7 audit contention proof. The OPS-12 timeout-sweep correction is being verified before a replacement exit record and `v0.1.0` tag.
- Both requested NoteSession findings are fixed. Local macOS Electron and a fresh local registry audit remain outstanding as directed. [remote-ci.md](milestones/remote-ci.md) preserves actual scheduled/manual history and failed runs.
- Commit and push directly to main; no branches or pull requests. The M1 changeset is consumed, and no version-PR job exists.
- M2 remains the next milestone after M1's formal exit; no M2 work is started here.

Refer to `docs/plan/README.md` for the reading guide and `docs/plan/13-decision-log.md` for every settled decision.
