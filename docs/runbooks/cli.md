# CLI command reference

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

> Do not hand-author this file's content once the generator exists — regenerate it with `pnpm gen` (or the dedicated CLI-docs step) and commit the result, exactly as `openapi.json` and the other generated artefacts are handled.

**Triggered by.** Planned work, not an incident — this is a generated reference, not a runbook to follow under alert pressure.

## What this runbook will contain

Generated from the command definitions (`iridium --help --json` feeding a generator in `tooling/docs/`), with `cli.contract.spec.ts` asserting the generated inventory matches what is committed here. This file is a build artefact once the `iridium` CLI exists (from M1 onward); the stub reserves the path before the generator exists so a new command cannot ship undocumented and a removed flag cannot linger.

## Source

- docs/plan/11-operations-and-deployment.md, "Runbook index" and "Incident runbooks"
