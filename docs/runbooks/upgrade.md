# Upgrade runbook

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

> `docs/ops/upgrade.md` is the narrative operator guide for planned upgrades; this file is its incident-format companion, named separately in the runbook index (`docs/plan/11-operations-and-deployment.md`, "Runbook index": "`upgrade.md` / `rotate-db-passwords.md` / `cli.md` — planned work, not incidents"). Confirm with the team that both are wanted as distinct documents before writing either one in full.

**Triggered by.** Planned work, not an incident — either a planned upgrade, or `IridiumMigrationsPending` firing outside one.

## What this runbook will contain

The runbook-format companion to `docs/ops/upgrade.md`'s narrative procedure: the step-by-step actions for walking an upgrade, or for a migration stuck pending, under the same discipline as every other runbook here (read-only triage first, no hand edits).

## Source

- docs/plan/11-operations-and-deployment.md, "Runbook index" and "Incident runbooks"
