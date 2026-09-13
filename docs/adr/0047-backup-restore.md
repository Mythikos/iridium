# A47 — Backup and restore: dump plus attachments plus an encrypted secrets bundle plus a manifest, with binlog PITR and a blocking `restore --verify`

**Status:** Accepted (2026-09-11).

## Context

Spec §8 requires backing up the database and attachments together with a documented, **tested** recovery procedure, and states that a Markdown export is not a complete backup of accounts, permissions, revisions, attachments, and collaboration state. Spec §9's "Backup recovery" row requires that a clean deployment can restore content, attachments, permissions, and revision history from the documented backup set. The plan adds a requirement the spec implies but does not state: a restore that produces an unauthenticatable or internally inconsistent system must **fail**, not appear to succeed. Three secrets make that non-obvious — the password pepper (A29), the audit HMAC key (A46), and `MCP_CURSOR_KEY` (A35) — because restoring a database without them yields a system where every password is invalid and the audit chain cannot be verified. A trigger detail matters too: `mysqldump` of triggers carries DEFINER clauses, which cause failures or privilege surprises on a fresh instance.

## Decision

`iridium backup --out <dir>` produces four artifacts:

1. `mysqldump --single-transaction --hex-blob --routines --events --skip-triggers --set-gtid-purged=OFF` run as `iridium_backup` (MySQL Shell `util.dumpInstance` and Percona XtraBackup 9.7 are documented alternatives). **Triggers are deliberately excluded** and re-created by `iridium migrate` during restore, so no DEFINER or `log_bin_trust_function_creators` issue can arise.
2. An attachment-store snapshot (`rsync -a` or bucket replication) started **after** the dump — safe because attachments are content-addressed and immutable (A44), so a later snapshot is always a superset.
3. A secrets bundle encrypted with an operator passphrase (`age`, pinned at M0): password pepper(s), audit HMAC key(s), `MCP_CURSOR_KEY`, attachment key(s), and all key versions.
4. `manifest.json`: server version, schema head, dump SHA-256, attachment count and bytes, audit chain heads, note count and maximum `head_seq`, and key versions.

Binary logs are retained 7 days for point-in-time recovery.

`iridium restore --from <dir> --verify` on a clean deployment: create the database and roles → load the dump → restore attachments → install secrets (**key versions must match the manifest**) → `iridium migrate` (which re-applies triggers and grants and forward-migrates) → then **blocking verification**:

- verify the audit chain for every chain;
- sample-load `note_docs` into throwaway `Y.Doc`s and compare `toString()` hashes against `note_projections.content_hash`;
- confirm every `attachments.storage_key` exists with a matching SHA-256;
- assert the collaboration invariants `head_seq == GREATEST(snapshot_through_seq, COALESCE(MAX(note_updates.seq), 0))` and `snapshot_through_seq <= head_seq` for every note (a violation **fails the restore**; `iridium doctor --repair-heads` is an explicit, audited repair);
- assert `projected_seq == head_seq` for unloaded notes, otherwise run `reindex --stale`;
- compare membership and role counts against the manifest.

Success writes an `admin.backup.verified` audit event and sets the `iridium_backup_last_verified_timestamp` metric. A nightly CI job, `ops.backup-restore.drill`, runs exactly these scripts. The Markdown export is documented as portability, never as backup.

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| Dump plus attachments plus manifest only (plan-risk-first) | A restore would come up with unverifiable audit chains and, without the pepper, no user could log in — a backup that cannot authenticate anyone is not a backup. |
| Including secrets in plaintext beside the dump | The backup set becomes a single-file compromise of every credential; the operator passphrase is the minimum separation (digest §6.2: keys kept separate, envelope encryption). |
| Dumping triggers with `mysqldump` | DEFINER clauses break or mis-privilege on a fresh instance; `iridium migrate` owns triggers and grants (A7), so restore re-applies them from migrations. |
| Snapshotting attachments **before** the dump | A file uploaded between the snapshot and the dump would be referenced but missing; content addressing makes the after-order strictly safe. |
| Non-blocking (advisory) verification | An operator would discover the corruption during an incident; blocking verification turns a silent bad restore into a loud failed restore. |
| Automatic `repair-heads` during restore | Silently rewriting durability metadata hides data loss; the repair exists but is explicit and audited. |
| Markdown export as the backup story | Spec §8 rejects it outright; it carries no accounts, permissions, revisions, or collaboration state. |
| XtraBackup as the default | Excellent and documented as an alternative, but it requires a matching server version and filesystem access; `mysqldump` is the lowest-common-denominator path every operator can run. |

## Consequences

Positive: a restore either produces a fully verified system or fails loudly; the nightly drill means the documented procedure is executed continuously rather than trusted; key versions in the manifest make a pepper or audit-key mismatch a startup-time failure rather than a silent authentication outage. Negative: `--verify` makes restore slower than a plain dump load (deliberate; the sampling rate for the Y.Doc check is configurable); the secrets bundle adds an operator passphrase to the runbook, which must itself be stored somewhere safe (documented in `11-operations-and-deployment.md`); binlog retention adds disk usage that `my.cnf`'s `binlog_expire_logs_seconds=604800` bounds (A9).

## Verification

`ops.backup-restore.drill` (nightly: back up a populated deployment, restore onto a clean one, run every verification, assert `admin.backup.verified`); `ops.restore-verify.chaos` (each of the blocking invariants and its negative on the same restored deployment: a wrong pepper or audit key version fails the restore, an injected `head_seq` inconsistency fails it and `--repair-heads` fixes it with an audit event, and a deleted blob fails verification); `backup.attachment-superset.integration` (a file uploaded between dump and snapshot is present and referenced); the "Backup recovery" acceptance row is exactly this drill.

## References

Digest §6.2 (OWASP secrets management, envelope encryption), §5.2 (MySQL dump and XtraBackup facts), §10.2 (enterprise expectations); spec §8, §9; plan-enterprise graft; gap fixes (secrets bundle, trigger exclusion, blocking verification). A59 adds `manifest.mysql_line` and the `restore.mysql_line_downgrade` refusal to the backup set's integrity contract, and names Percona XtraBackup **matched to the server's line** (8.4 or 9.7) as the physical alternative; `mysqldump` remains the shipped path on both. **G4, answered on 2026-09-12** (volume and database encryption only), confirms that the secrets bundle carries no attachment key family: the three secrets this ADR names — the password pepper, the audit HMAC key and `MCP_CURSOR_KEY` — remain the whole of it, and AG1 introduces no fourth, because OAuth credentials are opaque rows rather than signed tokens. Implemented in `11-operations-and-deployment.md` and `03-data-model.md`.

---

Source: docs/plan/13-decision-log.md, decision A47. This file is a faithful copy of that entry's Status, Context, Decision, Alternatives considered, Consequences, Verification and References fields; the decision log remains the authoritative, continuously-maintained record (status supersessions are recorded there first).
