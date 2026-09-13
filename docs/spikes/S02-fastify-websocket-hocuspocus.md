# S02 — `@fastify/websocket` 11.3.0 → `hocuspocus.handleConnection`

## Question

Does `@fastify/websocket` 11.3.0 (`app.get('/collab', { websocket: true, preValidation: [...] })`)
hand a socket to `hocuspocus.handleConnection(socket, request, context)` with working
`message`/`close` forwarding, Origin rejection before the upgrade and `maxPayload` enforcement?

## Why it blocks

M1's `apps/server/src/collab/server.ts` mounts Hocuspocus on the product's own Fastify instance
(12-milestones.md §4.3, the `apps/server/src/collab` row; 05-collaboration-and-durability.md,
"Mounting on `/collab`") so that the security plugin's `onRequest` chain, the route-policy boot
assertion and the `/collab` Origin allowlist run in front of the upgrade — the CSWSH refusal of
04-auth-and-access-control.md has no bypass switch (A24), and the M0 testkit's `NoteClient` is built
on an `Origin`-injecting `ws` subclass for exactly that reason. If the plugin cannot hand a socket to
Hocuspocus 4.7.0 with its hook chain intact, M1 wires `crossws/adapters/node` on `server.on('upgrade')`
instead, behind the same `CollabServer` interface. 05 also asks this spike to record three hook
behaviours the M1 design depends on rather than assumes: a close from inside `onStateless`, a throw
from `beforeHandleAwareness`, and a socket close while `onAuthenticate` is in flight.

## Pinned versions

| Item | Version | Role |
|---|---|---|
| `fastify` | 5.12.4 | The product's own `buildApp({ mode: 'in-process', database: 'none' })`, security plugin included |
| `@fastify/websocket` | 11.3.0 | Under test (`ws` 8.21.3 underneath, `maxPayload` from `LIMITS.WS_MAX_PAYLOAD_BYTES` = 2 097 152) |
| `@hocuspocus/server` | 4.7.0 | `Hocuspocus` instance, `handleConnection` / `handleMessage` / `handleClose` |
| `@hocuspocus/provider` | 4.7.0 | `HocuspocusProvider` and `HocuspocusProviderWebsocket` over the testkit's `createOriginWebSocket` (loaded from the workspace copy `@iridium/collab-client` pins, ESM build) |
| `@hocuspocus/common` | 4.7.0 | Wire message types |
| `yjs` / `lib0` / `y-protocols` | 13.6.32 / 0.2.117 / 1.0.7 | One instance across `@iridium/crdt`, `@hocuspocus/server` and `@hocuspocus/provider` (lockfile-pinned) |
| `@fastify/helmet` / `@fastify/rate-limit` / `@fastify/under-pressure` / `@fastify/cookie` | 13.1.1 / 11.2.0 / 9.1.0 / 11.1.2 | The boot-step-3 chain that runs on every upgrade request |
| `@iridium/testkit`, `@iridium/crdt`, `@iridium/contracts` | workspace | `createOriginWebSocket`, `openOriginWebSocket`, `waitFor`; `createNoteDoc` / `getContent` / `projectMarkdown`; `LIMITS` |
| `vitest` | 5.0.0 | Harness runner (`pool: 'forks'`) |
| `typescript` / `oxlint` | 7.0.2 / 1.82.0 | The harness type-checks under `apps/server/tsconfig.json` and lints clean |
| Node.js | 24.21.0 (`mise.toml` pin, the runtime `pnpm exec` resolves); the host `node` on PATH is 24.11.0 | |
| `pnpm` | 12.4.1 | |
| OS | Windows 11 Home 10.0.26200, x64 | |

## Method

Harness: `apps/server/test/spikes/` (decision D12-5 — deleted when the M1 kernel replaces it), run from
`apps/server` with

```
pnpm exec vitest --run --config test/spikes/vitest.config.ts test/spikes/s02-fastify-websocket-hocuspocus.spike.spec.ts
```

- `support/app.ts` — the real `buildApp` in `in-process` mode with `database: 'none'`, a loopback port
  reserved first so `PUBLIC_ORIGIN` names it (the Host guard compares against it), and a pino capture
  of every `warn`+ line so a double-send (`FST_ERR_REP_ALREADY_SENT`, `ERR_HTTP_HEADERS_SENT`) is an
  assertion rather than a console glance.
- `support/collab-mount.ts` — the mount of 05's "Mounting on `/collab`" as far as M0 can write it:
  `app.register(fastifyWebsocket, { options: { maxPayload: LIMITS.WS_MAX_PAYLOAD_BYTES } })`, then
  `app.get('/collab', { websocket: true, config: { auth: { public: true } }, preValidation: [originAllowlist] }, handler)`.
  The allowlist is the literal set `[PUBLIC_ORIGIN, 'app://iridium']`; absent or foreign `Origin`
  answers `sendProblem(request, reply, 'forbidden', …)` from the product's own `security/problem.ts`.
  The handler builds `new Request(`${PUBLIC_ORIGIN}${req.url}`, { headers })` — Hocuspocus 4.7.0's
  `handleConnection(socket, request, context)` takes a Fetch `Request`, reads `request.headers` and
  parses `request.url` for `requestParameters` — calls `hocuspocus.handleConnection(socket, request, { ip, requestId })`,
  and forwards `socket.on('message')` → `cc.handleMessage(Uint8Array)` and `socket.on('close')` →
  `cc.handleClose({ code, reason })`. Hocuspocus attaches no socket listeners itself.
- `support/provider.ts` — `HocuspocusProvider` with `WebSocketPolyfill: createOriginWebSocket({ origin })`
  from the testkit (the M1 `NoteClient` shape), recording every `onClose`, `onStatus`,
  `onAuthenticationFailed` and `onStateless` payload.
- `s02-fastify-websocket-hocuspocus.spike.spec.ts` — one `Hocuspocus` instance with an extension that
  counts `onRequest` / `onUpgrade` / `onListen` / `onConnect` / `onAuthenticate`, accepts the token
  `spike-ticket` in `onAuthenticate`, closes the document connection with
  `{ code: 4403, reason: 'protocol-error' }` from `onStateless` when the payload is `bad` (and answers
  `pong` to `ping`), and throws `{ code: 4403, reason: 'awareness-spoof' }` from
  `beforeHandleAwareness` when a state carries `user.id === 'spoof'`. Ten tests, in order:
  1. a provider with `Origin: PUBLIC_ORIGIN` reaches `synced`; a client edit reaches the server
     document and a server-side edit reaches the client;
  2. `Origin: app://iridium` is accepted too;
  3. absent `Origin` → HTTP 403 before the upgrade (raw `ws` socket, `unexpected-response` captured);
  4. `Origin: https://evil.example` → HTTP 403;
  5. a 3 MiB binary frame on an accepted socket → close code 1009;
  6. `connection.close({ code: 4403, reason: 'revoked' })` on the server-side `Connection` → the
     provider's `onClose`;
  7. the socket closes while `onAuthenticate` is parked on a deferred → no document, no
     `loadingDocuments` entry;
  8. two providers (`note:*`, `vault:*`) on one `HocuspocusProviderWebsocket`; the note provider sends
     the stateless payload `bad`;
  9. two sockets on one document; one sets the awareness field `user: { id: 'spoof' }`;
  10. the hook counters and the log capture.

  Every observation is written to `apps/server/test/spikes/results/s02-observations.json`.

## Result

**pass.** All ten tests pass (run of 2026-09-13, `Tests 10 passed (10)`); the register's criteria, item
by item:

| Criterion | Observed |
|---|---|
| Provider reaches `synced` | Yes, for `Origin: http://127.0.0.1:<port>` and for `Origin: app://iridium`; `provider.isAuthenticated === true`; `onConnect` fired once per socket. A client insert (`'hello from the client'`) appeared in `hocuspocus.documents.get('note:s2-sync')` and a server-side `document.transact(…, { source: 'local' })` insert was broadcast back — both directions of the forwarding work |
| Absent `Origin` → 403 before upgrade | HTTP `403` with the ProblemDetails body `{ type: 'urn:iridium:problem:forbidden', title: 'You do not have permission to do that', status: 403, code: 'forbidden', requestId, detail: 'The /collab upgrade carried no Origin header.' }`; `onConnect` count unchanged; `app.websocketServer.clients.size` unchanged — the socket never reached Hocuspocus |
| `Origin` outside the allowlist → 403 | Same body with `detail: 'The Origin header is not on the allowlist.'`; `onConnect` unchanged |
| 3 MiB frame → close 1009 | The client's `close` event: `{ code: 1009, reason: '' }` (`ws` sends the 1009 close frame with an empty reason). `LIMITS.WS_MAX_PAYLOAD_BYTES` (2 097 152) < 3 145 728. The frame never became a Hocuspocus message (`onConnect` unchanged). **The server side's own `close` event — what `handleClose` receives — carried `{ code: 1006, reason: '' }`**, because `ws` tears the socket down after the receiver error rather than completing a close handshake |
| `connection.close({ code: 4403, reason: 'revoked' })` surfaces `reason` on the provider's `onClose` | `onClose` received `{ event: { code: 1000, reason: 'revoked' } }`. The document-level close is a `MessageType.CLOSE` frame carrying the reason only; the provider hard-codes `code: 1000` (09-api-reference.md §3.6 already says clients key on the reason, never the code). The socket stayed open (`readyState === 1`), the provider flipped to `synced === false`, and the document unloaded once its last connection left |
| No `onRequest` / `onUpgrade` / `onListen` hocuspocus hooks needed | Counters after the whole run: `onRequest: 0`, `onUpgrade: 0`, `onListen: 0` (against `onConnect: 8`, `onAuthenticate: 8`, `onStateless: 2`, `beforeHandleAwareness: 10`). Those three hooks belong to Hocuspocus's own `Server` class and never fire under `handleConnection` |

The additional behaviours 05 asks this spike to record, all asserted:

- **Socket closed while `onAuthenticate` is in flight** — after the deferred resolved,
  `hocuspocus.documents.has('note:s2-inflight') === false` and `loadingDocuments.has(...) === false`:
  the queued `Authenticated` message fails on the closed socket inside `handleQueueingMessage`, the
  connection is dropped, and `createDocument` is never reached. No document leaks.
- **`connection.close({ code: 4403, reason: 'protocol-error' })` from inside `onStateless`** — the note
  provider's `onClose` saw `{ code: 1000, reason: 'protocol-error' }`, `note:s2-stateless` unloaded,
  the shared socket stayed `OPEN`, `vault:s2-stateless` stayed loaded, and the vault provider on the
  same socket sent `ping` and received `pong` afterwards with zero closes of its own. A document-level
  close is confined to that document.
- **A throw from `beforeHandleAwareness`** — the spoofing provider's document connection closed with
  `reason: 'awareness-spoof'` (`Connection.processMessages` maps the thrown `{ code, reason }` onto the
  CLOSE frame); the document's awareness states contained no `spoof` entry 150 ms later; the honest
  provider on the same document saw no close, kept its connection (`getConnectionsCount()` 2 → 1) and
  kept editing; the spoofer's socket stayed `OPEN`. The state is neither applied nor broadcast — the
  hook runs on a scratch `Awareness` before `applyAwarenessUpdate` touches the real one.
- **Nothing double-sends.** Zero pino lines mention `FST_ERR_REP_ALREADY_SENT`, `ERR_HTTP_HEADERS_SENT`
  or `ERR_STREAM_WRITE_AFTER_END` across the run: a `preValidation` hook that replies writes a plain
  HTTP response on the not-yet-upgraded socket and `@fastify/websocket`'s `onResponse` hook destroys it.

## Decision

M1 mounts `/collab` exactly as 05-collaboration-and-durability.md specifies — `@fastify/websocket`
11.3.0 with `maxPayload` from `LIMITS`, the Origin allowlist as a `preValidation` hook answering the
`forbidden` ProblemDetails, `hocuspocus.handleConnection(socket, new Request(PUBLIC_ORIGIN + req.url, { headers }), context)`
and explicit `message`/`close` forwarding — and the `crossws` fallback is not built.

## Fallback executed

n/a

## Follow-ups

- **Register row re-scored:** "3 MiB frame → close 1009" holds on the client; `handleClose` on the
  server receives `1006`. M1's `too-large` metric and log line must come from the frame-cap event
  (`socket.on('error')` with `RangeError: Max payload size exceeded`, or a `ws` `maxPayload` hook), never
  from the close code Hocuspocus is handed.
- **Close codes are not observable through a document-level close.** 09-api-reference.md §3.6's
  Hocuspocus-code column (4401/4403/4404/4205) describes `ClientConnection.terminate` / socket closes;
  a `connection.close({ code, reason })` reaches the provider as `code: 1000` plus the reason. The
  client state machine keys on reasons, as §3.6 already requires; the table's wording should say the
  code column applies to socket-level closes only.
- **The boot-step-3 chain runs on every upgrade request.** `@fastify/rate-limit` (global,
  unauthenticated tier 60/min per IP) counted every upgrade in this run; M1 must declare
  `config.rateLimit` on `/collab` deliberately (the per-IP and per-process socket caps of `collab/limits.ts`
  are a separate mechanism), exactly as 06 does for `/mcp`. The Host guard also applies to upgrades
  (a foreign `Host` is `421 host_rejected` before `preValidation` runs).
- Hocuspocus 4.7.0 fires `connected` *after* the first queued message of that connection is handled
  (`SyncStep1` is replayed before the `connected` hook); M1's participants broadcast in `connected`
  must not assume the first sync has not happened.
- Tests to write at M1 from this harness: `security.ws-origin.integration` (both refusals with the
  ProblemDetails body), `collab.stateless-close.integration`, `collab.awareness-identity.integration`, and
  the in-flight-auth close case; then delete `apps/server/test/spikes/` (D12-5).
- 05-collaboration-and-durability.md refers to this spike as `spike-fastify-websocket-hocuspocus`; the
  register id is S2 and the file is this one — the stale name should be replaced.
