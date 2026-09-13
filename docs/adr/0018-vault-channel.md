# A18 — Vault realtime channel: `vault:<vaultId>` as an empty, never-persisted Hocuspocus document

**Status:** Accepted (2026-09-11).

## Context

Spec §3 says nothing about live tree semantics; without a push channel the tree, membership and vault presence are stale until refresh. The desktop client cannot carry its bearer credential on an `EventSource`, and a second WebSocket would need a second auth and revocation path. Hocuspocus already provides authenticated, revocable, multiplexed documents on one socket and a stateless broadcast primitive (digest §2.2). The product-dx plan proposed this design (022); all three judge panels grafted it.

## Decision

Every vault has a Hocuspocus document named `vault:<vaultId>` handled by the `IridiumVaultChannel` extension: `onLoadDocument` returns nothing (the document stays empty), `onStoreDocument` throws `SkipFurtherHooksError`, `connection.readOnly = true` for every connection, and no update from a client is ever applied. The document is used only for `document.broadcastStateless` of `tree-changed {treeVersion, changes:[{nodeId, parentId, kind, op, version}]}`, `member-changed {userId, role|null}` and `vault-updated {version}`, and for vault awareness `{id, activeNoteId}`. It is authenticated with the same tickets (A24), authorised by `vault:read`, and closed by the same `CollabGateway` revocation path (A23). One provider per open vault per window; the UI invalidates the TanStack Query keys `[origin, 'vault', vaultId, …]` on each message (A40). Adopted at M4 (the server side ships with M2's tree service, which already bumps `vaults.tree_version` and calls `broadcastVault`).

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| REST polling | Stale by the poll interval; wasted load at fleet scale. |
| Server-Sent Events | Cannot carry the desktop bearer (main-only custody, A26) without a second credential path; a second connection to revoke. |
| Second WebSocket endpoint | Duplicates auth, Origin, ticket and revocation logic. |
| Persisting the vault document | Nothing to persist; an empty document avoids the compaction/checkpoint machinery entirely. |

## Consequences

Positive: instant tree/membership freshness and vault presence over an already-authenticated, already-revocable socket; the stateless messages are schema-validated in `@iridium/contracts/collab.ts` (`v: 1`). Negative: one extra Hocuspocus document per open vault counts against `maxPendingDocuments`/the admission budget (A50) — vault documents are empty and cheap; a client that sends a Yjs update on `vault:*` is answered `SyncStatus(false)` and, on a second attempt, closed `protocol-error`.

## Verification

`tree-live-updates.e2e` (Playwright web, M4); `collab.live-revocation.integration` covers `vault:*` closures; `collab.isolation.integration` asserts that `onStoreDocument` throws `SkipFurtherHooksError`, that `onLoadDocument` leaves the document empty, and that no client update on `vault:*` is ever applied; `collab.limits.integration` covers the read-only enforcement.

## References

Digest §2.2 (stateless channel, multiplexing, `SkipFurtherHooksError`); plan-product-dx 022; judges 1–3; skeleton F11. Implemented in `05-collaboration-and-durability.md` and `07-client-applications.md`.

---

Source: docs/plan/13-decision-log.md, decision A18. This file is a faithful copy of that entry's Status, Context, Decision, Alternatives considered, Consequences, Verification and References fields; the decision log remains the authoritative, continuously-maintained record (status supersessions are recorded there first).
