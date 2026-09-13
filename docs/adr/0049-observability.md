# A49 — Logging, metrics, and health: pino JSON with redaction, prom-client, liveness plus fail-closed readiness, alert rules

**Status:** Accepted (2026-09-11).

## Context

Spec §8 requires operational logging that excludes credentials and unnecessary document content, plus health checks. Digest §6.2 records the OWASP logging requirements (when, where, who, what on every event; always log authentication successes and failures, authorization failures, session events, and administrative actions; never log session ids, tokens, passwords, keys, or connection strings; add tamper detection and copy logs to read-only storage) and confirms pino 10.3.1's `redact` supports paths such as `req.headers.authorization` and `req.headers.cookie`. The readiness question is the sharp one: a process that accepts traffic while migrations are pending, or while `innodb_flush_log_at_trx_commit` is not 1, will violate the durability contract of A19 while reporting healthy.

## Decision

pino 10.3.1 with `redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]', '*.password', '*.token', '*.secret', '*.markdown', '*.update']`, request ids (honouring `X-Request-Id` behind the proxy), principal **ids only** (never names or emails in log bodies), and named SIEM events: `auth.login.*`, `authz.denied`, `collab.connection.*`, `collab.write.rejected`, `persist.failed|recovered`, `projection.timeout`, `mcp.call`, `job.*`, `backup.*`, `migration.*`. Hocuspocus runs with `quiet: true`. A `logging-redaction.integration` greps captured log output for fixture markers (a known password, a known token, a known note body) and fails if any appears.

`/healthz` reports process liveness and event-loop lag under 1 s. `/readyz` returns a JSON checklist and **fails closed**: both pools ping; `migrations: current` (a pending migration is a hard failure); `innodb_flush_log_at_trx_commit == 1` (a hard failure when `READYZ_STRICT_DURABILITY=true`, otherwise a warning); the attachment store is writable; the writer backlog age is under 30 s with no writer `failed` for more than 60 s (A21); the loaded-document budget is under 100 % (warning at 80 %, A50); the worker pool is responsive; clock skew is under 30 s. During shutdown drain it returns 503.

`/metrics` (guarded by a `METRICS_TOKEN` bearer or an internal CIDR; `@prometheus-io/client` 0.16.1 — `prom-client` is deprecated in favour of it and every mention of that name in this decision means the successor, spike S8, 2026-09-13) exposes `iridium_http_requests_total{route,status}`, `iridium_http_duration_seconds`, `iridium_ws_connections`, `iridium_docs_loaded`, `iridium_persist_latency_seconds`, `iridium_persist_failures_total`, `iridium_persist_queue_depth`, `iridium_persist_backlog_age_seconds`, `iridium_compactions_total`, `iridium_note_state_bytes`, `iridium_projection_duration_seconds{status}`, `iridium_projection_timeouts_total`, `iridium_mcp_calls_total{tool,status}`, `iridium_mcp_factory_errors_total`, `iridium_mcp_rate_limited_total`, `iridium_tokens_active`, `iridium_jobs_total{type,status}`, `iridium_backup_last_verified_timestamp`, `iridium_audit_chain_verified_timestamp`, `iridium_login_failures_total`, and `iridium_db_pool_in_use{pool}`. A Grafana dashboard JSON and alert rules live in `infra/monitoring/`: persist failures above zero for 5 minutes, backlog age over 30 s, a snapshot over 8 MB, a projection timeout rate over 1 %, `/readyz` failing, a backup verified more than 26 hours ago, and a loaded-document budget over 80 %. `@fastify/under-pressure` provides load shedding.

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| Unstructured or text logs | Not machine-parseable for SIEM ingestion, and redaction cannot be asserted mechanically. |
| Logging note content or update payloads for debugging | Spec §8 excludes unnecessary document content; the `*.markdown` and `*.update` redaction paths plus the grep test make it structurally hard to add by accident. |
| Advisory-only readiness (always 200) | A pod or container would take traffic with pending migrations or with `innodb_flush_log_at_trx_commit != 1`, breaking A19's durability guarantee while reporting healthy. |
| OpenTelemetry tracing in the MVP | Valuable, but it adds a collector to a single-node deployment; request ids plus the named events cover the operator's diagnostic need, and the logging shape is OTel-compatible later. |
| Unauthenticated `/metrics` | Exposes operational detail (document counts, token counts, failure rates) to anyone who can reach the port. |
| Logging user names and email addresses | Increases the personal-data footprint of logs for no diagnostic gain; ids resolve through the database when needed. |

## Consequences

Positive: one operator checklist (`/readyz`) answers "is this instance safe to serve?" including the durability setting; redaction is tested rather than reviewed; every alert rule corresponds to a metric that already exists. Negative: fail-closed readiness means a mis-set `innodb_flush_log_at_trx_commit` blocks startup in strict mode — intended, and the reason the flag exists for operators who consciously accept the risk; `/metrics` needs a token or network policy, which is one more deployment setting; the redaction path list must be extended whenever a new secret-bearing field name appears (covered by the grep test).

## Verification

`logging-redaction.integration` (A51: it boots with a pino destination captured in memory, exercises login, token use, a collaboration session, an import and an error path, then scans every line for the `irid_[a-z]{3}_` credential regex, `Bearer `, `Cookie`/`Set-Cookie`, the fixture note's unique marker and a base64 prefix of a known Yjs update — it needs a live database and socket, so it is an integration test rather than a guard); `readyz.integration` (each checklist item can be individually failed and produces a 503 with the failing key; strict durability behaviour both ways); `healthz.integration` (event-loop lag threshold); `metrics.integration` (every named metric is present after exercising its code path; the guard rejects an unauthenticated scrape); `ops.alerts.unit` (each alert rule's expression evaluates against a recorded metric fixture); shutdown drain test (503 during drain, in-flight requests complete within the 20 s budget of A.1).

## References

Digest §6.2 (OWASP logging, pino redaction), §5.2 (`@fastify/under-pressure`), §10.2; spec §8; plan-risk-first and plan-enterprise. Implemented in `11-operations-and-deployment.md`.

---

Source: docs/plan/13-decision-log.md, decision A49. This file is a faithful copy of that entry's Status, Context, Decision, Alternatives considered, Consequences, Verification and References fields; the decision log remains the authoritative, continuously-maintained record (status supersessions are recorded there first).
