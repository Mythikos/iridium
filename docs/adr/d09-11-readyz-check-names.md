# D09-11: the `/readyz` body and its check names

Status: accepted; amended 2026-09-25: `ReadyzCheckName` has seventeen names from M3, `server_settings` appended after `access_log_partitions`.

**As accepted.** `/readyz` returns the same JSON body with `200` and `503`, and `GET /admin/system` embeds it as `readiness`. Its `status` and per-check vocabulary is `ok`/`warn`/`fail`, and `ReadyzCheckName` is exactly the readiness table of 11-operations-and-deployment.md (sixteen checks, including `collab_owner_lease` and `access_log_partitions` for 03 D03-03 / I-20) — the same strings the `iridium_readyz_check_status{check}` label and the alert rules use. The enum gains `mysql_version` with A59's two required MySQL lines (8.4 LTS and 9.7 LTS); like `access_log_partitions`, it can never be `fail`. `/metrics` answers a bad token with a bare `401` (no `ProblemDetails`). An operator debugging a failing readiness check needs the checklist, not an error document; Prometheus does not parse `application/problem+json`. One vocabulary across the body, the metric label and the alert expressions is what makes a dashboard row, an alert and a `curl /readyz` line refer to provably the same check.

**Amended 2026-09-25.** `READYZ_CHECK_NAMES` in `packages/contracts/src/rest/ops.ts` appends `server_settings` after `access_log_partitions`, so the widening is additive and the check runs after `migrations` and `collab_owner_lease`; `ReadyzCheckName` has seventeen names from M3. Prose refers to `ReadyzCheckName` rather than restating a count. `server_settings` is fail-closed until the settings store's first load and can warn but never fail after it (OPS-24 and ARCH-10 as amended), and `infra/docker/runtime-smoke.ts`'s `REQUIRED_READY_CHECKS` includes it.

Verification: `readyz.integration` and `ops.readiness.unit`.

Source: the D09-11 amendment in [the decision log](../plan/13-decision-log.md), and D09-11 in [09-api-reference.md](../plan/09-api-reference.md), "Decisions made in this section".
