# Saves are failing while the database is up

*Stub seeded at M0. Not yet written — the incident procedure lands with the milestone that
ships the mechanism it covers, drawn from `docs/plan/11-operations-and-deployment.md`, not invented ahead of it.*

Every runbook in `docs/runbooks/` follows the same six headings, so an operator under pressure
always knows where the next instruction is: **Symptoms** (what fired, what users report) →
**What the system is already doing** (so nobody "fixes" a mechanism that is working) → **Triage**
(read-only commands, in order) → **Resolution** (the ordered actions, with the decision points
named) → **Verification** (how you know it is over) → **Follow-up** (what to change so it does not
recur, including which test was missing).

Two rules apply to every runbook and belong at the top of each one:

1. **Never weaken durability to clear a backlog.** Lowering `innodb_flush_log_at_trx_commit`,
   disabling `sync_binlog`, or removing the readiness durability check turns a visible incident
   into an invisible data-loss risk and breaks the "Saved" contract.
2. **Never hand-edit the database.** No incident in this index is resolved with `UPDATE`/`DELETE`
   from a MySQL shell. Repairs are `iridium repair …`, audited, and refuse to run when the
   corresponding `doctor` finding is absent.

**Triggered by.** `IridiumPersistFailing`, `IridiumPersistBacklog`, `IridiumWriterStuck` without `IridiumDbUnavailable`.

## What this runbook will contain

Diagnosis by the `reason` field on `persist.failed` events (`db_error`, `too_large`, `backpressure`, `note_trashed`, `content_invalid`, a writer stuck retrying), the safe resolution order, and what never to do — restarting the server to "clear" a stuck writer (it discards queued, unacknowledged updates the retry loop would have committed) or raising the queue bound to silence the alert.

## Source

- docs/plan/11-operations-and-deployment.md, "Runbook index" and "Incident runbooks" (one of the five detailed runbooks the plan writes out in full, § "2. `persist-failed.md`")
