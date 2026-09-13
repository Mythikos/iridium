# S01 — In-place V2 + V1 apply in `onLoadDocument`

## Question

Can `onLoadDocument` apply a V2 snapshot plus V1 log rows in place to `data.document` and return
`undefined`, with `afterLoadDocument` firing after the apply and before the first sync, without
Hocuspocus 4.7.0 re-applying the state (fix #1155) or the load appearing in Iridium's own `update`
listener?

## Why it blocks

Every reader and writer of `note_docs.snapshot` dispatches on `snapshot_format` through
`@iridium/crdt`'s codec (A15): the M1 loader (`persistence/loader.ts`, `hooks/persistence.ts`) applies
`loadState(document, snapshot, snapshot_format, LOAD_ORIGIN)` and then `applyV1` per row, the compactor
writes `encodeState(doc, 2)`, and migration `0014_note_docs` defaults `snapshot_format` to `2`. If the
in-place path does not hold — if Hocuspocus re-applied a returned document, if the load leaked into the
writer's `update` listener, or if `afterLoadDocument` could run before the state was in place — the
register's fallback flips one function in `packages/crdt/src/codec.ts` to V1 and edits `0014` in place
before M0 exit, which is permitted only now because no tagged schema exists yet (A7).

## Pinned versions

| Item | Version | Role |
|---|---|---|
| `@hocuspocus/server` | 4.7.0 | `onLoadDocument` / `afterLoadDocument` / `beforeHandleMessage` / `onStoreDocument` / `onChange`, `document.isLoading`, `loadingDocuments`, `openDirectConnection` |
| `@hocuspocus/provider` | 4.7.0 | The three clients per boot (workspace copy, ESM build) |
| `yjs` / `lib0` / `y-protocols` | 13.6.32 / 0.2.117 / 1.0.7 | One instance — asserted: the Hocuspocus `Document`'s base prototype is `createNoteDoc()`'s prototype |
| `@iridium/crdt` | workspace | `createNoteDoc`, `initialNoteState`, `encodeState`, `loadState`, `applyV1`, `stateVector`, `projectMarkdown`, `LOAD_ORIGIN` — the harness imports no `yjs` |
| `@iridium/testkit` | workspace | `createOriginWebSocket`, `formatMarker` / `countMarkers`, `waitFor`, `createDeferred`, `reserveLoopbackPort` |
| `fastify` / `@fastify/websocket` | 5.12.4 / 11.3.0 | The S2 mount on the real `buildApp` (`support/collab-mount.ts`) |
| `vitest` / `typescript` / `oxlint` | 5.0.0 / 7.0.2 / 1.82.0 | |
| Node.js | 24.21.0 (`mise.toml`; the runtime `pnpm exec` resolves) | |
| `pnpm` / OS | 12.4.1 / Windows 11 Home 10.0.26200, x64 (32 logical CPUs) | Timings in (f) are from this machine |

## Method

Harness: `apps/server/test/spikes/` (D12-5), run from `apps/server` with

```
pnpm exec vitest --run --config test/spikes/vitest.config.ts test/spikes/s01-onloaddocument-v2-apply.spike.spec.ts
```

- `support/stub-persistence.ts` — `CollabPersistence` as in-memory rows in the plan's shapes:
  `note_docs` (`snapshot`, `snapshot_format`, `snapshot_sv`, `snapshot_through_seq`, `head_seq`) and
  `note_updates` (`seq`, `update_v1`). `seed()` is `NoteService.initialize`: `initialNoteState(markdown)`
  gives the `seq = 1` V1 row and the first V2 snapshot (`Y.encodeStateAsUpdateV2` through
  `encodeState(doc, 2)`) with `snapshot_through_seq = 1`. `attach(document)` is the writer's
  `document.on('update')` listener: it drops `LOAD_ORIGIN` events and appends every other event's V1
  bytes as a row. `compact(noteId, 2)` snapshots at `head_seq` and prunes the covered rows, as
  `jobs/update_log_prune` would. A **shadow document** — every persisted row applied in order, never
  served — is the oracle: after a load, the served document's `stateVector` must be byte-equal to the
  shadow's and its `projectMarkdown` must equal the shadow's.
- The Hocuspocus extension of the spec: `onLoadDocument` records the hook order, attaches an *early*
  `update` listener before applying anything (to count what the apply itself emits, by origin), awaits
  `persistence.load()`, applies `loadState` + `applyV1` in place with `LOAD_ORIGIN`, compares state vector
  and text against the shadow, and returns `undefined`; `afterLoadDocument` records the order, reads
  `document.isLoading`, checks the Yjs class identity and attaches the writer; `beforeHandleMessage`,
  `connected`, `onConnect`, `onAuthenticate` record their order; `onStoreDocument` and `onChange` count
  invocations that land while the load is in progress.
- **Restart loop:** 21 boots of the real `buildApp` on one reserved port (the initial boot plus **20
  restarts**), one `Hocuspocus` instance per boot, the same stub store throughout. Per boot: three
  `HocuspocusProvider`s connect concurrently and reach `synced`; each inserts one marker line
  (`⟦c<k>:<boot>⟧\n`, from the testkit's `formatMarker`) at a different line start; the loop waits until all
  three clients hold all three markers and the writer has accepted exactly three updates; the server
  document's projection is compared with the shadow's; the clients are destroyed, the document unloads,
  the app closes. After boots 3, 7, 11, 15 and 19 the store is compacted to a V2 snapshot, so boots 4, 8,
  12, 16 and 20 load a snapshot alone and the others load a snapshot plus 3, 6 or 9 rows. Finally a
  fresh document is rebuilt from the store alone and every one of the 63 markers is counted.
- **Mid-load probe (e):** a boot whose `load()` is parked on a deferred; a first provider connects, a
  second one connects while the load is pending, then the gate opens.
- **Control:** two bare `Hocuspocus` instances driven through `openDirectConnection`: one whose
  `onLoadDocument` *returns* the V2 blob, one that applies it in place and returns `undefined`.
- **Synthetic history (f)** (`support/synthetic-history.ts`): one transaction per edit — single
  characters mostly at the end, occasional words, 6 % small deletions, deterministic PRNG — until the raw
  V1 log reaches 1 MiB; then the V1 snapshot, the V2 snapshot and `mergeV1(rows)` are sized, and loads
  are timed on fresh documents (7 samples each; 3 for the full replay), including the production shape
  "V2 snapshot at 90 % of the rows plus the last 10 % replayed".

Measurements are written to `apps/server/test/spikes/results/s01-restarts.json`, `s01-history.json`
and `s01-control.json`.

## Result

**pass.** All four tests pass (run of 2026-09-13, `Tests 4 passed (4)`, 54 s; the whole three-file harness runs in 66 s). Per criterion:

- **(a) `Y.encodeStateVector(document)` after load equals the fixture's vector** — true on 21 of 21
  boots (`svEqualAfterLoad`), and the projection equalled the shadow's on 21 of 21 (`textEqualAfterLoad`).
  Loaded shapes: boots 0, 4, 8, 12, 16, 20 loaded a V2 snapshot and zero rows; the others a snapshot plus
  3, 6 or 9 rows. The V2 snapshot grew from 63 bytes (the seed) to 1 852 bytes (seed plus 60 marker
  lines) at boot 20; `head_seq` ended at 61.
- **(b) every marker appears exactly once after 20 restarts** — 63 markers (21 boots × 3 clients), each
  found exactly once in the document rebuilt from the store alone; `countMarkers` per client is 21; the
  rebuilt projection is byte-equal to the shadow's.
- **(c) `afterLoadDocument` runs before the first `beforeHandleMessage`** — on every boot the order was
  `onConnect > onAuthenticate > onLoadDocument:start > onLoadDocument:end > afterLoadDocument > beforeHandleMessage > connected`
  (the other two connections' `onConnect`/`onAuthenticate` interleave with the single load; the relative
  order load → attach → first message held 21 of 21 times, and `afterLoadDocument` fired exactly once
  per boot). Hocuspocus queues the connection's first `SyncStep1` until `createDocument` resolves, which
  it does only after `afterLoadDocument` has been awaited.
- **(d) the `update` listener registered in `afterLoadDocument` receives zero load events and one event
  per client update** — `filteredLoadOrigin: 0` and `accepted: 3` on every boot. The early listener saw
  exactly `1 + rows` events, all with `LOAD_ORIGIN`, and `0` with any other origin, so the apply is the
  only thing that touches the document during a load; `onStoreDocument` and `onChange` fired `0` times
  during any load (Hocuspocus attaches its own `onUpdate` only after `onLoadDocument` resolves).
  Together with `document.isLoading` flipping from `true` (inside `onLoadDocument`) to `false` (inside
  `afterLoadDocument`) and (a), this is the "no re-apply" evidence: `undefined` is handed to the
  `onLoadDocument` callback, which applies only a `Doc` or a `Uint8Array` (fix #1155's shape).
- **(e) a connection arriving mid-load waits** — with the load parked, `document.isLoading === true` and
  `instance.loadingDocuments.has('note:…') === true` while `instance.documents` did not yet hold the
  name; the second provider joined the same pending promise (`persistence.loads` advanced by exactly 1
  for two connections); neither provider was `synced` 200 ms later; both synced once the gate opened,
  `isLoading` was `false`, and `afterLoadDocument` had fired once. Reported, as the row says; nothing
  needs gating.
- **(f) V2 against V1 on a 1 MiB synthetic history** (`s01-history.json`; the history is reproducible —
  seeded PRNG and a fixed `clientID`, because update sizes depend on the client id's varint width):
  50 722 transactions / rows, 71 260 characters of text; raw log 1 048 579 B; `mergeV1(rows)` 555 400 B;
  **V1 snapshot 295 900 B; V2 snapshot 183 837 B — V2/V1 = 0.6213, i.e. 1.6× smaller, not the "roughly
  an order of magnitude" A15 quotes** (an earlier run with a random client id measured 0.5713 on a
  46 194-row history; the ratio sits in that band). Load p50 / p95 on fresh documents: V1 snapshot
  11.21 / 25.15 ms; V2 snapshot 9.18 / 37.89 ms; merged V1 log 96.39 / 98.94 ms; replaying all 50 722
  rows 337.24 / 344.66 ms; V2 snapshot at 90 % plus 5 073 tail rows (106 777 B) 57.25 / 73.85 ms. Both
  snapshots load to the same state vector, and the V2 load and the V2-plus-tail load both project the
  same text as the source document.
- **Control** (`s01-control.json`): returning the V2 blob from `onLoadDocument` was **not rejected** by
  Hocuspocus — it `applyUpdate`ed the V2 bytes with the V1 decoder and produced an **empty document**
  (`text: ''`), silently. Applying in place and returning `undefined` produced `'control text\n'` with a
  state vector equal to the fixture's. The plan's "return `undefined`, never bytes" is load-bearing and
  the failure mode is silent, not loud.
- The Hocuspocus `Document` and `createNoteDoc()` share one `Y.Doc` prototype (`sameYjsClass: true` on
  every boot), so the codec's `loadState` operates on Hocuspocus's document without a second Yjs copy.

## Decision

`snapshot_format` stays `2`: `onLoadDocument` applies `loadState(document, snapshot, 2, LOAD_ORIGIN)`
then `applyV1(document, row, LOAD_ORIGIN)` per row in place and returns `undefined`, `afterLoadDocument`
attaches the writer and its `LOAD_ORIGIN`-filtering `update` listener, and migration `0014_note_docs`
is left as written.

## Fallback executed

n/a

## Follow-ups

- **A15's size claim re-scored:** on a typing-shaped history with `gc: true`, V2 is 1.6–1.75× smaller
  than V1, not ~10×. V2 stays the right choice (smaller, marginally faster to load, and the log still
  dominates: the merged V1 log is 3.0× the V2 snapshot and the raw log 5.7×), but the M8 storage and
  compaction budgets should use the measured ratio; S11 can re-measure it on the pilot corpus, where the
  ratio may differ.
- Narrow Iridium's `onLoadDocument` hook signature to `Promise<void>` (as 05 already says): 4.7.0 still
  applies a returned `Doc`/`Uint8Array` with V1 `applyUpdate`, and the control shows the result is an
  empty document rather than an error.
- `document.isLoading` and `instance.loadingDocuments` are the observable states for "a connection
  arriving mid-load waits"; M1 needs no admission logic of its own for that case.
- Hocuspocus 4.7.0 fires `connected` after the connection's first queued message is handled (see S02's
  follow-ups) — irrelevant to persistence, relevant to the participants broadcast.
- 05-collaboration-and-durability.md still names this spike `spike-onloaddocument-v2` with the file
  `docs/spikes/onloaddocument-v2.md`; the register's id is S1 and the file is this one.
- Tests to keep from this harness at M1: `collab.restart-no-duplication` (the restart loop with the real
  persistence), the mid-load case, and the "returned blob" control as a guard on the hook's return type;
  then delete `apps/server/test/spikes/` (D12-5).
