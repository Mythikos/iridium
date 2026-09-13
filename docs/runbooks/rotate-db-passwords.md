# Rotating database role passwords

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

**Triggered by.** Planned work, not an incident — rotating one or more of the three MySQL role passwords.

## What this runbook will contain

`ALTER USER … IDENTIFIED BY …` as root via the `mysql` container for the affected role (`iridium_app`, `iridium_migrator`, or `iridium_backup`), updating the corresponding secret file, restarting the server, and confirming with `iridium doctor --db-roles` that the role still connects and holds exactly its expected grants. No application code is involved.

## Source

- docs/plan/11-operations-and-deployment.md, "Runbook index" and "Incident runbooks" (named explicitly in the operations plan, "Database role passwords" row)
