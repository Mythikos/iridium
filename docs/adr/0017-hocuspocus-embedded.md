# A17 — Hocuspocus 4.7.0 embedded as the `Hocuspocus` class inside Fastify with Iridium's own extensions

**Status:** Accepted (2026-09-11); amended 2026-09-17.

## Context

Spec §6 names Hocuspocus and states that MySQL integration is part of this project. Digest §2.2–§2.3 verified that Hocuspocus 4.7.0 is the only MIT, actively maintained (12 releases in 2026), Node-embeddable Yjs backend with per-document `onAuthenticate` and `connection.readOnly`, `onTokenSync`/`requestToken`, `beforeHandleMessage`/`beforeHandleAwareness`, a stateless side channel, `DirectConnection` for server-side edits, `saveMutex`, and the `Hocuspocus` class (`handleConnection(WebSocketLike, Request, context)`) for mounting on an existing HTTP server. The `Server` class owns its own port; `@y/websocket-server` is a basic Yjs-14-beta backend without auth hooks; y-sweet is a separate Rust process with its own store and whose maintainer was acquired; a custom y-protocols server would re-implement everything. Verified hazards: `onChange` is invoked without `await`/`catch` (issue #754) so a rejecting hook is an unhandled rejection; Hocuspocus creates an empty document for any requested name; `closeConnections()` uses 4205 for everyone.

## Decision

`new Hocuspocus({timeout: 60000, debounce: 2000, maxDebounce: 10000, unloadImmediately: true, yDocOptions: {gc: true}, maxPendingDocuments: 100, extensions: [IridiumAuth, IridiumLimits, IridiumPersistence, IridiumVaultChannel]})` created in `apps/server/src/collab/server.ts` and mounted with `app.get('/collab', {websocket: true, preValidation: [originAllowlist, connectionCaps]}, …)` via @fastify/websocket 11.3.0 (`options.maxPayload = 2 MiB`), forwarding `message`/`close` to `ClientConnection.handleMessage`/`handleClose`. Document names are `note:<uuid>` and `vault:<uuid>`. The **persistence listener is Iridium's own `document.on('update')`** registered in `afterLoadDocument`, filtering `LOAD_ORIGIN` and accepting `{source:'connection'}` and `{source:'local'}` origins; `onChange` is not used for persistence. Every hook body is wrapped so it never rejects (issue #754). `@hocuspocus/extension-database` is not used. Hocuspocus specifics are confined behind `CollabServer` (start/stop, `closeNote`, `revokeUser`, `changeRole`, `broadcastVault`, `openServerEdit`, `participants`) and `CollabPersistence` interfaces in `apps/server/src/collab/`. Hook contract per document (skeleton §D.2): `onAuthenticate`, `onLoadDocument`, `afterLoadDocument`, `beforeHandleMessage`, `beforeHandleAwareness`, `onStateless`, `onTokenSync`, `onStoreDocument`, `beforeUnloadDocument`, `afterUnloadDocument`. `onLoadDocument` refuses unknown, trashed, foreign-vault and archived notes so Hocuspocus can never create phantom documents.

**Amendment (2026-09-17): awareness frame fidelity.** The pinned 4.7.0 `MessageReceiver` creates a scratch awareness instance whose synthetic local `{}` state reaches identity hooks, and its filtered re-encoding drops explicit null removals. Keep a version-bound pnpm patch to the source and both shipped runtimes: remove only that scratch participant and metadata, preserve null removals from the input, and retain a hook's deletion of a non-null state as suppression. Register restored presence (reported as `updated` by y-protocols) back to its connection so a later close removes it. The client adapter publishes only its own document client id, including null removal; remote timeouts remain local. Iridium validates every raw awareness entry before dispatch, including duplicate client ids and removal ownership, then keeps the identity/shape hook as defence in depth. This preserves strict impersonation checks and legitimate disconnect presence removal. `collab.awareness-identity.integration`, `crdt.frame.unit`, and `kernel.smoke.integration` verify the boundary; remove the patch only when an upstream version passes the same tests.

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| Hocuspocus `Server` class on its own port | Second port, second TLS endpoint, second Origin policy; cannot share Fastify's upgrade `preValidation`. |
| y-websocket / `@y/websocket-server` | No auth hooks; persistence only on last disconnect; Yjs 14 beta line. |
| y-sweet | Separate Rust process with its own S3/filesystem store and token scheme; MySQL cannot be the system of record; no releases since 2025-09. |
| Custom `ws` + y-protocols server | Re-implements multiplexing, auth queues, readOnly, awareness, ping/pong, ordered processing, load/unload and backoff for the sole benefit of an ack message the stateless channel already provides. |
| crossws node adapter (the documented pattern) | Loses Fastify's plugin-tree auth on upgrade; `@fastify/websocket` keeps `Origin` checks and connection caps inside `preValidation` (validated by the M0 spike). |
| `onChange` as the persistence hook | Fire-and-forget without catch (#754); a direct `update` listener is synchronous and owned by Iridium. |

## Consequences

Positive: one port, one TLS endpoint, one Origin policy, one revocation path (A23) and one ticket scheme (A24); server-side edits (restore, repair, import fix-ups) flow through `DirectConnection` and the same durability pipeline; the interface seam preserves F9 (a later split into a separate process) without a rewrite. Negative: the Fastify wiring is hand-written (`handleMessage`/`handleClose`) and Hocuspocus's `onRequest`/`onUpgrade`/`onListen` hooks do not fire in this mode — the M0 spike validates it; the client is locked to `@hocuspocus/provider` (its wire protocol is proprietary), acceptable behind `@iridium/collab-client`; Tiptap's "future of Hocuspocus" survey (issue #1153) is a watch item recorded in `14-risks-and-open-questions.md`.

## Verification

M0 spike `docs/spikes/S02-fastify-websocket-hocuspocus.md`; `kernel.smoke.integration`; `collab.convergence.integration` (three clients, overlapping positions); `collab.viewer-enforcement.integration` (`SyncStatus(false)`, no state change); `collab.baseline-on-connect.integration`; `security.ws-origin.integration`; `collab.limits.integration`; every hook has a unit test asserting it never rejects.

## References

Digest §2.1–§2.5, §11.6 (framework), §11.22; spec §6; plan-risk-first ADR-02; plan-agent-first ADR-03; plan-enterprise ADR-06/ADR-16; plan-product-dx 005. Implemented in `05-collaboration-and-durability.md` and `02-system-architecture.md`.

---

Source: docs/plan/13-decision-log.md, decision A17. This file is a faithful copy of that entry's Status, Context, Decision, Alternatives considered, Consequences, Verification and References fields; the decision log remains the authoritative, continuously-maintained record (status supersessions are recorded there first).


The pinned provider patch adds `detach(notifyServer = true)` on the provider and shared socket.
After a server-originated refusal, `NoteSession` calls `detach(false)` before destruction so cleanup
cannot enqueue another CLOSE against the next attachment. Normal client detach still sends CLOSE
and role upgrades wait for its acknowledgement before reusing the document routing key. The real
child restart and kill-after-commit suites retain the original client to verify this ordering.
