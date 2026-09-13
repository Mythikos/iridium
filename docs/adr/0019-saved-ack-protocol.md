# A19 — The "Saved" acknowledgement protocol

**Status:** Accepted (2026-09-11).

## Context

Spec §5: "Saved means the server has durably persisted a state that includes the user's pending edits. Being connected or synchronized with the server's memory is not sufficient." Digest §2.2 verified that Hocuspocus's `SyncStatus(true)` and the provider's `unsyncedChanges === 0`/`synced` fire immediately after the in-memory apply and before any store, and that there is no store retry (§11.4). §11.3 records the disagreement over which client clock to compare: own-clientID clock (Topics 1, 2, 5) versus full state-vector dominance (Topic 8), with Hocuspocus issue #845 ("maxDebounce causing client-id to change", still open) as the reason to prefer dominance. Two gaps existed in every plan: a client that opens a note without editing has no `persisted` message to compare against, and a crash between COMMIT and the broadcast leaves the client in `syncing` forever.

## Decision

(1) A client Yjs update reaches the server; `applyUpdate` runs; Hocuspocus answers `SyncStatus(true)` — in-memory only, never "Saved". (2) Iridium's `update` listener captures `svAfter = Y.encodeStateVector(doc)` synchronously and enqueues `{update, svAfter, actor:{userId, sessionId}, origin}` into the `NoteWriter`. (3) The writer transaction on `dbPersist`: `BEGIN; SELECT d.head_seq, n.deleted_at FROM note_docs d JOIN nodes n ON n.id = d.note_id WHERE d.note_id = ? FOR UPDATE` (trashed → drop the batch and close the document `note-trashed`); coalesce (A16); `INSERT note_updates (seq = head+1 … head+N, update_v1, sv_after, actor_type, actor_id, session_id, origin, …)`; `UPDATE note_docs SET head_seq = head+N, updated_at = ? WHERE note_id = ? AND head_seq = head` asserting `numUpdatedRows === 1n` (a mismatch is a corruption alarm, never silent); `COMMIT` under `innodb_flush_log_at_trx_commit = 1`. (4) Only after COMMIT: `document.broadcastStateless({t:'persisted', seq: head+N, sv: base64(svAfter_last)})`; the writer records `lastPersisted = {seq, sv}`. (5) **Baseline:** after every provider `synced` event (initial connect and every reconnect) the client sends `{t:'baseline'}`; `onStateless` replies `connection.sendStateless({t:'persisted', seq, sv})` from `lastPersisted`, initialised in `afterLoadDocument` from `note_docs.head_seq` and the last `note_updates.sv_after` (else `snapshot_sv`). (6) The client's `SaveStateMachine` (`@iridium/collab-client`, pure, property-tested): `saved ⇔ socket connected ∧ provider.synced ∧ unsyncedChanges == 0 ∧ dominates(persistedSv, Y.encodeStateVector(ydoc))`, where `dominates` checks every `(clientId, clock)` pair of the local vector — immune to #845 and to relayed updates. (7) Failure: `{t:'persist-failed', seq, reason, retryInMs}` with `reason ∈ {db_unavailable, db_error, note_trashed, too_large, backpressure, content_invalid}`; the batch stays at the head of the queue; backoff 200 ms → 5 s with jitter, unbounded while the document is loaded; the writer enters `failed` after 10 attempts or 30 s (alert; keeps retrying every 30 s). (8) The client shows `save-failed` when a `persist-failed` is newer than the last `persisted`, or when dominance is not reached within 15 s of the last local edit. (9) `{t:'flush'}` (Ctrl/Cmd+S; ≤ 6 per minute per connection) triggers immediate compaction plus projection and answers `{t:'projected', seq}`; the status pill shows "Saved · up to date for agents". Spec deviation F2 makes the definition precise: a Markdown checkpoint is **not** required for Saved (it trails by ≤ 10 s; `flush` makes it current).

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

`collab.durable-ack.chaos` (all fault points, kill-after-ack ×20 PR / ×200 nightly); `collab.baseline-on-connect.integration`; `convergence.model.prop` and `crdt.dominates.prop`; `save-state.machine.prop` (random event sequences never report `saved` without dominance); Playwright `saved-indicator.e2e` (Saved only after ack under a delayed-commit fault, M4); k6 SLO `durable_ack_ms p95 < 1 s`.

## References

Digest §2.2, §1.2 (state vectors), §11.2, §11.3, §11.4; spec §5, §9; plan-risk-first ADR-03/ADR-05; plan-agent-first ADR-04/ADR-05; plan-enterprise ADR-07; plan-product-dx 007/008 (flush graft); skeleton F2. Implemented in `05-collaboration-and-durability.md`, `09-api-reference.md` (§D.2) and `07-client-applications.md` (status pill).

---

Source: docs/plan/13-decision-log.md, decision A19. This file is a faithful copy of that entry's Status, Context, Decision, Alternatives considered, Consequences, Verification and References fields; the decision log remains the authoritative, continuously-maintained record (status supersessions are recorded there first).
