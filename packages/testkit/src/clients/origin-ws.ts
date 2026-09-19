/**
 * `OriginWebSocket` — the `ws` 8.21.3 subclass that injects `Origin`
 * (10-testing-and-quality.md, "Multi-client collaboration harness"; 12-milestones.md §4.3).
 *
 * Browsers send `Origin` on a WebSocket handshake; `ws` does not. Without this subclass every
 * collaboration test would be refused by the `/collab` Origin allowlist before the upgrade, and the
 * obvious "fix" — an environment escape hatch — is the one the plan rejects by name
 * (`IRIDIUM_ALLOW_NO_ORIGIN_WS` is a *rejected* configuration key, skeleton A24). So the harness sends
 * the header the browser sends, the CSWSH guard runs for real, and
 * `security.ws-origin.integration.spec.ts` proves the absent-`Origin` refusal by asking for
 * `{ origin: null }` rather than by turning the guard off.
 *
 * The exported surface is testkit's own (`TestWebSocket`, `TestWebSocketConstructor`) and never `ws`'s,
 * for two reasons: `@iridium/collab-client` injects a WebSocket *constructor* for Node support
 * (12-milestones.md §7.3), and keeping `ws` out of the emitted declarations means the harness can move
 * to another implementation without touching a consumer.
 */
import WebSocketImpl from 'ws';

/** The request header a browser sends and `ws` omits. */
export const ORIGIN_HEADER = 'Origin';

/** The browser-`WebSocket` surface `HocuspocusProvider` and the raw-socket tests use. */
export interface TestWebSocket {
  readonly url: string;
  readonly protocol: string;
  readonly readyState: number;
  readonly bufferedAmount: number;
  binaryType: string;
  send(data: string | ArrayBufferLike | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  /** Drop the socket without a close handshake — what a "network died" test needs. */
  terminate(): void;
  on(event: 'open', listener: () => void): this;
  on(event: 'close', listener: (code: number, reason: Buffer) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'message', listener: (data: unknown, isBinary: boolean) => void): this;
  once(event: 'open', listener: () => void): this;
  once(event: 'close', listener: (code: number, reason: Buffer) => void): this;
  once(event: 'error', listener: (error: Error) => void): this;
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
}

/** What `HocuspocusProvider`'s `WebSocketPolyfill` option takes. */
export interface TestWebSocketConstructor {
  new (url: string | URL, protocols?: string | string[]): TestWebSocket;
  readonly CONNECTING: number;
  readonly OPEN: number;
  readonly CLOSING: number;
  readonly CLOSED: number;
}

export interface OriginWebSocketOptions {
  /**
   * The value of the `Origin` header. `null` omits the header entirely, which is the case
   * `security.ws-origin.integration` asserts is refused — never a way to make a test pass.
   */
  readonly origin: string | null;
  /** Extra handshake headers (a ticket in a header, a forged `Sec-WebSocket-Protocol`, …). */
  readonly headers?: Readonly<Record<string, string>>;
  /** Mirrors the server's `WS_MAX_PAYLOAD_BYTES` so an oversize frame fails client-side too. */
  readonly maxPayload?: number;
  /** Bind an actual source address for multi-peer load tests; no proxy-header identity is forged. */
  readonly localAddress?: string;
}

/**
 * A `ws` socket that carries `Origin`. The third constructor argument is the harness's, so a test can
 * open one directly; `createOriginWebSocket` binds it for the places that may only pass `(url, protocols)`.
 */
class OriginWebSocket extends WebSocketImpl {
  constructor(
    address: string | URL,
    protocols: string | string[] | undefined,
    options: OriginWebSocketOptions,
  ) {
    const headers: Record<string, string> = { ...options.headers };
    if (options.origin !== null) {
      headers[ORIGIN_HEADER] = options.origin;
    }
    super(address, protocols, {
      headers,
      ...(options.maxPayload === undefined ? {} : { maxPayload: options.maxPayload }),
      ...(options.localAddress === undefined ? {} : { localAddress: options.localAddress }),
    });
  }
}

/**
 * Bind an `Origin` (and any extra handshake headers) into a constructor that takes only
 * `(url, protocols)` — the shape a WebSocket polyfill slot accepts.
 */
export function createOriginWebSocket(options: OriginWebSocketOptions): TestWebSocketConstructor {
  class BoundOriginWebSocket extends OriginWebSocket {
    constructor(address: string | URL, protocols?: string | string[]) {
      super(address, protocols, options);
    }
  }
  return BoundOriginWebSocket;
}

/** Open one socket directly, for the tests that drive the wire instead of a provider. */
export function openOriginWebSocket(
  url: string | URL,
  options: OriginWebSocketOptions,
  protocols?: string | string[],
): TestWebSocket {
  return new OriginWebSocket(url, protocols, options);
}
