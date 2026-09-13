# A21 — Per-document persistence serialisation and backpressure: `NoteWriter`

**Status:** Accepted (2026-09-11).

## Context

Spec §6: "Serialize persistence per note so an older asynchronous save cannot overwrite a newer state." During a MySQL outage an unbounded in-memory queue grows without limit (the risk-first plan's queue was unbounded); Hocuspocus's `beforeUnloadDocument` can veto an unload but nothing re-triggers it afterwards, so a vetoed unload could pin a document in memory forever (a gap in every plan).

## Decision

One `NoteWriter` per loaded document (`apps/server/src/collab/persistence/writer.ts`), strict FIFO, at most one in-flight transaction per note; compaction jobs share the FIFO (A16). The database guard is `note_docs … FOR UPDATE` plus the `head_seq` CAS — never an in-memory counter alone. **Queue bound:** 5 000 updates or 32 MiB; when exceeded the document becomes read-only for all connections, the writer broadcasts `persist-failed {reason:'backpressure'}` and an alert fires, until the queue drains. **Global fairness:** persistence concurrency equals `DB_POOL_PERSIST` (4) with round-robin scheduling across notes so no note starves. `beforeUnloadDocument` throws while the queue is non-empty or a transaction is in flight; **after the drain, if `getConnectionsCount() === 0`, the writer calls `hocuspocus.unloadDocument(document)`** so vetoed unloads complete; `afterUnloadDocument` disposes the writer. `/readyz` reports unhealthy when the oldest pending update is older than 30 s or any writer has been `failed` for more than 60 s (A49).

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| Unbounded queue (plan-risk-first) | Memory grows without bound during a DB outage; OOM converts a database incident into a collaboration outage. |
| In-memory sequence counter as the only guard | A restart or a second process breaks it; the row lock plus CAS is the only authoritative serialisation. |
| Dropping updates under backpressure | Violates spec §5 (edits must stay recoverable); read-only mode keeps the text on every client. |
| One global writer for all notes | Head-of-line blocking across notes; per-note FIFOs plus round-robin give fairness. |

## Consequences

Positive: bounded memory during outages while the ack stays truthful; no note can starve another; documents never leak after a veto. Negative: read-only under backpressure is a visible degradation (by design, with an alert); the writer's retry loop is Iridium code to maintain (Hocuspocus provides none).

## Verification

`collab.backpressure.chaos` (Toxiproxy latency/timeout on MySQL → queue bound reached → read-only + `persist-failed {backpressure}` → drain → editable again); `collab.unload-after-veto.integration`; `collab.graceful-shutdown.chaos` (drain within 20 s); `readyz.integration` (backlog age and `failed` writer conditions); k6 fairness assertion (no note's `durable_ack_ms` p95 exceeds the SLO while others are hot).

## References

Digest §2.2 (`beforeUnloadDocument`, `unloadDocument`, `shouldUnloadDocument`), §2.4 (pool sizing under simultaneous maxDebounce flushes); spec §6; plan-product-dx 007 (bounded queue graft); gap fixes. Implemented in `05-collaboration-and-durability.md`.

---

Source: docs/plan/13-decision-log.md, decision A21. This file is a faithful copy of that entry's Status, Context, Decision, Alternatives considered, Consequences, Verification and References fields; the decision log remains the authoritative, continuously-maintained record (status supersessions are recorded there first).
