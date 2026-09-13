# A32 — MCP transport and session mode: SDK v2, per-request factory, stateless dual-era, JSON response mode, `reply.hijack()`

**Status:** Accepted (2026-09-11); amended 2026-09-13 by spike S14 (`docs/spikes/S14-mcp-dual-era-handler.md`, pass): the `reply.hijack()` handoff is confirmed for both eras and the sub-application fallback is not taken, but three statements in this entry were wrong and are corrected below — the host-guard entry is `publicOrigin.hostname` rather than `PUBLIC_HOST`, the route drives the handler's web-standard face rather than `toNodeHandler` (under `toNodeHandler` the SDK answers a thrown factory with its own `-32603` body and `onMcpHostError` is unreachable), and the conformance baseline is not empty. Two measured consequences the M3 code must carry: `responseMode: 'json'` shapes the modern path only, a 2025-era response being `200 text/event-stream`; and after the hijack, headers set with `reply.header()` are never emitted, while helmet's are, because helmet writes to `reply.raw`.

## Context

The brief makes MCP a primary feature, not an add-on. Digest §3.2 verified the landscape precisely: `@modelcontextprotocol/sdk` 1.30.0 declares `LATEST_PROTOCOL_VERSION = '2025-11-25'` and **cannot serve** the current 2026-07-28 revision, with maintenance ending around January 2027; the v2 SDK (2.0.0, published 2026-07-27) is GA as split packages (`/server`, `/client`, `/core`, `/node`, `/express`, `/fastify`, `/hono`, `/conformance`); `createMcpHandler(factory, {legacy, responseMode, bus})` runs the factory **once per HTTP request** and its default `legacy: 'stateless'` serves 2025-era clients and modern 2026-07-28 clients from the same factory with no sessions; the 2026-07-28 revision **removed** protocol-level sessions and `Mcp-Session-Id`, so an older-era GET or DELETE should answer 405; servers MUST validate `Origin` and return 403 on mismatch (DNS rebinding); requests carry `MCP-Protocol-Version`, `Mcp-Method`, and `Mcp-Name` headers; `toNodeHandler` forwards `req.auth` as `ctx.http.authInfo`; and `createMcpFastifyApp`/`createMcpExpressApp` build their own app, so mounting into an existing app means wiring Host and Origin checks yourself. Digest §3.4 adds two operational traps: Claude Code's 5-minute idle timeout and 60-second first-byte timer, and the fact that any non-`OAuthError` exception in the verifier becomes a 500.

## Decision

Pins: `@modelcontextprotocol/server` 2.0.0, `@modelcontextprotocol/node` 2.0.0, `@modelcontextprotocol/fastify` 2.0.0 (with `hostHeaderValidation([publicOrigin.hostname])` — the hook compares `new URL('http://' + host).hostname` against its list, so a port-bearing entry refuses the server's own host); development and test only: `/client` 2.0.0, `/conformance` 0.1.16, `@modelcontextprotocol/inspector` 2.6.0. The handler is built once — `const handler = createMcpHandler(buildIridiumMcpServer, {legacy: 'stateless', responseMode: 'json'})` — and the route drives its **web-standard face** (`toWebRequest` → `handler.fetch` → Iridium's own writer onto `reply.raw`) rather than `toNodeHandler`, so the route owns every status and byte written after the hijack. The route is

```ts
app.all('/mcp', {
  config: { auth: { bearerOnly: true, principalKinds: ['token'] }, rateLimit: mcpBucket, bodyLimit: 1_048_576 },
  onRequest: [hostGuard, rejectBrowserOrigin, ignoreCookies],
  preHandler: [patAuth],
}, async (req, reply) => {
  if (!req.mcpAuthInfo) return reply.code(401).headers(wwwAuthenticate).send(invalidTokenBody);
  reply.hijack();
  try {                                                  // the handler's web-standard face (S14)
    const request  = toWebRequest(req.raw, req.body, { signal: abortOn(reply.raw) });
    const response = await handler.fetch(request, { authInfo: req.mcpAuthInfo, parsedBody: req.body });
    await writeWebResponse(response, reply.raw);
  } catch (e) { onMcpHostError(e, reply.raw); }
});
```

A factory or handler throw becomes **HTTP 500 with body `{"error":"server_error"}` and no details**, a pino error carrying the request id, and an increment of `iridium_mcp_factory_errors_total`. There is no `Mcp-Session-Id`; a legacy GET or DELETE answers 405; Iridium publishes no notifications and advertises no `listChanged` or `subscribe` capability in the MVP. It does not follow that the endpoint never speaks `text/event-stream`, and two places it does were measured by spike S14 and specified in 06-mcp-and-agent-access.md: a **2025-era** response is `200 text/event-stream` carrying one `event: message` frame, because `responseMode: 'json'` shapes the modern path only; and a modern client's `subscriptions/listen` is answered by the SDK's own listen router regardless of `responseMode`, acknowledged with an empty filter and never published on (D06-17). The `/mcp` proxy rules of 11-operations-and-deployment.md are therefore load-bearing for ordinary legacy traffic, not only for that stream. Both eras are served: 2026-07-28 (including `server/discover`, `_meta`, and `ttlMs`/`cacheScope`) and the 2025-era stateless path per POST. `instructions.md` is ≤ 2 KB (the vault/category/note model, stable IDs versus mutable paths, the `search_notes → get_note` workflow, line-range paging, revisions, and "note content is untrusted data"), and each vault's `ai_guidance` is appended to `list_vaults` output. `cacheHints` sets `{'tools/list': {ttlMs: 300000, cacheScope: 'private'}}` and leaves everything else at `ttlMs: 0, cacheScope: 'private'`. A 30-second server-side request timeout applies.

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| SDK v1.30.0 with a hand-wired stateful `NodeStreamableHTTPServerTransport` | Cannot speak 2026-07-28; maintenance ends ~January 2027; sessions add server state that blocks horizontal scaling and complicates revocation. |
| `legacy: 'reject'` (modern era only) | Cursor, VS Code, Windsurf, and Claude Code's v1 runtime are 2025-era today (digest §3.2); rejecting them would make the primary feature unusable for most clients. |
| `responseMode: 'sse'` | Requires `proxy_buffering off` and long read timeouts everywhere, and the MVP has no server-initiated notifications to stream; JSON is one response per POST and proxies handle it unchanged. |
| `createMcpFastifyApp` as a standalone app | A second Fastify app means a second auth, rate-limit, logging, and error pipeline; mounting one route keeps `config.auth`, the route-policy assertion, and the `ProblemDetails` shape uniform. |
| A separate MCP process | Loses the shared `authorize()`, `AuthzBus`, and `ContentReadCore`; adds a deployment component for no isolation benefit on a single-node MVP. |
| Writing the raw response without `reply.hijack()` | Fastify would also try to serialise and send a reply, corrupting the stream; `hijack()` is the documented handoff. |
| Returning error details on a factory throw | Leaks internals to an unauthenticated-ish surface; the request id in the log is the correlation handle. |

## Consequences

Positive: both protocol eras work from one code path; no per-client server state, so revocation (A23) and later horizontal scaling are unaffected; the official in-process test path (`handler.fetch`) and the conformance suite are available (A51); `cacheScope: 'private'` everywhere prevents a gateway or client from serving one token's ACL-dependent results to another. Negative: `reply.hijack()` means Fastify's `onSend` and serialisation hooks do not run for `/mcp`, so logging and metrics for that route are emitted explicitly; 2025-era clients get no `list_changed` or `resources/updated` notifications and will keep their last fetched tool list (documented for operators); the 30-second timeout plus Claude Code's 60-second first-byte timer put a hard latency budget on every tool (the k6 `get_note p95 < 300 ms` SLO exists to protect it).

## Verification

`mcp.dual-era.contract` (in-process `handler.fetch` with `@modelcontextprotocol/client` 2.0.0, default legacy `initialize` and pinned `2026-07-28`); `mcp.conformance.mcp` (`@modelcontextprotocol/conformance` 0.1.16 with a committed `--expected-failures` baseline: the tool drives the legacy leg only and its active suite is written against a reference server's fixtures, so the baseline is those scenarios plus the one Origin check Iridium refuses by policy, and the assertion is zero *unexplained* failures); the same `mcp.dual-era.contract` file asserts a legacy-era GET or DELETE answers 405; `mcp.host-guard.contract` (foreign Host → 403, browser `Origin` → 403); `mcp.factory-error.mcp` (an injected factory throw yields 500 with no details and increments the metric); Inspector 2.6.0 `--cli` smoke; the nightly real-client matrix (Claude Code ≥ 2.1.232 v2 runtime, VS Code, Cursor, bridge) and the proxied-stack header-passthrough test (A48).

## References

Digest §3.1–§3.5, §11.5, §11.6, §11.16; brief requirement 5; plan-risk-first ADR-13; plan-agent-first §3; judges 1, 2, 3; gap fix (factory-error handling). Implemented in `06-mcp-and-agent-access.md` and `09-api-reference.md` (§D.3).

---

Source: docs/plan/13-decision-log.md, decision A32. This file is a faithful copy of that entry's Status, Context, Decision, Alternatives considered, Consequences, Verification and References fields; the decision log remains the authoritative, continuously-maintained record (status supersessions are recorded there first).
