# Architecture decision records

Every ADR here is seeded verbatim from `docs/plan/13-decision-log.md`, which remains the
authoritative decision log (see that file's "How to read this log" section for the field
definitions and the supersession convention). Each file below carries its decision's Status,
Context, Decision, Alternatives Considered, Consequences, Verification and References fields
copied from the log; the Decision text is never edited, only superseded and annotated, exactly
as the log itself does. A recorded test-name or CI-gate spelling is a citation, corrected to its
canonical without a supersession marker wherever it appears (D13-16).

An ADR whose Status reads "Superseded by …" or "Superseded in part by …" is kept in full —
the superseding decision is a separate ADR of its own, cross-referenced from the Status line of
both.

## Area 1 — Repository, toolchain, and delivery

| ADR | Title | Status |
|---|---|---|
| [A1](./0001-monorepo-toolchain.md) | Monorepo toolchain: pnpm workspaces + Turborepo, TypeScript 7 native, oxlint/oxfmt, tsdown, Vite 8 | Accepted |
| [A2](./0002-mutation-lane.md) | Mutation-testing lane isolated with its own TypeScript 6 alias | Accepted |
| [A3](./0003-contracts-first-codegen.md) | Contracts-first code generation with CI drift checks | Accepted |
| [A4](./0004-node-24.md) | Node.js 24 LTS as the single runtime | Accepted |
| [A51](./0051-testing-harnesses.md) | Testing harnesses: one runner per layer, real infrastructure, one boot path, `@iridium/testkit` | Accepted; superseded in part by A59; amended 2026-09-25 (the `mcp` conformance baseline, AG11) |
| [A52](./0052-ci-pipelines.md) | CI: `ci.yml` / `nightly.yml` / `release.yml` with digest-pinned actions and license compliance | Accepted; superseded in part by AG6, A59, G8 and AG10 |
| [A54](./0054-client-server-compatibility.md) | Client/server compatibility: integer `apiVersion`, `minClientVersion`, additive-only rule, N-1 window | Accepted; amended 2026-09-18; amended 2026-09-25 (gate scope and release floor) |
| [A56](./0056-milestone-ordering.md) | Milestone ordering: risk-first order with enterprise foundations folded into M0/M1 | Accepted |

## Area 2 — HTTP server, validation, and data layer

| ADR | Title | Status |
|---|---|---|
| [A5](./0005-fastify.md) | Fastify 5 as the single HTTP host for REST, `/collab`, and `/mcp` | Accepted; superseded in part by AG1 |
| [A6](./0006-zod-and-openapi.md) | zod 4 everywhere; OpenAPI 3.1 generated, committed, linted, and fuzzed | Accepted; amended 2026-09-25 |
| [A7](./0007-kysely-migrations.md) | Kysely + kysely-ctl + kysely-codegen; forward-only migrations in production; fail-closed readiness | Accepted; superseded in part by D03-29 |
| [A8](./0008-db-roles.md) | Least-privilege MySQL roles: `iridium_app`, `iridium_migrator`, `iridium_backup` | Accepted |
| [A9](./0009-mysql-version.md) | MySQL 9.7 LTS primary, 8.4 LTS certified; baked `my.cnf` | Superseded by A59 |
| [A10](./0010-two-pools.md) | mysql2 with two Kysely instances: `dbApp` and `dbPersist` | Accepted |
| [A11](./0011-uuidv7-ids.md) | Entity IDs: UUIDv7 in `BINARY(16)`, canonical strings on every wire | Accepted |
| [A12](./0012-tree-model.md) | Tree model: adjacency list with a real root row, derived paths, per-vault mutex | Accepted |
| [A13](./0013-version-cas-if-match.md) | Optimistic concurrency: `version` CAS and `If-Match` on REST | Accepted; amended 2026-09-25 (`server_settings` serialised by the document validator) |

## Area 3 — Collaboration engine and durability

| ADR | Title | Status |
|---|---|---|
| [A14](./0014-yjs-v13-single-instance.md) | Yjs v13 stable set, one module instance, one first-party import point | Accepted |
| [A15](./0015-yjs-state-encoding.md) | Yjs state storage: V2 compacted snapshot plus V1 append log, applied manually | Accepted |
| [A16](./0016-update-log-compaction-checkpoints.md) | Per-update append log, compaction in the same per-note FIFO, Markdown checkpoints separate from sync state | Accepted |
| [A17](./0017-hocuspocus-embedded.md) | Hocuspocus 4.7.0 embedded as the `Hocuspocus` class inside Fastify with Iridium's own extensions | Accepted |
| [A18](./0018-vault-channel.md) | Vault realtime channel: `vault:<vaultId>` as an empty, never-persisted Hocuspocus document | Accepted |
| [A19](./0019-saved-ack-protocol.md) | The "Saved" acknowledgement protocol | Accepted |
| [A20](./0020-live-role-change.md) | Role change on a live connection: server flips `readOnly`, client re-attaches on upgrade | Accepted |
| [A21](./0021-note-writer-backpressure.md) | Per-document persistence serialisation and backpressure: `NoteWriter` | Accepted |
| [A22](./0022-hostile-crdt-content.md) | Hostile CRDT content detection at compaction, flag, and repair CLI | Accepted |
| [A50](./0050-admission-control.md) | Loaded-document admission control: explicit budget with refusal, no eviction | Accepted |
| [A.1](./0058-limits-policy.md) | Single limits policy | Accepted; amended 2026-09-25 (every M3 number named once) |

## Area 4 — Identity, sessions, and authorization

| ADR | Title | Status |
|---|---|---|
| [A23](./0023-live-revocation.md) | Live revocation: version columns, an in-process bus, a collaboration gateway, epoch checks, no caches | Accepted |
| [A24](./0024-collab-tickets.md) | Collaboration tickets: single-use 60 s tickets, batch issuance, limits sized to the connection caps | Accepted |
| [A25](./0025-awareness-presence.md) | Awareness and presence: validate identity on every message, server-authoritative participants | Accepted |
| [A26](./0026-session-model.md) | Session model: one `sessions` table, two delivery channels, no reusable credential in the renderer | Accepted |
| [A27](./0027-csrf.md) | CSRF for cookie sessions: custom header plus Fetch Metadata plus `SameSite=Lax` | Accepted |
| [A28](./0028-credential-delivery.md) | Initial credential delivery and password reset: one-time set-password links | Accepted |
| [A29](./0029-password-hashing.md) | Password hashing and login hardening: argon2id via prebuilt napi, versioned pepper, NIST policy, DB-backed throttling | Accepted |
| [A30](./0030-permission-matrix.md) | Permission matrix and `authorize()`: one static matrix, one function, 404 for non-members | Accepted |
| [A31](./0031-integration-tokens.md) | PAT / integration token model: id-embedded format, SHA-256 at rest, permission-string scopes, mandatory expiry, rotation, per-call access log | Accepted; amended 2026-09-25 (verifier mount, `ocs`, camelCase audit metadata, per-kind policy, per-grant budget) |

## Area 5 — MCP and agent access

| ADR | Title | Status |
|---|---|---|
| [A32](./0032-mcp-transport.md) | MCP transport and session mode: SDK v2, per-request factory, stateless dual-era, JSON response mode, `reply.hijack()` | Accepted; amended 2026-09-13 (S14) and 2026-09-25 (mount wiring, deadline, drain, header profile, host and methods clauses); superseded in part by AG10 and AG11 |
| [A33](./0033-mcp-auth.md) | MCP authentication: PAT bearer only, no Protected Resource Metadata in the MVP | Superseded by AG1 |
| [A34](./0034-mcp-tools-resources.md) | MCP tools and resources: six read-only tools over `ContentReadCore`, a note template, and a per-vault index resource | Accepted; amended 2026-09-25 (D06-38) |
| [A35](./0035-mcp-cursors.md) | MCP pagination cursors: opaque HMAC-signed cursors bound to token and filter hash | Accepted; amended 2026-09-25 |
| [A36](./0036-stdio-bridge.md) | stdio bridge: a first-party transparent proxy, `iridium-mcp` | Accepted; amended 2026-09-25 (D06-13) |
| [A37](./0037-content-read-core.md) | One read model for humans and agents: `ContentReadCore` over committed projections | Accepted; amended 2026-09-25 |
| [A38](./0038-projection-freshness.md) | Projection freshness and the search contract: bounded lag, human `flush`, rate-limited `?fresh=true`, explicit staleness | Accepted |

## Area 6 — Content pipeline, search, attachments, and portability

| ADR | Title | Status |
|---|---|---|
| [A39](./0039-search.md) | Search: InnoDB FULLTEXT over a narrow projection, behind a `SearchIndex` interface | Accepted |
| [A42](./0042-markdown-pipeline.md) | Markdown preview and sanitisation pipeline: shared token-to-mdast parser, sanitize-last hast, workers | Accepted; amended after S11 |
| [A43](./0043-obsidian-syntax.md) | Obsidian syntax in the MVP: detect, report, and index; render as literal text; keep the seam ready | Accepted |
| [A44](./0044-attachments.md) | Attachments: content-addressed storage behind a driver interface, served by id, explicit deletion only | Accepted |
| [A45](./0045-import-export.md) | Import and export: a two-phase import job, a streaming export job with a manifest and EOL/BOM restoration | Accepted |

## Area 7 — Client applications

| ADR | Title | Status |
|---|---|---|
| [A40](./0040-ui-framework.md) | UI framework and state: React 19.3 + TanStack Router/Query + Zustand + Base UI/shadcn v4 + Tailwind 4 | Accepted |
| [A41](./0041-editor-stack.md) | Editor stack: CodeMirror 6 with y-codemirror.next and disposable views | Accepted |
| [A53](./0053-electron-shell.md) | Electron shell: Electron 44.3.0, three plain build configs, electron-builder 26, generic updater on the server, full hardening, main-only credential custody | Accepted; superseded in part by the owner's answer to G8 (packaging, signing and in-application updates); amended 2026-09-13 (TLS posture, spike S7) |
| [A55](./0055-a11y-i18n-browsers.md) | Accessibility, internationalisation, and browser support | Accepted; superseded in part by AG6 |

## Area 8 — Audit, backup, operations, and threat model

| ADR | Title | Status |
|---|---|---|
| [A46](./0046-audit-log.md) | Audit log: same-transaction HMAC chain per `chain_id` with locked chain heads, triggers, a closed vocabulary, and CLI verify/export/archive | Accepted; amended 2026-09-20; amended 2026-09-25 (credential and settings lock orders) |
| [A47](./0047-backup-restore.md) | Backup and restore: dump plus attachments plus an encrypted secrets bundle plus a manifest, with binlog PITR and a blocking `restore --verify` | Accepted |
| [A48](./0048-deployment-topology.md) | Deployment topology: one server container, MySQL, an attachment volume, behind Caddy; hardened production compose; an air-gapped in-process TLS profile | Accepted |
| [A49](./0049-observability.md) | Logging, metrics, and health: pino JSON with redaction, prom-client, liveness plus fail-closed readiness, alert rules | Accepted; amended 2026-09-25 (request ids; MCP and OAuth metric labels) |
| [A57](./0057-threat-model.md) | Threat model and compliance evidence: T1–T20 with a control → implementation → evidence map, and the operator CLI surface | Accepted; superseded in part by AG1 |

## Area 9 — Owner answers to the open questions (2026-09-12, 2026-09-24)

| ADR | Title | Status |
|---|---|---|
| [AG1](./0060-oauth-authorization-server.md) | Iridium ships its own OAuth 2.1 authorization server, on a second MCP mount | Accepted (2026-09-12); superseded in part by AG9 and AG10 (2026-09-24) and by the D06-31 and D04-16 amendments and by D06-41 and D06-44 (2026-09-25); amended 2026-09-25 (the `ocs` client secret, manual clients, permission labels, the consent CSP, metadata strictness, and the registration and redirect rules) |
| [A59](./0059-mysql-dual-lts.md) | MySQL 8.4 LTS and 9.7 LTS as equal required targets | Accepted |
| [AG6](./0061-supported-clients.md) | Supported clients at 1.0: the desktop application; the web host is a development and internal surface | Accepted |
| [AG9](./0062-connector-proof-at-m4-exit.md) | The real-connector proof moves to M4 exit; M3 exits on the scripted OAuth client | Accepted (2026-09-24) |
| [AG10](./0063-headless-client-matrix.md) | Real-client observation at M3 is headless: the nightly matrix drives headless clients over real TLS and is advisory until M8; GUI clients are observed by hand | Accepted (2026-09-24) |
| [AG11](./0064-mcp-conformance-leaf.md) | MCP conformance tooling in a dev-only harness leaf; SDK v1 confined to it; third-party clients outside the workspace | Accepted (2026-09-24) |
| [AG12](./0065-m3-settings-groups.md) | The M3 settings store and `/admin/settings` carry only `mcpEnabled`, `patPolicy` and `oauthPolicy` | Accepted (2026-09-24) |

## Numbering

File numbers are assigned by the decision log, not by area order: `0001`–`0057` follow the
skeleton ids `A1`–`A57` in the order the log accepted them (grouped by area within this index,
but not sequential by file number within an area — see each area's table above), `0058` is the
single limits policy (`A.1`), `0059`–`0061` are the three ADRs the project owner's answers of
2026-09-12 to `docs/plan/14-risks-and-open-questions.md` §G produced (`A59`, `AG1`, `AG6`), and
`0062`–`0065` are the four ADRs the answers of 2026-09-24 produced (`AG9`–`AG12`), numbered in the
order the answers were recorded (D13-13). The open question G13 has no ADR until it is answered.

## Section decision amendments

- [ARCH-02: readiness probe lifecycle](./arch-02-readiness-probe-lifecycle.md), amended 2026-09-20 after remote latency and blackhole probes.

- [D10-25: nightly chaos runner budget](./d10-25-nightly-chaos-budget.md), amended 2026-09-20 after the first remote four-hour timeout.

- [D10-6: targeted acknowledgement wire faults](./d10-6-targeted-ack-faults.md), amended 2026-09-20 after the nightly baseline race.

- [OPS-04: MySQL client packaging](./ops-04-mysql-client-packaging.md), amended 2026-09-20 for both release architectures.

- [D01-15: Elastic License 2.0](./d01-15-elastic-license.md), accepted 2026-09-19; settles the licence the M0 exit record left open.

- [D10-33: collaboration owner lease scope](./d10-33-collaboration-owner-lease.md), amended 2026-09-20 for ownership-loss recovery observation. Section decision IDs keep their original names rather than consuming an A-series number.

- [OPS-12: serving SQL deadlines](./ops-12-serving-sql-deadlines.md), amended 2026-09-17.

- [D04-14: owner-executed session revocation](./d04-14-owner-executed-session-revocation.md), amended 2026-09-17.

- [D05-06: transient collaboration dependency failures](./d05-06-transient-collaboration-failures.md), amended 2026-09-17.

- [D12-20: Schemathesis milestone scope](./d12-20-schemathesis-milestone-scope.md), accepted 2026-09-17; amended 2026-09-25 (M3 scope): the `/api/v1` operations only, the MCP, OAuth and well-known surfaces excluded by path, cursor admission derived from the schema.

- [A54: live client compatibility](./0054-client-server-compatibility.md), [A51: test resources and milestone selection](./0051-testing-harnesses.md), and [A2: mutation report isolation](./0002-mutation-lane.md), amended 2026-09-18 after the independent M1 review.

- [AG9](./0062-connector-proof-at-m4-exit.md), [AG10](./0063-headless-client-matrix.md) and [AG11](./0064-mcp-conformance-leaf.md), accepted 2026-09-24 from the owner's answers to G9–G11, supersede in part [AG1](./0060-oauth-authorization-server.md) (its S15 and Standing Verification clauses), [A32](./0032-mcp-transport.md) (its nightly matrix and the place its development pins are declared) and [A52](./0052-ci-pipelines.md) (its nightly real MCP client matrix), each marked inline; [A48](./0048-deployment-topology.md)'s Verification gains `ops.tls-profile.integration` as the in-process TLS profile's M3 evidence (AG10); [A51](./0051-testing-harnesses.md) is amended 2026-09-25 for AG11: the `mcp` project's conformance baseline is a committed, typed, cause-checked file, and the tool runs from the AG11 leaf through an in-test credential proxy, marked inline.

- [D06-31 and D07-47: the server-rendered consent page](./d06-31-consent-page.md), amended 2026-09-25: a consent CSP defined once whose `form-action` names the validated redirect origin, a loopback warning line, an inlined, nonce'd stylesheet with no `/app/` reference, `READ_PERMISSION_LABELS` for the permission lines, no `service_documentation` clause, and the closing M3 clause superseded by AG9; AG1's matching Decision clauses are marked inline.

- [D14-04: question encoding and the one question record](./d14-04-question-record.md), amended 2026-09-25: 14 §G's answered and open tables are the only question record, and a commit encodes an answer.

- [D14-03: the milestone risk gate lives in the exit record](./d14-03-milestone-risk-gate.md), amended 2026-09-25.

- [D12-11: acceptance records for manual proofs](./d12-11-manual-proof-records.md), amended 2026-09-25: five records, the fifth `docs/acceptance/mcp-gui-clients.md`.

- [D12-15: one spike register](./d12-15-spike-register.md) and [D14-11: spike notes](./d14-11-spike-notes.md), amended 2026-09-25: spike timing (S9 at M3, S15 at M4, before exit) and fallback references by commit.

- [D12-21: the advisory nightly jobs](./d12-21-advisory-nightly-jobs.md), accepted 2026-09-25.

- [D10-43: the real-client matrix lane](./d10-43-client-matrix-lane.md), accepted 2026-09-25.

- [D06-37: snippet entry names and placeholders](./d06-37-snippet-entry-names.md), accepted 2026-09-25.

- [D06-16: the M3 agent and operator documentation set](./d06-16-agent-documentation-set.md), amended 2026-09-25: the union set, one generation step with placeholder rendering and status-before-snippet, and no documentation URL in the metadata documents.

- [ARCH-30: the MCP module exposes only its snippet renderer](./arch-30-mcp-exposed-modules.md), accepted 2026-09-25.

- [OPS-65: the bridge download is built into the server image and served from M3](./ops-65-bridge-download.md), accepted 2026-09-25, with [D06-14: bridge distribution](./d06-14-bridge-distribution.md), amended the same day.

- [D06-13: the `iridium-mcp` CLI contract](./d06-13-bridge-cli-contract.md), amended 2026-09-25, which supersedes [A36](./0036-stdio-bridge.md) in part; [A54: the minClientVersion gate's scope and the release floor](./0054-client-server-compatibility.md), amended 2026-09-25.

- [A35: pagination cursors](./0035-mcp-cursors.md), amended 2026-09-25: codec home, canonical encoding, path anchors, keyring verification with a per-listing signing version, 503 on key misconfiguration, one refusal sentence with the schema-length carve-out.

- [D06-09: the MCP error catalogue](./d06-09-mcp-error-catalogue.md), amended 2026-09-25.

- [D06-38: MCP tool-call errors and tool field presentation](./d06-38-mcp-tool-call-errors.md), accepted 2026-09-25 and recorded in [A34](./0034-mcp-tools-resources.md)'s Status.

- [D06-39: note reference resolution and slicing](./d06-39-note-resolution-and-slicing.md), accepted 2026-09-25.

- [A6: one zod entry point and composed import restrictions](./0006-zod-and-openapi.md), amended 2026-09-25.

- [A31: the token model](./0031-integration-tokens.md), amended 2026-09-25 in one Status line: the `AuthInfo.extra` spelling and the mount-only verifier (D06-18, D04-26), the `ocs` kind (D04-36), camelCase audit metadata (D04-35), the rotation-overlap and per-kind hourly defaults (D03-28) and the per-grant budget (D04-37), each marked inline.

- [A37: option permissions in `ContentReadCore`](./0037-content-read-core.md), amended 2026-09-25.

- [D06-15: the write-free MCP read graph](./d06-15-write-free-mcp-read-graph.md), amended 2026-09-25, with its verifier clause (the two verifier instances differ only in the mount).

- [D06-18: `AuthInfo.extra`](./d06-18-authinfo-extra.md), amended 2026-09-25 with D04-26: the SDK 2.0.0 field carrying `{principal, call, rateLimited?, serverDisabled?, deadline, requestId}`, and a verifier that takes only the mount and derives the resource; and [D04-30: the MCP-mount arm of `config.auth`](./d04-30-mcp-mount-route-arm.md), amended the same day.

- [D03-26: OAuth code-replay provenance and first-detection stamps](./d03-26-oauth-code-provenance.md), accepted 2026-09-25, with [D06-29: the refresh reuse trigger](./d06-29-refresh-reuse-trigger.md), amended the same day: reuse is a rotated row or a row of a family revoked as a theft response, chained once per presented row.

- [D04-16: bounded failure auditing](./d04-16-bounded-failure-auditing.md), amended 2026-09-25: named windows and a bounded gate, `oauth.authorize.denied` chained only for a signed-in request whose client resolved, replay and reuse bounded by first detection, and `user.login.failed` corrected to one unforced row per key and window plus one forced row per applied block.

- [D04-19: revoke-all](./d04-19-revoke-all.md), amended 2026-09-25: one chained row per bulk revocation, with capped `targets`; live credentials only, grants revoked whole, and verification split by surface.

- [D04-35: OAuth and token audit row shapes](./d04-35-oauth-audit-row-shapes.md), accepted 2026-09-25, with [D06-03: `mcp.access.denied` on the resolved vault's chain](./d06-03-mcp-access-denied-chain.md), amended the same day.

- [D06-40: the read-permission labels](./d06-40-permission-labels.md), accepted 2026-09-25.

- [D06-41: CIMD fetch rules](./d06-41-cimd-fetch.md), [D06-42: served metadata strictness](./d06-42-oauth-metadata-strictness.md) and [D06-44: the CIMD network edge](./d06-44-cimd-network-edge.md), accepted 2026-09-25, with [D06-33: dynamic client registration](./d06-33-registration.md) and [D06-35: loopback redirect URIs](./d06-35-loopback-redirects.md), amended the same day.

- [D06-43 and D03-27: OAuth client retirement and the client columns](./d06-43-oauth-client-retirement.md), accepted 2026-09-25.

- [D06-45: manual OAuth clients at M3](./d06-45-manual-oauth-clients-at-m3.md) and [D04-36: the OAuth client secret kind](./d04-36-client-secret-kind.md), accepted 2026-09-25; [AG1](./0060-oauth-authorization-server.md)'s Status and the matching Decision, threat and verification clauses are marked inline for these and the other OAuth amendments of the same day.

- [AG12: the M3 settings groups](./0065-m3-settings-groups.md), accepted 2026-09-24 from the owner's answer to G12; with it [D09-10: the server-settings document](./d09-10-server-settings-document.md), [ARCH-10: environment floors and the settings store's lifecycle](./arch-10-settings-floors.md), [D09-11: the `/readyz` check names](./d09-11-readyz-check-names.md) and [OPS-24: the server-settings readiness check](./ops-24-server-settings-readiness.md), amended 2026-09-25; [ARCH-02](./arch-02-readiness-probe-lifecycle.md) carries a dated note for the seventeenth check, and [A13](./0013-version-cas-if-match.md) and [A46](./0046-audit-log.md) are amended the same day (the settings validator; the credential and settings lock orders).

- [D03-28: one declaration per server-settings member](./d03-28-server-settings-vocabulary.md), accepted 2026-09-25.

- [D04-37: one budget per credential grant](./d04-37-per-credential-budget.md), accepted 2026-09-25.

- [D06-47: the authorization server's endpoint limits](./d06-47-oauth-endpoint-limits.md), accepted 2026-09-25.

- [D06-48: every M3 number named once](./d06-48-m3-numbers-named.md), accepted 2026-09-25 and recorded in [A.1](./0058-limits-policy.md)'s Status.

- [D06-11: the access-log writer](./d06-11-access-log-writer.md), with the D03-25 amendment (the append barrier, `streamsClosed()` and the flushing test reader), and [D06-23: client identity on recorded rows](./d06-23-client-identity.md), amended 2026-09-25.

- [D06-12: the MCP and OAuth metrics](./d06-12-mcp-oauth-metrics.md) and [ARCH-14: request ids](./arch-14-request-ids.md), amended 2026-09-25 and recorded in [A49](./0049-observability.md)'s Status.

- [D06-49: the last-used tracker](./d06-49-last-used-tracker.md), accepted 2026-09-25.

- [D06-02: token and agent-activity routes](./d06-02-token-activity-routes.md), amended 2026-09-25 for the M3/M7 route split.

- [ARCH-12: error codes and the normative envelope](./arch-12-error-code-status.md), [D06-22: the token REST DTOs](./d06-22-token-dtos.md) and [D09-30: error envelopes](./d09-30-error-envelopes.md), amended 2026-09-25.

- [D12-22: integration suites scheduled with their routes](./d12-22-suites-scheduled-with-routes.md), accepted 2026-09-25.

- [D04-31: `authorize()` unchanged by the authorization server](./d04-31-authorize-unchanged-by-oauth.md) and [D10-5: the standard harness knobs](./d10-5-harness-knobs.md), amended 2026-09-25.

- [D06-50: token lifecycle rules](./d06-50-token-lifecycle-rules.md), accepted 2026-09-25, with [D06-01: `token_not_rotatable`](./d06-01-token-not-rotatable.md) and [D10-33: credential revocation takes no owner lease](./d10-33-collaboration-owner-lease.md), amended the same day; [A46](./0046-audit-log.md)'s credential lock order and `lock-order.integration` races are amended with it.

- [D06-51: the all-vaults policy](./d06-51-all-vaults-policy.md), accepted 2026-09-25, with D09-19 and D07-31 amended the same day (`/meta.policies.patAllowAllVaultsForNonAdmins`).

- [D10-10: OpenAPI response coverage](./d10-10-openapi-coverage.md), amended 2026-09-25, with [A32](./0032-mcp-transport.md)'s amendment of the same day (mount wiring, deadline, drain, host and methods clauses, and the product header profile on every MCP response).

- [D10-11: wire baselines per release](./d10-11-wire-baselines.md), amended 2026-09-25, with [A54](./0054-client-server-compatibility.md)'s release floor.

- [D04-12: archived-vault administrative reads](./d04-12-allow-archived-routes.md), amended 2026-09-25.

- [ARCH-27: the OpenAPI collector](./arch-27-openapi-collector.md), amended 2026-09-25, and [D12-23: extended exit rows](./d12-23-extended-exit-rows.md), accepted 2026-09-25; [A5](./0005-fastify.md)'s plugin order is marked superseded in part by AG1.

- [ARCH-19: singleton contract suites](./arch-19-singleton-contract-suites.md), amended 2026-09-25.

- [D13-16: test-name citations](./d13-16-test-name-citations.md), which supersedes D13-2 in part, and [D03-29: the one-DDL exceptions](./d03-29-one-ddl-exceptions.md), which supersedes [A7](./0007-kysely-migrations.md) in part, accepted 2026-09-25; [A57](./0057-threat-model.md)'s threat table is marked superseded in part by AG1 (T1–T20).

- [ARCH-06: the shutdown drain](./arch-06-shutdown-drain.md), amended 2026-09-25: `503 not_ready` once the drain begins, the `mcp` drain phase, and the bounded write-behind flushes in `onClose`.

- [ARCH-31: the settings module](./arch-31-settings-module.md), accepted 2026-09-25.

- [D12-24: the plan-silent M3 schedules](./d12-24-plan-silent-m3-schedules.md), accepted 2026-09-25: the CLI schedules and the invariant-register rule.

- [ARCH-11: request context and MCP SDK error attribution](./arch-11-mcp-sdk-error-attribution.md), amended 2026-09-25: one scoped `AsyncLocalStorage`, in `mcp/plugin.ts`, read only by `recordSdkError`.

- [D04-10: token principals on step-up routes](./d04-10-step-up-token-refusal.md), [D04-28: MCP credentials are verified after `mcpIpGate`](./d04-28-mcp-credential-verification.md) and [D04-32: the CSRF exemption set](./d04-32-csrf-exemption-set.md), amended 2026-09-25.

- [D04-33: OAuth route surfaces](./d04-33-oauth-route-surfaces.md) and [D04-34: the public-route token boundary](./d04-34-public-route-token-boundary.md), accepted 2026-09-25.

- [D06-27: the four deliberate discovery `404`s](./d06-27-absent-discovery-routes.md), amended 2026-09-25: `OAUTH_ABSENT_ROUTES`, registered and indexed, never documented.

- [D06-46: the OAuth module layout](./d06-46-oauth-module-layout.md), accepted 2026-09-25: the protocol half `oauth/` and the credential half `auth/oauth/`.
