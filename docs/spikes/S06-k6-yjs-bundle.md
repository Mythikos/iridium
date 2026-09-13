# S06 — k6 2.2.0 with a bundled Yjs client

## Question

Can k6 2.2.0 execute an esbuild-bundled `yjs` / `lib0` / `y-protocols/sync` script under its Sobek
engine and speak the Hocuspocus wire protocol — one virtual user completing Auth → SyncStep1 →
SyncStep2 → Update against the S2 server and recording `yjs_propagation_ms`, a second virtual user
observing the marker with a measured propagation time, and `handleSummary` emitting JSON?

## Why it blocks

Nothing structurally. M8's exit is a table of SLOs asserted as thresholds — `ws_connecting` p95
< 500 ms, `yjs_propagation_ms` p95 < 250 ms, `durable_ack_ms` p95 < 1 s, `projection_lag_ms` p95
< 12 s, MCP `get_note` p95 < 300 ms — and the tuning that comes out of them is written into
`infra/compose.prod.yaml` and `docs/ops/configuration.md` (12-milestones.md, the "Load and tuning"
row). Those numbers are only worth anything if the generator speaks the real protocol: a generator
that opens sockets without syncing measures nothing about collaboration. k6 has no Node module
resolution and no Node core APIs, so the question is whether the CRDT libraries survive a bundle at
all (R-T22). The recorded fallback is a Node `worker_threads` generator over `@iridium/collab-client`'s
`NoteClient` with hdr-histogram metrics, the same scenarios, the same metric names and the same SLOs,
which is why the impact of a failure is Low.

## Pinned versions

| Item | Version | Role |
|---|---|---|
| k6 | 2.2.0 (`commit/00a9a1b7f5`, `go1.26.5`, `windows/amd64`) | Under test. A staged binary run by path; nothing is installed system-wide |
| esbuild | 0.25.12 for the runs recorded here, from a scratch npm project outside the repository; now the catalog's 0.28.2 as a `devDependency` of `@iridium/server` (Follow-up 4) | The bundler |
| `yjs` | 13.6.32 | Bundled (`node_modules/.pnpm/yjs@13.6.32`, the one copy the lockfile resolves and the copy `@iridium/crdt` compiles against) |
| `lib0` | 0.2.117 | Bundled (`node_modules/.pnpm/lib0@0.2.117`) |
| `y-protocols` | 1.0.7 | Bundled: `sync` and `awareness` (`node_modules/.pnpm/y-protocols@1.0.7_yjs@13.6.32`) |
| `@hocuspocus/server` | 4.7.0 | The server side of the protocol under test |
| `@hocuspocus/common` | 4.7.0 | Read for the `AuthMessageType` codec; not bundled — the client re-implements the framing |
| `fastify` / `@fastify/websocket` | 5.12.4 / 11.3.0 | The real `buildApp({ mode: 'in-process', database: 'none' })` and the `/collab` mount from the S2 harness |
| `@iridium/crdt`, `@iridium/testkit`, `@iridium/contracts` | workspace | `projectMarkdown`, `CONTENT_KEY`; `buildServerEnv` / `reserveLoopbackPort`; `LIMITS.WS_MAX_PAYLOAD_BYTES` |
| k6 script modules | `k6`, `k6/execution`, `k6/metrics`, `k6/websockets` | Left external by `--external:k6*` |
| Provider version string on the wire | `4.7.0` | The trailing `varString` of the `Auth` frame; the server records it as `providerVersion` |
| `typescript` / `oxlint` | 7.0.2 / 1.82.0 | `server.ts` type-checks under `apps/server/tsconfig.json`; the harness lints clean |
| Node.js | 24.11.0 for the harness processes (`node run.mjs`, `node server.ts`); 24.21.0 under `pnpm exec` (the `mise.toml` pin) for `tsc` and `oxlint` | |
| `pnpm` | 12.4.1 | |
| OS | Windows 11 Home 10.0.26200, x64 | |

## Method

Harness: `apps/server/test/load/spikes/s06/`, with its own `README.md`. It is **not** filed beside the
S1/S2/S14 harness in `apps/server/test/spikes/`, for two reasons: `apps/server/test/load/` is where the
register places this spike's recorded fallback, so a pass and a fail land in the same directory; and
this is not a Vitest file but an esbuild bundle plus a k6 binary plus a long-lived server process, and
it must not be collected by `test/spikes/vitest.config.ts`. The server it runs against **is** the S2
server: `server.ts` imports `support/app.ts` and `support/collab-mount.ts` from `../../../spikes/`
unchanged, so the real security plugin's `onRequest` chain, the route-policy boot assertion and the
`/collab` Origin allowlist run in front of every upgrade.

```
cd apps/server/test/load/spikes/s06
S06_K6=<path to k6.exe> node run.mjs --markers 200
```

The measurements below were taken with esbuild 0.25.12 run from a scratch npm project outside the
repository, because at the time nothing in the workspace declared a bundler (Follow-up 4). That is
no longer the invocation: `esbuild`, `@types/k6`, `yjs`, `lib0` and `y-protocols` are now
`devDependencies` of `@iridium/server` at their catalog pins, `build.mjs` resolves the bundler and the
three libraries from this package, and the `k6/*` modules the binary provides are declared as
`boundaries.implicitDependencies` in `apps/server/turbo.json`.

`run.mjs` bundles, boots `server.ts` (which prints one JSON line when it is listening), runs k6 against
it, shuts the server down over stdin and writes `results/s06-run.json`. It exits with k6's exit code.

- **Bundle** — `build.mjs` calls esbuild with the register's flags, `--bundle --format=cjs
  --platform=browser --external:k6*`, plus `--target=es2022`, and writes the metafile summary to
  `results/s06-bundle-meta.json`.
- **`src/wire.js`** — the Hocuspocus framing, hand-written against `@hocuspocus/server`'s
  `MessageReceiver` and `OutgoingMessage`: `varString(documentName) varUint(MessageType) <payload>`,
  with `Sync` (0), `Awareness` (1), `Auth` (2), `SyncReply` (4), `Stateless` (5), `CLOSE` (7) and
  `SyncStatus` (8). `@hocuspocus/provider` is deliberately *not* bundled — its `EventEmitter`,
  reconnect scheduler and socket abstraction would answer a different question. What is bundled is
  exactly the three libraries the register names.
- **`src/s06-collab.js`** — three scenarios. `observer` (1 VU) connects at 0 s and stays connected;
  `probe` (1 VU) connects at 2 s, completes Auth → SyncStep1 → SyncStep2 → Update and appends 200
  markers `[[S06:<vu>:<seq>:<epochMs>]]` 25 ms apart to the note's single `Y.Text`; `origins` (1 VU) is
  the control. The observer reads `Y.Text.observe` deltas and records
  `yjs_propagation_ms = Date.now() - epochMs` for each marker; the probe records `durable_ack_ms`
  against the `persisted` stateless broadcast whose per-VU head covers each marker, and
  `iridium_sync_status_ms` against the server's per-update `SyncStatus`. Thresholds are the M8 SLOs,
  and `checks: rate==1.0` is itself a threshold, so no assertion is eyeballed.
- **`server.ts`** — the S2 server plus one extension whose `afterStoreDocument` broadcasts
  `{"event":"persisted","heads":{…},"markers":n,"bytes":n}`. Hook counts, the final document text,
  `Y.Doc.store.clients` and `Y.Doc.store.pendingStructs` come back in the shutdown line.
- **`probes/getrandomvalues.js`** — a standalone k6 script, no bundle and no server, that measures how
  much entropy `crypto.getRandomValues` writes per typed-array element.

Measurements below are five single-VU runs of 200 markers, four 20-VU runs of 50 markers, and three
20-VU runs with `--yjs-client-id` (the reproduction). Raw data: `results/s06-run-<n>.json`,
`results/s06-k6-summary-<n>.json`, `results/s06-run-vus20-<n>.json`,
`results/s06-run-vus20-yjs-clientid-<n>.json`, `results/s06-bundle-meta.json`,
`results/s06-getrandomvalues.txt`.

## Result

**pass.** k6 2.2.0 executes the bundle, speaks the protocol, and emits the summary. Every register
criterion is met, and one defect that would have silently corrupted every future load run was found and
fixed inside the harness.

**The bundle.** 267 004 bytes (260.7 KiB) from 40 modules. The only unresolved imports left in the
output are `k6`, `k6/execution`, `k6/metrics` and `k6/websockets`. Largest inputs:
`yjs/dist/yjs.mjs` 299 797 B, `lib0/schema.js` 30 563 B, `lib0/encoding.js` 26 567 B,
`lib0/decoding.js` 17 847 B, `lib0/logging.js` 9 825 B, `y-protocols/awareness.js` 9 647 B,
`y-protocols/sync.js` 4 988 B; 471 048 B of package source and 18 426 B of harness source in, one file
out. No shim, no polyfill and no `inject` was needed: `k6 inspect` evaluates the init context (module
scope, `new Trend(...)`, the scenario table) without error.

**The Sobek environment.** Present: `TextEncoder`, `TextDecoder`, `crypto`
(`getRandomValues`, `randomUUID`, `subtle`, `CryptoKey`), `BigInt`, `ArrayBuffer`, `DataView`,
`Proxy`, `Reflect`, `setTimeout`, `setInterval`. **Absent**: `performance`, `queueMicrotask`,
`structuredClone`, `btoa`, `atob`, `URL`, `AbortController`, `Intl`, `WebAssembly`. Nothing in `yjs`,
`lib0/encoding`, `lib0/decoding`, `y-protocols/sync` or `y-protocols/awareness` reached for
`performance` on any path this spike exercised. A pending `setInterval` — y-protocols `Awareness`
keeps one for its outdated-state sweep — does **not** hold a k6 iteration open: with
`awareness.destroy()` removed the probe iteration still ended in 0.7 s.

**Single-VU round trip (5 runs × 200 markers, 25 ms apart).** k6 exit 0, 18/18 checks, 0 threshold
failures, every run. Ranges are across the five runs.

| Metric | count | min | avg | med | p(90) | p(95) | max |
|---|---|---|---|---|---|---|---|
| `yjs_propagation_ms` | 200 | 0 | 1.610 – 1.775 | 2 | 2 – 3 | 3 – 4 | 4 – 7 |
| `iridium_sync_status_ms` (in-memory apply ack) | 200 | 0 | 1.580 – 1.770 | 1.5 – 2 | 2 – 3 | 3 – 3.05 | 4 – 8 |
| `durable_ack_ms` (`afterStoreDocument` broadcast) | 200 | 0 – 1 | 105.720 – 109.085 | 106 – 108 | 203.1 – 205 | 211 – 214 | 216 – 242 |
| `ws_connecting` (k6 built-in) | 5 | 1.283 – 1.908 | 6.524 – 7.191 | 6 – 7.999 | 8.815 – 10.151 | 9.088 – 10.535 | 9.088 – 10.919 |
| `iridium_ws_connecting_ms` (script-side) | 2 | 2 | 4 – 6.5 | 4 – 6.5 | 5.6 – 10.1 | 5.8 – 10.55 | 6 – 11 |
| `iridium_sync_ms` (connect → synced) | 2 | 3 | 8 – 9 | 8 – 9 | 12 – 13.8 | 12.5 – 14.4 | 13 – 15 |

`yjs_propagation_ms` is quantised to whole milliseconds: Sobek has no `performance`, so `Date.now()` is
the only clock, and 3–5 of the 200 samples per run read 0 ms. The trend's `avg` (1.61–1.78 ms) is the
sub-millisecond signal.

Frames, one run: the probe sent 204 (1 `Auth`, 1 `Awareness`, 202 `Sync` = SyncStep1 + SyncStep2 + 200
Updates) and received 428 (202 `Sync`, 201 `SyncStatus`, 23 `Stateless`, 1 `Awareness`, 1 `Auth`), with
sync sub-types `{step1: 1, step2: 1, update: 200}`; the observer received 227. Identical on all five
runs, k6 counted `ws_msgs_sent` 210, `ws_msgs_received` 655, `data_sent` 13 605 B and `data_received`
33 787 B across all three scenarios. Server-side:
`onConnect` 2, `onAuthenticate` 2, `onLoadDocument` 1, `onChange` 200, `onStoreDocument` 23,
`afterStoreDocument` 23 — the 200 updates coalesced into 23 stores by `debounce: 50` /
`maxDebounce: 200`. The final document carried all 200 markers in 5 292 B with
`Y.Doc.store.pendingStructs` empty.

**`handleSummary`.** Emitted on every run: the `results/s06-k6-summary*.json` files are its output, and
they carry the metric values above plus a `thresholdFailures` array (empty on all five single-VU runs).

**The Origin control (`origins` scenario).** A foreign `Origin` (`https://evil.example`) and an absent
`Origin` are both refused before the upgrade; the allowlisted `Origin` opens. The server log carries
exactly two `authz.origin_rejected` warnings per run, one with `originPresent: true` and one with
`originPresent: false`, and `onConnect` stays at 2 — neither refused upgrade reached Hocuspocus, which
is S2's finding re-confirmed through a different client. This is also what proves k6 puts `Origin` on
the wire at all; without it the two measuring scenarios would have been talking to a server that had
stopped checking.

**Defect found: `crypto.getRandomValues` gives 8 bits per element, so every `Y.Doc.clientID` collides.**
k6 2.2.0 writes one random **byte per element** regardless of the element width. `new Uint32Array(4)`
comes back as the raw bytes `[233,0,0,0, 126,0,0,0, 159,0,0,0, 78,0,0,0]`, and 10 000 draws of
`getRandomValues(new Uint32Array(1))` produce a maximum of **255** and exactly **256** distinct values.
`lib0/random.uint32()` is `getRandomValues(new Uint32Array(1))[0]`, and yjs's `generateNewClientId`
*is* `lib0/random.uint32`, so inside k6 every `Y.Doc.clientID` is drawn from a 256-value space: the
birthday probability of a collision is 0.533 across 20 documents and 0.960 across 40. Two documents
sharing a `clientID` write conflicting items at the same `(client, clock)`, Yjs keeps one, and the other
virtual user's edits disappear with no error on either side. Reproduced with `--yjs-client-id` at 20
probes + 20 observers on one document, 1 000 updates:

| Run | distinct `clientID`s on the document | markers in the final document | `onChange` | `pendingStructs` | Shape of the loss |
|---|---|---|---|---|---|
| 1 | 19 (for 20 writers) | 950 / 1 000 | 950 | empty | one virtual user's entire 50-marker contribution absent |
| 2 | 20 | 969 / 1 000 | 970 | empty | one client entry holds 20 of 50 items; three VUs short (34, 49, 36 of 50); 1 stray character — a marker string was split, not merely dropped |
| 3 | 20 | 999 / 1 000 | 999 | empty | one marker absent |

Every observed `clientID` was ≤ 255. `pendingStructs` is empty in all three, so this is not update
buffering: the content is gone. With the harness assigning `clientID` itself
(`CLIENT_ID_BASE + exec.vu.idInTest`, base unique per run), 4/4 runs of the same shape are lossless —
1 000/1 000 markers, 20 distinct clients, `pendingStructs` empty, 303/303 checks.

**Concurrency smoke (4 runs, 20 probes + 20 observers on one document, 50 markers each).** All content
arrives (1 000/1 000) and all 303 checks pass, but k6 exits 99 because `yjs_propagation_ms` p(95) is
1 189–1 350 ms (med 37–61 ms, max 1 500–1 720 ms), over the 250 ms SLO. That number is the generator's
own cost, not the server's: on the same runs `iridium_sync_status_ms` p(95) is 56–67 ms and
`durable_ack_ms` p(95) is 215–237 ms, and `ws_connecting` p(95) at 43 sockets is 20.8–23.5 ms. Every
one of 1 000 updates is fanned out to 39 peers, so each observer decodes ~20 000 frames, on one
document, on one laptop — M8's shape is 300 virtual users across 60 documents. The smoke's purpose was
to find out whether the bundle survives concurrency; it does, and it is not an SLO verdict.

The same 20-VU shape also measured the cost of the naive observer. An earlier revision of the script
read `Y.Text.toString()` on every incoming update instead of taking `Y.Text.observe` deltas, and
recorded `yjs_propagation_ms` p(95) **11 133 ms** (avg 3 093 ms, med 1 506 ms, max 12 993 ms) — 8×
worse than the delta version's 1 371 ms p(95) on the run immediately after the change, both before the
`clientID` fix. Re-reading the document is O(document) per frame, so the measurement becomes a
measurement of the generator.

## Decision

k6 2.2.0 is the M8 load generator: `apps/server/test/load/` grows out of this harness — `src/wire.js`
as the protocol client, `src/s06-collab.js`'s scenario/threshold/`handleSummary` shape as the lane, and
the SLO table's metric names as written — with two rules the harness now encodes and M8 must keep:
every `Y.Doc` gets its `clientID` assigned by the script, never by yjs, and propagation is measured
from `Y.Text.observe` deltas, never by re-reading the document.

## Fallback executed

n/a — the spike passed. The recorded fallback (a Node `worker_threads` generator over
`@iridium/collab-client`'s `NoteClient` with hdr-histogram metrics in `apps/server/test/load/`) is not
built. Note that the `Y.Doc.clientID` rule above applies to the fallback too if it is ever revived for
another reason: under Node it is not needed, which is precisely why it would have gone unnoticed.

## Follow-ups

1. **`crypto.getRandomValues` writes one byte per element (upstream, k6 2.2.0).** To be filed against
   `grafana/k6`: the WebCrypto contract is to fill `byteLength` bytes.
   `results/s06-getrandomvalues.txt` and `probes/getrandomvalues.js` are the reproduction. Blast radius
   beyond `Y.Doc.clientID`: `lib0/random.uuidv4()` is built on the same call, so any identifier a k6
   script mints through `lib0` carries 8 bits per draw. Until it is fixed, a k6 script must not take a
   random number from any library that routes through `getRandomValues` with a typed array wider than
   `Uint8Array`.
2. **R-T22's named risk is the wrong one.** 14-risks-and-open-questions.md says "lib0 reaches for
   `crypto` and `performance`". `performance` is indeed absent from Sobek, and nothing on the paths this
   spike exercised wants it. `crypto` is *present* — and broken as above. The R-T22 row should be
   re-scored to name the entropy width, with the mitigation being the script-assigned `clientID` rather
   than a shim.
3. **The register's module path does not exist.** In k6 2.2.0 the WebSocket module is `k6/websockets`.
   `k6/net/websockets` is not a module: importing it sends k6 into automatic extension provisioning,
   which fails with `invalid build parameters: unknown dependency : k6/net/websockets` rather than a
   plain resolution error, so the harness sets `K6_BINARY_PROVISIONING=false`.
   `k6/experimental/websockets` still resolves but logs a deprecation warning.
4. **esbuild was not reachable from the workspace.** At these pins neither `vite` 8.3.0 nor `tsdown`
   0.23.0 depends on esbuild — both bundle with `rolldown` (~1.2.6 and ~1.2.7) — and no esbuild appeared
   anywhere under `node_modules/.pnpm`, so the runs recorded here took it from a scratch project through
   `build.mjs`'s `--esbuild` / `S06_ESBUILD`. **Remedy, landed:** the M8 load lane is `apps/server`'s
   (10-testing-and-quality.md L9, D10-14), so the lane's tools are too — `esbuild` and `@types/k6` are
   `devDependencies` of `@iridium/server` at their catalog pins (esbuild 0.28.2), `build.mjs` is a plain
   `import * as esbuild from 'esbuild'`, and the scratch-project plumbing is gone. The four `k6/*`
   modules the binary provides, which no `package.json` can declare, are
   `boundaries.implicitDependencies: ["k6"]` in `apps/server/turbo.json` — `turbo boundaries` matches on
   the package root, so one entry covers `k6`, `k6/execution`, `k6/metrics` and `k6/websockets`. That
   declaration is also what clears the emitted bundle, whose `require("k6/…")` calls boundaries reads
   like any other import: it walks every file in a package, gitignored or not (a probe file under
   `dist/` and the same file under a dot-prefixed `.bundle/` were both reported), so the bundle stays in
   `dist/` — the directory oxlint and oxfmt already exclude — rather than being hidden behind an emit
   location or carrying suppressions in generated output. Re-bundled on the landed toolchain, esbuild
   0.28.2 produces the same shape as the recorded runs: the same 40 modules, the same
   `yjs` 13.6.32 / `lib0` 0.2.117 / `y-protocols` 1.0.7, the same four `k6/*` externals, 267 571 B
   against 0.25.12's 267 004 B. The measurements in this note are the 0.25.12 runs; `results/` was left
   as they wrote it.
5. **esbuild could not resolve the CRDT libraries from `apps/server`.** Under pnpm's strict layout
   `yjs`, `lib0` and `y-protocols` were `@iridium/crdt`'s dependencies and not the server's, so the
   register's flag list was insufficient on its own: the runs recorded here added
   `nodePaths: [packages/crdt/node_modules]`. **Remedy, landed:** `apps/server` declares all three as
   `devDependencies` at `catalog:`, so they resolve natively from the lane and `nodePaths` is gone.
   pnpm-workspace.yaml's `overrides` block pins each to `catalog:`, which keeps the A14 provenance
   statement exactly as strong — the bundled `yjs` is the single copy the lockfile resolves and the copy
   `@iridium/crdt` compiles against, asserted by `deps.single-instance.guard`. They are
   `devDependencies` while the load lane is the only importer in the package and move to `dependencies`
   when M1's collaboration persistence imports Yjs from product code.
6. **There is no `persisted` message in Hocuspocus 4.7.0.** 14's method for this spike asks for one.
   What the server sends per update is `MessageType.SyncStatus` (opcode 8) with `updateSaved: true`,
   emitted by `MessageReceiver.readSyncMessage` the moment `readUpdate` has applied the update **in
   memory**, before any `onStoreDocument` runs — measured here as `iridium_sync_status_ms`, p(95) 3 ms.
   A `durable_ack_ms` SLO timed against it would be meaningless: the real durability ack is a stateless
   payload the server broadcasts from `afterStoreDocument`, p(95) 212 ms, two orders of magnitude apart.
   M1's `CollabPersistence` must therefore keep the stateless `persisted` broadcast the plan already
   describes, and 11-operations-and-deployment.md's `durable_ack_ms` row should say which of the two it
   means.
7. **`Hocuspocus` has no `destroy()`.** `@hocuspocus/server`'s `index.d.ts` declares
   `destroy(): Promise<void>` on the `Server` wrapper, which Iridium never uses; the embedded
   `Hocuspocus` class exposes `flushPendingStores()`, `closeConnections()`, `getDocumentsCount()` and
   `getConnectionsCount()` instead. Teardown anywhere in the product is
   `flushPendingStores()` + `closeConnections()` + `app.close()`.
8. **`options` is rebound inside `handleSummary`.** By the time `handleSummary` runs, the script's
   exported `options` object is k6's consolidated Go-side config: `Object.keys(options.scenarios)`
   returns `getFullExecutionRequirements`, `getSortedConfigs`, `unmarshalJSON`, `validate` — the Go
   method set — not the scenario names. `options.thresholds` still reads correctly. Any M8 summary that
   wants to name its scenarios must carry the list as data.
9. **`ws_connecting` is free, and it covers refused upgrades.** `k6/websockets` emits it natively with
   sub-millisecond resolution, and it records a sample for a **rejected** handshake too (5 samples for
   2 note sockets plus the 3 control sockets), so the M8 threshold on it also guards the upgrade
   refusal path. The script-side `iridium_ws_connecting_ms` tracks it within the millisecond that
   `Date.now()` can resolve and stays only as a cross-check.
10. **`docs/plan/12-milestones.md` §4.4 and §"Load and tuning" name `apps/server/test/load/` for the
    fallback but not for the pass.** The S6 row should point at `apps/server/test/load/spikes/s06/` so
    the M8 lane is built from this harness rather than beside it.
