# A15 — Yjs state storage: V2 compacted snapshot plus V1 append log, applied manually

**Status:** Accepted (2026-09-11); amended 2026-09-13 by spike S1 (`docs/spikes/S01-onloaddocument-v2-apply.md`, pass): the in-place apply and the `afterLoadDocument`/`isLoading` semantics are confirmed and the fallback is not taken, but the size advantage measures 1.6–1.75×, not the order of magnitude the Context quotes from yjs #675. The decision is unchanged; the budgets that cite the ratio are not.

## Context

Digest §11.1 records the sharpest disagreement among the research topics. Topic 1 recommends storing the compacted state as V2 (`Y.encodeStateAsUpdateV2`, ~95 % smaller — yjs #675 measured 8,969,403 bytes V1 → 452,346 bytes V2) with the wire log kept V1; Topics 2 and 5 recommend V1 everywhere because Hocuspocus, y-protocols and `Y.mergeUpdates` are V1-native and "mixing Yjs V1 and V2 encodings corrupts merges". Facts both sides agree on: y-protocols is V1-only on the wire; Hocuspocus's `onLoadDocument` applies a returned `Uint8Array` with V1 `applyUpdate`; `@hocuspocus/extension-database` is V1 full-state; `mergeUpdates` never garbage-collects, so compaction must load into a `Y.Doc` regardless of format (§1.2). Two of the three judge panels chose V2 snapshots (plan-risk-first ADR-04, plan-enterprise ADR-05) over the V1-everywhere position (plan-agent-first ADR-06, plan-product-dx 006).

## Decision

`note_docs.snapshot` holds `Y.encodeStateAsUpdateV2(doc)` with `snapshot_format = 2` and `yjs_major = 13`; `note_updates.update_v1` holds the wire bytes exactly as applied (`yjs_major = 13`). `onLoadDocument` applies `applyUpdateV2(snapshot)` then `applyUpdate(update_v1)` for every row with `seq > snapshot_through_seq` in `seq` order, mutating `data.document` in place, and **returns `undefined`** — never bytes, so Hocuspocus's V1 return path is never used. The codec lives in one module of `@iridium/crdt` with branded `V1Update`, `V2State` and `StateVector` types, so passing a V2 blob to a V1 function is a compile error. The M0 spike `docs/spikes/S01-onloaddocument-v2-apply.md` confirms the in-place apply and the `afterLoadDocument`/`isLoading` semantics on Hocuspocus 4.7.0; its recorded fallback is V1 snapshots behind the same `snapshot_format` column (one function change in the codec, no schema change). `note_revisions.snapshot` uses the same codec and columns (`snapshot_format`, `yjs_major`, `snapshot_sv`).

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| V1 everywhere with a `yjs_format` column (agent-first, product-dx, judge 1) | Up to 20× larger snapshots multiply backup size, load time and resident memory for every note, revision and restore; the "one encoding" simplicity is largely illusory because the codec must exist anyway for compaction. |
| Return merged bytes from `onLoadDocument` (`Y.mergeUpdates([snapshot, ...updates])`) | Forces V1 snapshots and never GCs; the Hocuspocus 4.7.x return path is also the one fixed by #1155 ("skip the document self-apply") — in-place apply avoids it entirely. |
| Yjs snapshots (`Y.snapshot`) for history | Require `gc: false`; growth is unbounded; history comes from `note_revisions` instead (A16). |

## Consequences

Positive: backups, restores and loads scale with content rather than tombstones; compaction (which loads into a `Y.Doc` anyway) produces a GC'd, small state; `yjs_major` marks every blob for a future v14 migration. Negative: V2 encoding is roughly twice as slow as V1 (yjs #675) — acceptable at compaction cadence; the spike is a hard M0 gate (passed 2026-09-13), and it measured the size advantage at 1.6–1.75× rather than the ~95 % the Context quotes from yjs #675, so the storage and compaction budgets are sized from the measurement rather than from the issue; readers of the log must never treat `update_v1` and `snapshot` interchangeably (enforced by the branded types).

## Verification

M0 spike `docs/spikes/S01-onloaddocument-v2-apply.md` (pass, or fallback executed and recorded); `persistence.model.prop` (fast-check model: random update sequences persisted, compacted at random points, reloaded — the reloaded `toString()` equals the model); `collab.restart-no-duplication.integration` (spec §9 row "Initialization/reconnection"); `collab.initial-state-only-path.guard`; `restore --verify` sample-loads snapshots and compares hashes (A47).

## References

Digest §1.2 (encoding API, #675, `mergeUpdates` never GCs), §2.2 (`onLoadDocument` return handling, #1155), §11.1; plan-risk-first ADR-04; plan-enterprise ADR-05; judges 2 and 3. Implemented in `03-data-model.md` (§C.5) and `05-collaboration-and-durability.md`.

---

Source: docs/plan/13-decision-log.md, decision A15. This file is a faithful copy of that entry's Status, Context, Decision, Alternatives considered, Consequences, Verification and References fields; the decision log remains the authoritative, continuously-maintained record (status supersessions are recorded there first).
