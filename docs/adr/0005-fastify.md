# A5 — Fastify 5 as the single HTTP host for REST, `/collab`, and `/mcp`

**Status:** Accepted (2026-09-11); the plugin-order clause is **superseded in part by AG1 (2026-09-12)**: it gains the oauth step before rest (recorded 2026-09-25), marked inline in the Decision.

## Context

One process must serve REST, the Hocuspocus WebSocket, static bundles, and the MCP endpoint on one port behind one Origin/Host policy (spec §6, §8). The digest (§5.2, §11.6) verified: Express 5.2.1 has had no release since 2025-12-01 and has no validation/OpenAPI story; Hono's Node adapter makes raw `IncomingMessage` integrations (needed for `Hocuspocus.handleConnection` and `toNodeHandler`) second-class; NestJS 12 depends on decorators, which `erasableSyntaxOnly` (A1) forbids; Fastify 5.12.4 has `@fastify/websocket` (auth in `preValidation` during upgrade, `options.maxPayload`, `injectWS()`), `fastify-type-provider-zod` 7.0.0 for zod 4, `@fastify/swagger` 9.8.1 for OpenAPI 3.1, and an official `@modelcontextprotocol/fastify` 2.0.0 adapter.

## Decision

fastify 5.12.4 with @fastify/websocket 11.3.0, @fastify/helmet 13.1.1 (CSP nonces via `enableCSPNonces`), @fastify/rate-limit 11.2.0, @fastify/cookie 11.1.2, @fastify/multipart 10.1.1, @fastify/under-pressure 9.1.0, @fastify/static (pin at M0), @fastify/swagger 9.8.1 (+ @fastify/swagger-ui 6.1.1 on `/docs`, admin or dev only), fastify-type-provider-zod 7.0.0, @modelcontextprotocol/fastify 2.0.0. `buildApp({mode})` in `apps/server/src/app.ts` is the only boot path, with plugin order config → db → security → auth → authz → audit → rest → collab → mcp → ops → jobs. **Superseded in part by AG1 (2026-09-12; recorded 2026-09-25):** the order is config → db → security → auth → authz → audit → oauth → rest → collab → mcp → ops → jobs (`02-system-architecture.md`, "Boot sequence and plugin order"). For information: the ARCH-27 amendment (2026-09-25) registers `@fastify/swagger`'s collector in `app.ts` immediately before the oauth step; that placement supersedes no clause of this decision, which never placed the collector. Every route declares `config.auth` (A30); a boot-time assertion fails the process if one does not. The server binds `127.0.0.1:4000` behind a reverse proxy (A48) with `trustProxy` set to the proxy CIDR only.

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| Express 5.2.1 | Stale; hand-wired `ws` upgrade outside the middleware tree; no schema-driven OpenAPI; the MCP SDK's own `createMcpExpressApp` still needs Host/Origin wiring by hand. |
| Hono 4.13.7 + @hono/node-server | Web-standard `Request` in handlers is elegant, but Hocuspocus and the MCP Node handler need the raw Node socket/response; those integrations become adapter special cases. |
| NestJS 12.0.1 | Decorators and DI ceremony conflict with `erasableSyntaxOnly` and the native `.ts` dev loop; a second validation model. |
| Two processes (REST vs collaboration) | Loses the shared in-memory revocation bus, tombstone set, and per-vault mutex that A23/A46 rely on; the `CollabServer` interface preserves the split for later (F9). |

## Consequences

Positive: same-port WebSocket with auth inside the plugin tree; one OpenAPI document generated from the routes; the official MCP adapter; helmet nonces feed CodeMirror's `EditorView.cspNonce`. Negative: Fastify 5's LTS table lists Node 20/22 (works on 24 in practice — pinned and tested); `@fastify/websocket` forwards `message`/`close` to `ClientConnection.handleMessage/handleClose` by hand (A17), which the M0 spike validates.

## Verification

M0 spike `docs/spikes/S02-fastify-websocket-hocuspocus.md`; `authz.route-policy.boot.guard` (every route has `config.auth`); `rest.route-index.contract`; `mcp.dual-era.contract` through the mounted route; `readyz.integration`.

## References

Digest §5.1–§5.3, §11.6, §3.2 (`toNodeHandler`), §6.2 (`trustProxy`, helmet); unanimous across plans (risk-first ADR-06, agent-first ADR-02, enterprise ADR-02, product-dx 003). Implemented in `02-system-architecture.md` and `09-api-reference.md`.

---

Source: docs/plan/13-decision-log.md, decision A5. This file is a faithful copy of that entry's Status, Context, Decision, Alternatives considered, Consequences, Verification and References fields; the decision log remains the authoritative, continuously-maintained record (status supersessions are recorded there first).
