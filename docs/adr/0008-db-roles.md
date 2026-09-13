# A8 — Least-privilege MySQL roles: `iridium_app`, `iridium_migrator`, `iridium_backup`

**Status:** Accepted (2026-09-11).

## Context

The audit log (A46) is only tamper-evident if the application cannot alter it. A single application user with DDL rights defeats triggers and grants. The enterprise plan introduced three roles; judges 1 and 3 grafted them.

## Decision

`infra/docker/mysql/init/01_roles.sql` creates: `iridium_app` (DML on all tables; `INSERT` + `SELECT` only on `audit_events` and `audit_events_archive`; `SELECT` only on `kysely_migration*`; no DDL, `FILE`, or `SUPER`), `iridium_migrator` (DDL + DML + `TRIGGER`; no `GRANT OPTION`), and `iridium_backup` (`SELECT`, `LOCK TABLES`, `RELOAD`, `PROCESS`, `REPLICATION CLIENT`, `SHOW VIEW`, `TRIGGER`, `EVENT`). Migration `0034_grants` re-applies grants and is skipped when the migrating user lacks `GRANT` (managed hosting). `db-grants.integration` asserts the app role cannot `UPDATE`/`DELETE` audit rows and that the `SIGNAL SQLSTATE '45000'` trigger fires.

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| Single application user | "The app physically cannot alter history" is the property enterprise reviewers ask for; a single user cannot provide it. |
| Application-enforced immutability only | Any SQL injection or bug in the app would bypass it. |

## Consequences

Positive: append-only audit at the database privilege level; backups run under a read-only principal; migrations under a principal the app never uses. Negative: three credentials to provision (`DATABASE_URL`, `DATABASE_MIGRATE_URL`, backup credentials via `*_FILE`); `iridium audit archive` runs under the migrator role because the app role cannot move rows out of `audit_events`.

## Verification

`db-grants.integration` (M1 gate); `audit.chain.integration`; `restore --verify` re-applies grants through `iridium migrate` (A47).

## References

Digest §6.2 (append-only audit guidance), §5.2 (MySQL roles/grants facts); plan-enterprise §3.8/§10.3, ADR-13; judges 1, 3. Implemented in `03-data-model.md` and `11-operations-and-deployment.md`.

---

Source: docs/plan/13-decision-log.md, decision A8. This file is a faithful copy of that entry's Status, Context, Decision, Alternatives considered, Consequences, Verification and References fields; the decision log remains the authoritative, continuously-maintained record (status supersessions are recorded there first).
