# A7 — Kysely + kysely-ctl + kysely-codegen; forward-only migrations in production; fail-closed readiness

**Status:** Accepted (2026-09-11); the one-DDL-per-file clause is **superseded in part by D03-29 (2026-09-25)**: it admits exactly `0028_audit_events_triggers` and `0029_audit_events_archive` by content hash, marked inline in the Decision.

## Context

The schema (skeleton §C) needs DDL that ORMs cannot express: `FULLTEXT` indexes, virtual generated columns in `UNIQUE` keys, multi-valued JSON indexes, `RANGE COLUMNS` partitions, triggers, and grants. Digest §5.2 verified that drizzle-kit has no MySQL `FULLTEXT` support (issues #1018/#1495 open) and Drizzle 1.0 is still RC; Prisma 7's only MySQL adapter is `@prisma/adapter-mariadb` and its CLI `latest` is an 8.0 RC; Kysely 0.29.5 offers typed SQL, `Migrator` with per-migration `transactionMode`, and raw `sql` for the rest.

## Decision

kysely 0.29.5 with `MysqlDialect` over mysql2 pools (A10); kysely-ctl 0.21.0 migrations in `apps/server/migrations/NNNN_<name>.ts`, one DDL statement per file [**Superseded in part by D03-29 (2026-09-25):** two M0 files, `0028_audit_events_triggers` (2 statements) and `0029_audit_events_archive` (3), each `IF NOT EXISTS`-guarded, are admitted by content hash; no further exception is admitted (`03-data-model.md` §14.2; `migrations.one-ddl.guard`)], idempotent guards, `transactionMode: 'per-migration'`, the whole run wrapped in `GET_LOCK('iridium_migrate', 60)`; kysely-codegen 0.20.0 output diffed in CI against the hand-written `apps/server/src/db/schema.ts`. `iridium migrate status|up|to` uses `DATABASE_MIGRATE_URL` (the migrator role of A8). The container entrypoint migrates only when `IRIDIUM_MIGRATE_ON_BOOT=true` (default `true` in dev/compose; documented off for HA). `/readyz` returns 503 while migrations are pending. Production migrations are forward-only with the expand/contract rule (a column is dropped one release after code stops using it). Triggers and grants live in migrations so a restore re-applies them (A45/A47). The initial set is `0001_users` … `0034_grants` (skeleton §C.11).

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| Drizzle 0.45 / 1.0-rc | No `FULLTEXT`, generated-column, or functional-unique DDL; `push` cannot detect index-expression changes; 1.0 not GA. |
| Prisma 7 | mariadb driver, not mysql2; CLI on an 8.0 RC; `Bytes`/`DateTime(3)` defaults fight the schema. |
| Raw mysql2 without a query builder | Loses typed results and the codegen drift check. |
| Auto-migrate on every boot | Operators must control schema changes; HA needs one migrator. |
| Down migrations in production | Data-destroying rollbacks; the expand/contract rule plus backups (A47) replace them. |

## Consequences

Positive: exact DDL; typed SQL without a model layer; operators run migrations deliberately and readiness refuses traffic on a schema mismatch. Negative: `kysely-ctl 0.21.0` requires `kysely < 0.30` (pin discipline); one-DDL-per-file means 34 initial files (deliberate: each is individually idempotent and retryable).

## Verification

M0: migrations 0001–0034 apply on `mysql:8.4.11` and `mysql:9.7.2-oraclelinux9` — under A59 both are entries of the merge-blocking `ci.yml › integration` matrix rather than a primary and a nightly lane, and `migrations.parity.integration` additionally asserts that the schema the two produce is **identical**, not merely legal; kysely-codegen diff step in `static`; `readyz.integration` (503 with a pending migration); `migrations.integration` (two concurrent `migrate up` runs — one waits on `GET_LOCK`); the M8 upgrade rehearsal (M1-era backup → current).

## References

Digest §5.2 (Kysely, Drizzle, Prisma facts, generated columns, partitions), §11.8; unanimous (risk-first ADR-08, agent-first ADR-14, enterprise ADR-04/ADR-29, product-dx 004). Implemented in `03-data-model.md` and `11-operations-and-deployment.md`.

---

Source: docs/plan/13-decision-log.md, decision A7. This file is a faithful copy of that entry's Status, Context, Decision, Alternatives considered, Consequences, Verification and References fields; the decision log remains the authoritative, continuously-maintained record (status supersessions are recorded there first).
