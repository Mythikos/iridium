# S10: Hocuspocus client identity through compaction

## Question

Do the pinned provider and server keep each live Y.Doc client ID stable through continuous compaction, acknowledgement, per-user undo, and reconnect to a restarted process?

## Why it blocks

M1's saved indicator compares the complete local state vector with an acknowledged committed vector. Changing a live client ID during compaction or reconnect would break that proof and presence ownership; rebuilding the document would also invalidate local undo history.

## Pinned versions

| Component | Version exercised |
|---|---|
| Hocuspocus server / provider | 4.7.0, with the repository's recorded server and provider patches |
| Yjs / lib0 / y-protocols | 13.6.32 / 0.2.117 / 1.0.7 |
| Fastify / @fastify/websocket | 5.12.4 / 11.3.0 |
| Node.js / Vitest | 24.21.0 / 5.0.0 |
| MySQL | 8.4.11 and 9.7.2, actual `mysql:8.4.11` and `mysql:9.7.2-oraclelinux9` containers |
| Product client | workspace `@iridium/collab-client` NoteSession, via `@iridium/testkit` |

## Method

The committed reproduction is `apps/server/test/chaos/collab.clientid-stable.chaos.spec.ts`. Run it with `IRIDIUM_MYSQL_IMAGE=mysql:8.4.11 pnpm exec vitest run --project chaos apps/server/test/chaos/collab.clientid-stable.chaos.spec.ts --maxWorkers=1` (set the environment variable separately in PowerShell).

The test starts the actual built server CLI as an OS child, seeds through public REST and CLI, and connects two real product clients. Both create their own CRDT structs before recording their client IDs. Alternating edits continue every 250 ms beyond the production 10 s maximum compaction debounce. Each observation compares text and both directions of state-vector dominance against a separate replay of MySQL snapshot and ordered update-log bytes. The database snapshot sequence must advance. Presence must retain each authenticated user under the original client ID. An isolated undo by the first editor removes its own later marker and preserves the second editor's marker. A real child restart retains both original client documents and IDs, recovers whole-vector saved, and leaves update rows attributed to both actors.

## Result

**pass** on both supported engines. On 2026-09-17 the complete connected test passed in 18.87 s on MySQL 8.4.11 and 18.38 s on MySQL 9.7.2. The measured runs are recorded in `reports/m1-chaos-aggregate-84.log` and `reports/m1-chaos-aggregate-97.log`; the earlier 8.4.11 reproduction is `reports/m1-collab-chaos-complete-84.log`. Both runs exercise the actual built server process, real persistence, original clients, continuous compaction, undo, and restart.

## Decision

Keep the same live Y.Doc and client ID across compaction and reconnect, with per-user undo intact and saved authorized only by a whole-vector committed acknowledgement.

## Fallback executed

n/a. Client-ID churn was not observed. The provider's separate close/retry and awareness forwarding defects were fixed without replacing the live document; the repository patches are documented in `patches/README.md`.

## Follow-ups

Keep this reproduction in the M1 chaos lane. Any provider, Yjs, compaction, or reconnect change must rerun it with the supported database matrix. The connected repair and committed-prefix snapshot regressions separately protect formatting repair and writes queued after a compaction barrier.
