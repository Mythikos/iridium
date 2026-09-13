# A23 — Live revocation: version columns, an in-process bus, a collaboration gateway, epoch checks, no caches

**Status:** Accepted (2026-09-11).

## Context

Spec §4 is explicit: "Revoking access or downgrading a role must affect already-open sessions, not just the next login. The server must stop unauthorized future reads/writes and disconnect or reauthorize affected collaboration sessions." Spec §9 makes it an acceptance row ("Live revocation"). The difficulty is that three credential kinds and two long-lived surfaces are involved at once: a cookie session doing REST, a WebSocket connection that was authorized at upgrade and may live for hours, and a PAT that an agent presents per call. Digest §6.2 records the OWASP requirements that drive the design — authorize every WebSocket *message* and not just the connection, close all of a user's sockets on logout or session expiry, rotate tokens on long-lived connections, deny by default, validate permissions on every request through centralized middleware — and the Hocuspocus 4.7.0 primitives that make it possible: `connection.readOnly`, `onTokenSync` with `connection.requestToken()`, `Hocuspocus.closeConnections(documentName?)`, `hocuspocus.documents`, `document.connections`, and `@hocuspocus/common` `CloseEvents` (Unauthorized = 4401). Three of the four source plans proposed a short-TTL principal cache (15–30 s) to keep per-request cost down; that cache is exactly a 30-second window in which a removed member keeps reading, which the acceptance row forbids. A judge review also found a weakness in the first formulation: collapsing `users.authz_version` and `vault_members.version` into one summed integer makes two independent changes cancel out.

## Decision

Versioned rows plus an after-COMMIT bus plus an enforcement gateway, with no authorization cache in the MVP.

1. **Version columns.** `users.authz_version INT UNSIGNED` is bumped when the user is disabled, their password changes, an administrator revokes their sessions, or any `vault_members` row for that user is inserted, updated, or deleted. `vault_members.version INT UNSIGNED` is bumped on a role change (it is also the `If-Match` ETag source for membership routes, A13).
2. **`AuthzBus`.** An interface (`apps/server/src/authz/bus.ts`) with an in-process implementation for the MVP and a Redis implementation as the recorded post-MVP path (F9). It publishes **after COMMIT**, never inside the transaction: `user.disabled`, `user.password_changed`, `session.revoked`, `token.revoked`, `membership.removed`, `membership.role_changed`, `vault.archived`, `note.trashed`, `note.purged`.
3. **`CollabGateway`.** Subscribes to the bus and iterates `hocuspocus.documents` → `document.getConnections()`. Membership removal, user disable, or session revocation close every `note:*` and `vault:*` connection belonging to that user or session with `connection.close({code: 4403, reason: 'revoked'})`. A role downgrade or upgrade follows A20 instead of closing. A vault archive closes the vault's connections with reason `vault-archived`. A note trash or purge closes that note's document.
4. **Epoch check per message.** Every connection carries `authzEpoch = {userAuthzVersion, memberVersion}` — **a tuple, never a sum**. `beforeHandleMessage` compares the tuple with the in-process epoch table and re-evaluates from the database on any mismatch, applying the result (close, `readOnly` flip, or continue) before the message is handled.
5. **Token re-validation.** `onTokenSync` is driven by `connection.requestToken()` every 15 minutes ± 3 minutes of jitter per connection (A24 sizes the ticket economy for it).
6. **Per-request evaluation.** REST costs two indexed lookups per request (the session row, then the membership row). MCP costs a fresh `access_tokens` row read plus a membership read per request. There is **no principal or PAT cache in the MVP**; the `PrincipalResolver` interface permits a version-checked cache later, and the version columns are precisely what such a cache would validate against.

Acceptance: closure within 1 s of COMMIT, a reconnect attempt refused, and the next MCP call failing.

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| 15–30 s TTL principal cache (three of four source plans) | A bounded window in which a removed member still reads is still a violation of spec §4 and of the "Live revocation" acceptance row. Two indexed lookups on a single-process MVP are the cheaper correctness. |
| Rely on the next login / next connect | The literal text of spec §4 rejects it. |
| Single summed `authz_version` integer on the connection | A membership upgrade and a user-version bump can net to the same number; the tuple cannot collide. |
| Polling the database from each connection on a timer | Latency floor equal to the poll interval, plus N queries per tick; the bus is exact and free in-process. |
| Re-authorizing only at `onAuthenticate` | The connection outlives the decision; OWASP requires per-message authorization on WebSockets (digest §6.2). |

## Consequences

Positive: revocation is exact, not eventual; the same mechanism serves sessions, tokens, and sockets; the bus boundary is the only thing that has to change for multi-process deployment (Hocuspocus ships `@hocuspocus/extension-redis` 4.7.0 for the document fan-out side). Negative: two extra indexed reads on every REST request and per MCP call (measured in the k6 budgets, and the reason `dbApp` has a pool of 20 — A10); the in-process bus makes single-process a correctness assumption for the MVP, which F9 documents and the interface contains; `beforeHandleMessage` does real work on the hot path, so the epoch table lookup must stay a map read.

## Verification

`collab.live-revocation.integration` (membership removal, role downgrade, user disable, and session revoke each close the socket within 1 s of COMMIT and refuse the reconnect); `mcp.revocation.mcp` (next MCP call fails after revoke); `collab.epoch-tuple.prop` (property test: no pair of independent version changes produces an equal tuple); `authz.seams.unit` (a grep guard test asserting no principal memoisation outside the interface); k6 `durable_ack_ms` and `get_note` SLOs hold with per-request evaluation.

## References

Digest §6.2 (OWASP WebSocket and authorization guidance, Hocuspocus hooks), §2.2, §11.15; spec §4, §9; plan-risk-first ADR-12; plan-enterprise ADR-11; judge weakness fix (tuple). Implemented in `04-auth-and-access-control.md` and `05-collaboration-and-durability.md`.

---

Source: docs/plan/13-decision-log.md, decision A23. This file is a faithful copy of that entry's Status, Context, Decision, Alternatives considered, Consequences, Verification and References fields; the decision log remains the authoritative, continuously-maintained record (status supersessions are recorded there first).
