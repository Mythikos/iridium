/**
 * `createCollabServer` — the one `new Hocuspocus(` site and the `/collab` mount
 * (05-collaboration-and-durability.md, "Instance configuration", "Mounting on `/collab`", "Server
 * restart and recovery"; 02-system-architecture.md ARCH-06; spike S2).
 *
 * Hocuspocus is used through the `Hocuspocus` class, never the `Server` class: it is mounted on the
 * same Fastify instance, origin and port as REST, behind the same Origin allowlist and the same
 * shutdown drain. The route forwards `message` / `close` to `ClientConnection.handleMessage` /
 * `handleClose` — the S2 wiring — and applies these bounds before dispatch:
 *
 *  1. **the owner lease**: a process without `iridium_collab_owner` closes the socket `4503
 *     no-owner-lease` before any document is loaded, logging the denial once;
 *  2. **canonical routing**: bounded note/vault names and optional session suffixes are checked
 *     before either the rate limiter or Hocuspocus retains a key;
 *  3. **the awareness cap**: an `Awareness` (type 1) frame whose per-`(socket, documentName)` window
 *     is empty is dropped — never forwarded, never a close — because a Hocuspocus hook can only
 *     object by throwing (D05-18).
 *
 * The outbound side wraps the socket's `send` so the two post-acknowledgement fault points of the
 * chaos suite (`ws.drop-after-ack`, `store.kill-after-ack`) fire *after* a `persisted` frame reached
 * the wire, which is the only honest place for them.
 *
 * `closeAll` and `unloadAll` are the `collab` and `unload` phases of the drain: `closing` with the
 * 2 s grace, then `4205 shutdown`, then `flushPendingStores()` and a wait for the last document to
 * unload — bounded by the drain's own deadline, never here.
 */
import fastifyWebsocket from '@fastify/websocket';
import { Hocuspocus, type Extension, type WebSocketLike } from '@hocuspocus/server';
import { decodeServerNoteMessage, encodeStateless, LIMITS, parseDocName } from '@iridium/contracts';
import { FRAME_TYPE, peekFrame, peekStatelessPayload, type FrameHeader } from '@iridium/crdt';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type WebSocket from 'ws';

import type { IridiumConfig } from '../config/env.ts';
import type { Clock, TimerHandle } from '../ops/clock.ts';
import type { FaultAcknowledgement } from '../ops/faults.ts';
import type { CollabHookContext } from './context.ts';
import type { CollabLimits } from './limits.ts';
import type { CollabMetrics } from './metrics.ts';
import type { CollabOwnerLease } from './owner-lease.ts';
import { RateWindow } from './rate.ts';
import { CollabRejection, closeEventFor } from './rejection.ts';

/** The app-level `Ping(9)`/`Pong(10)` timeout; proxies must idle out later than this (11). */
export const HOCUSPOCUS_TIMEOUT_MS = 60_000;

/** How long a client has to copy unsent text out on shutdown (D05-12; ARCH-06). */
export const SHUTDOWN_GRACE_MS = 2_000;

/** How often `unloadAll` re-checks that the last document has left memory. */
const UNLOAD_POLL_MS = 50;

/** Milliseconds in one second, the awareness window. */
const ONE_SECOND_MS = 1_000;

/**
 * Hocuspocus's own defaults, kept explicit (A17). They are the library's queue shapes for
 * pre-authentication traffic, not Iridium caps: nothing pre-validates against them and nothing
 * publishes them.
 */
const HOCUSPOCUS_DEFAULTS = Object.freeze({
  pendingDocuments: 100,
  unauthenticatedQueueBytes: 5 * 1024 * 1024,
  unauthenticatedQueueMessages: 1000,
});

/**
 * Fixed awareness windows owned by one physical socket, including unauthenticated traffic.
 *
 * Names are canonical before this cache is reached. Capacity bounds a flood of distinct refused
 * attachments; expiry bounds retention even on an idle socket. An auth retry cannot reset a
 * document's quota, and all session suffixes share that document's window. @internal
 */
export class SocketAwarenessWindows {
  readonly #windows = new Map<
    string,
    { readonly window: RateWindow; readonly expiresAt: number }
  >();
  readonly #clock: Pick<Clock, 'now' | 'after'>;
  #timer: TimerHandle | null = null;
  #closed = false;

  constructor(clock: Pick<Clock, 'now' | 'after'>) {
    this.#clock = clock;
  }

  /** Counters retained by this socket, for bounded-resource diagnostics. */
  get size(): number {
    return this.#windows.size;
  }

  /** Excess frames and new keys at capacity are dropped; neither consumes another resource. */
  take(documentName: string): boolean {
    if (this.#closed) return false;
    const now = this.#clock.now();
    this.#expire(now);
    let entry = this.#windows.get(documentName);
    if (entry === undefined) {
      if (this.#windows.size >= LIMITS.AWARENESS_DOCUMENTS_PER_SOCKET) return false;
      entry = {
        window: new RateWindow(LIMITS.AWARENESS_MESSAGES_PER_SECOND, ONE_SECOND_MS),
        expiresAt: now + ONE_SECOND_MS,
      };
      this.#windows.set(documentName, entry);
      this.#arm(now);
    }
    return entry.window.take(now);
  }

  /** Closing the physical socket releases every entry and the sole expiry timer. */
  close(): void {
    this.#closed = true;
    this.#windows.clear();
    this.#timer?.cancel();
    this.#timer = null;
  }

  #expire(now: number): void {
    for (const [name, entry] of this.#windows) {
      if (entry.expiresAt <= now) this.#windows.delete(name);
    }
    if (this.#windows.size === 0) {
      this.#timer?.cancel();
      this.#timer = null;
    }
  }

  #arm(now: number): void {
    if (this.#timer !== null || this.#windows.size === 0) return;
    let earliest: number | null = null;
    for (const entry of this.#windows.values()) {
      earliest = earliest === null ? entry.expiresAt : Math.min(earliest, entry.expiresAt);
    }
    if (earliest === null) return;
    this.#timer = this.#clock.after(Math.max(0, earliest - now), () => {
      this.#timer = null;
      const current = this.#clock.now();
      this.#expire(current);
      this.#arm(current);
    });
  }
}

function canonicalRoutingKey(header: FrameHeader): boolean {
  if (parseDocName(header.documentName) === null) return false;
  if (header.routingKey === header.documentName) return true;
  const sessionId = header.routingKey.slice(header.documentName.length + 1);
  return (
    sessionId.length <= LIMITS.COLLAB_SESSION_ID_MAX_CHARS && /^[A-Za-z0-9_-]+$/u.test(sessionId)
  );
}

/** The fault registry slice the socket layer fires. */
export interface SocketFaults {
  readonly enabled: boolean;
  fire(
    point: string,
    connectionId?: string,
    acknowledgement?: FaultAcknowledgement,
  ): { readonly fired: boolean };
  crash(point: string, acknowledgement?: FaultAcknowledgement): void;
}

/** What the server needs. */
export interface CollabServerOptions {
  readonly config: IridiumConfig;
  readonly limits: CollabLimits;
  readonly clock: Clock;
  readonly logger: {
    info(fields: Readonly<Record<string, unknown>>, message: string): void;
    warn(fields: Readonly<Record<string, unknown>>, message: string): void;
  };
  readonly extensions: readonly Extension<CollabHookContext>[];
  readonly ownerLease: Pick<
    CollabOwnerLease,
    'held' | 'noteDenied' | 'captureGeneration' | 'isCurrent'
  >;
  readonly faults: SocketFaults;
  readonly metrics: () => CollabMetrics | null;
  /** The `preValidation` hooks of the upgrade: the Origin allowlist, then the socket caps. */
  readonly preValidation: ReadonlyArray<
    (request: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply | undefined | void>
  >;
  readonly wsConnections: () => {
    inc(labels: { doc_kind: string }): void;
    dec(labels: { doc_kind: string }): void;
  } | null;
}

/** One loaded document, as `loadedDocuments()` reports it. */
export interface LoadedDocumentInfo {
  readonly name: string;
  readonly connections: number;
}

/** The server as the plugin and the drain see it. */
export interface CollabServer {
  readonly hocuspocus: Hocuspocus<CollabHookContext>;
  mount(app: FastifyInstance): Promise<void>;
  loadedDocuments(): readonly LoadedDocumentInfo[];
  /** Retained awareness counters across physical sockets, for bounded-resource diagnostics. @internal */
  awarenessWindowCount(): number;
  /** The `collab` drain phase. */
  closeAll(): Promise<void>;
  /** The `unload` drain phase. */
  unloadAll(): Promise<void>;
  /** Immediately relatches every live connection, then closes its physical socket with 4503. */
  fenceConnections(): Promise<void>;
  /** Joins already-started loads before an old generation is unloaded. */
  settleLoads(): Promise<void>;
}

/** `IncomingHttpHeaders` → the `Headers` the Hocuspocus `Request` carries. */
export function toHeaders(raw: Readonly<Record<string, string | string[] | undefined>>): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else {
      headers.set(name, value);
    }
  }
  return headers;
}

/** `ws` hands a `Buffer`, a `Buffer[]` or an `ArrayBuffer`; Hocuspocus wants one `Uint8Array`. */
export function toUint8Array(data: WebSocket.RawData): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function outboundBytes(data: string | ArrayBufferLike | Blob | ArrayBufferView): Uint8Array | null {
  if (typeof data === 'string' || data instanceof Blob) return null;
  if (ArrayBuffer.isView(data))
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return new Uint8Array(data);
}

/** Decode the real note and sequence for the two post-acknowledgement fault points. */
function persistedAckOfFrame(bytes: Uint8Array): FaultAcknowledgement | null {
  const header = peekFrame(bytes);
  if (header === null || header.type !== FRAME_TYPE.stateless) return null;
  const note = parseDocName(header.documentName);
  if (note?.channel !== 'note') return null;
  const payload = peekStatelessPayload(bytes, header);
  if (payload === null) return null;
  const decoded = decodeServerNoteMessage(payload);
  return decoded.ok && decoded.message.t === 'persisted'
    ? { noteId: note.id, seq: decoded.message.seq }
    : null;
}

/** Builds the server. */
export function createCollabServer(options: CollabServerOptions): CollabServer {
  const { config, limits, clock, logger, faults } = options;

  const sockets = new Set<WebSocket>();
  const awarenessCounts = new Set<{ readonly size: number }>();
  const ownership: Extension<CollabHookContext> = {
    extensionName: 'IridiumOwnership',
    beforeSync: async ({ connection }) => {
      const generation = connection.context.ownerGeneration;
      if (generation === undefined || !options.ownerLease.isCurrent(generation)) {
        connection.readOnly = true;
        throw new CollabRejection('no-owner-lease');
      }
    },
  };
  const hocuspocus = new Hocuspocus<CollabHookContext>({
    name: 'iridium',
    timeout: HOCUSPOCUS_TIMEOUT_MS,
    debounce: config.collab.debounceMs,
    maxDebounce: config.collab.maxDebounceMs,
    unloadImmediately: true,
    yDocOptions: { gc: true, gcFilter: () => true },
    maxPendingDocuments: HOCUSPOCUS_DEFAULTS.pendingDocuments,
    maxUnauthenticatedQueueSize: HOCUSPOCUS_DEFAULTS.unauthenticatedQueueBytes,
    maxUnauthenticatedQueueMessages: HOCUSPOCUS_DEFAULTS.unauthenticatedQueueMessages,
    flushDelay: false,
    quiet: true,
    extensions: [ownership, ...options.extensions],
  });

  const mount = async (app: FastifyInstance): Promise<void> => {
    await app.register(fastifyWebsocket, {
      options: { maxPayload: limits.wsMaxPayloadBytes },
    });

    app.get(
      '/collab',
      {
        websocket: true,
        // Ticket-authenticated inside the protocol; the upgrade itself carries no credential. The
        // global REST limiter is switched off for the upgrade deliberately: the socket caps in
        // `collab/limits.ts` are the bound, and counting a window's reconnect storm as an anonymous
        // REST flood would refuse exactly the clients the caps exist to admit.
        config: { auth: { public: true }, rateLimit: false },
        preValidation: [...options.preValidation],
      },
      (socket, request) => {
        if (!options.ownerLease.held) {
          options.ownerLease.noteDenied();
          const refusal = closeEventFor('no-owner-lease');
          socket.close(refusal.code, refusal.reason);
          return;
        }

        const generation = options.ownerLease.captureGeneration();
        const current = (): boolean => options.ownerLease.isCurrent(generation);
        sockets.add(socket);
        const awarenessWindows = new SocketAwarenessWindows(clock);
        awarenessCounts.add(awarenessWindows);
        const socketId = request.id;
        const webRequest = new Request(`${config.server.publicOrigin.origin}${request.url}`, {
          headers: toHeaders(request.headers),
        });
        const wire: WebSocketLike = {
          get readyState(): number {
            return socket.readyState;
          },
          close: (code, reason) => {
            awarenessWindows.close();
            socket.close(code, reason);
          },
          send: (data) => {
            if (!current()) return;
            socket.send(data);
            if (!faults.enabled) return;
            const bytes = outboundBytes(data);
            const acknowledgement = bytes === null ? null : persistedAckOfFrame(bytes);
            if (acknowledgement === null) return;
            if (faults.fire('ws.drop-after-ack', socketId, acknowledgement).fired)
              socket.terminate();
            faults.crash('store.kill-after-ack', acknowledgement);
          },
        };
        const connection = hocuspocus.handleConnection(wire, webRequest, {
          ip: request.ip,
          requestId: socketId,
          connectedAt: clock.now(),
          ownerGeneration: generation,
        });
        options.wsConnections()?.inc({ doc_kind: 'note' });

        socket.on('message', (data: WebSocket.RawData) => {
          if (socket.readyState !== socket.OPEN) return;
          if (!current()) {
            const refusal = closeEventFor('no-owner-lease');
            socket.close(refusal.code, refusal.reason);
            return;
          }
          const bytes = toUint8Array(data);
          const header = peekFrame(bytes);
          // Validate the complete routing key before either our limiter or Hocuspocus retains it.
          // A valid normalized name must not conceal an unbounded or repeated-NUL session suffix.
          if (header === null || !canonicalRoutingKey(header)) {
            awarenessWindows.close();
            const refusal = closeEventFor('protocol-error');
            socket.close(refusal.code, refusal.reason);
            return;
          }
          if (header.type === FRAME_TYPE.awareness && !awarenessWindows.take(header.documentName)) {
            options.metrics()?.collabMessagesTotal.inc({ type: 'awareness_dropped' });
            return;
          }
          connection.handleMessage(bytes);
        });
        socket.on('close', (code: number, reason: Buffer) => {
          sockets.delete(socket);
          options.wsConnections()?.dec({ doc_kind: 'note' });
          awarenessWindows.close();
          awarenessCounts.delete(awarenessWindows);
          connection.handleClose({ code, reason: reason.toString() });
        });
        socket.on('error', (error: Error) => {
          if (error instanceof RangeError && error.message.includes('Max payload size exceeded')) {
            logger.warn(
              {
                event: 'collab.limit.exceeded',
                limit: 'WS_MAX_PAYLOAD_BYTES',
                requestId: socketId,
              },
              'a frame exceeded the WebSocket payload cap; ws closed the socket with 1009',
            );
            return;
          }
          logger.warn({ err: error, requestId: socketId }, 'collab.socket.error');
        });
      },
    );
  };

  const loadedDocuments = (): readonly LoadedDocumentInfo[] =>
    [...hocuspocus.documents.values()].map((document) => ({
      name: document.name,
      connections: document.getConnectionsCount(),
    }));

  const after = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      clock.after(ms, resolve);
    });

  const closeAll = async (): Promise<void> => {
    const closing = encodeStateless({
      v: 1,
      t: 'closing',
      reason: 'shutdown',
      graceMs: SHUTDOWN_GRACE_MS,
    });
    let noteDocuments = 0;
    for (const document of hocuspocus.documents.values()) {
      if (parseDocName(document.name)?.channel === 'vault') {
        for (const connection of document.getConnections())
          connection.close(closeEventFor('shutdown'));
        continue;
      }
      noteDocuments += 1;
      document.broadcastStateless(closing);
    }
    if (noteDocuments > 0) await after(SHUTDOWN_GRACE_MS);
    for (const document of hocuspocus.documents.values()) {
      for (const connection of document.getConnections())
        connection.close(closeEventFor('shutdown'));
    }
    logger.info(
      { event: 'shutdown.started', documents: noteDocuments },
      'collaboration connections closed',
    );
  };

  const fenceConnections = async (): Promise<void> => {
    for (const document of hocuspocus.documents.values()) {
      for (const connection of document.getConnections()) connection.readOnly = true;
    }
    const refusal = closeEventFor('no-owner-lease');
    await Promise.all(
      [...sockets].map(
        (socket) =>
          new Promise<void>((resolve) => {
            if (socket.readyState === socket.CLOSED) {
              resolve();
              return;
            }
            const deadline = clock.after(SHUTDOWN_GRACE_MS, () => socket.terminate());
            socket.once('close', () => {
              deadline.cancel();
              resolve();
            });
            socket.close(refusal.code, refusal.reason);
          }),
      ),
    );
  };

  const settleLoads = async (): Promise<void> => {
    // Load refusals are already handled by their owning auth request; this joins their lifetimes.
    await Promise.allSettled(hocuspocus.loadingDocuments.values());
  };

  const unloadAll = async (): Promise<void> => {
    hocuspocus.flushPendingStores();
    // The writers complete every vetoed unload themselves once they drain; this waits for the last
    // document to leave memory. The drain's deadline bounds it, so a writer parked in `failed` ends in
    // `persist.drain_timeout` rather than in an unbounded wait here.
    while (hocuspocus.documents.size > 0 || hocuspocus.unloadingDocuments.size > 0) {
      // A copy, because `unloadDocument` removes entries from the map being walked.
      const documents = Array.from(hocuspocus.documents.values());
      for (const document of documents) {
        if (hocuspocus.shouldUnloadDocument(document)) void hocuspocus.unloadDocument(document);
      }
      // eslint-disable-next-line no-await-in-loop -- a poll: each turn waits for the last unload
      await after(UNLOAD_POLL_MS);
    }
  };

  return {
    hocuspocus,
    mount,
    loadedDocuments,
    awarenessWindowCount: () =>
      [...awarenessCounts].reduce((total, windows) => total + windows.size, 0),
    closeAll,
    unloadAll,
    fenceConnections,
    settleLoads,
  };
}
