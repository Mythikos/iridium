# A11 — Entity IDs: UUIDv7 in `BINARY(16)`, canonical strings on every wire

**Status:** Accepted (2026-09-11).

## Context

Note and vault IDs are stable identities exposed to agents (`iridium://vault/{vault_id}/note/{note_id}`), stored as primary keys in InnoDB (clustered), and must be ASCII-stable in URIs. Two plans chose ULID `CHAR(26)`; two chose UUIDv7. Judges 1 and 2 chose UUIDv7.

## Decision

UUIDv7 generated in-repo by `@iridium/contracts/ids.ts` (no dependency; monotonic within a process), stored as `BINARY(16)`, rendered as canonical lowercase UUID strings on every REST/MCP/IPC surface; branded TypeScript types per entity (`VaultId`, `NodeId`, `NoteId`, `AttachmentId`, `UserId`, `TokenId`, `SessionId`, `JobId`, `RevisionId`).

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| ULID `CHAR(26) ascii_bin` (agent-first, product-dx) | 26 bytes per key versus 16; every secondary index carries the key; no standard textual form that URL and OpenAPI validators already know. |
| UUIDv4 | Random clustered inserts fragment InnoDB pages. |
| Auto-increment | Enumerable; leaks cardinality; unusable across vault exports/imports. |

## Consequences

Positive: time-ordered inserts, half the key width of ULID text, `format: uuid` in OpenAPI, ASCII-stable `iridium://` URIs. Negative: MySQL helpers (`UUID_TO_BIN`) are not used — conversion happens in one codec module so the binary form never leaks; property tests cover monotonicity and round-trip.

## Verification

`contracts.ids.unit` (round-trip, ordering, uniqueness across workers); the `toMatchOpenApi(operationId, status)` matcher enforces `format: uuid`; `mcp.resources.mcp` tests the URI template.

## References

Digest §5.2 (BINARY/clustered facts); judges 1, 2; plan-risk-first ADR-24; plan-product-dx 023 (rejected ULID). Implemented in `03-data-model.md` and `09-api-reference.md`.

---

Source: docs/plan/13-decision-log.md, decision A11. This file is a faithful copy of that entry's Status, Context, Decision, Alternatives considered, Consequences, Verification and References fields; the decision log remains the authoritative, continuously-maintained record (status supersessions are recorded there first).
