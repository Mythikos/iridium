# Architecture decision records

Every ADR here is seeded verbatim from `docs/plan/13-decision-log.md`, which remains the
authoritative decision log (see that file's "How to read this log" section for the field
definitions and the supersession convention). Each file below carries its decision's Status,
Context, Decision, Alternatives Considered, Consequences, Verification and References fields
copied from the log; the Decision text is never edited, only superseded and annotated, exactly
as the log itself does.

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
| [A51](./0051-testing-harnesses.md) | Testing harnesses: one runner per layer, real infrastructure, one boot path, `@iridium/testkit` | Accepted; superseded in part by A59 |
| [A52](./0052-ci-pipelines.md) | CI: `ci.yml` / `nightly.yml` / `release.yml` with digest-pinned actions and license compliance | Accepted; superseded in part by AG6 |
| [A54](./0054-client-server-compatibility.md) | Client/server compatibility: integer `apiVersion`, `minClientVersion`, additive-only rule, N-1 window | Accepted |
| [A56](./0056-milestone-ordering.md) | Milestone ordering: risk-first order with enterprise foundations folded into M0/M1 | Accepted |

## Area 2 — HTTP server, validation, and data layer

| ADR | Title | Status |
|---|---|---|
| [A5](./0005-fastify.md) | Fastify 5 as the single HTTP host for REST, `/collab`, and `/mcp` | Accepted |
| [A6](./0006-zod-and-openapi.md) | zod 4 everywhere; OpenAPI 3.1 generated, committed, linted, and fuzzed | Accepted |
| [A7](./0007-kysely-migrations.md) | Kysely + kysely-ctl + kysely-codegen; forward-only migrations in production; fail-closed readiness | Accepted |
| [A8](./0008-db-roles.md) | Least-privilege MySQL roles: `iridium_app`, `iridium_migrator`, `iridium_backup` | Accepted |
| [A9](./0009-mysql-version.md) | MySQL 9.7 LTS primary, 8.4 LTS certified; baked `my.cnf` | Superseded by A59 |
| [A10](./0010-two-pools.md) | mysql2 with two Kysely instances: `dbApp` and `dbPersist` | Accepted |
| [A11](./0011-uuidv7-ids.md) | Entity IDs: UUIDv7 in `BINARY(16)`, canonical strings on every wire | Accepted |
| [A12](./0012-tree-model.md) | Tree model: adjacency list with a real root row, derived paths, per-vault mutex | Accepted |
| [A13](./0013-version-cas-if-match.md) | Optimistic concurrency: `version` CAS and `If-Match` on REST | Accepted |

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
| [A.1](./0058-limits-policy.md) | Single limits policy | Accepted |

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
| [A31](./0031-integration-tokens.md) | PAT / integration token model: id-embedded format, SHA-256 at rest, permission-string scopes, mandatory expiry, rotation, per-call access log | Accepted |

## Area 5 — MCP and agent access

| ADR | Title | Status |
|---|---|---|
| [A32](./0032-mcp-transport.md) | MCP transport and session mode: SDK v2, per-request factory, stateless dual-era, JSON response mode, `reply.hijack()` | Accepted |
| [A33](./0033-mcp-auth.md) | MCP authentication: PAT bearer only, no Protected Resource Metadata in the MVP | Superseded by AG1 |
| [A34](./0034-mcp-tools-resources.md) | MCP tools and resources: six read-only tools over `ContentReadCore`, a note template, and a per-vault index resource | Accepted |
| [A35](./0035-mcp-cursors.md) | MCP pagination cursors: opaque HMAC-signed cursors bound to token and filter hash | Accepted |
| [A36](./0036-stdio-bridge.md) | stdio bridge: a first-party transparent proxy, `iridium-mcp` | Accepted |
| [A37](./0037-content-read-core.md) | One read model for humans and agents: `ContentReadCore` over committed projections | Accepted |
| [A38](./0038-projection-freshness.md) | Projection freshness and the search contract: bounded lag, human `flush`, rate-limited `?fresh=true`, explicit staleness | Accepted |

## Area 6 — Content pipeline, search, attachments, and portability

| ADR | Title | Status |
|---|---|---|
| [A39](./0039-search.md) | Search: InnoDB FULLTEXT over a narrow projection, behind a `SearchIndex` interface | Accepted |
| [A42](./0042-markdown-pipeline.md) | Markdown preview and sanitisation pipeline: unified/remark with a custom GFM wiring, `rehype-sanitize` last, hast → React, workers | Accepted |
| [A43](./0043-obsidian-syntax.md) | Obsidian syntax in the MVP: detect, report, and index; render as literal text; keep the seam ready | Accepted |
| [A44](./0044-attachments.md) | Attachments: content-addressed storage behind a driver interface, served by id, explicit deletion only | Accepted |
| [A45](./0045-import-export.md) | Import and export: a two-phase import job, a streaming export job with a manifest and EOL/BOM restoration | Accepted |

## Area 7 — Client applications

| ADR | Title | Status |
|---|---|---|
| [A40](./0040-ui-framework.md) | UI framework and state: React 19.3 + TanStack Router/Query + Zustand + Base UI/shadcn v4 + Tailwind 4 | Accepted |
| [A41](./0041-editor-stack.md) | Editor stack: CodeMirror 6 with y-codemirror.next and disposable views | Accepted |
| [A53](./0053-electron-shell.md) | Electron shell: Electron 44.3.0, three plain build configs, electron-builder 26, generic updater on the server, full hardening, main-only credential custody | Accepted; superseded in part by the |
| [A55](./0055-a11y-i18n-browsers.md) | Accessibility, internationalisation, and browser support | Accepted; superseded in part by AG6 |

## Area 8 — Audit, backup, operations, and threat model

| ADR | Title | Status |
|---|---|---|
| [A46](./0046-audit-log.md) | Audit log: same-transaction HMAC chain per `chain_id` with locked chain heads, triggers, a closed vocabulary, and CLI verify/export/archive | Accepted |
| [A47](./0047-backup-restore.md) | Backup and restore: dump plus attachments plus an encrypted secrets bundle plus a manifest, with binlog PITR and a blocking `restore --verify` | Accepted |
| [A48](./0048-deployment-topology.md) | Deployment topology: one server container, MySQL, an attachment volume, behind Caddy; hardened production compose; an air-gapped in-process TLS profile | Accepted |
| [A49](./0049-observability.md) | Logging, metrics, and health: pino JSON with redaction, prom-client, liveness plus fail-closed readiness, alert rules | Accepted |
| [A57](./0057-threat-model.md) | Threat model and compliance evidence: T1–T17 with a control → implementation → evidence map, and the operator CLI surface | Accepted |

## Area 9 — Owner answers to the open questions (2026-09-12)

| ADR | Title | Status |
|---|---|---|
| [AG1](./0060-oauth-authorization-server.md) | Iridium ships its own OAuth 2.1 authorization server, on a second MCP mount | Accepted |
| [A59](./0059-mysql-dual-lts.md) | MySQL 8.4 LTS and 9.7 LTS as equal required targets | Accepted |
| [AG6](./0061-supported-clients.md) | Supported clients at 1.0: the desktop application; the web host is a development and internal surface | Accepted |

## Numbering

File numbers are assigned by the decision log, not by area order: `0001`–`0057` follow the
skeleton ids `A1`–`A57` in the order the log accepted them (grouped by area within this index,
but not sequential by file number within an area — see each area's table above), `0058` is the
single limits policy (`A.1`), and `0059`–`0061` are the three ADRs the project owner's answers of
2026-09-12 to `docs/plan/14-risks-and-open-questions.md` §G produced (`A59`, `AG1`, `AG6`).

## Section decision amendments

- [D10-33: collaboration owner lease scope](./d10-33-collaboration-owner-lease.md), amended 2026-09-20 for ownership-loss recovery observation. Section decision IDs keep their original names rather than consuming an A-series number.

- [OPS-12: serving SQL deadlines](./ops-12-serving-sql-deadlines.md), amended 2026-09-17.

- [D04-14: owner-executed session revocation](./d04-14-owner-executed-session-revocation.md), amended 2026-09-17.

- [D05-06: transient collaboration dependency failures](./d05-06-transient-collaboration-failures.md), amended 2026-09-17.

- [D12-20: Schemathesis milestone scope](./d12-20-schemathesis-milestone-scope.md), accepted 2026-09-17.

- [A54: live client compatibility](./0054-client-server-compatibility.md), [A51: test resources and milestone selection](./0051-testing-harnesses.md), and [A2: mutation report isolation](./0002-mutation-lane.md), amended 2026-09-18 after the independent M1 review.
