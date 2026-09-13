# A20 — Role change on a live connection: server flips `readOnly`, client re-attaches on upgrade

**Status:** Accepted (2026-09-11).

## Context

Spec §4 requires that downgrading a role affects already-open sessions. Digest §2.2 verified that for a `readOnly` connection an incoming update is not applied and is answered `SyncStatus(false)`, which leaves the provider's `unsyncedChanges` permanently above zero; the provider re-authenticates only when the socket reopens, and `forceSync()` does not resend rejected updates. Every source plan handled the downgrade; none handled the upgrade back to editor, which is the common "give me edit rights for a minute" flow.

## Decision

Downgrade: `CollabGateway.changeRole()` sets `connection.readOnly = true` on every `note:*` connection of that user in the vault and sends `connection.sendStateless({t:'role', role:'viewer'})`; pending viewer updates are answered `SyncStatus(false)` and the client enters the `rejected` state with its text exportable via `host.files.saveText` ("Export my text"). Upgrade: `readOnly = false` plus `{t:'role', role}`; the client detaches the provider and attaches a **fresh `HocuspocusProvider` on the same `Y.Doc`** with a fresh ticket — the full SyncStep1/SyncStep2 exchange merges every pending local update, `unsyncedChanges` resets — then requests the baseline (A19). `forceSync()` alone is not used.

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| `forceSync()` on upgrade | Verified not to resend updates that were rejected; `unsyncedChanges` never returns to zero, so Saved is unreachable. |
| Close the connection on any role change and let the provider reconnect | Loses the pending viewer edits the spec wants kept "visibly unsaved and recoverable" (spec §5). |
| Client-side re-authentication only | The server must flip `readOnly` itself; it is the security boundary (spec §4). |

## Consequences

Positive: both directions are handled without losing text; the same `Y.Doc` and `UndoManager` survive the re-attach, so per-client undo is intact. Negative: a re-attach is a full sync of the note (bounded by the note-size limits, A.1); the client must serialise re-attach with any in-flight ticket fetch.

## Verification

`collab.live-revocation.integration` (includes downgrade → upgrade re-attach, asserting pending updates land and Saved is reached); `status-pill.transitions.component` (a fake provider driven through baseline and re-attach, M4); `revocation-while-open.e2e`.

## References

Digest §2.2 (readOnly enforcement, `unsyncedChanges` accounting, per-document close semantics); spec §4, §5; gap fix "role upgrade after downgrade". Implemented in `05-collaboration-and-durability.md` and `07-client-applications.md`.

---

Source: docs/plan/13-decision-log.md, decision A20. This file is a faithful copy of that entry's Status, Context, Decision, Alternatives considered, Consequences, Verification and References fields; the decision log remains the authoritative, continuously-maintained record (status supersessions are recorded there first).
