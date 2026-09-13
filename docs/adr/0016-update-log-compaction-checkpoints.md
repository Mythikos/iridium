# A16 — Per-update append log, compaction in the same per-note FIFO, Markdown checkpoints separate from sync state

**Status:** Accepted (2026-09-11).

## Context

Spec §5 defines Saved as durable persistence; spec §8 requires recoverable checkpoints separate from the binary sync state; spec §6 requires per-note serialised persistence. The digest verified that Hocuspocus's `onStoreDocument` is debounced per document (2 000 / 10 000 ms), runs inside `document.saveMutex`, and on error only logs and returns — there is **no retry** (§2.2, §11.4), and that `SyncStatus(true)` is sent after the in-memory apply, before any store (§2.2). Topics disagreed on whether the durable write happens per update or per debounced store (§11.2) and whether Saved must also imply a Markdown checkpoint. A gap common to all four plans was that `onStoreDocument` returned before compaction finished, making `flushPendingStores()` and the post-store unload check untruthful.

## Decision

Two write paths share one per-note FIFO (`NoteWriter`, A21). (1) **Log path:** the writer coalesces a burst into one transaction, but not into one row. The batch is split into contiguous `(actor, session, origin)` **runs**, each run is merged with `Y.mergeUpdates` into one `note_updates` row (≤ 1 MiB per row, `YJS_UPDATE_MAX_BYTES`), so one COMMIT writes `seq = head+1 … head+N` and performs a **single** `head_seq` compare-and-set to `head+N`. Rows therefore scale with commits and with changes of authorship, never with keystrokes, and per-row authorship stays exact for `list_note_revisions` and for the audit trail. `head_seq = 412` means 412 update rows have committed and the note's current revision is 412 — not that 412 batches were committed — and a `persisted {seq}` after one COMMIT can advance by more than one, which a client must treat as normal rather than as a lost acknowledgement (`05-collaboration-and-durability.md` D05-01; `01-vision-scope-and-principles.md` §"Update batch"). One batch is itself capped at `WRITER_BATCH_MAX_UPDATES` (512) updates and `WRITER_BATCH_MAX_RAW_BYTES` (8 MiB) of raw update bytes so a long database stall cannot make one transaction unbounded. The transaction and the post-COMMIT `persisted` broadcast are specified in A19. (2) **Compaction path:** `onStoreDocument` (debounce 2 000 / maxDebounce 10 000 ms; 100 / 500 ms in integration tests) enqueues a compaction job into the same FIFO **and awaits it** while holding Hocuspocus's `saveMutex`, so `flushPendingStores()` and the unload check are truthful. The job captures `{stateV2, sv, throughSeq = lastCommittedSeq, markdown, sizeChars}` synchronously at the head of the queue (after every earlier row has committed), then runs one transaction in the order `03-data-model.md` §8.6 fixes: the same `note_docs d JOIN nodes n … FOR UPDATE` guard as the write transaction; `UPDATE note_docs SET snapshot = ?, snapshot_sv = ?, snapshot_through_seq = ?, snapshot_size = ?, snapshot_at = ? WHERE note_id = ? AND snapshot_through_seq < ?`; the guarded `note_projections`/`note_search`/`note_links` replacement (`WHERE revision < ?`, `<=` for idempotent re-runs); the `note_revisions` insert when the checkpoint policy fires; then **one** `UPDATE notes SET size_chars = ?, oversize = ?, content_invalid = ?, last_edited_by = ?, last_edited_at = ?, last_checkpoint_at = ?, updated_at = ?` — exactly one `notes` row lock per compaction, which is where the hostile-content verdict of A22 and the last editor the writer carried forward in memory both land (D03-14); and `note_docs.projected_seq` **last**, so a crash leaves it behind rather than ahead. After COMMIT it schedules the derived projection job (piscina, A42) and broadcasts `{t:'projected', seq}`. **Checkpoint kinds** (`note_revisions.kind`): `create`, `import`, `checkpoint` (content hash changed ∧ ≥ `vaults.auto_checkpoint_interval_min` (default 10) since the last), `unload` (last client left and no revision row exists at head — invariant: an unloaded note always has a revision at `head_seq`), `named` (Ctrl/Cmd+S), `pre_restore` (current content captured before a restore), `restore`, `trash`. **Thinning** (`jobs/revision_thinning`) applies to `checkpoint` and `unload` kinds only: keep all for 24 h, hourly for 30 d, daily thereafter; `named`, `restore`, `pre_restore`, `import`, `create` and `trash` are never thinned. **Log pruning** (`jobs/update_log_prune`): rows with `seq <= snapshot_through_seq` older than 7 days are deleted — loading never depends on pruned rows. The V2 `snapshot` blob is copied into `note_revisions.snapshot` for `named`/`restore`/`pre_restore`/`import`/`trash` rows and for `checkpoint` rows below 4 MB.

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| Full-state store per debounce with the ack in `afterStoreDocument` (digest Topics 8 and 10) | Saved latency equals the debounce (2–10 s); write amplification is the whole state per store; there is no retry to lean on. |
| Compaction outside the FIFO | An older asynchronous compaction could overwrite a newer state (spec §6 forbids exactly this); the FIFO plus the `snapshot_through_seq < ?` guard make it impossible. |
| Yjs snapshots for revisions | Need `gc: false` and grow without bound (A15). |
| A checkpoint on every compaction | Write amplification; the hash-and-interval policy bounds growth while `flush` makes the checkpoint current on demand. |
| Immediate log pruning after compaction | Loses the forensic window; 7 days is cheap because rows are coalesced. |

## Consequences

Positive: durable acknowledgement is per commit and independent of the debounce; every restore is reversible (`pre_restore`); the "checkpoint at head for unloaded notes" invariant lets `restore --verify` and `iridium doctor` check consistency; retention is bounded and named versions are permanent. Negative: the compactor holds `saveMutex` while awaiting a transaction on `dbPersist` — bounded by the FIFO and the pool size; thinning removes intermediate `checkpoint` rows, so `get_note(revision=N)` on a thinned revision answers "not retained; nearest retained: …" (A34).

## Verification

`collab.durable-ack.chaos` (kill-after-ack ×20 on PR, ×200 nightly; `store.throw`, `store.crash-before-commit`, `store.crash-after-commit-before-ack`, `store.slow:<ms>`, `compact.throw`); `collab.unload-after-veto.integration`; `collab.graceful-shutdown.chaos`; `projection.monotonic.integration`; `revisions.thinning.integration`; `revisions.restore.integration` (`pre_restore` + `restore` rows); `persistence.model.prop`; the `iridium doctor` invariant `head_seq == GREATEST(snapshot_through_seq, MAX(note_updates.seq))`.

## References

Digest §2.2 (`saveMutex`, no retry, `SkipFurtherHooksError`, `flushPendingStores`), §1.2 (`mergeUpdates`, GC), §11.2, §11.4, §11.23; spec §5, §6, §8; plan-risk-first ADR-03; plan-agent-first ADR-04; plan-enterprise ADR-07/ADR-08; plan-product-dx 007/028. Implemented in `05-collaboration-and-durability.md` and `03-data-model.md` (§C.5).

---

Source: docs/plan/13-decision-log.md, decision A16. This file is a faithful copy of that entry's Status, Context, Decision, Alternatives considered, Consequences, Verification and References fields; the decision log remains the authoritative, continuously-maintained record (status supersessions are recorded there first).
