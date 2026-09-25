# M3 working record

M3, MCP, agent access and the OAuth 2.1 authorization server, is in progress. It entered from
`1fa4b7e32df09f70cc48ce63bfbf380083944b20`
(`docs(plan): settle the M3 specification before implementation`), the commit that settled the M3
specification against the tree and recorded the owner's four decisions below. `CURRENT` reads M2 and
stays at M2 until M3 exits: LT-9 advances it in the exit-record commit that `v0.3.0` targets. This
record is the working account of the milestone: the owner's decisions, the waves and lead tasks, the
rules every package works under, the binding LIMITS owner table and the lead's merge steps. Once
`M3-exit.md` is written, it is the exit declaration and takes precedence wherever the two differ.

## The owner's decisions

The owner answered four scoping questions, G9 to G12, on 2026-09-24. The entry commit records each
one as a decision-log entry with its ADR, as a row of 14-risks-and-open-questions.md §G carrying the
owner's words and the reading applied, and in every section that repeats it. They are settled for
M3.

1. **S15 and the live connector move to M4 (AG9).** `/oauth/authorize` sends a browser that has no
   session to the SPA's `/app/login`, which arrives with M4, so no real connector can complete the
   flow against an M3 build. M3 therefore exits on `oauth.authorization-code.integration`. In it,
   the testkit's scripted `oauthClient()`, in both its `dynamic` and `cimd` registrations, signs in
   through `POST /auth/sessions`, consents to two vaults on the server-rendered page, exchanges the
   code with PKCE `S256`, reads a note on `/mcp/connect` and refreshes once. The end-to-end
   claude.ai and Claude Desktop connector run is spike S15, which runs before M4 exits. Recorded in
   13 AG9 (superseding in part AG1 and D06-31), `docs/adr/0062-connector-proof-at-m4-exit.md`, 14 §G
   row G9, and 12 §4.4 (S15 at `M4 (before exit)`), §7.3, §8.2 and §8.3.
2. **S9 and the client matrix are headless at M3 (AG10).** S9 runs before M3 exits, as a
   `workflow_dispatch` of `nightly.yml › mcp-clients` at target M3 (LT-8). It drives only clients
   that run headlessly: the Claude Code CLI, `mcp-remote`, the downloaded `iridium-mcp` bridge, the
   SDK client, `curl` and the scripted OAuth clients. Every matrix run serves `PUBLIC_ORIGIN` over
   the product's own in-process TLS profile. GUI clients are recorded as not yet observed. They are
   observed by hand in `docs/acceptance/mcp-gui-clients.md`, first before M4 exits and again at M8.
   The nightly matrix is advisory from M3 to M7 and becomes a gate at M8. Recorded in 13 AG10
   (superseding in part AG1, A32, A52 and the S9 method), `docs/adr/0063-headless-client-matrix.md`,
   14 §G row G10, 12 §4.4 (the S9 row) and §7.2 (`apps/e2e/mcp-clients` and Spike S9), and D12-11 as
   amended.
3. **The conformance tools live in a dev-only leaf (AG11).** `@modelcontextprotocol/conformance`
   0.1.16 and `@modelcontextprotocol/inspector` 2.6.0 are catalog pins, declared only as
   `devDependencies` of the private leaf `tooling/mcp-conformance` (`@iridium/mcp-conformance`). The
   leaf is tagged `harness`: it depends on nothing and nothing depends on it. It is the one
   workspace where MCP SDK v1 may resolve, and `guards.mcp-sdk-confinement.guard` holds SDK v1 to
   it. Tests spawn both bins through the testkit's `mcp/toolchain.ts`. The lead creates and installs
   the leaf at LT-5 under the approved registry egress. mcp-remote and Claude Code stay outside the
   workspace: the npm manifest and lockfile under `apps/e2e/mcp-clients/clients/` (LT-4) pin them,
   and only the nightly job installs them. Recorded in 13 AG11 (superseding in part the removal of
   both packages at 12 §4.2 step 3 and A32's development-and-test pins clause),
   `docs/adr/0064-mcp-conformance-leaf.md`, 14 §G row G11 and 12 §7.2 (`tooling/mcp-conformance`).
4. **The settings store carries three groups (AG12).** M3 ships the `SettingsStore` and
   `GET`/`PUT /admin/settings` with exactly `patPolicy`, `mcpEnabled` and `oauthPolicy`, the groups
   that M3 code reads. `sessionPolicy`, `passwordPolicy`, `retention` and `desktopUpdatePolicy`
   continue to be read from `EnvSchema` until M7 adds each one in the change that rewires its
   consumer, and a `PUT` that names one of them is `422 validation_failed`. Recorded in 13 AG12
   (superseding in part 12 §11.2's M7 scheduling, and ARCH-10 and D09-10 as amended 2026-09-25),
   `docs/adr/0065-m3-settings-groups.md`, 14 §G row G12, and 12 §7.2 (`apps/server/src/settings`)
   and §7.3.

## Waves

The milestone runs as lead tasks (LT) and parallel packages (W). Each package owns explicit paths
and consumes only earlier waves. The lead task that follows a wave merges it.

LT-0 → W0 {contracts, schema, edge, seams, compat} + LT-1 → LT-2 → W1 {settings, envelopes,
read-graph, observability, bridge, doctor, citations} → LT-3 → W2 {credentials, surfaces, imports} →
LT-4 → W3 {oauth, mcp, docs} → LT-5 → W4 {mcp-transport, mcp-content, oauth-suites, audit, wire,
conformance, matrix} → LT-6 → W5 {release} → LT-7, LT-8 (S9), LT-9 (exit).

| Wave | Package | Title |
|---|---|---|
| W0 | W0-contracts | Contracts: the M3 wire, policy, audit and MCP vocabulary, with per-area route, policy, expected-key and authorization-case slots |
| W0 | W0-schema | Forward migrations 0060–0066, the schema and its fingerprint, and the CAS, one-DDL and plan-parity guards |
| W0 | W0-edge | Boot spine and request edge: TLS profile, boot-step and REST-area slots, one path classifier, routing branch, request ids, drain budget, the M3 log-event registry and the testkit harness seams |
| W0 | W0-seams | Lifecycle seams: the Promise `TicketStore` and every caller, scoped query deadlines, fenced batch deletes, and the M3 corruption operations |
| W0 | W0-compat | Per-release wire baselines at M3 entry: `v0.2.0` captured from its tag, the pointer, and the release-floor rule |
| W1 | W1-settings | Server settings store, M3 configuration, readiness, `/meta` and the client-compatibility floor |
| W1 | W1-envelopes | One error-envelope dispatcher, the path-based CSRF exemption and the `HEAD`/`rateLimit` boot check |
| W1 | W1-read-graph | The pagination module, the write-free read graph and `ContentReadCore`'s one resolution and slicing semantics |
| W1 | W1-observability | The batched access-log writer and REST/OAuth producer, the audit-chain write rules, the M3 metric set and the close-flush deadline |
| W1 | W1-bridge | `@iridium/mcp-bridge`: the single-file `iridium-mcp` stdio ⇄ Streamable HTTP proxy |
| W1 | W1-doctor | `doctor` register selection, the M3 credential invariants and the canonical repair commands |
| W1 | W1-citations | The D13-16 test-name citation checker, its guard and the docs citation corrections |
| W2 | W2-credentials | Credential core: the `TokenPrincipal` union, PAT lifecycle, one verifier, per-credential budget, last-used, bounded failure auditing, revocation, and their REST and CLI surfaces |
| W2 | W2-surfaces | Boot-time browser sign-in surface, the `/desktop/tools` bridge download, and the image's bridge stages |
| W2 | W2-imports | One `no-restricted-imports` composition (`RESTRICTED_IMPORT_OWNERS` minus `DECLARED_EXEMPTIONS`) and its guard |
| W3 | W3-oauth | The OAuth 2.1 authorization server: protocol half, credential half, OAuth REST and CLI, consent page, sweep, and the scripted test client |
| W3 | W3-mcp | The two MCP mounts: one handler, the six tools and two resource shapes over `ContentReadCore` |
| W3 | W3-docs | Agent and operator documentation, the generated agent-docs step, and the client registry `versions.json` |
| W4 | W4-mcp-transport | MCP transport suites on both mounts: dual era, host guard, discovery, rate limits, fail-closed, auth, factory errors, header profile, the both-mount verifier and CSRF clauses |
| W4 | W4-mcp-content | MCP content and authorization suites on both mounts: tool schema, scopes, isolation, revocation, cursors, output, resources, instructions |
| W4 | W4-oauth-suites | OAuth suites that cross into `/mcp/connect`: discovery split, the full code flow, disabled mode, audience, insufficient scope, OAuth revocation |
| W4 | W4-audit | Cross-surface audit, access-log, metrics, concurrency and admin suites |
| W4 | W4-wire | Route inventory, wire contracts and compatibility: the M3 route-policy assertion, OpenAPI, problem details, Schemathesis, route index, the OAuth-surface compat facts, published-URL gate cases, non-goals |
| W4 | W4-conformance | Bridge parity, MCP conformance against the typed baseline, Inspector smoke, and SDK v1 confinement |
| W4 | W4-matrix | The headless real-client matrix: static-header, OAuth and coexistence specs |
| W5 | W5-release | CI, nightly and release lanes, the M3 mutation scope and threshold, and the `v0.3.0` upgrade-fixture writer |

W5 exists because the workflows run W4-conformance's and W4-matrix's specs by path, and a package
may consume only earlier waves.

## Lead tasks

| Task | When | Work |
|---|---|---|
| LT-0 | M3 entry, `main` at `1fa4b7e`, before any W0 worktree | Opens this record and lands the entry registries as one commit: the complete M3 `LIMITS` register with its `since: 3` rows, and A54's `API_VERSION` moved beside `RELEASE_MIN_CLIENT_VERSION` in contracts `rest/meta.ts` (below). |
| LT-1 | During W0, in the lead's own worktree; merged with W0 | `apps/server/src/cli/doctor-register.ts`: every check in 03 §16.1's register that M0–M2 left unimplemented, each a chunked read-only `SELECT` reporting offending ids, run by default in `iridium doctor` (exit 6 on a finding) and selectable by id. |
| LT-2 | After every W0 package reports done | Merges W0 and LT-1, regenerates and commits the generated artefacts, applies the reported plan amendments, runs the full gate on both MySQL lines, confirms the schema fingerprint and the `v0.1.0` and `v0.2.0` baselines, and moves `LIST_PAGE_MAX` and `LIST_PAGE_DEFAULT` to `since: 1`. |
| LT-3 | After W1 | Merges the seven W1 packages under LT-2's gate, applies W1-citations' findings outside its trees, deletes the knip entries for the MCP SDK packages the bridge now imports, confirms that `.changeset/m3-server.md` carries `[migration]` and `[config]` and that `authz.vault-isolation`, `cli.maintenance` and `jobs.partitions` read `access_log` only through the new helpers, and moves `BOUNDED_LIST_MAX` to `since: 1` and `CURSOR_TTL_SECONDS` to `since: 2`. |
| LT-4 | After W2, before W3 | Merges W2 under W2-imports' lint composition, moves the three `AUDIT_DEDUP_*` rows to `since: 1`, records W2-credentials' clause split in 10, adds `secure-json-parse` 4.1.0 with its dependency reviews, and creates the `apps/e2e/mcp-clients/clients/` npm manifest and lockfile (mcp-remote 0.13.5, Claude Code ≥ 2.1.232). |
| LT-5 | After W3, before W4 | Merges W3, commits the regenerated OpenAPI document, `tools.schema.json` and `docs/agents` regions, deletes the knip entries for the MCP SDK v2 packages now imported, confirms that every W0 stub and slot is filled except `bridge-client.ts` and `toolchain.ts`, creates and installs the `tooling/mcp-conformance` leaf, and adds the `apps/e2e` dependencies W4-matrix needs. |
| LT-6 | After W4, before W5 | Merges the seven W4 packages, applies the defects their suites reported outside their fix rights, and runs `pnpm gen` and the full gate, the `mcp` project included, on both MySQL lines. |
| LT-7 | After W5 | Merges W5-release and records its `v0.3.0` dataset choice (10's `seed.structure.integration` row, D12-4). Then rehearses M3 at target M3 on both MySQL lines: the `since: 3` rows of `limits.policy.unit` ratchet in, `guards.acceptance-map.guard` requires every M3 layer, and the coverage gate, Stryker at break 75, knip, boundaries, dedupe, audit and licence all run. Confirms that no stub, empty slot, interim fallback or transitional field remains. |
| LT-8 | After LT-7, before the exit rehearsal | Runs spike S9 as the `nightly.yml › mcp-clients` dispatch with `milestone_exit=M3`. Writes `docs/spikes/S09-mcp-real-client-matrix.md`, the observed headless rows of `versions.json` and the headless wording of `docs/ops/mcp-clients.md`. Takes S9's fallback within M3 for any client that fails. |
| LT-9 | M3 exit | Runs the exit rehearsal on both lines, promotes the `v0.3.0` upgrade fixture and versions to 0.3.0 through Changesets. Writes `M3-exit.md`, which carries the Known-risks field and the Open-questions field with G13, due at M4 entry. Sets `CURRENT` to M3, updates the repository guide, 15 and `remote-ci.md`, tags `v0.3.0` on the exit-record commit and captures `baselines/v0.3.0`. |

## Working rules

LT-0 states eight rules, and every package brief is written against them. When a brief cites rule
(iv), it means the verify template.

- **(i) The plan is the specification.** A package never edits `docs/plan` or `docs/adr`, except for
  W1-citations' D13-16 citation corrections. It records any divergence, or any choice the plan
  leaves open, with proposed amendment text in its report. The lead applies the amendment (the 13
  entry, the ADR mirror and the sections that repeat it) at the next merge task and regenerates the
  acceptance map.
- **(ii) Dependencies are the lead's.** Packages run only `pnpm install --frozen-lockfile` and never
  touch the lockfile, the catalog, manifest dependencies or `knip.jsonc`.
- **(iii) Generate locally, never commit the outputs.** After the build and before any test, a
  package runs `pnpm gen --skip-db` (W0-schema runs the full `pnpm gen`), so that `gen.drift.guard`,
  `toMatchOpenApi` and `expectAuthorizationInventory` see its own routes. It commits none of the
  outputs. Before committing, it restores with `git checkout`: `packages/contracts/openapi`,
  `packages/contracts/mcp/tools.schema.json`, `packages/api-client/src/generated`,
  `packages/contracts/src/generated`, `packages/testkit/src/msw/generated`,
  `docs/acceptance-map.json`, `docs/non-goals.json`, `docs/ops/db-grants.sql` and
  `apps/server/test/fixtures/db-grants.snapshot.sql`. The one exception is W3-docs'
  `docs/agents/**`. The lead regenerates and commits at every merge.
- **(iv) The verify template.** The steps run in this order:
  1. a frozen install;
  2. build, check-types and lint over the changed workspaces and their dependents;
  3. the local generation of rule (iii);
  4. the image, built under the package's own tag `iridium-server:m3-<id>` (the id in lower case, as
     in `iridium-server:m3-w0-contracts`) and exported as `IRIDIUM_TEST_SERVER_IMAGE`, with
     `IRIDIUM_MYSQL_IMAGE=mysql:8.4.11`;
  5. the full unit, guard, integration, contract and property projects, plus `mcp` from W4 and
     `chaos` where a package names it;
  6. `turbo boundaries`, `knip --production --no-exit-code` (report-only, because `knip.jsonc` is
     the lead's), `node scripts/check-test-name-references.ts`, `node scripts/check-env-lists.ts`
     and `oxfmt --check`.

  A package that edits a file under one of 12 §3's per-file coverage globs runs step 5 with
  `IRIDIUM_COVERAGE_GATE=1` and `--coverage.include` restricted to those globs, so the configured
  thresholds apply. Each brief carries the concrete command for its own paths, and where a package
  needs them it adds a `mysql:9.7.2-oraclelinux9` run of named specs or the runtime smoke.
- **(v) Each shared registry has one editor per wave**, the one listed below. Anyone else describes
  the addition in their report.
- **(vi) A limit-worded numeric literal becomes a `LIMITS` member.** The owner table below is
  binding. `limits.single-source.allowlist.json` also has one editor per wave (W1-settings,
  W2-credentials, W3-oauth). The package that introduces a constant adds its allowlist entry;
  entries are never pre-seeded, because `limits.single-source.guard` fails on an entry that matches
  nothing.
- **(vii) Outage cases in the mcp project use per-test Toxiproxy proxies.** Each case creates its
  own uniquely named proxy, because the mcp project runs files in parallel and its global setup
  creates no shared proxy.
- **(viii) Test names come only from 10's inventory.**

### Shared registries

- `packages/contracts/src/limits.ts`: LT-0, then W1-settings for the `LIMIT_ENV_OVERRIDES` block
  only. W1-settings adds D03-28's `PAT_DEFAULT_RATE_LIMIT_PER_HOUR` and
  `OAUTH_DEFAULT_RATE_LIMIT_PER_HOUR` entries and drops `MCP_RATE_LIMIT_PER_HOUR`; the testkit names
  `patDefaultRateLimitPerHour` and `oauthDefaultRateLimitPerHour` replace `mcpRateLimitPerHour`. The
  three MCP overrides landed in LT-0.
- `apps/server/src/limits.policy.unit.spec.ts`: LT-0, then W0-seams for the synchronous
  `InMemoryTicketStore` block of the case
  `expires tickets at the policy TTL and accepts exactly the maximum HTTP ticket batch` (lines
  997–1014 after LT-0; `satisfies Record<LimitId, Enforcement>` is line 722), then the lead's merge
  steps below and the LT-7 ratchet.
- Route rows, `ROUTE_POLICIES`, `EXPECTED_KEYS` and the authorization cases: W0-contracts
  restructures them into per-area slots, which W1-settings (settings), W2-credentials (tokens),
  W3-oauth (oauth) and W3-mcp (mcp) fill.
- `packages/contracts/src/errors.ts`: W0-contracts, W1-settings, W2-credentials, W3-oauth, W4-wire
  (defect rights). Contracts `authz.ts`: W0-contracts, W2-credentials (the `TokenPrincipal` union),
  W3-oauth.
- `apps/server/src/authz/route-policy.ts`: W0-contracts (types), W1-settings, W2-credentials,
  W3-mcp, W4-wire. `app.ts`: W0-edge, W1-read-graph, W2-credentials, W3-oauth. `rest/plugin.ts`:
  W0-edge, then W1-read-graph. `rest/version.ts`: W0-edge in W0, W1-settings in W1.
- `audit/plugin.ts`: W0-edge, W1-observability. `security/*`: W0-edge, W1-envelopes, W2-credentials
  (rate limits), W3-oauth (CSP), W4-wire. `ops/metrics.ts`: W1-observability, with later waves only
  incrementing. `ops/events.ts`: W0-edge. `ops/shutdown.ts`: W0-edge, W1-observability, W3-mcp.
  `ops/readiness.ts`: W0-edge, W1-settings.
- `cli/commands.ts`: W1-doctor, W2-credentials, W3-oauth. `db/corrupt.ts`: W0-seams, W1-doctor.
- The testkit barrel: W0-edge only. Testkit start-server and in-process: W0-edge, W1-observability,
  W3-oauth. `vitest.config.ts`: W0-edge. `oxlint.config.ts`: W2-imports. `gen.ts`: W3-docs. Stryker
  and `ci.yml`: W1-read-graph (the pagination mutate scope), W5-release.
- The lockfile, catalog, manifest dependencies, `knip.jsonc`, generated artefacts and plan and ADR
  amendments: the lead.

## LT-0: the entry registries

LT-0 lands before any W0 worktree exists. Otherwise `limits.policy.unit.spec.ts` would need two W0
editors, one for the `satisfies` table and one for the ticket block.

- **The M3 LIMITS register.** Every member of 02's single-limits table that `limits.ts` lacked, each
  with a `limits.policy.unit` row at `since: 3` naming the owner and wiring the plan assigns
  (D06-48, D03-28, D04-37, D06-11, D06-49). It also adds `AUDIT_TARGETS_MAX`, which moves out of
  contracts `audit.ts` into `LIMITS` at `since: 1`, because `audit/chain.ts` has enforced it since
  M1. There is no `OAUTH_CLIENT_NAME_MAX_CHARS` (D06-47).
- **Two members the plan named no constant for**, added in the same change as the plan amendment:
  `MCP_GET_NOTE_HEADING_MAX_CHARS` (512, `get_note`'s `heading` argument, which 06, 09 §4.4 and the
  D06-09 amendment bounded by a bare 512) and `BEARER_MAX_BYTES` (128, the verifier's step 1 on
  every mount, which 06 stated as a bare number). Both are refusing numbers, so D06-48's rule makes
  them members; neither is a column width or a protocol hint. The same amendment makes
  `SEARCH_QUERY_MAX_CHARS` the member that `search_notes`' `query` reuses, which D06-48's reuse list
  had left out, and replaces the literals in the `search_notes` sketch with the members its table
  already cites.
- **The environment overrides.** `LIMIT_ENV_OVERRIDES` gains the three MCP entries of D06-48 whose
  `EnvSchema` keys already exist: `MCP_RATE_LIMIT_BURST_PER_MIN`, `MCP_PROCESS_CEILING_PER_MIN` and
  `MCP_REQUEST_TIMEOUT_MS`, with the testkit names `mcpBurstPerMinute`, `mcpProcessCeilingPerMinute`
  and `mcpRequestTimeoutMs`. D03-28's two hourly entries need keys that W1-settings creates, so they
  stay with W1-settings.
- **A54 as amended.** `API_VERSION` moves from `rest/version.ts` into contracts `rest/meta.ts`,
  beside `RELEASE_MIN_CLIENT_VERSION` (`'0.0.0'`). `rest/version.ts` serves and enforces the SemVer
  maximum of that release floor and `schema_meta.min_client_version`. A malformed release floor
  fails the module at load with `InvalidReleaseFloorError`. The database-free export uses the
  release floor alone, and `iridium version` reports `apiVersion` and `releaseMinClientVersion`, the
  floor the binary carries, per 11's row. W1-settings keeps the gate's scope, `SERVED_FEATURES` and
  `featuresFor`.
- **Plan corrections in the same change.** 02's API compatibility counter row now names contracts
  `rest/meta.ts`, rather than a `version.ts` that does not exist, and names the release floor. 06's
  plugin sketch no longer passes `graceMs` into `runExchange`, because `mcp/web-response.ts` owns
  `MCP_DEADLINE_GRACE_MS` (02, D06-48). A sketch that injected it would leave the owner file without
  the reference `limits.policy.unit` requires. The D06-48 ADR mirror now carries every member that
  13's entry lists.

## The LIMITS owner table

This table is the binding interface between LT-0 and the packages. It is the `since: 3` part of
`limits.policy.unit`'s `ENFORCEMENT` register, 73 rows, with each member's value from `LIMITS` at
LT-0. The spec enforces it mechanically once the target milestone is M3
(`IRIDIUM_TEST_TARGET_MILESTONE=M3` at LT-7, then `CURRENT`):

- **Owner.** The owner file, or for a directory some source file under it, must contain the text
  `LIMITS.<ID>` in code. A comment, a string or a template literal does not count, and a numeric
  literal in the member's place is a missing reference. A package references `LIMITS.<ID>` in the
  owner file named.
- **Wiring.** Each wiring expression must match code in the file named. When a property is named,
  the match must be inside that property's initializer, so the spelling of the option or property is
  part of the interface. A package that names an option differently (`burst` for `burstPerMinute`,
  or a destructured `processCeilingPerMinute` with no `mcp.` before it) turns M3 red at integration.
- **Environment-backed rows** are owned by `config/env.ts`, whose default reads the member. Their
  consumers receive the configured value and never read the member:
  - `auth/tokens/budget.ts` takes `burstPerMinute` and `hourlyDefault` by injection and references
    only `LIMITS.MCP_SEARCH_COST`, in `weightOf`;
  - `auth/plugin.ts` passes `config.mcp.burstPerMinute`;
  - `settings/merge.ts`'s `baselinesFrom` sets
    `defaultRateLimitPerHour: config.tokens.patDefaultRateLimitPerHour` and
    `defaultRateLimitPerHour: config.oauth.defaultRateLimitPerHour`;
  - `mcp/plugin.ts` passes `deadlineMs: config.mcp.requestTimeoutMs`, and
    `mcp.processCeilingPerMinute` is read from the configuration by `mcp/plugin.ts` or by
    `mcp/rate-limit.ts`.

  A read of `LIMITS.MCP_TOKEN_BURST_PER_MINUTE` or `LIMITS.MCP_TOKEN_PER_HOUR` in `budget.ts` would
  bypass both the environment override and the settings-resolved hourly default.
- **`MCP_DEADLINE_GRACE_MS`.** `runExchange` in `mcp/web-response.ts` reads the member itself; it is
  not an input to `runExchange`. `mcp/plugin.ts` references it for `closeMounts`, which disconnects
  a drained peer that has stopped reading.

Paths are relative to `apps/server/src/`. `contracts` is `packages/contracts/src/` and
`mcp-bridge src/` is `packages/mcp-bridge/src/`. A path ending in `/` is a directory, and any `.ts`
or `.tsx` file under it may carry the reference, except a spec, a `.d.ts` and a file under a
`testing/` directory. The package named is the one whose code must carry the reference. When a row's
owner or wiring spans two packages, each is listed. An `env` note names the `LIMIT_ENV_OVERRIDES`
key at LT-0. W1-settings replaces `MCP_RATE_LIMIT_PER_HOUR` with `PAT_DEFAULT_RATE_LIMIT_PER_HOUR`
and `OAUTH_DEFAULT_RATE_LIMIT_PER_HOUR`, and both map to `MCP_TOKEN_PER_HOUR`.

| Member | Value | Owner file (package) | Wiring (package) |
|---|---|---|---|
| `MCP_TOKEN_BURST_PER_MINUTE` | 120 (env `MCP_RATE_LIMIT_BURST_PER_MIN`) | `config/env.ts` (W1-settings) | `auth/tokens/budget.ts`: `/\bburstPerMinute\b/` (W2-credentials); `auth/plugin.ts`: `/config\.mcp\.burstPerMinute/` (W2-credentials) |
| `MCP_TOKEN_PER_HOUR` | 3,000 (env `MCP_RATE_LIMIT_PER_HOUR` at LT-0) | `config/env.ts` (W1-settings) | `settings/merge.ts`: `/\btokens\.patDefaultRateLimitPerHour\b/` in the `defaultRateLimitPerHour:` initializer (W1-settings); `settings/merge.ts`: `/\boauth\.defaultRateLimitPerHour\b/` in the `defaultRateLimitPerHour:` initializer (W1-settings); `auth/tokens/budget.ts`: `/\bhourlyDefault\b/` (W2-credentials) |
| `MCP_SEARCH_COST` | 3 | `auth/tokens/budget.ts` (W2-credentials) | — |
| `MCP_PROCESS_PER_MINUTE` | 600 (env `MCP_PROCESS_CEILING_PER_MIN`) | `config/env.ts` (W1-settings) | `mcp/rate-limit.ts`: `/\bprocessCeilingPerMinute\b/` (W3-mcp); `mcp/`: `/\bmcp\.processCeilingPerMinute\b/` (W3-mcp) |
| `BEARER_MAX_BYTES` | 128 | `auth/tokens/verify.ts` (W2-credentials) | — |
| `MCP_AUTH_FAILURES_PER_IP_PER_MINUTE` | 60 | `mcp/rate-limit.ts` (W3-mcp) | — |
| `MCP_REQUEST_DEADLINE_MS` | 30,000 (env `MCP_REQUEST_TIMEOUT_MS`) | `config/env.ts` (W1-settings) | `mcp/plugin.ts`: `/config\.mcp\.requestTimeoutMs/` in the `deadlineMs:` initializer (W3-mcp); `mcp/web-response.ts`: `/\bdeadlineMs\b/` (W3-mcp); `mcp/web-response.ts`: `/\bdeadlineSignal\b/` (W3-mcp); `mcp/tools/register.ts`: `/\bextra\??\.deadline\b/` (W3-mcp); `mcp/resources.ts`: `/\bextra\??\.deadline\b/` (W3-mcp) |
| `MCP_DEADLINE_GRACE_MS` | 2,000 | `mcp/web-response.ts` (W3-mcp) | `mcp/plugin.ts`: `/\bLIMITS\.MCP_DEADLINE_GRACE_MS\b/` (W3-mcp) |
| `MCP_GET_NOTE_MAX_CHARS` | 100,000 | `mcp/` (W3-mcp) | — |
| `MCP_GET_NOTE_HEADING_MAX_CHARS` | 512 | `contracts mcp/` (W0-contracts) | — |
| `MCP_HEADING_LIST_MAX` | 50 | `mcp/errors.ts` (W3-mcp) | — |
| `MCP_HEADING_LIST_ITEM_MAX_CHARS` | 120 | `mcp/errors.ts` (W3-mcp) | — |
| `MCP_MAX_RESOURCE_LINKS` | 50 | `mcp/` (W3-mcp) | — |
| `MCP_LIST_VAULTS_PAGE_MAX` | 100 | `contracts mcp/` (W0-contracts) | — |
| `MCP_LIST_VAULTS_PAGE_DEFAULT` | 50 | `contracts mcp/` (W0-contracts) | — |
| `MCP_LIST_VAULTS_FREE_TEXT_MAX_CHARS` | 12,000 | `mcp/tools/list-vaults.ts` (W3-mcp) | — |
| `MCP_LIST_VAULTS_PAGE_TEXT_MAX_CHARS` | 50,000 | `mcp/tools.unit.spec.ts` (W3-mcp) | — |
| `MCP_VAULT_INDEX_MAX_ENTRIES` | 2,000 | `mcp/` (W3-mcp) | — |
| `MCP_VAULT_INDEX_RECENT_NOTES` | 50 | `mcp/resources.ts` (W3-mcp) | — |
| `MCP_COMPLETION_MAX` | 20 | `mcp/resources.ts` (W3-mcp) | — |
| `MCP_MAX_SUBSCRIPTIONS` | 1,024 | `mcp/plugin.ts` (W3-mcp) | `mcp/plugin.ts`: `/\bLIMITS\.MCP_MAX_SUBSCRIPTIONS\b/` in the `maxSubscriptions:` initializer (W3-mcp) |
| `MCP_KEEPALIVE_MS` | 15,000 | `mcp/plugin.ts` (W3-mcp) | `mcp/plugin.ts`: `/\bLIMITS\.MCP_KEEPALIVE_MS\b/` in the `keepAliveMs:` initializer (W3-mcp) |
| `MCP_INSTRUCTIONS_MAX_BYTES` | 2,048 | `mcp/factory.ts` (W3-mcp) | — |
| `MCP_TOOL_DESCRIPTION_MAX_BYTES` | 2,048 | `mcp/factory.ts` (W3-mcp) | — |
| `PAT_MAX_ALLOWLIST_VAULTS` | 200 | `contracts rest/tokens.ts` (W0-contracts) | `oauth/`: `/\bLIMITS\.PAT_MAX_ALLOWLIST_VAULTS\b/` (W3-oauth) |
| `PAT_MAX_ACTIVE_PER_USER` | 100 | `auth/tokens/` (W2-credentials) | — |
| `TOKEN_LIST_MAX` | 200 | `contracts rest/tokens.ts` (W0-contracts) | — |
| `TOKEN_LIST_DEFAULT` | 50 | `contracts rest/tokens.ts` (W0-contracts) | — |
| `ADMIN_NOTE_MAX_CHARS` | 120 | `contracts rest/tokens.ts` (W0-contracts) | — |
| `PAT_RATE_LIMIT_PER_HOUR_MIN` | 60 | `contracts settings.ts` (W0-contracts) | `config/env.ts`: `/\bSERVER_SETTING_RULES\b/` (W1-settings) |
| `PAT_RATE_LIMIT_PER_HOUR_MAX` | 100,000 | `contracts settings.ts` (W0-contracts) | `config/env.ts`: `/\bSERVER_SETTING_RULES\b/` (W1-settings) |
| `PAT_LIFETIME_DAYS_MAX` | 366 | `contracts settings.ts` (W0-contracts) | `config/env.ts`: `/\bSERVER_SETTING_RULES\b/` (W1-settings) |
| `PAT_ROTATION_OVERLAP_HOURS_MAX` | 24 | `contracts settings.ts` (W0-contracts) | `config/env.ts`: `/\bSERVER_SETTING_RULES\b/` (W1-settings) |
| `OAUTH_ACCESS_TOKEN_TTL_MINUTES_MIN` | 5 | `contracts settings.ts` (W0-contracts) | `config/env.ts`: `/\bSERVER_SETTING_RULES\b/` (W1-settings) |
| `OAUTH_ACCESS_TOKEN_TTL_MINUTES_MAX` | 1,440 | `contracts settings.ts` (W0-contracts) | `config/env.ts`: `/\bSERVER_SETTING_RULES\b/` (W1-settings) |
| `OAUTH_REFRESH_DAYS_MAX` | 366 | `contracts settings.ts` (W0-contracts) | `config/env.ts`: `/\bSERVER_SETTING_RULES\b/` (W1-settings) |
| `ACCESS_LOG_MAX_NOTE_IDS` | 2,000 | `audit/access-log-writer.ts` (W1-observability) | — |
| `ACCESS_LOG_FLUSH_INTERVAL_MS` | 2,000 | `audit/access-log-writer.ts` (W1-observability) | — |
| `ACCESS_LOG_FLUSH_ROWS` | 200 | `audit/access-log-writer.ts` (W1-observability) | — |
| `ACCESS_LOG_QUEUE_MAX_ROWS` | 10,000 | `audit/access-log-writer.ts` (W1-observability) | — |
| `ACCESS_LOG_QUEUE_MAX_BYTES` | 16,777,216 | `audit/access-log-writer.ts` (W1-observability) | — |
| `TOKEN_LAST_USED_FLUSH_INTERVAL_MS` | 600,000 | `auth/tokens/last-used.ts` (W2-credentials) | — |
| `TOKEN_LAST_USED_PENDING_MAX` | 10,000 | `auth/tokens/last-used.ts` (W2-credentials) | — |
| `SHUTDOWN_FLUSH_MARGIN_MS` | 1,000 | `ops/shutdown.ts` (W1-observability) | — |
| `BRIDGE_LIST_REFRESH_MS` | 300,000 | `mcp-bridge src/` (W1-bridge) | — |
| `BRIDGE_UPSTREAM_TIMEOUT_DEFAULT_MS` | 60,000 | `mcp-bridge src/` (W1-bridge) | — |
| `BRIDGE_UPSTREAM_TIMEOUT_MIN_MS` | 5,000 | `mcp-bridge src/` (W1-bridge) | — |
| `OAUTH_CODE_TTL_SECONDS` | 60 | `auth/oauth/codes.ts` (W3-oauth) | — |
| `OAUTH_CONSENT_REQUEST_TTL_SECONDS` | 600 | `oauth/consent-request-store.ts` (W3-oauth) | — |
| `OAUTH_MAX_PENDING_CONSENTS` | 1,000 | `oauth/consent-request-store.ts` (W3-oauth) | — |
| `OAUTH_CIMD_MAX_BYTES` | 32,768 | `oauth/cimd.ts` (W3-oauth) | — |
| `OAUTH_CIMD_TIMEOUT_MS` | 5,000 | `oauth/cimd.ts` (W3-oauth) | — |
| `OAUTH_CIMD_CACHE_SECONDS` | 86,400 | `oauth/cimd.ts` (W3-oauth) | — |
| `OAUTH_CIMD_FETCHES_PER_USER_PER_HOUR` | 20 | `oauth/client-resolution.ts` (W3-oauth) | — |
| `OAUTH_CLIENT_ID_MAX_CHARS` | 512 | `contracts rest/oauth.ts` (W0-contracts) | `oauth/cimd.ts`: `/\bLIMITS\.OAUTH_CLIENT_ID_MAX_CHARS\b/` (W3-oauth) |
| `OAUTH_DCR_PER_IP_PER_HOUR` | 10 | `oauth/` (W3-oauth) | — |
| `OAUTH_MAX_UNUSED_CLIENTS` | 1,000 | `oauth/register.ts` (W3-oauth) | — |
| `OAUTH_UNUSED_CLIENT_TTL_DAYS` | 7 | `auth/oauth/clients.ts` (W3-oauth) | — |
| `OAUTH_MAX_REDIRECT_URIS` | 8 | `auth/oauth/redirect-uri.ts` (W3-oauth) | — |
| `OAUTH_MAX_REDIRECT_URI_CHARS` | 512 | `auth/oauth/redirect-uri.ts` (W3-oauth) | — |
| `OAUTH_CODE_VERIFIER_MIN` | 43 | `oauth/pkce.ts` (W3-oauth) | — |
| `OAUTH_CODE_VERIFIER_MAX` | 128 | `oauth/pkce.ts` (W3-oauth) | — |
| `OAUTH_TOKEN_ENDPOINT_PER_IP_PER_MINUTE` | 60 | `oauth/` (W3-oauth) | — |
| `OAUTH_AUTHORIZE_PER_SESSION_PER_HOUR` | 30 | `oauth/` (W3-oauth) | — |
| `BOUNDED_LIST_MAX` | 1,000 | `contracts rest/` (W0-contracts) | `members/service.ts`: `/\.limit\(\s*LIMITS\.BOUNDED_LIST_MAX\b/` (W1-read-graph); `vaults/read.ts`: `/\.limit\(\s*LIMITS\.BOUNDED_LIST_MAX\b/` (W1-read-graph) |
| `LIST_PAGE_MAX` | 500 | `contracts rest/tree.ts` (W0-contracts) | — |
| `LIST_PAGE_DEFAULT` | 200 | `contracts rest/tree.ts` (W0-contracts) | — |
| `AUDIT_DEDUP_SHORT_WINDOW_MS` | 60,000 | `auth/audit.ts` (W2-credentials) | `collab/audit.ts`: `/\bLIMITS\.AUDIT_DEDUP_SHORT_WINDOW_MS\b/` (W2-credentials) |
| `AUDIT_DEDUP_LONG_WINDOW_MS` | 600,000 | `auth/audit.ts` (W2-credentials) | — |
| `AUDIT_DEDUP_KEYS_MAX` | 10,000 | `auth/audit.ts` (W2-credentials) | — |
| `CURSOR_TTL_SECONDS` | 3,600 | `pagination/cursor.ts` (W1-read-graph) | — |
| `CURSOR_PATH_HEAD_MAX_BYTES` | 1,024 | `pagination/path-keyset.ts` (W1-read-graph) | — |
| `BODY_MAX_BYTES_MCP` | 1,048,576 | `mcp/` (W3-mcp) | — |

`AUDIT_TARGETS_MAX` (1,000) is the one LT-0 member outside this table. `audit/chain.ts` owns it at
`since: 1`, because M1's writer already caps `targets`.

### Shipped caps: the lead's merge steps

A member that names a cap already enforced by shipped code is recorded at the milestone that shipped
it (10's HP-5 paragraph; D06-48): `BOUNDED_LIST_MAX`, `LIST_PAGE_MAX`, `LIST_PAGE_DEFAULT` and the
`AUDIT_DEDUP_*` members at M1, and `CURSOR_TTL_SECONDS` at M2. Until its owner reads the member, an
earlier `since` would fail today, so LT-0 records these rows at `since: 3`. The lead moves each one
at the merge that lands its owner, keeping the owner and wiring unchanged:

- **LT-2**, after W0-contracts replaces the REST page literals in `ListChildrenQuery`,
  `ListNodesQuery`, `ListInboundLinksQuery` and `UnreferencedAttachmentsQuery`: `LIST_PAGE_MAX` and
  `LIST_PAGE_DEFAULT` move to `at(1, …)`.
- **LT-3**, after W0-contracts' `.max(1000)` replacements in contracts `rest/me.ts`, `members.ts`
  and `vaults.ts`, and after W1-read-graph's `members/service.ts`, `vaults/read.ts` and
  `pagination/cursor.ts`: `BOUNDED_LIST_MAX` moves to `at(1, …)` and `CURSOR_TTL_SECONDS` to
  `at(2, …)`.
- **LT-4**, after W2-credentials' `auth/audit.ts` and `collab/audit.ts`:
  `AUDIT_DEDUP_SHORT_WINDOW_MS`, `AUDIT_DEDUP_LONG_WINDOW_MS` and `AUDIT_DEDUP_KEYS_MAX` move to
  `at(1, …)`, and the spec's "Shipped code still enforces these caps" comment is deleted with them.

After each move the lead runs `limits.policy.unit` with `IRIDIUM_TEST_TARGET_MILESTONE=M1` and again
with `M2`. LT-7 then runs it at M3, where every row above ratchets in. It fixes any owner-file
mismatch in the owning code, never in the table.

## LT-0 local evidence

These lanes ran on the LT-0 tree before its commit, on this machine, on 2026-09-25 UTC. None of them
is a remote result.

| Lane | Result |
|---|---|
| `build`, `check-types`, `lint` over `@iridium/contracts` and `@iridium/server` with its dependencies | 23 tasks, all green; lint 0 warnings |
| `unit` + `guard`, target M2 from `CURRENT` | 4,516 passed, 9 skipped, 0 failed, 225 files |
| `limits.policy.unit`, `IRIDIUM_TEST_TARGET_MILESTONE=M1` | 17 passed; at M3 it fails with exactly the gaps the packages close, as intended until LT-7 |
| `pnpm gen --skip-db` | all nine artefacts current, no drift |
| `integration`, `mysql:8.4.11`: `meta.apiversion.integration`, `audit.chain.integration`, `compat.n-minus-1.integration` | 25 passed, 0 failed |
| `oxfmt --check` on the touched files, `check-test-name-references`, `check-env-lists` | all green |
