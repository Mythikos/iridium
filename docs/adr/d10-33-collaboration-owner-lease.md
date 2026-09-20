# D10-33: collaboration owner lease scope

Status: accepted, amended 2026-09-20.

**D10-33 amendment, 2026-09-17 — schema scope.** MySQL advisory-lock names are server-wide, so a constant name incorrectly excludes independent deployments and per-worker test schemas. `ownerLockName` is `iridium_collab_owner:` followed by the 43-character unpadded base64url SHA-256 digest of the canonical schema name read on the reserved connection. The complete name is 64 ASCII characters. Resolve that name through `information_schema.SCHEMATA WHERE SCHEMA_NAME = DATABASE()` so MySQL's database-name comparison rules apply. There is no caller-selected lock key or environment override. Servers using the same schema still compete for exactly one lease; separate schemas can serve concurrently. The reservation, zero wait, readiness retry, denial, and drain ordering remain unchanged. The source exposes the resolved name as `lease.lockName` for diagnostics. Acquisition failures and shutdown racing acquisition must return the reserved connection without leaving a lock held.
Source: the D10-33 amendment in [the decision log](../plan/13-decision-log.md). The acquisition and refusal protocol is owned by [the single-process ownership section](../plan/10-testing-and-quality.md#single-process-document-ownership).

## Standby product traffic

**D10-33 amendment, 2026-09-17: standby product traffic.** A serving process without the schema owner lease exposes operational endpoints but refuses product traffic, including committed REST reads, with `503 not_ready`; `/collab` retains `4503 no-owner-lease`. This supersedes the earlier allowance for committed REST reads on a standby. A second process accepting authorization mutations would update its own process-local epoch table without fencing the active owner's sockets. The one-owner deployment therefore hands all product traffic to the active owner, retries acquisition through readiness, and enables the standby only after ownership is established. Operator session-revocation commands are executed by that owner or under an exclusively acquired offline owner lease; asynchronous notification alone is insufficient for the immediate post-COMMIT write guarantee.

## Outage recovery observation

**D10-33 amendment, 2026-09-20: recovery after ownership loss.** Actions run `35478972790`,
MySQL 8.4 job `105993370481`, reaches readiness after restoring the database and saves two clients,
but the third remains in its legitimate socket retry when CH-6's 30 s deadline expires.
That deadline predates CH-6's ownership-loss exception and contradicts the accepted 5–60 s document
and 1–30 s socket ladders in 05. Preserve the 30 s recovery requirement while ownership stays valid.
For an observed owner-lease loss and automatic reattachment, the test allows 75 s from restoring
the database: the 60 s document ceiling, one 5 s readiness tick and 10 s for admission and durable
save. Socket retries proceed independently. The fixture never forces reconnection; all three
original documents and undo managers must survive, all edits must commit exactly once, and the
overall 180 s case deadline remains. This changes that acceptance deadline explicitly; it does
not change retry delays, fencing, durability, pool bounds or the intact-owner requirement.
