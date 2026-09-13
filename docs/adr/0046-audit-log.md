# A46 — Audit log: same-transaction HMAC chain per `chain_id` with locked chain heads, triggers, a closed vocabulary, and CLI verify/export/archive

**Status:** Accepted (2026-09-11).

## Context

Spec §8 requires recording administrative and structural actions using authenticated identities and explicitly forbids treating CRDT client identifiers or self-reported cursor names as proof of authorship. Digest §6.2 verifies the industry conventions: dot-notation actions, `occurred_at`, `actor {id, type, …}`, `targets []`, `context {location, user_agent}`, append-only enforcement through insert-only database privileges, a separate schema, tenant and actor context on every row, and hash/HMAC chaining that makes tampering **detectable** (not preventable). It also records that enterprise questionnaires rank audit-log retention and export immediately after SSO and SCIM. Digest §11.26 records the granularity disagreement: a per-MCP-call audit row (Topic 3), a split between lifecycle events and a high-volume access log (Topic 6), and per-tool-call rows with returned note ids (Topic 10). The subtle correctness problem is the chain itself: computing `prev_hash` by reading the last row without a lock forks the chain under concurrency, producing two rows claiming the same predecessor — which verification then reports as tampering. A second, deeper problem is deadlock: the audit writer takes a lock inside every mutating transaction, so its lock order must be fixed relative to the vault row, the node rows, and the persistence writer.

## Decision

`AuditWriter.record(trx, event)` runs **inside the mutating transaction**: `SELECT last_id, last_hash FROM audit_chain_heads WHERE chain_id = ? FOR UPDATE` (chain `vault:<id>` for vault-scoped events, `server` otherwise), then `hash = HMAC-SHA256(AUDIT_HMAC_KEY[key_version], prev_hash || canonicalJSON(row))`, then the INSERT, then the head UPDATE.

**Lock order is normative**, declared once in `02-system-architecture.md` §"Lock order" and restated here because this ADR is the reason it exists: `vaults` → `nodes` → `notes` → `note_docs` → `note_updates` → `note_projections` → `note_search` → `note_links` → `note_revisions` → `trash_entries` → `audit_chain_heads` (always the last lock of any transaction). Every structural transaction is a `withVaultLock()` transaction and takes that chain. Two participants sit outside it and carry their own no-cycle arguments, because a single total order is not achievable with the guard SQL that A19 fixes:

- **Persistence writer and compactor (`dbPersist`).** The writer's guard locks exactly two rows — the note's `note_docs` row and, through the `JOIN nodes` that A19 mandates, the note's `nodes` row — and never `notes`, `vaults` or `audit_chain_heads`; it never participates in a structural transaction. The compaction transaction opens with the same guard and then takes `note_projections`, `note_search`, `note_links`, `note_revisions` and exactly one `notes` row (which is why the `notes` write is one statement per compaction, never one per commit — decision D03-14 in `03-data-model.md`). The guard acquires `note_docs` before `nodes`, and that cannot cycle because **no structural transaction on a *live* note locks `note_docs`**: rename, move, trash, restore and role changes never touch it; `NoteService.initialize` inserts it inside the create transaction before any writer for that note can exist; and purge deletes it only for a trashed subtree whose documents are closed and whose writers are disposed.
- **Purge.** Deletes children-first in FK-safe order (`note_links` → `note_search` → `note_projections` → `note_revisions` → `note_updates` → `note_docs` → `notes` → `trash_entries` → `nodes`) under the vault lock, and is safe for the same reason.

The trash transaction in particular never locks `note_docs`: the writer's own `deleted_at` check under its own lock plus `markClosing` handle the race, and a crash between COMMIT and the gateway side-effect is repaired because `onAuthenticate` and `onLoadDocument` refuse trashed notes and a boot-time sweep closes any loaded trashed document.

`BEFORE UPDATE` and `BEFORE DELETE` triggers on `audit_events` raise `SIGNAL SQLSTATE '45000'`; `iridium_app` holds INSERT and SELECT only (A8). The action vocabulary is closed and lives in `@iridium/contracts/audit.ts` (enumerated in `03-data-model.md` §C.9). Operator commands: `iridium audit verify-chain [--chain]` and `iridium audit export --vault --from --to --format jsonl|csv`. Retention (`AUDIT_RETENTION_DAYS`, default 400) is implemented as export-then-archive into `audit_events_archive` (identical DDL, triggers, and grants) by `iridium audit archive` running under the migrator role — **no stored procedure**. Vault managers can see administrative actions taken inside their own vault. The high-volume `access_log` is separate, partitioned monthly by `RANGE COLUMNS(occurred_at)`, carries `note_ids JSON`, `bytes_out`, and client name and version, and is retained 90 days by dropping partitions.

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| Per-row `prev_hash` computed without a lock | Forks the chain under concurrent writers; verification then cannot distinguish a fork from tampering. The head row plus `FOR UPDATE` serialises only audit writes, and Iridium's mutation rate is low enough that this is not a bottleneck. |
| Asynchronous audit writes (queue, then persist) | An audit row can be lost while the mutation it describes is committed — the one failure mode an audit log must not have. Same-transaction writing means the mutation rolls back if the audit write fails. |
| One global chain | Every vault mutation would contend on a single head row and every export would carry every vault's history; per-vault chains keep contention and disclosure scoped. |
| A stored procedure for archiving | Introduces DEFINER semantics and `log_bin_trust_function_creators` questions in restore, for logic a CLI command expresses more testably. |
| Application-enforced immutability only | The `iridium_app` role would still technically be able to UPDATE; the triggers plus the grant make "the application physically cannot alter history" a statement a test can prove (A8's `db-grants.integration`). |
| Auditing every read into `audit_events` | Read volume would swamp the chain and slow every mutation behind it; reads go to the partitioned `access_log` (digest §11.26's split, adopted). |
| Free-form action strings | Unqueryable and untestable; a closed vocabulary in `@iridium/contracts/audit.ts` means a typo is a compile error. |

## Consequences

Positive: every audited event is atomic with the change it describes, so there are no orphan rows in either direction; tampering is detectable per chain and verification is a CLI command a customer can run; the lock order is written down, so deadlocks are a design question answered once rather than an intermittent production incident; the audit and access logs have independent retention and volume profiles. Negative: audit writes serialise per chain, so a bulk operation inside one vault (an import commit) is bounded by that chain's head lock — which is why the import commit writes one summary event with the report hash rather than one event per note; `AUDIT_HMAC_KEY` becomes restore-critical and versioned (A47 verifies key versions and A57 lists `iridium keys rotate audit`); a chain that is legitimately truncated (archive) must record the boundary so verification can start from it.

## Verification

`audit.chain.integration` (a chain verifies after thousands of concurrent mutations with no forks; an out-of-band row edit — performed as the migrator role — makes `verify-chain` fail at the exact row; the append adds under 5 ms to a mutating transaction); `db-grants.integration` (A8: `iridium_app` cannot UPDATE or DELETE `audit_events`, and the trigger fires); `lock-order.integration` (concurrent structural, trash, and persistence operations produce no deadlock over 200 randomised interleavings); `audit.trash-race.chaos` (a crash between COMMIT and the gateway side-effect leaves no loaded trashed document after restart); `audit.archive.integration` (export-then-archive preserves verifiability across the boundary); `audit.vocabulary.unit` (every emitted action is in the closed set); `access-log.integration` (partition creation ahead of time and retention drop).

## References

Digest §6.2 (audit schema conventions, append-only privileges, HMAC chaining), §11.26; spec §8; plan-enterprise graft; judges 1, 2, 3; gap fixes (lock order, trash race). Implemented in `03-data-model.md` (§C.9), `04-auth-and-access-control.md`, `11-operations-and-deployment.md`.

---

Source: docs/plan/13-decision-log.md, decision A46. This file is a faithful copy of that entry's Status, Context, Decision, Alternatives considered, Consequences, Verification and References fields; the decision log remains the authoritative, continuously-maintained record (status supersessions are recorded there first).
