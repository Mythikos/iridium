/**
 * The window's single multiplexed `/collab` socket
 * (05-collaboration-and-durability.md, *Reconnection semantics*, provider configuration;
 * 09-api-reference.md section 3.1).
 *
 * One `HocuspocusProviderWebsocket` carries every open note and every open vault channel of a
 * window, so the resource a workspace budgets is document attachments and never sockets. The
 * configuration below is the plan's table, in one place: a second copy in the UI and a third in the
 * testkit is how a reconnect ladder quietly stops matching the server's `timeout`.
 *
 * The WebSocket implementation is injected because this package is isomorphic: a browser and an
 * Electron renderer have `WebSocket` as a global, Node does not, and the testkit's `ws` subclass
 * additionally sends the `Origin` header a browser sends, so the CSWSH guard is exercised rather
 * than bypassed (10-testing-and-quality.md, `NoteClient`).
 */

import { HocuspocusProviderWebsocket } from '@hocuspocus/provider';

/**
 * The provider configuration of 05-collaboration-and-durability.md.
 *
 * Named without a limit word on purpose: these are a client's own reconnect policy, not caps the
 * server enforces or `GET /meta.limits` publishes (02-system-architecture.md, invariant 6). The
 * ceiling is 30 s rather than the document ladder's 60 s because a dead socket takes every open
 * note down with it, and the server's `timeout` is 60 s, so a healthy socket must be back long
 * before the server would have given up on it.
 */
const SOCKET_RECONNECT_TIMEOUT_MS = 30_000;
const SOCKET_BACKOFF_DELAY_MS = 1_000;
const SOCKET_BACKOFF_INITIAL_MS = 0;
const SOCKET_BACKOFF_FACTOR = 2;
const SOCKET_BACKOFF_FLOOR_MS = 1_000;
const SOCKET_BACKOFF_CEILING_MS = 30_000;
/** `0` is Hocuspocus's "no limit": a laptop closed overnight reconnects when it wakes. */
const SOCKET_ATTEMPTS_UNLIMITED = 0;

/** What `createCollabSocket` needs. */
export interface CollabSocketOptions {
  /** `wss://<host>/collab` — no query string and no credential (skeleton A24). */
  readonly url: string;
  /**
   * The `WebSocket` implementation, for a host that has no global one. Node passes `ws`; a browser
   * and an Electron renderer pass nothing.
   */
  readonly webSocketPolyfill?: unknown;
  /** Connect on construction. `false` lets a caller attach documents first. */
  readonly autoConnect?: boolean;
}

/** The window's socket, configured as 05-collaboration-and-durability.md fixes it. */
export function createCollabSocket(options: CollabSocketOptions): HocuspocusProviderWebsocket {
  return new HocuspocusProviderWebsocket({
    url: options.url,
    messageReconnectTimeout: SOCKET_RECONNECT_TIMEOUT_MS,
    delay: SOCKET_BACKOFF_DELAY_MS,
    initialDelay: SOCKET_BACKOFF_INITIAL_MS,
    factor: SOCKET_BACKOFF_FACTOR,
    minDelay: SOCKET_BACKOFF_FLOOR_MS,
    maxDelay: SOCKET_BACKOFF_CEILING_MS,
    jitter: true,
    maxAttempts: SOCKET_ATTEMPTS_UNLIMITED,
    ...(options.autoConnect === undefined ? {} : { autoConnect: options.autoConnect }),
    ...(options.webSocketPolyfill === undefined
      ? {}
      : { WebSocketPolyfill: options.webSocketPolyfill }),
  });
}
