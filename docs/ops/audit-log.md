# Audit log

An audited mutation and its event commit in the same transaction. If the event cannot be written, the mutation rolls back. Note text, individual keystrokes, CRDT updates and ordinary human reads are not audit payloads. `access_log` separately records authenticated denied requests and token read traffic; its monthly partitions have a different retention lifecycle.

## Vocabulary and scope

The closed vocabulary and chain assignments are [`AUDIT_ACTIONS` and `AUDIT_ACTION_CHAIN`](../../packages/contracts/src/audit.ts). Unknown actions are rejected. The vocabulary reserves later-milestone actions; an enum value does not mean its endpoint already ships.

| Family | Actions |
|---|---|
| Authentication | `user.login.succeeded`, `user.login.failed`, `user.logout`, `user.reauth.succeeded`, `user.password.set`, `user.password.changed`, `session.revoked`, `session.revoked_all` |
| Tokens | `token.created`, `token.rotated`, `token.revoked`, `token.revoked_all`, `token.denied` |
| OAuth, from M3 | `oauth.client.registered`, `oauth.client.disabled`, `oauth.client.deleted`, `oauth.client.expired`, `oauth.consent.granted`, `oauth.consent.updated`, `oauth.consent.revoked`, `oauth.refresh.reuse_detected`, `oauth.code.replayed`, `oauth.authorize.denied` |
| Vaults | `vault.created`, `vault.updated`, `vault.archived`, `vault.restored`, `vault.settings.changed`, `vault.member.added`, `vault.member.role_changed`, `vault.member.removed` |
| Tree | `node.created`, `node.renamed`, `node.moved`, `node.trashed`, `node.restored`, `node.purged` |
| Content | `note.revision.named`, `note.revision.restored`, `note.content.invalid`, `note.content.repaired` |
| Attachments | `attachment.uploaded`, `attachment.deleted` |
| Transfer, from M6 | `export.created`, `import.scanned`, `import.committed`, `import.aborted` |
| Administration | `admin.user.created`, `admin.user.updated`, `admin.user.disabled`, `admin.user.enabled`, `admin.user.deleted`, `admin.user.password_reset`, `admin.settings.changed`, `admin.job.triggered`, `admin.job.cancelled`, `admin.audit.exported`, `admin.backup.verified`, `admin.release.published`, `admin.release.withdrawn` |
| Access and collaboration | `mcp.access.denied`, `collab.connection.rejected`, `collab.write.rejected` |
| System | `system.migration.applied`, `system.key.rotated`, `system.audit.archived` |

Vault-scoped actions use `vault:<32 lowercase UUID hex digits>`; other actions use `server`. Events carry actor and credential identity, outcome, request/CLI context and relevant resource ids. Optional metadata contains non-content before/after values. CLI context records the OS user, host and argument shape without argument values. Bulk targets are bounded and explicitly marked when truncated.

## Chain semantics and verification

Each chain has one locked `audit_chain_heads` row. The mutating transaction takes that lock last, appends the event and advances the head atomically. Genesis is id zero and 32 zero bytes:

```text
HMAC-SHA256(key[key_version], previous_hash_bytes || UTF8(auditChainPreimage(payload)))
```

`payload.prev_id` is the preceding event's id; the new auto-increment id is assigned after hashing. [`auditChainPreimage()`](../../packages/contracts/src/audit.ts) applies canonical JSON: sorted object keys, stable JSON scalars, preserved array order and six-digit UTC timestamps. SQL-null optional columns are omitted from the top-level payload; nulls inside context/metadata remain nulls. UUIDs become canonical strings. Do not hash the complete exported row: `id`, `hash`, `prev_hash` and `key_version` are not payload members.

Key bytes are the UTF-8 bytes of the configured key material, including its base64 spelling. Do not decode it again. Retain every historical `AUDIT_HMAC_KEY_V<n>` secret: verification selects each row's key version and refuses a missing key.

```sh
iridium audit verify-chain --json
iridium audit verify-chain --chain vault:0123456789ab7def8123456789abcdef --json
```

Verification walks live and archived rows together in id order, checks each predecessor/HMAC, then compares the final row with the stored head. Exit 0 means intact; 5 names a divergence; 2 means configuration prevented verification. [`verifyChain()`](../../apps/server/src/audit/chain.ts) is the reference verifier. A filtered export requires its preceding chain anchor and cannot establish whole-chain completeness. Preserve trusted head values with audit evidence snapshots.

A failure is an incident: preserve database/key evidence and follow [audit verification](../runbooks/audit-verify.md). Do not reset a chain or rewrite rows to make verification pass.

## Export formats

```sh
iridium audit export --format jsonl --include-archive --out audit.jsonl
iridium audit export --format csv --vault <vault-uuid> --from 2026-09-01T00:00:00.000Z --to 2026-09-20T00:00:00.000Z --out audit.csv
```

`--action` selects one known action. The default is JSONL from the live table; `--include-archive` adds retained archived rows. Export holds a repeatable-read snapshot, pages by id and streams with backpressure, preventing an archive move from duplicating or hiding a row. `--out` creates a restrictive new file and refuses overwrite. Without it, rows go to stdout and the summary to stderr.

JSONL emits every stored column: identities as UUIDs, hashes as hex, timestamps as six-digit UTC strings and JSON columns as objects/arrays. CSV quotes every field, doubles embedded quotes and encodes structured fields as JSON. Use CSV for analysis and retain JSONL for verification. A successful operator export emits `admin.audit.exported` after its snapshot, so the event appears in a subsequent export.

## Archive and retention

```sh
iridium audit archive --dry-run --json
iridium audit archive --older-than-days 400 --json
iridium audit verify-chain --json
```

`AUDIT_RETENTION_DAYS` defaults to 400. A requested age may extend that floor, never shorten it. The job selects an old contiguous prefix, verifies its chain, streams a `.jsonl.zst` export plus `.sha256` sidecar into `AUDIT_ARCHIVE_EXPORT_DIR` (default `/data/exports/audit-archive`), and fsyncs published evidence before moving rows. Bounded transactions copy original rows/hashes into `audit_events_archive`, verify the copy, delete matching live rows and record `system.audit.archived`. Archived history remains retained.

The app role cannot delete audit events. Deletion uses the migrator role on one pinned connection with `@iridium_audit_archive=1`. The job resets this flag before releasing the connection and destroys the connection if reset fails. Triggers stay installed. Without a maintenance credential the result is `skipped_no_ddl_credential`, and the CLI refuses completion. Supply `DATABASE_MIGRATE_URL` to the executing owner, or stop the serving process and run the CLI with that credential and the real owner lease.

Maintenance commands enqueue durable jobs for the serving owner; an offline CLI can acquire the same lease. `JOBS_ENABLED=false` disables automatic scheduling while explicit jobs remain executable. Keep archive exports and historical keys with backups. Dropping access-log partitions neither removes nor verifies the audit chain.
