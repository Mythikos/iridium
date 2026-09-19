# A19 — The "Saved" acknowledgement protocol

**Status:** Accepted (2026-09-11); amended 2026-09-18 to require a canonical delete-set fingerprint beside vector dominance.

## Context

Spec §5: "Saved means the server has durably persisted a state that includes the user's pending edits. Being connected or synchronized with the server's memory is not sufficient." Digest §2.2 verified that Hocuspocus's `SyncStatus(true)` and the provider's `unsyncedChanges === 0`/`synced` fire immediately after the in-memory apply and before any store, and that there is no store retry (§11.4). §11.3 records the disagreement over which client clock to compare: own-clientID clock (Topics 1, 2, 5) versus full state-vector dominance (Topic 8), with Hocuspocus issue #845 ("maxDebounce causing client-id to change", still open) as the reason to prefer dominance. Two gaps existed in every plan: a client that opens a note without editing has no `persisted` message to compare against, and a crash between COMMIT and the broadcast leaves the client in `syncing` forever.

## Decision

(1) A client Yjs update reaches the server; `applyUpdate` runs; Hocuspocus answers `SyncStatus(true)` — in-memory only, never "Saved". (2) Iridium's `update` listener captures `svAfter = Y.encodeStateVector(doc)` and `dsAfter = deleteSetFingerprint(doc)` synchronously at the same applied-update boundary and enqueues `{update, svAfter, dsAfter, actor:{userId, sessionId}, origin}` into the `NoteWriter`. (3) The writer transaction on `dbPersist`: `BEGIN; SELECT d.head_seq, n.deleted_at FROM note_docs d JOIN nodes n ON n.id = d.note_id WHERE d.note_id = ? FOR UPDATE` (trashed → drop the batch and close the document `note-trashed`); coalesce (A16); `INSERT note_updates (seq = head+1 … head+N, update_v1, sv_after, actor_type, actor_id, session_id, origin, …)`; `UPDATE note_docs SET head_seq = head+N, updated_at = ? WHERE note_id = ? AND head_seq = head` asserting `numUpdatedRows === 1n` (a mismatch is a corruption alarm, never silent); `COMMIT` under `innodb_flush_log_at_trx_commit = 1`. (4) Only after COMMIT: `document.broadcastStateless({t:'persisted', seq: head+N, sv: base64(svAfter_last), ds: dsAfter_last})`; the writer records `lastPersisted = {seq, sv, ds}`. (5) **Baseline:** after every provider `synced` event (initial connect and every reconnect) the client sends `{t:'baseline'}`; `onStateless` replies `connection.sendStateless({t:'persisted', seq, sv, ds})` from `lastPersisted`, initialised in `afterLoadDocument` from the fully replayed committed document and `note_docs.head_seq`; both the vector and fingerprint describe that committed FIFO prefix. An unloaded baseline replays the snapshot and ordered log before computing the pair. (6) The client's `SaveStateMachine` (`@iridium/collab-client`, pure, property-tested): `saved ⇔ socket connected ∧ provider.synced ∧ unsyncedChanges == 0 ∧ dominates(persistedSv, Y.encodeStateVector(ydoc)) ∧ persistedDs === deleteSetFingerprint(ydoc)`, where `dominates` checks every `(clientId, clock)` pair of the local vector and exact fingerprint equality additionally covers local or relayed deletions whose clocks do not change. (7) Failure: `{t:'persist-failed', seq, reason, retryInMs}` with `reason ∈ {db_unavailable, db_error, note_trashed, too_large, backpressure, content_invalid}`; the batch stays at the head of the queue; backoff 200 ms → 5 s with jitter, unbounded while the document is loaded; the writer enters `failed` after 10 attempts or 30 s (alert; keeps retrying every 30 s). (8) The client shows `save-failed` when a `persist-failed` is newer than the last `persisted`, or when vector dominance and exact delete-set fingerprint equality have not both been reached within 15 s of the last local edit. (9) `{t:'flush'}` (Ctrl/Cmd+S; ≤ 6 per minute per connection) triggers immediate compaction plus projection and answers `{t:'projected', seq}`; the status pill shows "Saved · up to date for agents". Spec deviation F2 makes the definition precise: a Markdown checkpoint is **not** required for Saved (it trails by ≤ 10 s; `flush` makes it current).

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| Ack from `afterStoreDocument` | Only per debounced store; skipped on failure; no retry (§11.4). |
| Hocuspocus `SyncStatus` / provider `synced` | Means "in server memory" (§2.2); violates spec §5 literally. |
| Own-clientID clock only (`decodeStateVector(sv).get(ydoc.clientID)`) | Vulnerable to #845 and to relayed updates from a second tab; dominance costs the same and is strictly more conservative. |
| Counter-based acks (sequence numbers only) | Cannot express that the persisted state includes *this client's* edits after a reconnect that merged pending updates. |
| Requiring a Markdown checkpoint for Saved | Would tie Saved to the 2–10 s compaction and multiply write amplification; `flush` covers the agent-freshness need. |

## Consequences

Positive: the acceptance row "Durable saving" holds under kill-after-ack with a 500–2 000 ms Toxiproxy latency toxic widening the window; a note opened without edits shows Saved immediately from the baseline; crash-after-commit-before-ack self-heals on reconnect; the `save-failed` state is explicit and recoverable. Negative: one extra round trip on every `synced` (the baseline message); the client must keep its own `unsyncedChanges` accounting in step with the provider's (which decrements only on `SyncStatus(true)`); the protocol is Iridium-specific and versioned (`v: 1`, A54).

## Verification

`collab.durable-ack.chaos` (all fault points, kill-after-ack ×20 PR / ×200 nightly); `collab.baseline-on-connect.integration`; `collab.deletion-durability.integration` (local and relayed deletions held before COMMIT); `crdt.durability.unit`; `convergence.model.prop` and `crdt.dominates.prop`; `save-state.machine.prop` (random event sequences never report `saved` without vector dominance and exact canonical delete-set fingerprint equality); Playwright `saved-indicator.e2e` (Saved only after ack under a delayed-commit fault, M4); k6 SLO `durable_ack_ms p95 < 1 s`.

## References

Digest §2.2, §1.2 (state vectors), §11.2, §11.3, §11.4; spec §5, §9; plan-risk-first ADR-03/ADR-05; plan-agent-first ADR-04/ADR-05; plan-enterprise ADR-07; plan-product-dx 007/008 (flush graft); skeleton F2. Implemented in `05-collaboration-and-durability.md`, `09-api-reference.md` (§D.2) and `07-client-applications.md` (status pill).

---

Source: docs/plan/13-decision-log.md, decision A19. This file is a faithful copy of that entry's Status, Context, Decision, Alternatives considered, Consequences, Verification and References fields; the decision log remains the authoritative, continuously-maintained record (status supersessions are recorded there first).


## Amendment, 2026-09-18

A pure deletion can leave every Yjs state-vector clock unchanged. The real held-COMMIT regression reproduced Saved before the deletion was durable, so v1 `persisted` now requires `ds`: exactly 64 lowercase hexadecimal characters containing SHA-256 of `Y.encodeSnapshot(Y.createSnapshot(Y.snapshot(doc).ds, new Map()))`, computed by `deleteSetFingerprint` in `@iridium/crdt`. The fingerprint records deleted struct ranges; it neither replaces the state vector nor contains deleted content or synthetic document metadata.

The writer captures `{svAfter, dsAfter}` synchronously at each applied-update boundary. Coalescing retains the final member's pair, and retry or exact durable reconciliation retains that same committed FIFO prefix witness; later edits never enter an earlier acknowledgement. Baselines compute both witnesses from the fully replayed committed document. Saved, the pending-work warning and the 15 s deadline require vector dominance AND exact fingerprint equality. A server fingerprint containing additional deletions is conservatively unsaved until replay and a matching acknowledgement. Missing or malformed `ds` is rejected, never defaulted. No SQL witness column is required. This is a pre-release v1 correction: the server and clients must ship together.

See [A19 amendment](../plan/13-decision-log.md#a19-amendment-2026-09-18-deletion-aware-saved-acknowledgements). Verification: `collab.deletion-durability.integration`, `crdt.durability.unit` and `save-state.machine.prop`.
