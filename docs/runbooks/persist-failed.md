# Saves are failing

Never weaken durability to clear a backlog: keep `innodb_flush_log_at_trx_commit=1`, `sync_binlog=1`, and the readiness durability checks enabled. Never hand-edit note snapshots, update rows, sequence numbers, or revisions. Use the audited repair CLI for supported repairs.

## Symptoms

Users see **Save failed**, **Syncing**, or a read-only note. `IridiumPersistFailing`, `IridiumPersistBacklog`, or `IridiumWriterStuck` fires. The relevant logs carry `persist.failed`, `persist.backpressure`, `persist.cas_mismatch`, `projection.invalid_content`, or `compaction.refused` with the note ID and reason.

## What the system is already doing

The writer queues accepted updates and acknowledges only after MySQL COMMIT. Database failures keep updates in memory and retry with bounded backoff; a persist-failed notice never means those edits were committed. At the queue cap, every connection on that note becomes read-only until the backlog drops below both recovery thresholds. Other notes retain their scheduler slots. Content-invalid and oversize latches require their own correction. A sequence mismatch is a permanent refusal requiring investigation, not an automatic retry.

If the reserved MySQL ownership connection is lost, the process immediately fences its old document generation, refuses product HTTP work, and closes collaboration sockets with `4503 no-owner-lease`. Already-running transactions settle before those old documents unload; the process does not resume their queued writers under a replacement generation. Clients retain their existing Y.Doc, undo history and pending edits, then resend after the serving owner becomes available. Health, readiness and metrics remain accessible.

A projection or checkpoint failure can leave the REST projection stale while acknowledged collaboration edits remain durable. Ordinary markdown reads continue to return the last committed projection. A fresh read can refuse invalid content or unavailable capacity.

## Triage

1. Preserve affected clients and their local unsaved text. Do not restart merely to empty the writer queue: queued, unacknowledged changes may exist only in the process and the clients.
2. Read `/healthz`, `/readyz`, and authenticated `/metrics`. Check `db_connectivity`, `collab_owner_lease`, and `persist_backlog`; inspect `iridium_persist_queue_depth`, `iridium_persist_backlog_age_seconds`, `iridium_persist_writers_failed`, `iridium_persist_failures_total{reason=...}`, and `iridium_db_pool_in_use{pool=...}` against the corresponding pool sizes.
3. Correlate the affected note ID with the failure log. Record the last acknowledged sequence and the failure reason. Check database/network availability, storage free space, and the MySQL error log without changing rows.
4. If `persist.cas_mismatch` appears, check that only one collaboration process serves this schema. A standby with `collab_owner_lease` failed and `/collab` reason `no-owner-lease` is refusing ownership correctly; do not bypass its lock.
5. If only projection/compaction fails, compare ordinary markdown's ETag and stale indication with the note's acknowledged sequence. Do not classify stale projection output as loss of an acknowledged update.

## Resolution

- **db_unavailable / db_error:** restore database connectivity, storage and the documented grants. Keep the existing process alive while its queue retries. Fix the logged SQL/configuration error before expecting retries to recover.
- **collab_owner_lease / no-owner-lease:** restore the reserved connection's database path and check which process holds the schema lease. An intentional standby serves only operational endpoints. Leave pending client documents open while ownership recovers; the next owner claims a fresh durable generation after old transactions release their locks. Never change the singleton fence row or bypass the lease. Expect a new authenticated collaboration connection, followed by a committed acknowledgement covering the retained edits.
- **backpressure:** restore writer throughput and reduce the input source producing the excess. Keep the production queue bounds. Allow the queue to drain; role-derived editing resumes automatically and clients resend their still-pending state through normal authorization.
- **content_invalid:** preserve unsaved client text, arrange a controlled server stop, and run `iridium doctor --repair-content <note-id> --dry-run --json` against the same deployment configuration. Review the reported CR normalization and discarded formatting/embeds. Run the same command with `--yes --json` to commit the repair, then restart normally. The command requires the schema owner lease, writes a pre-repair checkpoint and an audited repair update, and refuses a result above the note hard cap.
- **oversize / snapshot refusal:** follow [large-note.md](large-note.md). Do not raise the safety caps or delete CRDT history manually. Preserve content for an authorized reduction or export workflow; M1 does not provide an arbitrary text-replacement HTTP endpoint.
- **cas_mismatch:** stop competing writers from accepting further work, preserve logs and backups, and follow [corrupted-document.md](corrupted-document.md). Never decrement `head_seq`, discard update rows, or force an optimistic acknowledgement.
- **note_trashed:** the server refuses late writes by design. Preserve local pending text and resolve the note's trash state through the supported product workflow.

## Verification

Wait for healthy readiness, zero failed writers, and a draining queue. On an authorized client, make a small identifiable edit and wait for **Saved**; a synced provider alone is insufficient. Open a fresh client and confirm the marker occurs exactly once. Confirm the corresponding ordinary projection catches up after compaction and that no new CAS or persist-failed event appears. A successful repair must clear content_invalid, retain a pre-repair revision and the audit event, and allow a subsequent ordinary collaborative edit.

The executable recovery evidence is `collab.durable-ack.chaos`, `collab.db-outage.chaos`, `collab.backpressure.chaos`, `collab.content-invalid.chaos`, `collab.graceful-shutdown.chaos`, and `collab.owner-lease.integration`. The CLI fault registry is test-only and must not be enabled in production.

## Follow-up

Record the failure reason, affected notes, last acknowledged sequences, database error, queue/pool readings, and corrective action. Add the observed failure boundary to the relevant connected regression before changing retry or admission behavior. Retain client exports until fresh recovery and projection verification have completed. Review capacity and database alerts; never use a larger queue or weaker durability setting to make an alert disappear.
