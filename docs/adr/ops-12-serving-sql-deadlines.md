# OPS-12: serving SQL deadlines

Status: accepted, amended 2026-09-17, 2026-09-18 and 2026-09-20.

**OPS-12 amendment, 2026-09-17: serving SQL deadlines.** `dbApp` and `dbPersist` enforce `DB_QUERY_TIMEOUT_MS` (default 10 000 ms, integer range 1 through 2 147 483 647) independently for each pool acquisition and SQL command. The mysql2 adapter destroys a connection before propagating `PROTOCOL_SEQUENCE_TIMEOUT`, removes its occupied slot and preserves that failure on subsequent commands. A late acquisition is released; idle reserved owner connections are not expired. A failed COMMIT has an unknown outcome, so the adapter does not retry it or claim rollback; saved acknowledgement and recovery continue to rely on committed replay and head-sequence checks. Maintenance and backup pools keep their separate long-running policies. The black-hole outage campaign exposed the missing bound: a TCP connection can remain open indefinitely while traffic stops, and the pinned driver's query-timeout callback does not itself destroy that connection.

Source: the OPS-12 amendment in [the decision log](../plan/13-decision-log.md). The configuration and pool contract are in [operations](../plan/11-operations-and-deployment.md#kysely-instances).

**Superseded in part, 2026-09-18.** The minimum above is now 2000 ms. Each serving connection sets both InnoDB and metadata lock waits to `floor(DB_QUERY_TIMEOUT_MS / 2000)` seconds; structural/persistence scopes only lower and restore the baseline. This makes the server lock-timeout `503 busy` response reachable before the command deadline, while preserving `503 unavailable` for uncertain outcomes. The dated amendment in the decision log preserves the prior decision and the reason for this correction.

## OPS-12 amendment: InnoDB timeout-sweep margin (2026-09-20)

The supported minimum for `DB_QUERY_TIMEOUT_MS` is now **3000 ms**. The default remains
10 000 ms, the maximum remains 2 147 483 647 ms, and serving lock waits remain
`floor(DB_QUERY_TIMEOUT_MS / 2000)` seconds. This is a pre-release configuration-boundary
correction; explicit values below 3000 are rejected rather than silently clamped.

MySQL 8.4.11 and 9.7.2 check expired InnoDB lock waits in a once-per-second sweep. A nominal
one-second lock wait can therefore be reported near two seconds, leaving no response margin
under the former two-second command minimum. Actual Actions check
[106060922722](https://github.com/Mythikos/iridium/actions/runs/35504070807/job/106060922722)
observes `PROTOCOL_SEQUENCE_TIMEOUT` instead of `ER_LOCK_WAIT_TIMEOUT` in the held audit-head
case. Its failed run and the previously passing runs remain unchanged.

The new minimum reserves one second each for the lock wait, the regular sweep, and delivery
of the refusal. Scheduler or network stalls and multiple waits may still exhaust the total
command budget; those remain `503 unavailable`, and an uncertain COMMIT is never described
as rolled back. No failure mapping, driver destruction, retry policy or test assertion is
weakened. Maintenance/backup commands and idle owner reservations retain their own policies.

`db.session-policy.unit` checks the sweep and response allowance at the minimum and other
budget boundaries; its new regression fails with zero remaining margin under the old minimum.
`config.env.unit` rejects the old range. `audit.bounded-failures.integration` and
`db.lock-timeout.integration` retain exact server 1205, transaction rollback, connection reuse,
chain verification and caller-owned exact-once retry assertions on both supported engines.

Primary implementations: [MySQL 8.4.11](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/lock/lock0wait.cc#L1353)
and [MySQL 9.7.2](https://github.com/mysql/mysql-server/blob/mysql-9.7.2/storage/innobase/lock/lock0wait.cc#L1353).
