# OPS-12: serving SQL deadlines

Status: accepted, amended 2026-09-17 and 2026-09-18.

**OPS-12 amendment, 2026-09-17: serving SQL deadlines.** `dbApp` and `dbPersist` enforce `DB_QUERY_TIMEOUT_MS` (default 10 000 ms, integer range 1 through 2 147 483 647) independently for each pool acquisition and SQL command. The mysql2 adapter destroys a connection before propagating `PROTOCOL_SEQUENCE_TIMEOUT`, removes its occupied slot and preserves that failure on subsequent commands. A late acquisition is released; idle reserved owner connections are not expired. A failed COMMIT has an unknown outcome, so the adapter does not retry it or claim rollback; saved acknowledgement and recovery continue to rely on committed replay and head-sequence checks. Maintenance and backup pools keep their separate long-running policies. The black-hole outage campaign exposed the missing bound: a TCP connection can remain open indefinitely while traffic stops, and the pinned driver's query-timeout callback does not itself destroy that connection.

Source: the OPS-12 amendment in [the decision log](../plan/13-decision-log.md). The configuration and pool contract are in [operations](../plan/11-operations-and-deployment.md#kysely-instances).

**Superseded in part, 2026-09-18.** The minimum above is now 2000 ms. Each serving connection sets both InnoDB and metadata lock waits to `floor(DB_QUERY_TIMEOUT_MS / 2000)` seconds; structural/persistence scopes only lower and restore the baseline. This makes the server lock-timeout `503 busy` response reachable before the command deadline, while preserving `503 unavailable` for uncertain outcomes. The dated amendment in the decision log preserves the prior decision and the reason for this correction.
