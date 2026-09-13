# A35 — MCP pagination cursors: opaque HMAC-signed cursors bound to token and filter hash

**Status:** Accepted (2026-09-11).

## Context

A32 makes the endpoint stateless, so pagination cannot live in server memory. A cursor that is merely an offset or an unsigned JSON blob can be replayed against a different token, a different filter set, or a different vault — which, in a product whose entire value is per-vault ACLs, is an authorization bypass waiting to be discovered. The spec's "Vault isolation" row and A30's 404 rule both apply to paging. Tree mutations during a long enumeration are a second problem: a keyset over derived paths is correct only while the tree is unchanged, and A12 deliberately derives paths rather than storing them.

## Decision

`apps/server/src/mcp/cursor.ts` emits `base64url(JSON {v: 1, k: 'notes'|'search'|'revisions'|'attachments', a: <after key>, f: sha256(filters), t: tokenId, tv?: treeVersion, exp}) + HMAC-SHA256` using `MCP_CURSOR_KEY`, a dedicated secret included in the backup bundle (A47) and rotatable with `iridium keys rotate cursor`. Expiry is 1 hour. Keysets: `(path, id)` for notes, `(score DESC, note_id)` for search (the query is re-executed and the page filtered server-side), `(revision DESC)` for revisions, `(name, id)` for attachments. A foreign, expired, or mismatched cursor returns `isError` with "cursor invalid or expired — restart from the first page". **Pagination stability:** page 1 of `list_notes` embeds `tree_version`; later pages continue best-effort and set `stale: true` when `tree_version` has changed, with the documented remedy being to restart for a consistent listing. `limit` is capped at 500 for lists and 100 for search. REST uses the same cursor module.

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| Offset pagination (`LIMIT ?, ?`) | Skips and duplicates rows under concurrent edits, and degrades on deep pages; a keyset is both correct and indexable. |
| Unsigned cursors | Replayable across tokens, filters, and vaults; signing makes cross-token replay a verification failure rather than a leak. |
| Server-side cursor state (a table or a memory map) | Contradicts A32's statelessness; adds a cleanup job and a shared-state dependency for no benefit. |
| Cursors without a filter hash | A cursor from `path_prefix: '/public'` replayed against `path_prefix: '/hr'` would page through the second tree from the first's position. |
| Snapshot isolation across pages (a consistent tree version enforced server-side) | Would require pinning a tree snapshot per cursor; the honest `stale: true` flag plus a documented restart is simpler and does not hold resources. |
| No expiry | A leaked cursor is a long-lived capability; one hour bounds it, and the token itself is still checked on every request. |

## Consequences

Positive: cursor replay across tokens, queries, or vaults is impossible; one cursor module serves MCP and REST, so both behave identically; no server state to scale or clean up. Negative: search paging re-executes the query per page and filters server-side, which costs CPU on deep paging (bounded by the 100-item search cap and the per-token rate limit); `MCP_CURSOR_KEY` becomes restore-critical (a rotated or missing key invalidates outstanding cursors — acceptable, and verified by the restore checks in A47); `stale: true` is a contract agents must handle, and `instructions.md` says so.

## Verification

`mcp.cursor.unit` (signature verification, expiry, filter-hash mismatch, wrong `k`); `mcp.cursor.mcp` (a cursor from token A used with token B is rejected; keyset correctness with concurrent inserts; `stale: true` after a tree mutation; limit caps); `ops.key-rotation.drill` (`iridium keys rotate cursor` invalidates outstanding cursors cleanly with the documented `isError` text).

## References

Digest §3.2 (`tools/list` and `resources/list` cursor semantics), §3.4, §3.5 (opaque signed cursors bound to token id), §11.16; spec §4, §9; plan-agent-first graft. Implemented in `06-mcp-and-agent-access.md` and `09-api-reference.md`.

---

Source: docs/plan/13-decision-log.md, decision A35. This file is a faithful copy of that entry's Status, Context, Decision, Alternatives considered, Consequences, Verification and References fields; the decision log remains the authoritative, continuously-maintained record (status supersessions are recorded there first).
