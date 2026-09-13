# Upgrading a deployment

*Stub seeded at M0. Not yet written — content lands with the milestone named below, drawn
from `docs/plan/11-operations-and-deployment.md`, not invented ahead of it.*

> A separate `docs/runbooks/upgrade.md` exists for the incident-style version of this procedure (triggered by the `IridiumMigrationsPending` alert or run under time pressure); this document is the narrative operator guide. See the note in that file.

## What this document will contain

The upgrade procedure for a Compose deployment: reading a release's operator flags (`[migration]`, `[long-running]`, `[config]`, `[api]`, `[key]`, `[proxy]`, `[breaking-ops]`), the pre-flight checklist whose step 5 — a verified pre-upgrade backup — is not optional ("an upgrade without a verified pre-upgrade backup is an upgrade without a rollback"), forward-only migrations and the expand/contract rule, and the rollback procedure and its limits.

## Source

- docs/plan/11-operations-and-deployment.md, "Runbook: upgrading a Compose deployment", "Release notes and operator flags"
- docs/plan/12-milestones.md §12 (M8 scope: "forward-only migrations, expand/contract, the rollback procedure and its limits")
