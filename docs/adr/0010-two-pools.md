# A10 — mysql2 with two Kysely instances: `dbApp` and `dbPersist`

**Status:** Accepted (2026-09-11).

## Context

The persistence writer's transactions are the "Saved" path (A19). If REST/MCP bursts exhaust a shared pool, saves queue behind reads and the truthful ack becomes slow or fails. Digest §5.2 verified mysql2 defaults: `FOUND_ROWS` in the client flags (so `affectedRows` counts matched rows — required for `WHERE version=?` CAS), `jsonStrings: false`, `supportBigNumbers: false` by default, `connectionLimit 10`.

## Decision

mysql2 3.24.4. Two Kysely instances over two pools: `dbApp` (`connectionLimit 20`; REST, MCP, jobs) and `dbPersist` (`connectionLimit 4`; reserved for `NoteWriter` transactions and compaction). Both pools set `supportBigNumbers: true`, `jsonStrings: false`, and the default `FOUND_ROWS` flag is asserted at boot (the CAS code relies on `numUpdatedRows === 1n` meaning "matched one row"). Pool sizes are `DB_POOL_APP` / `DB_POOL_PERSIST` env values; the persist pool size is also the global persistence concurrency (A21).

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| One pool | REST bursts starve saves; no way to bound persistence concurrency independently. |
| Separate process for persistence | Loses the in-process `saveMutex`/writer coordination with Hocuspocus (A17); the interface seam (`CollabPersistence`) keeps the option. |

## Consequences

Positive: save latency is isolated from read traffic; `iridium_db_pool_in_use{pool}` makes starvation visible. Negative: two pools count against `max_connections=200`; `/readyz` must ping both.

## Verification

`readyz.integration` (both pools pinged); `collab.backpressure.chaos` and the k6 SLO `durable_ack_ms p95 < 1 s` under REST load; a boot assertion test for the `FOUND_ROWS` flag.

## References

Digest §5.2 (mysql2 defaults, Kysely dialect); all plans (risk-first ADR-08). Implemented in `02-system-architecture.md` and `03-data-model.md`.

---

Source: docs/plan/13-decision-log.md, decision A10. This file is a faithful copy of that entry's Status, Context, Decision, Alternatives considered, Consequences, Verification and References fields; the decision log remains the authoritative, continuously-maintained record (status supersessions are recorded there first).
