# Pinned dependency corrections

`pnpm-workspace.yaml` and `pnpm-lock.yaml` register these patches; frozen installs apply them.

- `@fastify/websocket@11.3.0`: an earlier `onRequest` hook can reject an HTTP upgrade before
  the plugin initializes `request.ws`. Response cleanup now checks the plugin-owned raw socket
  marker, so that refusal closes its TCP connection and Fastify shutdown can finish. The plugin
  also owns raw socket errors throughout asynchronous admission, releasing that handler only after
  `ws` takes ownership or the refused socket closes. A client reset during admission therefore
  closes its own socket without crashing the process. The real transport regressions are
  `collab.upgrade-cleanup.unit`, built through the product's `buildApp`.
- `@hocuspocus/server@4.7.0`: the embedded server follows Iridium's authenticated, per-connection
  awareness ownership. See ADR0017 and the real awareness identity/rate integration suites.
- `@hocuspocus/provider@4.7.0`: `detach(false)` disposes a server-refused attachment locally. Sending
  another CLOSE can terminate the replacement provider on the shared socket. Default detach still
  sends CLOSE. Both distributed module formats, declarations and package source are patched; the
  original-client crash/reconnect and role-upgrade suites exercise both paths. Socket cleanup retains
  the retired connection's error handler until close, so cancelling a Node ws handshake cannot emit
  an uncaught error or deliver a stale close to its replacement.
  One cancellable retry owns the transport until its first protocol message; HTTP open alone does
  not complete that attempt. Disconnect and destroy settle pending attempts and delays, and callback
  dispatch stops when its physical socket is retired. Handshake generations and live socket checks
  prevent an old token lookup from authenticating or syncing a replacement attachment, including
  heartbeat cleanup and retirement by an outgoing-message observer. The targeted proofs are
  `testkit.socket-lifecycle.unit` and `testkit.provider-handshake.unit`, including real Node ws
  teardown and reentrant lifecycle callbacks.
- `ssh-remote-port-forward@1.0.4`: Testcontainers' host-port relay pipes an SSH channel and TCP socket
  without error handlers. A Toxiproxy reset therefore emitted an unhandled Socket error and killed
  the test runner. Per-pair error/close handlers now destroy both ends, preserving the network failure
  for the clients while allowing the real degradation suite to report its result.

Re-evaluate these corrections when upgrading each dependency. Remove a patch only after the
corresponding regression passes against the upstream release.
