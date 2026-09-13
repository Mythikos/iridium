# AG6 — Supported clients at 1.0: the desktop application; the web host is a development and internal surface

**Status:** Accepted (2026-09-12). Supersedes the supported-browsers clause of A55 and the cross-browser smoke lane of A52.

## Context

A55 committed to "current Chrome and Edge (Chromium-class); Firefox and WebKit get nightly smoke tests only and are best-effort", with open question G6 as the lever to upgrade that. On 2026-09-12 the project owner answered G6 with "We can ignore browser for now — the primary MVP is desktop." That answer is broader than the question: it does not choose browsers, it re-prioritises the product. The brief's item 2 still requires both a web UI and an Electron desktop app from **one** shared UI codebase, and the browser host is how that codebase is developed and how the component and web end-to-end suites run, so the answer cannot be implemented by deleting `apps/web`.

## Decision

The desktop application is Iridium's supported client at 1.0. The web host remains — built, served at `/app/*`, hardened under the nonce CSP, and covered by a merge-blocking `chromium` end-to-end lane and the Vitest Browser Mode component project — as a development and internal surface with no support commitment at 1.0; it runs in current Chrome and Edge. Firefox and WebKit are out of scope entirely: the `firefox-smoke` and `webkit-smoke` Playwright projects and the `nightly.yml › browser-smoke` job are removed, and their absence is asserted by `guards.non-goals.guard` (case *Cross-browser support*, non-goal id `cross-browser-support`). Where a spec §9 acceptance row is proven in both hosts, the Electron proof gates 1.0 and the browser proof is a development signal: `docs/acceptance-map.json` carries `gating: true` on that layer, rule 7 of `guards.acceptance-map.guard` requires the gating test to be selected by a merge-blocking lane, the Electron specs that discharge a row carry `@smoke`, and Concurrent editing, Viewer enforcement and Live revocation retire at M5 rather than M4. The single UI codebase, the `IridiumHost` seam, the three host implementations, `apps/web`'s place in the server image, every web-specific security control and the milestone order (M4 before M5) are unchanged.

**Assumption recorded with the decision.** The owner's answer named a priority, not a matrix. The plan reads it as a change of commitment rather than a deletion, for the two reasons above. If the owner meant that `apps/web` should not ship at all, that is a larger change and returns as a question.

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| Delete `apps/web` and the browser host | Contradicts brief item 2, removes the surface the component and web E2E suites run on, and would require re-building a browser host to develop the UI at all. It would also make the `IridiumHost` seam untestable against two real implementations, which is the mechanism that keeps one codebase honest. |
| Keep the Firefox and WebKit nightly smoke lanes as "free information" | A nightly lane nobody is accountable for is an implicit support claim and a source of failures that are triaged into silence. Out of scope means no lane, and the non-goal guard makes that checkable. |
| Keep retiring rows on the M4 browser proof and treat the desktop specs as renditions | Would let 1.0 be declared on evidence from a host the project does not support. The desktop host is also the one holding the session credential, so viewer enforcement, revocation and durability are exactly what has to be proven there. |
| Reorder the milestones so the desktop shell comes first | The shell mounts the shared UI bundle; there is nothing to wrap before M4 exists. Priority is not build order. |
| Demote the web `chromium` lane to nightly since the host is unsupported | It is how the shared UI is tested; demoting it would slow every UI regression's discovery to a day and would rot the very codebase the desktop client ships. |

## Consequences

Positive: the project's support claim is now true and testable; the acceptance rows are gated on the client people actually run; two CI lanes and a tag's second meaning disappear; the deployment documentation can answer "what do I install?" in one sentence. Negative: the merge-blocking `e2e-electron` job grows, because acceptance specs that used to be nightly now run on three operating systems per pull request — the answer to a critical-path problem is sharding the `electron` project, never demoting a gating proof; three spec §9 rows now retire one milestone later, which makes M4's exit record shorter and M5's longer; and the web host now ships with no support commitment, which must be stated plainly to operators rather than left to inference (`11-operations-and-deployment.md`, "Supported clients").

## Verification

`guards.non-goals.guard` (case *Cross-browser support*: exactly three Playwright projects, no Firefox/WebKit selector anywhere, no `browser-smoke` job, no `@smoke` tag under `apps/e2e/web/`); `guards.acceptance-map.guard` rule 7 (every gating proof selected by a merge-blocking lane); `desktop.three-instances.e2e`, `desktop.viewer-readonly.e2e`, `desktop.revocation-while-open.e2e`, `desktop.durable-save.e2e`, `desktop.hostile-markdown.e2e`, `desktop.open-note.e2e` (the gating proofs); `desktop.a11y-keyboard-only.e2e` (the accessibility commitment in the supported client); `ui.unsupported-browser.component` (the feature-floor page's copy); `host.contract.component`, `host.contract.e2e` and `desktop.host-contract.e2e` (unchanged — the one-codebase requirement is still proven in both hosts).

## References

Owner answer to open question G6, 2026-09-12; brief item 2; A55, A52, A53, A40; spec §10 (mobile clients). Implemented in `01-vision-scope-and-principles.md` §4.6, `07-client-applications.md` §9.3, `10-testing-and-quality.md`, `11-operations-and-deployment.md`, `12-milestones.md`.

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
| A42 | Markdown pipeline: unified/remark, custom GFM wiring, `rehype-sanitize` last, workers | 6 | `08-markdown-pipeline-import-export.md`, `07-client-applications.md` |
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

---

Source: docs/plan/13-decision-log.md, decision AG6. This file is a faithful copy of that entry's Status, Context, Decision, Alternatives considered, Consequences, Verification and References fields; the decision log remains the authoritative, continuously-maintained record (status supersessions are recorded there first).
