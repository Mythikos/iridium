/** The shipped provider owns an aborted Node ws attempt until that attempt's close event. */
import { errorMonitor } from 'node:events';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';

import { HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { createCollabSocket } from '@iridium/collab-client';
import { FRAME_TYPE } from '@iridium/crdt';
import { describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';

import { createDeferred, withDeadline } from './harness/deadline.ts';

const DEADLINE_MS = 4000;
type CollabSocket = ReturnType<typeof createCollabSocket>;

function closed(socket: WebSocket | Duplex): Promise<void> {
  // events.once(socket, 'close') installs an error listener and would conceal the exact uncaught
  // error this test exists to catch. This observer listens only for close.
  return new Promise((resolve) => {
    socket.once('close', () => resolve());
  });
}

function nodeSocket(provider: CollabSocket): WebSocket {
  const socket = provider.webSocket;
  if (!(socket instanceof WebSocket))
    throw new Error('The provider must own a real Node ws socket.');
  return socket;
}

async function upgradeFixture() {
  const held = createDeferred<{ readonly socket: Duplex; readonly closed: Promise<void> }>();
  const accepted = createDeferred<{
    readonly socket: WebSocket;
    readonly firstPong: Promise<void>;
    readonly secondPong: Promise<void>;
  }>();
  const server = createServer();
  const websocketServer = new WebSocketServer({ noServer: true });
  const peers = new Map<Socket, Promise<void>>();
  const transportErrors: Error[] = [];
  let upgrades = 0;

  server.on('connection', (socket) => {
    const ended = closed(socket);
    peers.set(socket, ended);
    socket.once('close', () => peers.delete(socket));
    socket.on('error', (error) => transportErrors.push(error));
  });
  server.on('upgrade', (request, socket, head) => {
    upgrades += 1;
    if (upgrades === 1) {
      const ended = closed(socket);
      // Keep the handshake unanswered but read the peer's FIN so the held transport can close.
      socket.once('end', () => socket.end());
      socket.resume();
      held.resolve({ socket, closed: ended });
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, (websocket) => {
      const firstPong = createDeferred<void>();
      const secondPong = createDeferred<void>();
      let pongs = 0;
      websocket.on('error', (error) => transportErrors.push(error));
      websocket.on('message', (data, binary) => {
        if (!binary || !(data instanceof Buffer) || !data.equals(Buffer.from([FRAME_TYPE.pong]))) {
          transportErrors.push(
            new Error('The provider sent a non-pong frame to the lifecycle probe.'),
          );
          return;
        }
        pongs += 1;
        if (pongs === 1) firstPong.resolve(undefined);
        if (pongs === 2) secondPong.resolve(undefined);
      });
      accepted.resolve({
        socket: websocket,
        firstPong: firstPong.promise,
        secondPong: secondPong.promise,
      });
      // A provider connect attempt settles on its first protocol message, not merely HTTP 101.
      websocket.send(Uint8Array.of(FRAME_TYPE.ping));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('The probe needs a TCP listener.');

  return {
    url: `ws://127.0.0.1:${String(address.port)}/collab`,
    held: held.promise,
    accepted: accepted.promise,
    transportErrors,
    upgradeCount: () => upgrades,
    peerCount: () => peers.size,
    async close(): Promise<void> {
      const peerClosures = [...peers.values()];
      for (const websocket of websocketServer.clients) websocket.terminate();
      for (const socket of peers.keys()) socket.destroy();
      await Promise.all([
        ...peerClosures,
        new Promise<void>((resolve, reject) =>
          websocketServer.close((error) => (error === undefined ? resolve() : reject(error))),
        ),
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error === undefined ? resolve() : reject(error))),
        ),
      ]);
    },
  };
}

async function wait<T>(promise: Promise<T>, description: string): Promise<T> {
  return withDeadline(promise, { timeoutMs: DEADLINE_MS, description });
}

/** Only the browser transport is scripted; the provider owns every retry and protocol transition. */
class ScriptedWebSocket {
  readyState = 0;
  binaryType = 'arraybuffer';
  readonly sent: unknown[] = [];
  readonly #listeners = new Map<string, Set<(event: unknown) => void>>();

  addEventListener(name: string, callback: (event: unknown) => void): void {
    const listeners = this.#listeners.get(name) ?? new Set<(event: unknown) => void>();
    listeners.add(callback);
    this.#listeners.set(name, listeners);
  }

  removeEventListener(name: string, callback: (event: unknown) => void): void {
    this.#listeners.get(name)?.delete(callback);
  }

  #emit(name: string, event: unknown): void {
    for (const callback of this.#listeners.get(name) ?? []) callback(event);
  }

  open(): void {
    this.readyState = 1;
    this.#emit('open', {});
  }

  ping(): void {
    this.#emit('message', { data: Uint8Array.of(FRAME_TYPE.ping).buffer });
  }

  fail(): void {
    this.readyState = 3;
    this.#emit('error', new Error('The peer interrupted this connection attempt.'));
    this.#emit('close', { code: 1006, reason: '' });
  }

  send(message: unknown): void {
    this.sent.push(message);
  }

  close(): void {
    if (this.readyState === 3) return;
    const connecting = this.readyState === 0;
    this.readyState = 3;
    if (connecting) this.#emit('error', new Error('WebSocket was closed before establishment.'));
    this.#emit('close', { code: 1000, reason: '' });
  }
}

interface RetryFixture {
  readonly provider: CollabSocket;
  readonly sockets: readonly ScriptedWebSocket[];
  latest(this: void): ScriptedWebSocket;
}

/** Third-party timers are a host I/O seam; no provider method or reconnect rule is mocked. */
async function retryFixture(
  run: (fixture: RetryFixture) => Promise<void>,
  makeProvider: (transport: typeof ScriptedWebSocket) => CollabSocket = (transport) =>
    createCollabSocket({
      url: 'ws://fixture.invalid/collab',
      autoConnect: false,
      webSocketPolyfill: transport,
    }),
): Promise<void> {
  vi.useFakeTimers();
  const sockets: ScriptedWebSocket[] = [];
  class BoundSocket extends ScriptedWebSocket {
    constructor() {
      super();
      sockets.push(this);
    }
  }
  const provider = makeProvider(BoundSocket);
  provider.setConfiguration({ jitter: false });
  try {
    await run({
      provider,
      sockets,
      latest() {
        const socket = sockets.at(-1);
        if (socket === undefined) throw new Error('The provider has not dialled a transport yet.');
        return socket;
      },
    });
  } finally {
    provider.destroy();
    await vi.advanceTimersByTimeAsync(0);
    vi.clearAllTimers();
    vi.useRealTimers();
  }
}

describe('testkit.socket-lifecycle.unit [area:testkit]', () => {
  it.each(['destroy', 'supersede'] as const)(
    'settles a CONNECTING attempt on %s without orphaning its error handler or poisoning the next socket',
    async (action) => {
      const fixture = await upgradeFixture();
      const providers: CollabSocket[] = [];
      const uncaught: unknown[] = [];
      const rejections: unknown[] = [];
      const monitorException = (error: Error): void => {
        uncaught.push(error);
      };
      const monitorRejection = (reason: unknown): void => {
        rejections.push(reason);
      };
      process.on('uncaughtExceptionMonitor', monitorException);
      process.on('unhandledRejection', monitorRejection);
      const makeProvider = (): CollabSocket => {
        const provider = createCollabSocket({
          url: fixture.url,
          webSocketPolyfill: WebSocket,
          autoConnect: false,
        });
        providers.push(provider);
        return provider;
      };

      try {
        const first = makeProvider();
        const firstAttempt = first.connect();
        const held = await wait(fixture.held, 'the real server to hold the first HTTP upgrade');
        const retired = nodeSocket(first);
        const retiredClosed = closed(retired);
        const retiredErrors: Error[] = [];
        retired.on(errorMonitor, (error: Error) => retiredErrors.push(error));
        expect(retired.readyState).toBe(WebSocket.CONNECTING);
        expect(retired.listenerCount('error')).toBe(1);

        // Both public operations close the old socket before ws emits its asynchronous error. The
        // retained listener must reject only the old attempt even after a new one replaces it.
        if (action === 'destroy') first.destroy();
        const active = action === 'destroy' ? makeProvider() : first;
        const activeAttempt = active.connect();
        expect(retired.listenerCount('error')).toBe(1);
        const accepted = await wait(fixture.accepted, 'the replacement HTTP upgrade');
        await wait(
          Promise.all([
            firstAttempt,
            activeAttempt,
            retiredClosed,
            held.closed,
            accepted.firstPong,
          ]),
          'both connection attempts and the retired TCP transport to settle',
        );

        expect(retired.readyState).toBe(WebSocket.CLOSED);
        expect(retiredErrors).toHaveLength(1);
        expect(retiredErrors[0]?.message).toBe(
          'WebSocket was closed before the connection was established',
        );
        expect(retired.listenerCount('error')).toBe(0);
        expect(retired.listenerCount('close')).toBe(0);
        expect(active.connectionAttempt).toBeNull();
        expect(active.status).toBe('connected');
        expect(first.status).toBe(action === 'destroy' ? 'disconnected' : 'connected');
        expect(nodeSocket(active).readyState).toBe(WebSocket.OPEN);
        expect(fixture.upgradeCount()).toBe(2);
        expect(fixture.peerCount()).toBe(1);
        expect(Object.keys(active.webSocketHandlers)).toHaveLength(1);

        accepted.socket.send(Uint8Array.of(FRAME_TYPE.ping));
        await wait(
          accepted.secondPong,
          'the active provider to answer another protocol ping after retired cleanup',
        );
        expect(active.status).toBe('connected');
        const activeClosed = closed(nodeSocket(active));
        const acceptedClosed = closed(accepted.socket);
        active.destroy();
        await wait(
          Promise.all([activeClosed, acceptedClosed]),
          'the final upgraded transport to close',
        );
        expect(active.webSocket).toBeNull();
        expect(active.connectionAttempt).toBeNull();
        expect(active.shouldConnect).toBe(false);
        expect(active.status).toBe('disconnected');
        expect(Object.keys(active.webSocketHandlers)).toEqual([]);
        expect(fixture.transportErrors).toEqual([]);
        expect(uncaught).toEqual([]);
        expect(rejections).toEqual([]);
      } finally {
        try {
          for (const provider of providers) provider.destroy();
          await wait(
            fixture.close(),
            'the lifecycle probe to release all owned listeners and transports',
          );
        } finally {
          process.removeListener('uncaughtExceptionMonitor', monitorException);
          process.removeListener('unhandledRejection', monitorRejection);
        }
      }
      expect(fixture.peerCount()).toBe(0);
      expect(uncaught).toEqual([]);
      expect(rejections).toEqual([]);
    },
  );
  it('keeps HTTP-open attempts owned until the first protocol message and never replaces their healthy successor', async () => {
    await retryFixture(async ({ provider, sockets, latest }) => {
      const attempt = provider.connect();
      const first = latest();
      first.open();
      let joined = false;
      const sameAttempt = provider.connect().then(() => {
        joined = true;
        return undefined;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(joined).toBe(false);
      expect(provider.cancelWebsocketRetry).toBeTypeOf('function');
      expect(sockets).toHaveLength(1);

      first.fail();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(sockets).toHaveLength(2);
      const recovered = latest();
      recovered.open();
      recovered.ping();
      await Promise.all([attempt, sameAttempt]);
      expect(provider.connectionAttempt).toBeNull();
      expect(provider.cancelWebsocketRetry).toBeUndefined();
      expect(recovered.sent).toEqual([Uint8Array.of(FRAME_TYPE.pong)]);

      // An orphan retryer used to retire this already-established successor on its next attempt.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(sockets).toHaveLength(2);
      expect(latest()).toBe(recovered);
      expect(recovered.readyState).toBe(1);
      expect(provider.status).toBe('connected');
    });
  });

  it.each(
    (['disconnect', 'destroy'] as const).flatMap((action) =>
      (
        ['initial-delay', 'connecting', 'http-open', 'retry-delay', 'delayed-reconnect'] as const
      ).map((phase) => ({ action, phase })),
    ),
  )(
    'settles $phase on $action and prevents every pending timer from resurrecting the socket',
    async ({ action, phase }) => {
      await retryFixture(async ({ provider, sockets, latest }) => {
        if (phase === 'initial-delay') provider.setConfiguration({ initialDelay: 1_000 });
        let settled = false;
        const attempt = provider.connect().then(() => {
          settled = true;
          return undefined;
        });
        if (phase === 'http-open' || phase === 'delayed-reconnect') latest().open();
        if (phase === 'retry-delay') latest().fail();
        if (phase === 'delayed-reconnect') {
          latest().ping();
          await attempt;
          latest().close();
        }
        await vi.advanceTimersByTimeAsync(0);
        const beforeStop = sockets.length;
        provider[action]();
        await vi.advanceTimersByTimeAsync(0);
        expect(settled).toBe(true);
        await attempt;
        expect(provider.connectionAttempt).toBeNull();
        expect(provider.shouldConnect).toBe(false);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(sockets).toHaveLength(beforeStop);
        expect(provider.status).toBe('disconnected');

        const resumed = provider.connect();
        if (action === 'disconnect') {
          await vi.advanceTimersByTimeAsync(1_000);
          latest().open();
          latest().ping();
        }
        await resumed;
        expect(sockets).toHaveLength(beforeStop + (action === 'disconnect' ? 1 : 0));
        expect(provider.status).toBe(action === 'disconnect' ? 'connected' : 'disconnected');
      });
    },
  );

  it('publishes an attempt before a connecting-status listener can cancel it', async () => {
    await retryFixture(async ({ provider, sockets }) => {
      provider.on('status', ({ status }: { status: string }) => {
        if (status === 'connecting') provider.disconnect();
      });
      let settled = false;
      const attempt = provider.connect().then(() => {
        settled = true;
        return undefined;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(true);
      await attempt;
      expect(provider.connectionAttempt).toBeNull();
      expect(provider.status).toBe('disconnected');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(sockets).toHaveLength(1);
    });
  });

  it('preserves a replacement retry created by a connecting-status listener', async () => {
    await retryFixture(async ({ provider, sockets, latest }) => {
      let replacement: Promise<unknown> | undefined;
      let replaced = false;
      provider.on('status', ({ status }: { status: string }) => {
        if (status === 'connecting' && !replaced) {
          replaced = true;
          replacement = provider.connect();
        }
      });
      const retired = provider.connect();
      expect(sockets).toHaveLength(2);
      latest().open();
      let joined = false;
      const active = provider.connect().then(() => {
        joined = true;
        return undefined;
      });
      await vi.advanceTimersByTimeAsync(0);
      await retired;
      expect(joined).toBe(false);
      expect(provider.cancelWebsocketRetry).toBeTypeOf('function');
      latest().ping();
      await Promise.all([active, replacement]);
      expect(joined).toBe(true);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(sockets).toHaveLength(2);
      expect(provider.status).toBe('connected');
    });
  });

  it.each(['http-open-status', 'first-message-status', 'first-message-connect'] as const)(
    'stops retired %s callbacks before publishing state or frames against a replacement',
    async (boundary) => {
      await retryFixture(async ({ provider, sockets, latest }) => {
        let armed = false;
        let replacement: Promise<unknown> | undefined;
        const statuses: string[] = [];
        let connections = 0;
        const replaceSocket = (): void => {
          if (!armed) return;
          armed = false;
          provider.disconnect();
          replacement = provider.connect();
        };
        provider.on('status', ({ status }: { status: string }) => {
          if (status === 'connected' && boundary !== 'first-message-connect') replaceSocket();
        });
        provider.on('connect', () => {
          if (boundary === 'first-message-connect') replaceSocket();
        });
        provider.on('status', ({ status }: { status: string }) => statuses.push(status));
        provider.on('connect', () => {
          connections += 1;
        });
        const retiredAttempt = provider.connect();
        const retired = latest();
        armed = boundary === 'http-open-status';
        retired.open();
        if (boundary !== 'http-open-status') {
          statuses.length = 0;
          armed = true;
          retired.ping();
        }
        await vi.advanceTimersByTimeAsync(0);
        await retiredAttempt;
        expect(sockets).toHaveLength(2);
        expect(connections).toBe(0);
        expect(statuses.filter((status) => status === 'connected')).toHaveLength(
          boundary === 'first-message-connect' ? 1 : 0,
        );
        expect(provider.status).toBe('connecting');
        expect(provider.connectionAttempt).not.toBeNull();
        expect(provider.cancelWebsocketRetry).toBeTypeOf('function');
        expect(provider.receivedOnOpenPayload).toBeUndefined();
        expect(provider.lastMessageReceived).toBe(0);
        expect(retired.sent).toEqual([]);
        const active = latest();
        expect(active.sent).toEqual([]);
        active.open();
        active.ping();
        await replacement;
        expect(connections).toBe(1);
        expect(provider.lastMessageReceived).toBeGreaterThan(0);
        expect(active.sent).toEqual([Uint8Array.of(FRAME_TYPE.pong)]);
        expect(provider.status).toBe('connected');
      });
    },
  );

  it.each(
    (['disconnect', 'destroy'] as const).flatMap((action) =>
      (['onOpen', 'onMessage'] as const).map((callback) => ({ action, callback })),
    ),
  )(
    'does not continue a configured $callback after its callback calls $action',
    async ({ action, callback }) => {
      await retryFixture(
        async ({ provider, sockets, latest }) => {
          let lateCallbacks = 0;
          provider.on(callback === 'onOpen' ? 'open' : 'message', () => {
            lateCallbacks += 1;
          });
          const attempt = provider.connect();
          latest().open();
          if (callback === 'onMessage') latest().ping();
          await vi.advanceTimersByTimeAsync(0);
          await attempt;
          expect(lateCallbacks).toBe(0);
          expect(provider.status).toBe('disconnected');
          expect(provider.shouldConnect).toBe(false);
          expect(provider.webSocket).toBeNull();
          expect(provider.connectionAttempt).toBeNull();
          expect(provider.lastMessageReceived).toBe(0);
          expect(latest().sent).toEqual([]);
          await vi.advanceTimersByTimeAsync(60_000);
          expect(sockets).toHaveLength(1);
        },
        (transport) =>
          new HocuspocusProviderWebsocket({
            url: 'ws://fixture.invalid/collab',
            autoConnect: false,
            WebSocketPolyfill: transport,
            [callback]: function (this: CollabSocket): void {
              this[action]();
            },
          }),
      );
    },
  );

  it('does not publish a retired close after a disconnected-status callback opens a replacement', async () => {
    await retryFixture(async ({ provider, sockets, latest }) => {
      const initial = provider.connect();
      latest().open();
      latest().ping();
      await initial;
      let replacement: Promise<unknown> | undefined;
      let armed = true;
      let staleCloses = 0;
      provider.on('status', ({ status }: { status: string }) => {
        if (status !== 'disconnected' || !armed) return;
        armed = false;
        replacement = provider.connect();
      });
      provider.on('close', () => {
        staleCloses += 1;
      });
      latest().close();
      expect(sockets).toHaveLength(2);
      expect(staleCloses).toBe(0);
      expect(provider.status).toBe('connecting');
      latest().open();
      latest().ping();
      await replacement;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(sockets).toHaveLength(2);
      expect(provider.status).toBe('connected');
    });
  });

  it('keeps a replacement owned when a terminal attempt status callback reconnects', async () => {
    await retryFixture(async ({ provider, sockets, latest }) => {
      provider.setConfiguration({ timeout: 100, maxAttempts: 1 });
      let replacement: Promise<unknown> | undefined;
      let armed = true;
      const statuses: string[] = [];
      provider.on('status', ({ status }: { status: string }) => {
        if (status !== 'disconnected' || !armed) return;
        armed = false;
        replacement = provider.connect();
      });
      provider.on('status', ({ status }: { status: string }) => statuses.push(status));
      const expired = provider.connect();
      await vi.advanceTimersByTimeAsync(100);
      await expired;
      expect(sockets).toHaveLength(2);
      expect(statuses).toEqual(['connecting', 'connecting']);
      expect(provider.status).toBe('connecting');
      expect(provider.connectionAttempt).not.toBeNull();
      expect(provider.cancelWebsocketRetry).toBeTypeOf('function');
      latest().open();
      latest().ping();
      await replacement;
      expect(provider.status).toBe('connected');
      await vi.advanceTimersByTimeAsync(5_000);
      expect(sockets).toHaveLength(2);
    });
  });

  it('retains the configured attempt budget and reports exhaustion once without a leftover retry', async () => {
    await retryFixture(async ({ provider, sockets, latest }) => {
      provider.setConfiguration({ maxAttempts: 2 });
      const failed: unknown[] = [];
      provider.on('maxAttemptsFailed', ({ error }: { error: unknown }) => failed.push(error));
      const attempt = provider.connect();
      latest().fail();
      await vi.advanceTimersByTimeAsync(999);
      expect(sockets).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(sockets).toHaveLength(2);
      latest().fail();
      await attempt;
      expect(failed).toHaveLength(1);
      expect(failed[0]).toBeInstanceOf(Error);
      expect(provider.connectionAttempt).toBeNull();
      expect(provider.shouldConnect).toBe(false);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(sockets).toHaveLength(2);
      expect(failed).toHaveLength(1);
    });
  });
});
