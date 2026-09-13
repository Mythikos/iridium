# A59 — MySQL 8.4 LTS and 9.7 LTS as equal required targets

**Status:** Accepted (2026-09-12). **Supersedes.** A9 in full; the MySQL lane assignment of A52.

## Context

The project owner made MySQL 8 a requirement on 2026-09-12 while asking that modern MySQL stay supported. A9 had made 9.7 primary and 8.4 an advisory nightly lane. MySQL 8.0 reached end of life on 2026-04-30 (last release 8.0.46); 8.4 LTS is supported to 2029-04-30 (extended 2032-04-30) and 9.7 LTS to ~2034-04-21; 9.0–9.6 and the 26.x line are innovation releases with roughly three months of support each; upgrades hop LTS to LTS (digest §5.2, §9.2, §10.2, §11.8).

**Assumption.** "MySQL 8" is read as **8.4 LTS**, because 8.0 is end of life and 8.4 is the only supported 8.x line. If 8.0 was meant literally, the floor drops below `CREATE TRIGGER IF NOT EXISTS` (8.0.29+), `my.cnf` needs a per-line variant, and the product would ship onto an unpatched engine — that returns to the owner as a question rather than being decided here.

## Decision

Two required targets, no primary. `mysql:8.4.11` is the compatibility floor and the image every unset selector resolves to (`IRIDIUM_MYSQL_IMAGE`, `MYSQL_TAG`); `mysql:9.7.2-oraclelinux9` is the reference production image in `compose.prod.yaml` and `docs/ops/deployment.md`. 8.0, 9.0–9.6 and 26.x are refused at boot (`config.mysql_unsupported`, exit `2`; `IRIDIUM_ALLOW_UNTESTED_MYSQL` downgrades the refusal to a permanent `/readyz` `mysql_version: warn`). Every statement the product executes must have identical semantics on both, with the floor at 8.4.11 and no use of a construct 8.4 deprecates — which retires the "8.0.13-compatible" subset, since `migrate ensure-guards` already needs 8.0.29+. `ci.yml`'s `integration` and `chaos-core` jobs become two-entry matrices, all four checks required on `main` from M0, and the nightly `mysql-84` job is deleted. `manifest.json` records `mysql_line` and a restore never crosses an LTS line downwards. The rule is held by `db.dialect-floor.guard`, the `db.version-floor.boot` refusal, the matrices and `migrations.parity.integration`.

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| Keep 9.7 primary with a merge-blocking 8.4 lane | A declared primary makes the other engine the one nobody develops against; the defect then arrives as a red required check rather than as a failing local test. Making the floor the default an unset selector resolves to costs nothing and moves detection into the development loop. |
| 8.4 only | Discards the owner's "support modern" and forces every site through an 8.4 → 9.7 hop inside the product's life. |
| MySQL 8.0 as the floor | End of life 2026-04-30; no security patches; below `CREATE TRIGGER IF NOT EXISTS`. |
| Certify innovation releases too | ~3 months of support each; `mysql:latest` is that line, which is why it is never used. A non-blocking nightly `mysql-innovation` lane gives early warning without a support claim. |
| Ship both 8.4 and 9.7 client tools in the runtime image | Two dump paths, and the less-exercised one fails in a drill. One 9.7.2 client, proven against both servers. |
| Allow a cross-line restore downgrade behind a flag | A 9.7 dump loaded into 8.4 produces a database that loads and is wrong. The pre-upgrade backup was taken on the older line and restores onto it cleanly, so the override would only make the wrong thing possible. |

## Consequences

Positive: two supported engines with one tested schema; a portability defect fails in the development loop; the produced schema is compared between engines rather than each statement merely compiled; a cross-line restore downgrade becomes impossible rather than merely discouraged; sites that standardise on 8.4 (and their DBAs) are served without a second product. Negative: runner-minutes for `integration` and `chaos-core` double (wall-clock does not — matrix entries run in parallel); the `VALUES(col)` upsert form must be rewritten to the row alias; branch protection carries four database checks instead of two; and every future SQL construct must be checked against the floor, which is what the guard's denylist exists to make cheap.

## Verification

M0: `db.dialect-floor.guard`, `migrations.parity.integration`, `db.version-floor.integration` and `migrations.integration` green on both matrix entries; `ops.mysql-config.spec` boots the shipped `my.cnf` on both and asserts equal resolved variables. M1: `db.auth-plugin.integration` and `db-grants.integration` (including the `MYSQLDUMP_ARGV`-against-both-servers assertion) on both. M8: `ops.cross-line-restore.drill`, the `restore.mysql_line_downgrade` case of `ops.restore-verify.chaos`, and `ops.compose-prod.clean-vm` once per line.

## References

Digest §5.2, §9.2, §10.2, §11.8; owner's answer to open question G3 (2026-09-12); MySQL 8.0 reference manual for `CREATE TRIGGER IF NOT EXISTS` (8.0.29+) and for the deprecation of the `VALUES()` function. Implemented in `03-data-model.md`, `10-testing-and-quality.md`, `11-operations-and-deployment.md` and `12-milestones.md`.

---

Source: docs/plan/13-decision-log.md, decision A59. This file is a faithful copy of that entry's Status, Context, Decision, Alternatives considered, Consequences, Verification and References fields; the decision log remains the authoritative, continuously-maintained record (status supersessions are recorded there first).
