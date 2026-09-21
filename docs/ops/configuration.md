# Configuration

*Stub seeded at M0. Not yet written — content lands with the milestone named below, drawn
from `docs/plan/11-operations-and-deployment.md`, not invented ahead of it.*

## What this document will contain

Every `IRIDIUM_*` environment key with its default, its floor (the minimum an admin-adjustable `server_settings` row may relax it to), and its effect, plus the precedence rule between an env value and a `server_settings` row — `max(env, setting)` for security-tightening knobs, the setting for the others — as enforced in `apps/server/src/config/effective.ts`.

## Source

- docs/plan/11-operations-and-deployment.md, "Effective configuration and admin-adjustable settings"
- docs/plan/12-milestones.md §12 (M8 scope)

## Argon2id parameters (`ARGON2_MEMORY_KIB`, `ARGON2_TIME_COST`)

Written early, ahead of the rest of this document, because `docs/spikes/S13-argon2-calibration.md`
measured these values before M1 built the login path against them.

The `EnvSchema` defaults for `ARGON2_MEMORY_KIB` and `ARGON2_TIME_COST` are `65536` and `3`. Those
are what the server assumes when the variables are unset, on any host — a developer machine, a CI
runner, or a production deployment that has not set them. They are not changed by this section: a
schema default applies to every one of those hosts, and only one of them is the calibration target.

The production default is set at the deployment layer instead, in `infra/compose.prod.yaml`'s
`server` service: `ARGON2_MEMORY_KIB=131072` (128 MiB), `ARGON2_TIME_COST=6`. S13 measured the
`65536`/`3` defaults at p50 47.80 ms / p95 56.45 ms on the 4 vCPU / 4 GiB reference container — well
under the 150–300 ms window `ARGON2_*` is calibrated against — and found `131072`/`6` centered in
that window: p50 **213.51 ms**, p95 **224.58 ms**.

The concurrency check matters as much as the latency: with eight logins hashing concurrently, a
`SELECT 1` probe run every 10 ms against the same MySQL host measures how much the hashing work
disturbs the event loop. At the `131072`/`6` pair, that probe's p95 was **44.52 ms** against the
50 ms threshold this project treats as the ceiling — **11 percent headroom** below it. A security
lead evaluating a heavier pair (a higher `ARGON2_MEMORY_KIB` or `ARGON2_TIME_COST` than the measured
default) should re-run S13's concurrency probe rather than assume the margin holds, because 11
percent is not a wide margin and the pair was chosen to land in the target window, not to maximise
headroom on the probe.

Both variables may be raised for a specific deployment without a code change; `iridium doctor
--argon2` (an M1+ CLI deliverable — the M0 CLI ships only `serve` and `migrate`) will warn rather
than fail when the measured latency on a given host falls outside the 150–300 ms window, since the
right pair is host-dependent (`docs/spikes/S13-argon2-calibration.md`, "Follow-ups").

## Database query deadlines (`DB_QUERY_TIMEOUT_MS`)

The M1 serving pools bound both connection acquisition and each SQL command to 10 000 ms by default. Set `DB_QUERY_TIMEOUT_MS` to a positive integer no greater than `2147483647`; `iridium config check` reports the effective value. `DB_CONNECT_TIMEOUT_MS` controls the separate initial TCP/MySQL connection timeout.

A timed-out SQL command destroys its connection before propagating the failure, freeing the pool slot and preventing another request from inheriting an unfinished command. This does not expire idle collaboration-owner reservations or impose a deadline on migration and backup operations. A COMMIT timeout has an unknown outcome: the failed attempt emits no Saved acknowledgement, and durable replay resolves the committed state on recovery.

## Projection rebuild admission (`REINDEX_RATE_PER_SECOND`)

M2 maintenance jobs and `iridium reindex` share a limit of 20 note admissions per second by default. Set `REINDEX_RATE_PER_SECOND` to a positive integer to change that rate; `iridium config check` reports the effective value. This throttles rebuild work entering the bounded projection worker pool. It does not change the worker timeout or the durability of live note updates. Rebuild jobs retain their cursor and continue after restart; see [projection-backlog.md](../runbooks/projection-backlog.md).
