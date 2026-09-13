# A50 — Loaded-document admission control: explicit budget with refusal, no eviction

**Status:** Accepted (2026-09-11).

## Context

All active `Y.Doc`s live in the server process (A17). Digest §2.6 lists the memory budget as an open question; yjs #675 shows multi-second `applyUpdate` and freezes near 9 MB states. No source plan bounded the number or total size of loaded documents, so a burst of opens (or a pathological vault) could exhaust memory and take down collaboration for everyone.

## Decision

Two environment-configurable budgets: `COLLAB_MAX_LOADED_DOCS` (default 2 000) and `COLLAB_MAX_STATE_BYTES_TOTAL` (default 1 GiB, estimated from `note_docs.snapshot_size` at load time). When admitting a new document would exceed either, `onAuthenticate` throws and the connection is closed with reason `capacity`; the client shows "Server busy — retrying" and retries with the provider's backoff; an alert fires. Idle documents unload through `unloadImmediately: true` (after the writer drains, A21). Live documents are never evicted. Metrics `iridium_docs_loaded` and `iridium_note_state_bytes`; `/readyz` warns at 80 % of either budget.

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| LRU eviction of live documents | Evicting a document with connected editors interrupts them and forces a reload storm; refusing new admissions is predictable and affects only newcomers. |
| No limit (rely on `maxPendingDocuments`) | `maxPendingDocuments` bounds concurrent *loads*, not resident documents. |
| Per-vault budgets | Adds policy surface without a demonstrated need; the process-level budget is the OOM protection. |

## Consequences

Positive: predictable OOM protection; operators see the budget on the dashboard and can size the process; capacity is a visible, alertable condition rather than a crash. Negative: under sustained overload new opens are refused (by design); the byte estimate uses the last compacted size, so a note that grew since compaction is under-counted until the next compaction.

## Verification

`collab.limits.integration` (open documents up to the budget with a small `COLLAB_MAX_LOADED_DOCS`, assert the next open closes with `capacity` and that unloading one admits one more); `readyz.integration` (80 % warning); the k6 load lane asserts RSS < 1.5 GB at 300 VUs / 60 docs on 4 vCPU (A51).

## References

Digest §2.6 (memory budget question), §1.2 (yjs #675), §2.2 (`maxPendingDocuments`, `unloadImmediately`); skeleton F15; gap fix. Implemented in `05-collaboration-and-durability.md` and `11-operations-and-deployment.md`.

---

Source: docs/plan/13-decision-log.md, decision A50. This file is a faithful copy of that entry's Status, Context, Decision, Alternatives considered, Consequences, Verification and References fields; the decision log remains the authoritative, continuously-maintained record (status supersessions are recorded there first).
