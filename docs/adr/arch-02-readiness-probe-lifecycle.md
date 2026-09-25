# ARCH-02: readiness probe lifecycle

Status: accepted, amended 2026-09-20; noted 2026-09-25: M3 appends the fail-closed `server_settings` check after `access_log_partitions`, so the scan has seventeen checks.

The first remote extended chaos campaigns expose two lifecycle problems. CH-16 adds up to
500 ms of database latency before starting the standby process; Fastify's default ten-second
onReady limit expires while the application performs its serial readiness scan. During a
blackhole outage, HTTP probes and five-second periodic probes start overlapping scans and
multiply borrowers waiting on the same unavailable pools.

Concurrent readiness callers now join one complete evaluation. Completion releases that
flight, including failed check outcomes, so the next request or timer performs a fresh scan.
The sixteen checks retain their order, names, thresholds and fail-closed policy. A scan that
finishes during drain cannot reopen admission. This avoids repeated work against a slow
dependency without caching a failure across later recovery probes.

The Fastify plugin/onReady timeout is explicitly 60 seconds, matching the child startup
handshake budget. It remains bounded, and the same setting applies in every server mode.
No listener opens before boot completes. A slow but reachable database can finish the real
readiness probes instead of being mistaken for a plugin that forgot to resolve its hook.
CH-16's injected latency, iteration count and 180-second case deadline are unchanged.

Noted 2026-09-25: M3 appends one check, `server_settings`, after `access_log_partitions`, so `ReadyzCheckName` has seventeen names and the fail-closed set is `migrations`, `collab_owner_lease` and `server_settings` (OPS-24, D09-11 and ARCH-10 as amended). The check performs the settings store's first load and later refreshes it inside the same one-flight evaluation. The order of the existing sixteen, their thresholds, the one-flight rule and the 60-second bound are otherwise unchanged; the text above describes the sixteen-check scan as it stood on 2026-09-20.

Verification belongs to `ops.readiness.unit`, `ops.shutdown.unit`, `readyz.integration`,
`collab.second-process-refused.chaos` and `collab.db-outage.chaos`. The remote failures and
subsequent observed results remain in [remote-ci.md](../milestones/remote-ci.md); this design
record alone is not evidence of a successful remote run.

References: [ARCH-02](../plan/02-system-architecture.md),
[Fastify pluginTimeout](https://fastify.dev/docs/latest/Reference/Server/#plugintimeout),
and [Fastify onReady](https://fastify.dev/docs/latest/Reference/Hooks/#onready).
