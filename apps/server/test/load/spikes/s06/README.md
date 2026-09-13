# Spike S6 harness — k6 2.2.0 with a bundled Yjs client

The question is in `docs/plan/12-milestones.md` §4.4 and `docs/plan/14-risks-and-open-questions.md`
("S6 — k6 with bundled Yjs"); the verdict is `docs/spikes/S06-k6-yjs-bundle.md`. Nothing here is
product code and nothing here may be imported by product code.

It lives under `apps/server/test/load/` rather than beside the S1/S2/S14 harness in
`apps/server/test/spikes/` for two reasons: `apps/server/test/load/` is where the register places the
recorded fallback (the Node `worker_threads` generator over `@iridium/collab-client`), so a pass and a
fail land in the same directory; and this harness is not a Vitest file — it is an esbuild bundle plus a
k6 binary plus a long-lived server process, and it must not be swept up by
`test/spikes/vitest.config.ts`. The server it runs against **is** the S2 harness: `server.ts` imports
`support/app.ts` and `support/collab-mount.ts` from `../../../spikes/` unchanged.

| File                | What it is                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------- |
| `src/wire.js`       | The Hocuspocus 4.7.0 wire protocol on `k6/websockets` + `yjs` + `lib0` + `y-protocols`                        |
| `src/s06-collab.js` | The k6 script: `observer`, `probe` and `origins` scenarios, the SLO trends, `handleSummary`                   |
| `build.mjs`         | esbuild: `--bundle --format=cjs --platform=browser --external:k6*` → `dist/` + `results/s06-bundle-meta.json` |
| `server.ts`         | The S2 harness server as a standalone process, plus the `persisted` stateless ack                             |
| `run.mjs`           | Bundle → boot the server → run k6 → shut down → `results/s06-run.json`                                        |

## Running it

k6 2.2.0 is a pinned binary, never a `PATH` lookup and never installed system-wide. Everything else
the lane needs is declared by `@iridium/server`: `esbuild`, `@types/k6`, `yjs`, `lib0` and
`y-protocols` are `devDependencies` at their catalog pins, so `build.mjs` resolves the bundler and the
CRDT libraries from this package and nothing is staged outside the repository. The four `k6/*` modules
the binary itself provides are declared once, as `boundaries.implicitDependencies` in
`apps/server/turbo.json`.

```
S06_K6=<path to k6.exe> node run.mjs --markers 200
```

`yjs`, `lib0` and `y-protocols` are `devDependencies` only while this lane is the one thing in
`apps/server` that imports them. They move to `dependencies` when M1's collaboration persistence
imports Yjs from product code; the `catalog:` specifiers and pnpm-workspace.yaml's `overrides` block
do not change with the move, so the single-instance invariant (A14) is unaffected either way.

`--no-build` reuses `dist/s06-collab.bundle.js`. `--vus N` runs N virtual users per scenario against
one document (the concurrency smoke; the register's shape is `--vus 1`). `--yjs-client-id` leaves
`Y.Doc.clientID` to yjs's own generator, which reproduces the k6 `crypto.getRandomValues` defect the
note records.

`run.mjs` exits with k6's exit code, so a crossed threshold is a non-zero exit (99).

## What the run asserts

Every claim is a k6 `check` or a threshold, never an eyeballed log line, and `checks: rate==1.0` is
itself a threshold so a failed check fails the run:

- `probe` — Auth → SyncStep1 → SyncStep2 → Update, a `read-write` scope, one `SyncStatus` per update
  plus one for its own `SyncStep2`, every marker acknowledged by a `persisted` broadcast, no protocol
  errors.
- `observer` — synced, every marker of every probe observed, each probe's markers in ascending order,
  the probe's awareness state received, no protocol errors.
- `origins` — a foreign `Origin` and an absent `Origin` are both refused before the upgrade while the
  allowlisted one opens, which is what proves k6 puts `Origin` on the wire at all.

Thresholds are the M8 SLO table's: `ws_connecting` and `iridium_ws_connecting_ms` p95 < 500 ms,
`yjs_propagation_ms` p95 < 250 ms, `durable_ack_ms` p95 < 1 s.

`results/` holds the measurements the note cites: `s06-bundle-meta.json` (esbuild metafile summary),
`s06-run-<n>.json` and `s06-k6-summary-<n>.json` (the three single-VU runs), `s06-run-vus20-<n>.json`
(the 20-VU smoke) and `s06-run-vus20-yjs-clientid-<n>.json` (the same smoke with the defect
reproduced).
