# A24 — Collaboration tickets: single-use 60 s tickets, batch issuance, limits sized to the connection caps

**Status:** Accepted (2026-09-11).

## Context

The WebSocket needs a credential that is not the session cookie (digest §6.2: tokens must never appear in the WebSocket URL, where they land in proxy access logs; a cross-site WebSocket handshake does not carry `SameSite=Lax` cookies, so cookies are not available to the desktop's `app://iridium` origin anyway) and not a long-lived bearer (the renderer must never hold a reusable credential, A26). Digest §11.13 records the disagreement: Topic 6 wanted single-use tickets, Topics 2 and 4 wanted a short-lived collab JWT from the provider's `token` getter. A gap all four plans shared: with ticket limits of 10–30 per minute, a user with 20 open documents who reconnects after a network blip needs 20 tickets at once and is immediately rate-limited out of their own workspace.

## Decision

A ticket is `irid_tkt_<id16>_<secret43><crc6>` (the A31 credential format, kind `tkt`), stored SHA-256-hashed in an in-process `TicketStore` (an interface; Redis later per F9), bound to `{sessionId, userId}`, with a 60 s TTL and single use. `POST /auth/collab-tickets {count: 1..50}` issues a batch so one request covers a reconnect with many open documents. Rate limits: 300 tickets/min per session and 1 000/min per IP. Re-validation runs every 15 minutes ± 3 minutes of jitter per connection with a 5-minute server-side grace before a connection that has not answered `requestToken()` is closed. The provider's `token` getter retries 3 times with backoff on 429 or network errors, so a transient ticket-endpoint failure never closes a healthy connection. The ticket travels in the Hocuspocus auth message, never in the URL. The Origin allowlist on upgrade is `PUBLIC_ORIGIN`, `app://iridium`, plus dev origins when `NODE_ENV=development`; an **absent `Origin` is 403 always** — test clients use a `ws` subclass that injects `Origin: <PUBLIC_ORIGIN>` (`@iridium/testkit`, A51), and there is deliberately no bypass environment variable.

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| Session cookie on the WebSocket | Not sent on the desktop's cross-site handshake; and a cookie that *is* sent cross-site (`SameSite=None`) is the CSWSH vector (digest §6.2). |
| Short-lived collab JWT (Topics 2/4, plan-agent-first) | A bearer the renderer holds and can replay for its lifetime; revocation then needs a denylist. A single-use ticket is revoked by being used. |
| Ticket in the WebSocket URL query string | Lands in reverse-proxy access logs (digest §6.2 explicitly forbids it). |
| 10–30 tickets/min (all four plans) | A 20-tab reconnect exhausts the budget; the limits are now sized from the A.1 connection caps (20 connections per user) with headroom for retries. |
| Multi-use tickets with a longer TTL | Replayable; single use plus batch issuance gives the same ergonomics without the replay window. |
| An `IRIDIUM_ALLOW_NO_ORIGIN_WS` escape hatch for tests | A production-reachable authentication bypass switch; the test client injects a real `Origin` header instead. |

## Consequences

Positive: no reusable WebSocket credential exists anywhere; a reconnect storm costs one HTTP request per window; the Origin rule has no exceptions, so there is nothing to misconfigure. Negative: `POST /auth/collab-tickets` is on the reconnect hot path and must be fast and highly available (it is a single indexed insert into an in-memory store); the batch count is a small amplification surface, bounded at 50 and rate-limited; the 5-minute grace means a connection whose token sync fails survives slightly longer than the sync interval suggests (deliberate, and shorter than any session TTL).

## Verification

`tickets.batch-and-limits.integration` (a second use of one ticket is rejected; a 20-document reconnect succeeds within the limits; the 301st ticket in a minute is 429; a 429 from the ticket endpoint does not close a healthy connection); `security.ws-origin.integration` (missing, foreign, and `app://iridium` origins); `collab.token-sync.integration` (15-minute re-validation with jitter, grace expiry closes).

## References

Digest §6.2 (OWASP WebSocket security, CSWSH), §2.2 (`onTokenSync`, `requestToken`), §11.13; spec §4, §8; plan-risk-first ADR-10; judges 1, 2; gap fix (batch issuance and limit sizing). Implemented in `04-auth-and-access-control.md`, `05-collaboration-and-durability.md`, `09-api-reference.md`.

---

Source: docs/plan/13-decision-log.md, decision A24. This file is a faithful copy of that entry's Status, Context, Decision, Alternatives considered, Consequences, Verification and References fields; the decision log remains the authoritative, continuously-maintained record (status supersessions are recorded there first).
