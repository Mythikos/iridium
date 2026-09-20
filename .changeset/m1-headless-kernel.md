---
"@iridium/server": minor
"@iridium/api-client": minor
"@iridium/collab-client": minor
"@iridium/contracts": minor
"@iridium/crdt": minor
"@iridium/markdown": minor
"@iridium/testkit": minor
"@iridium/ui": patch
---

Add the M1 headless kernel: authenticated sessions, password setup and reset, scoped tokens, vault membership, note APIs, live permission changes, and an audited operator CLI. Collaborative edits converge through the shared client and reach Saved only after MySQL commits and the acknowledgement covers both insertion clocks and deleted ranges. The pre-release v1 acknowledgement requires its `ds` witness, so server and clients ship together. Persistence includes restart recovery, bounded queues, compaction, and a single serving owner per database.

Bound document CLOSE handshakes and grace retries so pending edits can recover after a missing reply. Preserve content U+FEFF characters after the encoding BOM is removed, and destroy refused document loads so their awareness timers cannot prevent clean shutdown.

Reject unknown initial vault members with a transactional 404 and accept both single and repeated user-status query filters.

[migration] Apply forward migrations 0049–0055 with `iridium migrate up`. The administrator mutex serializes user creation and last-administrator checks, and durable session-revocation commands execute in the serving owner, and an ownership-generation fence prevents a replaced owner from committing stale collaboration transactions; migration 0054 records actual per-table grant application or skip provenance, and 0055 seeds the client-version floor without lowering an existing operator value. Existing audit and note history is retained.

[config] Readiness now checks the active audit key, collaboration ownership, writer backlog, and database durability. Keep the configured password pepper and audit keys available, and run `iridium config check` and `iridium doctor` before serving traffic. A configured `WS_MAX_PAYLOAD_BYTES` must be positive. `DB_QUERY_TIMEOUT_MS` bounds serving-pool acquisition and SQL commands (default 10 seconds, minimum 2 seconds); serving row and metadata lock waits use the whole-second floor of half that budget, and timed-out connections are destroyed and ambiguous COMMIT outcomes are resolved through durable replay.
