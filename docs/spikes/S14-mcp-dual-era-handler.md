# S14 — One `createMcpHandler` behind `reply.hijack()`

## Question

Does one `toNodeHandler(createMcpHandler(factory, { legacy: 'stateless', responseMode: 'json' }))`
behind Fastify `reply.hijack()` serve both protocol eras statelessly underneath Iridium's own
`onRequest` / `preHandler` chain?

## Why it blocks

M3's `apps/server/src/mcp/plugin.ts` mounts `/mcp` and `/mcp/connect` on the product's Fastify
instance with one handler instance and a per-request factory (06-mcp-and-agent-access.md, "Mounting
the two MCP routes on Fastify"): Iridium's own hooks — the Host guard, `rejectBrowserOrigin`,
`ignoreCookies`, `mcpIpGate`, `patAuth` / `oauthAuth`, `mcpKillSwitch`, `chargeRateLimit` — run in front
of the SDK, the route hijacks the reply and hands `reply.raw` to the adapter, `onResponse` reads the
per-call access record (D06-18), and `onMcpHostError` owns the response on failure. If the hand-off
through `reply.hijack()` is defective, M3 mounts `createMcpFastifyApp` as an encapsulated
sub-application instead and re-attaches the same hooks there. The verdict also fixes the shape of the
two things the plan could only assume: what a thrown factory answers, and what the conformance
baseline of a minimal server looks like.

## Pinned versions

| Item | Version | Role |
|---|---|---|
| `@modelcontextprotocol/server` | 2.0.0 | `createMcpHandler`, `McpServer` (`registerTool`, `registerResource`) |
| `@modelcontextprotocol/node` | 2.0.0 (over `@hono/node-server` 1.19.17) | `toNodeHandler`, `toWebRequest` |
| `@modelcontextprotocol/fastify` | 2.0.0 | `hostHeaderValidation` |
| `@modelcontextprotocol/core` | 2.0.0 | Shared by server and client |
| `@modelcontextprotocol/client` | 2.0.0 | The in-process client (`Client` with `versionNegotiation: { mode: 'legacy' }` and `{ mode: { pin: '2026-07-28' } }`, `StreamableHTTPClientTransport` with a tracing `fetch`); the workspace copy `@iridium/testkit` pins, loaded by path |
| `@modelcontextprotocol/conformance` | 0.1.16 | Installed with npm 11.14.1 into a scratch project outside the repository; carries its own `@modelcontextprotocol/sdk` 1.30.0 (the v1 SDK), `undici` 7.29.1 and `express` 5.2.1 |
| `@modelcontextprotocol/inspector` | 2.6.0 | Same scratch project; its `--cli` runs on `@modelcontextprotocol/client` 2.0.0 |
| `fastify` | 5.12.4 | The product's `buildApp({ mode: 'in-process', database: 'none' })` with the security plugin (`@fastify/helmet` 13.1.1, `@fastify/rate-limit` 11.2.0, `@fastify/under-pressure` 9.1.0, `@fastify/cookie` 11.1.2) |
| `zod` | 4.6.2 | The `echo` tool's `inputSchema` |
| `@iridium/testkit`, `@iridium/contracts` | workspace | `reserveLoopbackPort`, `waitFor`; `LIMITS.BODY_MAX_BYTES_MCP` |
| `vitest` / `typescript` / `oxlint` | 5.0.0 / 7.0.2 / 1.82.0 | |
| Node.js | 24.21.0 (`mise.toml`; the runtime `pnpm exec` resolves, also used to spawn the two tools) | |
| `pnpm` / OS | 12.4.1 / Windows 11 Home 10.0.26200, x64 | |

## Method

Harness: `apps/server/test/spikes/` (D12-5), run from `apps/server` with

```
IRIDIUM_S14_TOOLS=<scratch project with conformance 0.1.16 and inspector 2.6.0> \
pnpm exec vitest --run --config test/spikes/vitest.config.ts test/spikes/s14-mcp-dual-era-handler.spike.spec.ts
```

(Without `IRIDIUM_S14_TOOLS` the two external-tool tests are skipped and the in-process client covers
their assertions.) `support/s14-serve.ts` serves the same mount by hand for a reader who wants to point
the tools at it one scenario at a time.

- `support/mcp-mount.ts` — one `createMcpHandler(factory, { legacy: 'stateless', responseMode: 'json', onerror })`
  constructed once (its construction-time `console.warn` captured, D06-25), the stub factory of the
  register row (one `echo` tool with `inputSchema: z.object({ text })`, one static resource
  `iridium://spike/static`, an explicit `capabilities` block, and a `throwNext` switch), and the handler
  mounted **twice** on the real `buildApp`, under identical guards, so the two ways of writing the
  response can be compared:
  - `/mcp` — the plan's wiring verbatim: `reply.hijack()` then
    `toNodeHandler(handler)(Object.assign(req.raw, { auth }), reply.raw, req.body)`;
  - `/mcp-owned` — the same handler through its web-standard face: `reply.hijack()`, then
    `toWebRequest(req.raw, req.body, { signal })` → `handler.fetch(request, { authInfo, parsedBody })` →
    Iridium writes the `Response` to `reply.raw` (status, headers, body with back-pressure) and maps the
    SDK's `500` to the plan's `{"error":"server_error"}`.

  Both routes: `method: ['GET', 'POST', 'DELETE']`, `config: { auth: { public: true }, rateLimit: false }`,
  `bodyLimit: LIMITS.BODY_MAX_BYTES_MCP`, `onRequest: [hostHeaderValidation([publicOrigin.hostname]), rejectBrowserOrigin]`
  (the plan's predicate: any `Origin` header present → `403 {"error":"origin_not_allowed"}`), a
  `preHandler` recording the request id, an `onResponse` recording `reply.raw.statusCode`, and the
  route-level `catch` → `onMcpHostError` (destroy if `headersSent`, else `500 {"error":"server_error"}`).
- `support/mcp-client.ts` — the client module and a `tracingFetch` that records method, path, the
  `MCP-Protocol-Version` / `Mcp-Method` / `Mcp-Name` request headers, status, and the `Mcp-Session-Id` /
  content-type response headers of every exchange.
- `s14-mcp-dual-era-handler.spike.spec.ts` — 17 tests: the construction warning; for each mount, legacy
  era (list, call `echo`, list and read the resource), modern era pinned to `2026-07-28` (same calls),
  `GET`/`DELETE`, four browser `Origin` values, a thrown factory on the legacy era and on the modern era;
  the foreign `Host` (end to end, and the SDK hook in isolation on a bare Fastify instance with
  `inject`, with the two allowlist spellings the plan could pass); the session-id / chain / `onResponse`
  / double-send invariants; the conformance suite; the Inspector CLI. The two tools are spawned
  **asynchronously** (`execFile`) because the server under test lives in the test process — a
  synchronous spawn blocks the event loop that has to answer the tool, which is how the first run of
  this harness produced nothing but timeouts.

Observations are written to `apps/server/test/spikes/results/s14-observations.json`; the conformance
run's per-scenario `checks.json` files to `results/s14-conformance/`.

## Result

**pass** — the hand-off through `reply.hijack()` is correct for both eras, both mounts and all 159
requests of the run (`Tests 17 passed (17)` on 2026-09-13), so the recorded fallback is not needed.
Two items of the criterion are not met *as written* and the plan text is corrected instead, because
neither is a hijack defect and the fallback would change neither: the `500` body is the SDK's under
`toNodeHandler` (met verbatim only by the web-standard-face wiring this note adopts), and the
conformance baseline of the stub is not empty (see below). Item by item:

| Criterion | Observed |
|---|---|
| Both eras list and call `echo` | **Legacy** (`versionNegotiation: { mode: 'legacy' }`): `getProtocolEra() === 'legacy'`, negotiated `2025-11-25`; wire: `initialize → 200`, `notifications/initialized → 202`, one `GET → 405` (the client's standalone-stream attempt, tolerated), `tools/list`, `tools/call`, `resources/list`, `resources/read → 200`; the factory was constructed with `era: 'legacy'` for all six served requests. **Modern** (`{ pin: '2026-07-28' }`): `getProtocolEra() === 'modern'`, negotiated `2026-07-28`; wire: `server/discover` then the four methods, every request carrying `MCP-Protocol-Version: 2026-07-28` and `Mcp-Method`; the factory saw `era: 'modern'` five times. Identical on `/mcp` and `/mcp-owned`. Inspector 2.6.0 `--cli … --transport http --method tools/list` printed the `echo` tool and `--method tools/call --tool-name echo --tool-arg text=…` echoed it (exit 0, era `legacy`) |
| Legacy `GET` / `DELETE` → 405 | Both mounts: `405 {"jsonrpc":"2.0","error":{"code":-32000,"message":"Method not allowed."},"id":null}`, no `Mcp-Session-Id` |
| No `Mcp-Session-Id` ever emitted | 0 of the 28 traced client exchanges and 0 of the raw responses carried the header (the legacy leg is constructed with `sessionIdGenerator: undefined`; the modern path is per request) |
| Browser `Origin` → 403 | `https://evil.example`, `PUBLIC_ORIGIN` itself, `app://iridium` and the literal `null` all answered `403 {"error":"origin_not_allowed"}` on both mounts, before the factory ran; the same `initialize` without `Origin` answered `200` |
| `hostHeaderValidation([PUBLIC_HOST])` rejects a foreign `Host` | End to end, `Host: evil.example` is answered by the product's own boot-step-3 guard first — `421 {"code":"host_rejected", …, "detail":"This server answers only to 127.0.0.1:<port>."}` — before any route-level hook. The SDK hook in isolation (`inject` on a bare instance): `hostHeaderValidation(['127.0.0.1'])` → own host `200`, `evil.example` `403`. **`hostHeaderValidation(['127.0.0.1:<port>'])` — the plan's literal `[PUBLIC_HOST]`, whose value carries the port — answered `403` to the server's own host**: the hook compares `new URL('http://' + host).hostname` against the list, so the entry must be `publicOrigin.hostname` |
| Thrown factory → HTTP 500 `{"error":"server_error"}` | Status `500` on both mounts and both eras; `createMcpHandler`'s `onerror` received `factory boom` each time (4 of 4). **Body:** on `/mcp` the SDK answers the throw itself — `{"jsonrpc":"2.0","error":{"code":-32603,"message":"Internal server error"},"id":1}` — and the route's `catch` never ran (0 catches over 159 requests): `createLegacyStatelessFallback` and `serveModern` both catch factory errors, and `toNodeHandler` additionally catches anything `fetch` throws. On `/mcp-owned` the route saw the SDK's `500` `Response` and wrote `{"error":"server_error"}`. The next request on each mount was served normally |
| Conformance baseline empty for the stub | 0.1.16 has no `--requirements` flag and no 2026-07-28 suite: the flag is `--spec-version`, the server scenarios are tagged `2025-06-18` / `2025-11-25` only, and all 85 requests of the run were served in the **legacy** era. Active suite, 30 scenarios: **5 passed** (`server-initialize`, `ping`, `tools-list`, `resources-list`, `dns-rebinding-protection/localhost-host-rebinding-rejected` — a foreign `Host` and `Origin` answered `421`), **1 warning** (`server-sse-multiple-streams`: "server did not provide session ID" — stateless by design), **24 failures explained by reference-server fixtures the stub does not carry** (`-32602 Tool test_simple_text not found`, `test_image_content`, `test_sampling`, `test://static-text`, … and `-32601 Method not found` for prompts, logging, completion, subscribe), and **1 failure that is Iridium's own policy**: `dns-rebinding-protection/localhost-host-valid-accepted` sends `Origin: http://127.0.0.1:<port>` and expects `2xx`; `rejectBrowserOrigin` answers `403`, exactly as 06 specifies ("deliberately stricter than the specification"). Unexplained failures: **0** — asserted by the harness's classification. The stub's `--expected-failures` baseline is therefore those 25 entries, not empty |
| Underneath Iridium's own chain, with `hijack()` intact | 159 requests passed the root `onRequest` chain (request id, Host guard, helmet, rate limiter disabled per route, load shedding) and the route `preHandler`; `onResponse` fired for all 38 hijacked replies with the status the SDK actually wrote (`200`, `202`, `405`, `500`) and for the 9 replies the `onRequest` guards refused; zero pino lines mention `FST_ERR_REP_ALREADY_SENT`, `ERR_HTTP_HEADERS_SENT` or `ERR_STREAM_WRITE_AFTER_END`; `toNodeHandler`'s `onerror` never fired; the construction warning was captured exactly once (`responseMode: 'json' drops mid-call notifications. subscriptions/listen streams are always served over SSE regardless; …`) |

Further observations the M3 design must absorb:

- **`responseMode: 'json'` shapes the modern path only.** Every legacy-era response in the trace is
  `200 text/event-stream` (one `event: message` frame, then end of stream): the legacy leg constructs
  the 2025 transport with `sessionIdGenerator: undefined` alone and never sees `responseMode`. 06's
  "request/response exchanges are never chunked" holds for `2026-07-28` clients (`application/json`)
  and not for 2025-era clients; the `/mcp` proxy rules of 11-operations-and-deployment.md (no buffering)
  are load-bearing for both eras, not only for `subscriptions/listen`.
- **After `hijack()`, headers set through `reply.header()` are not emitted.** Helmet's headers reached
  the wire (it writes to `reply.raw`); the product's own `content-security-policy` hook and any
  `cache-control: no-store` set with `reply.header()` did not. Whatever `/mcp` must carry is set on
  `reply.raw` (or by the owned writer).
- Under `exactOptionalPropertyTypes`, Node's `IncomingMessage` (`method?: string | undefined`) is not
  assignable to the SDK's `NodeIncomingMessageLike` (`method?: string`); one documented cast sits at the
  boundary. `bodyLimit` is a Fastify route option, not a `config` key. The global `@fastify/rate-limit`
  bucket (unauthenticated tier, 60/min per IP) is switched off per route with `config.rateLimit: false`,
  as 06 already prescribes; without it the conformance run alone would exceed the tier.

## Decision

M3 mounts one `createMcpHandler(buildIridiumMcpServer, { legacy: 'stateless', responseMode: 'json', … })`
instance behind `reply.hijack()` on the product Fastify instance for both `/mcp` and `/mcp/connect` —
no encapsulated sub-application — but through the handler's web-standard face
(`toWebRequest(req.raw, req.body, { signal })` → `handler.fetch(request, { authInfo, parsedBody })` →
Iridium's own response writer and `onMcpHostError`) rather than `toNodeHandler`, so the route owns every
status and byte written after the hijack, including the `500 {"error":"server_error"}` body; the
`hostHeaderValidation` allowlist entry is `PUBLIC_ORIGIN`'s hostname, not `PUBLIC_HOST`.

## Fallback executed

n/a

## Follow-ups

- **Register and 06 re-scored:** (1) the factory-throw item reads "HTTP 500 `{"error":"server_error"}`"
  and is reachable only through the fetch-face wiring above; with `toNodeHandler` the body is the SDK's
  `-32603` JSON-RPC error and `onMcpHostError` is dead code. (2) `hostHeaderValidation([config.PUBLIC_HOST])`
  must become `hostHeaderValidation([config.server.publicOrigin.hostname])` in 06's mounting snippet and
  in `mcp/plugin.ts`, and `mcp.host-guard.contract` must cover a `PUBLIC_ORIGIN` with an explicit port.
  (3) `@modelcontextprotocol/conformance` 0.1.16 takes `--spec-version`, not `--requirements`, has no
  2026-07-28 suite, and drives the server through the v1 SDK, i.e. through the legacy leg only; the
  "baseline empty" wording should become "the baseline lists only reference-fixture scenarios plus the
  `localhost-host-valid-accepted` Origin check", and M3's `mcp.conformance.mcp` should commit that
  `--expected-failures` YAML. (4) 06's "never chunked" sentence applies to the modern era only.
- The end-to-end foreign-`Host` answer on the product is `421 host_rejected` from boot step 3, not the SDK
  hook's `403`; `mcp.host-guard.contract` should assert `421` and keep the SDK hook as the second layer
  that only ever sees `PUBLIC_HOST`.
- `onResponse` fires after `hijack()` with `reply.raw.statusCode`, so D06-18's access-log design stands;
  `reply.statusCode` is not the written status and must not be read there.
- M3's owned writer needs the abort and back-pressure handling `toNodeHandler` provides (abort on
  `res.close`, wait for `drain`), which the harness's `writeWebResponse` shows in ~25 lines; the 30 s
  deadline's `504` and the `headersSent` check of `onMcpHostError` become straightforward once the route
  holds the `Response`.
- Tests to keep from this harness at M3 (`apps/server/test/mcp/**`): the dual-era echo round trips with
  the wire trace, the four-`Origin` refusal, the `PUBLIC_HOST`-with-port probe, the factory-throw body on
  both eras, the no-session-id sweep, the `onResponse`-after-hijack count, and the conformance run with
  its committed baseline; then delete `apps/server/test/spikes/` (D12-5).
