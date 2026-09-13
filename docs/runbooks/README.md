# Incident runbooks

Every runbook in this directory follows the same six headings, so an operator under pressure always
knows where the next instruction is: **Symptoms** → **What the system is already doing** →
**Triage** → **Resolution** → **Verification** → **Follow-up**. Two rules apply to all of them:
never weaken durability to clear a backlog, and never hand-edit the database (repairs are
`iridium repair …`, audited). See any runbook file for the full statement of both rules, and
`docs/plan/11-operations-and-deployment.md`, "Incident runbooks", for the source.

Every file below is currently a stub seeded at M0 — the procedure itself is written as the
mechanism it covers ships, not invented ahead of it.

| Runbook | Triggered by |
|---|---|
| [`db-unavailable.md`](./db-unavailable.md) | `IridiumDbUnavailable`, `IridiumNotReady`, users see "Reconnecting" |
| [`persist-failed.md`](./persist-failed.md) | `IridiumPersistFailing`, `IridiumPersistBacklog`, `IridiumWriterStuck`, users see "Save failed" |
| [`disk-full.md`](./disk-full.md) | `IridiumDiskLow`, `IridiumDiskCritical`, upload/export/import failures |
| [`revoked-but-connected.md`](./revoked-but-connected.md) | a report or a review finding that a removed user still had a live session |
| [`corrupted-document.md`](./corrupted-document.md) | `IridiumPersistCasMismatch`, `content-invalid` on a note, a projection hash mismatch in `restore --verify` |
| [`readyz-failing.md`](./readyz-failing.md) | `IridiumNotReady` with a check other than the database |
| [`capacity.md`](./capacity.md) | `IridiumDocBudgetHigh`, `IridiumAdmissionRefusing`, `IridiumDbPoolSaturated`, `IridiumPressureShedding` |
| [`large-note.md`](./large-note.md) | `IridiumSnapshotLarge`, `IridiumCompactionRefused`, `size-exceeded` reports |
| [`projection-timeouts.md`](./projection-timeouts.md) | `IridiumProjectionTimeouts`, `IridiumProjectionLag`, "preview won't render", agents see stale revisions |
| [`backup-missing.md`](./backup-missing.md) | `IridiumBackupMissing` (no successful `iridium backup` in 26 h) |
| [`restore-drill-stale.md`](./restore-drill-stale.md) | `IridiumRestoreDrillStale` (no verified restore within the site's drill cadence) |
| [`audit-verify.md`](./audit-verify.md) | `IridiumAuditChainBroken`, `IridiumAuditChainUnverified` |
| [`key-compromise.md`](./key-compromise.md) | a suspected leak of a pepper, the audit HMAC key, the cursor key, or a DB password |
| [`revoke-everything.md`](./revoke-everything.md) | a suspected account or agent-credential compromise |
| [`jobs.md`](./jobs.md) | `IridiumJobStale` |
| [`login-abuse.md`](./login-abuse.md) | `IridiumLoginFailureSpike` |
| [`mcp-errors.md`](./mcp-errors.md) | `IridiumMcpFactoryErrors`, agent reports of 401/500 |
| [`clock-skew.md`](./clock-skew.md) | `IridiumClockSkew` |
| [`tls-renewal.md`](./tls-renewal.md) | `IridiumTlsCertExpiringSoon` (air-gapped profile) |
| [`desktop-release-rollback.md`](./desktop-release-rollback.md) | a published desktop bundle must be withdrawn |
| [`upgrade.md`](./upgrade.md) | planned work, not an incident |
| [`rotate-db-passwords.md`](./rotate-db-passwords.md) | planned work, not an incident |
| [`cli.md`](./cli.md) | generated reference, not an incident runbook |

Source: `docs/plan/11-operations-and-deployment.md`, "Runbook index".
