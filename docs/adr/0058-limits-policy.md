# A.1 — Single limits policy

**Status:** Accepted (2026-09-11); the three bridge timings were **added 2026-09-25** (D06-13 amendment) under the Decision's own rule that a later section may add a cap, and no existing value changed; **amended 2026-09-25 (D06-48):** every M3 number that bounds, refuses, times out or sizes server-held state is a `LIMITS` member named once, `BOUNDED_LIST_MAX` is named (replacing `rest/pagination.ts`'s `BOUNDED_LIST_ROWS`), `LIMIT_ENV_OVERRIDES` gains the MCP burst, process-ceiling and request-deadline overrides, and column widths and protocol hints stay named module constants on the single-source allowlist.

## Context

Digest §11.24 records five incompatible sets of size limits across the research topics (WebSocket `maxPayload` 1, 2 or 4 MiB; note caps of 1 000 000 UTF-16 units, 2 MiB, or 2 MB Markdown / 16 MB state; 100 messages per second versus per-minute budgets). A pathological Markdown document or unbounded CRDT growth is a real denial-of-service class (yjs #675; micromark quadratic cases in §7.2), and the spec (§8) requires upload and message size limits. Limits scattered across packages drift.

## Decision

One policy, expressed as constants in `@iridium/contracts/limits.ts` and enforced at the named points:

| Item | Value | Enforced where |
|---|---|---|
| WebSocket frame `maxPayload` | 2 MiB | `@fastify/websocket` options |
| Single Yjs update | ≤ 1 MiB | `beforeHandleMessage` (close `too-large`) |
| Yjs messages per connection | 200 / 10 s | `beforeHandleMessage` (close `rate-limited`) |
| Awareness messages per connection | 10 / s (excess dropped) | `beforeHandleAwareness` |
| Connections | 20 per user, 50 per IP, 5 000 per process | upgrade `preValidation` |
| Loaded documents / state bytes | 2 000 docs / 1 GiB | `onAuthenticate` (close `capacity`, A50) |
| Note text | soft 1 000 000 UTF-16 units (client blocks pastes; server flags `notes.oversize` at compaction → note read-only until reduced); hard 2 097 152 at create/import/restore/repair | client + server |
| V2 snapshot size | alert > 8 MB; compaction refuses > 64 MB (note read-only, admin alert) | compactor |
| Writer queue | 5 000 updates or 32 MiB → backpressure | `NoteWriter` (A21) |
| Writer batch | 512 updates or 8 MiB of raw update bytes per transaction (`WRITER_BATCH_MAX_UPDATES`, `WRITER_BATCH_MAX_RAW_BYTES`); a merged `note_updates` row ≤ 1 MiB | `NoteWriter` batch assembly, split at `(actor, session, origin)` run boundaries (A16) |
| Compaction debounce / max | 2 000 / 10 000 ms (100 / 500 in integration tests) | Hocuspocus config |
| `flush` / `?fresh=true` | 6 / min per connection, or per principal + note | `onStateless`, REST rate limit |
| Update-log retention after compaction | 7 days | maintenance job |
| Checkpoint cadence | content change ∧ ≥ 10 min (vault setting) + unload/named/restore/import/trash | compactor |
| Ticket TTL / reuse / batch / rate | 60 s / single use / ≤ 50 per request / 300 per min per session, 1 000 per min per IP | `TicketStore`, rate limit |
| Token re-validation | every 15 min ± 3 min jitter; 5 min reply grace | `onTokenSync` |
| REST | authenticated 600/min per principal; unauthenticated 60/min per IP; login 10/min per IP | `@fastify/rate-limit` |
| MCP / PAT | 120/min burst + 3 000/h per token (search costs 3); `/mcp` process ceiling 600/min | `mcp/rate-limit.ts` |
| Markdown projection | 2 MiB source, blockquote depth 32, list indent 64 cols, 20 000 lines/paragraph, 10 s server / 2 s client | `@iridium/markdown` pre-scan + workers |
| Upload | 50 MiB per attachment; import 2 GiB, 50 000 files, depth 64 | `@fastify/multipart`, import worker |
| Body limits | JSON 1 MiB (`/mcp` 1 MiB) | Fastify `bodyLimit` |
| Shutdown drain | 20 s | `main.ts` |
| Bridge timings (added 2026-09-25, D06-13 amendment) | list refresh 300 000 ms (`BRIDGE_LIST_REFRESH_MS`); upstream timeout default 60 000 ms (`BRIDGE_UPSTREAM_TIMEOUT_DEFAULT_MS`), floor 5 000 ms (`BRIDGE_UPSTREAM_TIMEOUT_MIN_MS`) | `packages/mcp-bridge/src` |

Every value is imported from the contracts package by the enforcing code and by the tests; no literal limit appears elsewhere (a lint `no-magic-numbers` exception list is maintained for this file only). A later section may **add** a cap to `limits.ts` — it must then appear in the `LimitId` union with an enforcement site and in the canonical rendering of `02-system-architecture.md` §"The single limits policy" — but it may never rename one, because the single-source test compares identifiers rather than values and a second spelling of one cap leaves one constant unreferenced and the other outside the union.

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| Per-topic numbers left as found in the digest | Contradictory; a 4 MiB `maxPayload` with a 1 MiB update cap, or a 1 MiB payload with a 2 MiB note, cannot both be right. |
| Larger note caps (16 MB state) | yjs #675 shows multi-second loads near 9 MB V1; the 8 MB alert and 64 MB refusal keep loads responsive. |
| Limits configurable per deployment for everything | Most values are protocol invariants that clients and tests depend on; only the few marked as vault or server settings (checkpoint interval, PAT rate, TTLs) are runtime-configurable. |

## Consequences

Positive: one source of truth shared by client, server, load tests and documentation; every enforcement point has a named close reason or error code; the digest's conflict is closed. Negative: the numbers are engineering defaults derived from yjs #675, crdt-benchmarks and the micromark measurements rather than Iridium-specific measurements — M8's load calibration may revise them (a revision is a new ADR superseding this one).

## Verification

`collab.limits.integration` (each WebSocket limit triggers its close reason); `tickets.batch-and-limits.integration`; `mcp.rate-limit.mcp`; `markdown.pathological.unit` (pre-scan rejects each cap); `attachments.security.integration` (upload cap); `limits.policy.unit` (a compile-time exhaustive switch over the `LimitId` union, distributed across the enforcing modules, so a constant with no enforcement site does not compile) and `limits.single-source.guard` (no numeric limit exists outside `@iridium/contracts/limits.ts`); `ops.load.slo` at M8.

## References

Digest §11.24, §1.2 (#675), §7.2 (quadratic cases), §6.2 (OWASP WebSocket message/rate limits); spec §8; plan-risk-first ADR-26; plan-product-dx 029; skeleton §A.1 and F15. Implemented in `05-collaboration-and-durability.md`, `08-markdown-pipeline-import-export.md`, `09-api-reference.md` and `11-operations-and-deployment.md`.

---

Source: docs/plan/13-decision-log.md, decision A.1. This file is a faithful copy of that entry's Status, Context, Decision, Alternatives considered, Consequences, Verification and References fields; the decision log remains the authoritative, continuously-maintained record (status supersessions are recorded there first).
