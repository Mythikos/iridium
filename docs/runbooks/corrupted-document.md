# A note's collaborative state is in question

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

**Triggered by.** `IridiumPersistCasMismatch`, a `content-invalid` finding on a note, or a projection hash mismatch surfaced by `restore --verify`.

## What this runbook will contain

Distinguishing the failure cases a corrupted document can present, and the `iridium repair` commands that fix each one — never a hand edit of `note_docs` or `note_updates`, per the second universal rule above.

## Source

- docs/plan/11-operations-and-deployment.md, "Runbook index" and "Incident runbooks" (one of the five detailed runbooks the plan writes out in full)
