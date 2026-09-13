# A9 — MySQL 9.7 LTS primary, 8.4 LTS certified; baked `my.cnf`

**Status:** Superseded by A59 (2026-09-12).

> Superseded by **A59 — MySQL 8.4 LTS and 9.7 LTS as equal required targets**. The baked `my.cnf` contents, the `log_bin = binlog` base-name correction and the `authentication_policy` spelling all carry forward unchanged; what A59 supersedes is the primary/certified split, the 8.0.13 compatibility floor, the nightly lane assignment, and the claim in this ADR's alternatives table that 9.7 adds Community tablespace encryption — `component_keyring_file` is Community Edition on 8.4 and 9.7 alike.

A9's **Decision** and **References** below are the text as accepted on 2026-09-11 and are kept unedited (D13-2). Their two mentions of open question G3 — the Decision's closing sentence "Whether the 8.4 lane remains a requirement is open question G3 (default: both)" and the References list's `open question G3` — are historical record of a question the owner answered on 2026-09-12, not a live dependency. The answer, and the assumption it rests on, are in A59 and in "Decisions settled by the owner's answers of 2026-09-12".

## Context

MySQL 8.0 reached end of life on 2026-04-30; 9.7 is the current LTS line with eight-year support; 8.4 LTS is supported to 2032; upgrades hop LTS to LTS (8.0 → 8.4 → 9.7, no skipping); Percona XtraBackup 9.7 exists; the Docker `latest` tag is an innovation release (digest §5.2, §11.8). Several settings (`innodb_ft_min_token_size`, stopwords, `sql_require_primary_key`) must be fixed before the first `FULLTEXT` index or table is created.

## Decision

`mysql:9.7.2-oraclelinux9` is the pinned image for compose, Testcontainers, and service containers; a nightly CI lane runs `mysql:8.4.11`; all SQL stays 8.0.13-compatible (functional key parts are the floor). `infra/docker/mysql/my.cnf` is baked before migration `0001`: `character_set_server=utf8mb4`, `collation_server=utf8mb4_0900_ai_ci`, `authentication_policy=caching_sha2_password`, `innodb_flush_log_at_trx_commit=1`, `sync_binlog=1`, `log_bin=binlog`, `binlog_format=ROW`, `binlog_expire_logs_seconds=604800`, `innodb_ft_min_token_size=2`, `innodb_ft_enable_stopword=OFF`, `max_allowed_packet=256M`, `innodb_redo_log_capacity=2G`, `sql_require_primary_key=ON`, `max_connections=200`, `cte_max_recursion_depth=200`.

Two spellings in that list are load-bearing and were wrong in earlier drafts of it. `log_bin`'s argument is the log **base name**, not a boolean: `log_bin=ON` produces `ON.000001` and breaks every `binlog.NNNNNN` path in the backup manifest, the PITR runbook and `iridium doctor --pitr-window`. And the plugin pin is `authentication_policy`, because `default_authentication_plugin` was deprecated in 8.0.27 and **removed in 8.4.0** — an unknown variable makes `mysqld` exit at startup rather than warn, and this one file is mounted into the development compose, `compose.prod.yaml`, the Testcontainers fixture and the 8.4 nightly lane, so setting it would mean the database never comes up, before migration `0001` and before any drill. `authentication_policy` exists on both 8.4 and 9.x, and `init/01_roles.sh` already writes `IDENTIFIED WITH caching_sha2_password` per user. `ft_min_word_len` is deliberately absent: it is MyISAM-only, every Iridium table is InnoDB, and `innodb_ft_min_token_size` is what governs the FULLTEXT tokenizer. Whether the 8.4 lane remains a requirement is open question G3 (default: both).

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| MySQL 8.0 | End of life. |
| 8.4 LTS only | Forces the 8.4 → 9.7 hop during the product's life; 9.7 adds Community TDE and the tooling Iridium documents (XtraBackup 9.7). |
| 9.7 only, no 8.4 lane | Conservative sites run 8.4; the lane is cheap and keeps SQL portable (G3 can drop it). |
| Innovation releases (26.x) | Unsupported after ~3 months each. |

## Consequences

Positive: long support horizon; the durability settings the "kill after ack" proof depends on (`innodb_flush_log_at_trx_commit=1`, `sync_binlog=1`) are configuration of record, and `/readyz` checks the first (A49); PITR via binlogs (A47). Negative: `mysql_native_password` is removed in 9.x (mysql2 speaks `caching_sha2_password`, fine); a repository bug once auto-upgraded 8.4 hosts to 9.7 (digest §10.2) — the deployment docs pin the major explicitly.

## Verification

M0 exit: an empty server passes `/readyz` against 9.7.2 and 8.4.11 with the shipped `my.cnf` mounted — which is itself the standing check that the file contains no variable either release rejects; the nightly 8.4 lane repeats it; `readyz.integration` asserts `innodb_flush_log_at_trx_commit == 1` under `READYZ_STRICT_DURABILITY=true`; `migrations.integration` applies `0001`–`0034` on both images against the same file; `ops.pitr.chaos` proves the binlog base name by replaying `binlog.NNNNNN` files out of the backup set; `search.acl.integration` and `search.snippets.unit` depend on the baked FULLTEXT settings and fail on a default `my.cnf`.

## References

Digest §5.2, §9.2, §10.2, §11.8; unanimous (risk-first ADR-07, agent-first ADR-13, enterprise ADR-03, product-dx 004); open question G3. Implemented in `03-data-model.md` and `11-operations-and-deployment.md`.

---

Source: docs/plan/13-decision-log.md, decision A9. This file is a faithful copy of that entry's Status, Context, Decision, Alternatives considered, Consequences, Verification and References fields; the decision log remains the authoritative, continuously-maintained record (status supersessions are recorded there first).
