/**
 * `NoteClient` — the real-wire collaboration client
 * (10-testing-and-quality.md, "Multi-client collaboration harness"; 12-milestones.md §5.2,
 * `@iridium/testkit`).
 *
 * The plan is explicit about what it is built on and why: *"Built on `@iridium/collab-client`'s
 * `NoteSession`, so integration and chaos tests exercise the exact provider, codec and
 * `SaveStateMachine` that ship in the UI"* and *"`saveState` is the product's `SaveStateMachine`, not
 * a reimplementation, so a bug in the indicator is a test failure rather than a divergence between
 * harness and UI."*
 *
 * The harness therefore owns exactly four things, and every one of them is something the product has
 * no reason to own:
 *
 * 1. the `Origin`-injecting WebSocket constructor (`origin-ws.ts`), because `ws` omits the header a
 *    browser sends and the CSWSH guard must run for real rather than be bypassed (skeleton A24);
 * 2. the ticket source, which is the real `POST /api/v1/auth/collab-tickets` with a real session
 *    (`auth/tickets.ts`) — there is no test-only authentication path;
 * 3. **observation**: the transition log, the decoded stateless log and the close log, none of which
 *    a product client keeps, plus the waiters that turn them into assertions with deadlines;
 * 4. **forgery**: `sendRaw` and the hand-built frames of `awareness-frame.ts`, which is how a test
 *    sends what a correct client never would.
 *
 * Everything else — the `Y.Doc`, the undo manager, the provider, the reconnect ladder, the save state
 * — is read off the product's `NoteSession` and is never re-implemented here.
 */

import { WebSocketStatus } from '@hocuspocus/provider';
import {
  base64ToBytes,
  createCollabSocket,
  NoteSession,
  receiveNoteStateless,
  type CollabClock,
  type CollabLog,
  type SaveState,
  type TicketSource,
} from '@iridium/collab-client';
import {
  COLLAB_CLOSE_CODES,
  CollabCloseReason,
  LIMITS,
  NoteId,
  noteDocName,
  UserId,
  type PresenceMode,
  type Role,
  type ServerNoteMessage,
} from '@iridium/contracts';
import { stateVector, type NoteDoc, type NoteText, type NoteUndoManager } from '@iridium/crdt';

import { DEFAULT_WAIT_TIMEOUT_MS, waitFor, type WaitOptions } from '../harness/deadline.ts';
import { countMarkers, createMarkerSequence, type MarkerSequence } from '../harness/markers.ts';
import { awarenessFrame, type AwarenessEntry } from './awareness-frame.ts';
import type { OriginWebSocketOptions, TestWebSocketConstructor } from './origin-ws.ts';
import { createOriginWebSocket } from './origin-ws.ts';

/** The window's single multiplexed socket, as `@iridium/collab-client` configures it. */
export type CollabSocket = ReturnType<typeof createCollabSocket>;

/** The live `HocuspocusProvider`, or `null` while the session is detached, dormant or terminal. */
export type CollabProvider = NoteSession['provider'];

/** One close this client observed, in the order the provider reported them. */
export interface NoteClientClose {
  /**
   * The WebSocket close code. A server `CLOSE(7)` frame reaches the provider as `1000` whatever the
   * Iridium code was (spike S2, recorded in `docs/spikes/S02-…`), which is exactly why the client
   * keys on the reason string; a socket-level close carries its real code.
   */
  readonly code: number;
  /** The reason verbatim, including one outside the vocabulary. */
  readonly reason: string;
  /** The same reason parsed, or `null` when the server sent one this version does not know. */
  readonly collabReason: CollabCloseReason | null;
  readonly via: 'close-frame' | 'auth-denied';
}

/** The received durable sequence, decoded struct vector and delete-set witness, without recomputation. */
export interface NoteAck {
  readonly seq: number;
  readonly sv: Uint8Array;
  readonly ds: string;
}

/** A predicate over the product's save state, or the state itself. */
export type SaveStateTarget = SaveState | ((state: SaveState) => boolean);

/**
 * The harness's view of one open note.
 *
 * Every member is either a view onto `NoteSession` or an observation the harness recorded; nothing
 * here computes a save state, a dominance decision or a reconnect delay of its own.
 */
export interface NoteClient {
  readonly userId: string;
  /** The session the ticket was minted from, when the caller knew it. */
  readonly sessionId: string | null;
  /** `note:<uuid>` — the routing key on the wire. */
  readonly documentName: string;
  /** The product session, for anything this interface does not surface. */
  readonly session: NoteSession;
  readonly ydoc: NoteDoc;
  readonly text: NoteText;
  readonly undo: NoteUndoManager;
  readonly provider: CollabProvider;
  /** `ydoc.clientID`, which is what an awareness frame claims and the spoof test forges. */
  readonly clientId: number;

  /** The product's current `SaveStateMachine` state. */
  readonly saveState: SaveState;
  /** Every state the machine passed through, oldest first, with no repeats. */
  readonly states: readonly SaveState[];
  /** Every decoded server → client stateless message, in arrival order. */
  readonly stateless: readonly ServerNoteMessage[];
  readonly closes: readonly NoteClientClose[];

  typeAt(position: number, text: string): void;
  deleteAt(position: number, length: number): void;
  /** Append `⟦tag:<n>⟧` and return it; the ordinal is this client's own sequence. */
  marker(tag: string): string;
  /** How many markers of a tag the text carries — the duplication oracle. */
  markerCount(tag: string): number;

  waitFor(target: SaveStateTarget, options?: WaitOptions): Promise<void>;
  /** Resolves on the next `persisted`, or on any `persisted` at or past `seq` when one is given. */
  waitForAck(seq?: number, options?: WaitOptions): Promise<NoteAck>;
  waitForStateless<T extends ServerNoteMessage['t']>(
    t: T,
    options?: WaitOptions,
  ): Promise<Extract<ServerNoteMessage, { t: T }>>;
  waitSynced(options?: WaitOptions): Promise<void>;
  waitClosed(options?: WaitOptions): Promise<NoteClientClose>;

  /** `Y.encodeStateVector(ydoc)` through `@iridium/crdt`, the only package that may call it. */
  sv(): Uint8Array;
  /** Drop the socket, keeping the document and its pending updates. */
  disconnectSocket(options?: WaitOptions): Promise<void>;
  /** Resume the shared transport within a deadline, retaining the session and pending edits. */
  reconnectSocket(options?: WaitOptions): Promise<void>;
  /** Raw bytes on the socket, for the hostile-client cases. */
  sendRaw(bytes: Uint8Array): void;
  /** A stateless payload, including a malformed one; a non-string is JSON-encoded first. */
  sendStateless(payload: unknown): void;
  /** Publish awareness fields through the provider, exactly as the product client does. */
  setAwareness(state: Readonly<Record<string, unknown>>): void;
  /** Publish presence through the session (`{user:{id}}` plus `cursor` and `mode`). */
  publishPresence(presence: { cursor?: unknown; mode?: PresenceMode }): void;
  /** A hand-built awareness frame, which is the only way to claim a foreign identity. */
  sendAwarenessFrame(entries: readonly AwarenessEntry[]): void;
  close(): Promise<void>;
}

export interface NoteClientOptions {
  /** `ws://127.0.0.1:<port>/collab`, from `TestServer.wsUrl`. Ignored when `socket` is given. */
  readonly wsUrl?: string;
  /** Share one window's socket across several notes; the sharer owns closing it. */
  readonly socket?: CollabSocket;
  /** The note this client opens. */
  readonly noteId: string;
  /** The authenticated user, published as `AwarenessState.user.id`. */
  readonly userId: string;
  /** The session the tickets belong to, recorded for assertions. */
  readonly sessionId?: string;
  /** Where tickets come from; `restTicketSource(client)` is the ordinary one. */
  readonly tickets: TicketSource;
  /** The role the membership says; `Authenticated {scope}` and `{t:'role'}` correct it. */
  readonly role?: Role;
  /**
   * The `Origin` header value. Defaults to the origin derived from `wsUrl`; `null` omits it and is
   * used only by `security.ws-origin.integration`, which asserts the server refuses it.
   */
  readonly origin?: string | null;
  /** `provider.configuration.flushDelay` — set through options, never monkey-patched. */
  readonly flushDelayMs?: false | number;
  /** Defaults to `LIMITS.WS_MAX_PAYLOAD_BYTES`, so an oversize frame is refused on both ends. */
  readonly maxPayload?: number;
  /** A real socket source address, for load distributed across independent test peers. */
  readonly localAddress?: string;
  /** Extra handshake headers, for the hostile-client cases. */
  readonly headers?: Readonly<Record<string, string>>;
  /** A `ManualClock` drives every client deadline without sleeping. */
  readonly clock?: CollabClock;
  readonly log?: CollabLog;
  /** `Y.Doc` garbage collection; `true` everywhere in Iridium (A17). */
  readonly gc?: boolean;
  /** Connect the socket on construction. Defaults to Hocuspocus's own `true`. */
  readonly autoConnect?: boolean;
}

/**
 * The WebSocket constructor a `NoteClient` hands to `@iridium/collab-client`'s injection point
 * (12-milestones.md §7.3). Exported because `startServer` and the vault-channel harness need the
 * same one.
 */
export function noteClientWebSocket(
  options: Pick<NoteClientOptions, 'origin' | 'headers' | 'maxPayload' | 'localAddress'> & {
    defaultOrigin: string;
  },
): TestWebSocketConstructor {
  const origin = options.origin === undefined ? options.defaultOrigin : options.origin;
  const wsOptions: OriginWebSocketOptions = {
    origin,
    ...(options.headers === undefined ? {} : { headers: options.headers }),
    maxPayload: options.maxPayload ?? LIMITS.WS_MAX_PAYLOAD_BYTES,
    ...(options.localAddress === undefined ? {} : { localAddress: options.localAddress }),
  };
  return createOriginWebSocket(wsOptions);
}

/**
 * The provider events the harness listens to.
 *
 * `HocuspocusProvider` extends an untyped emitter (`on(event: string, fn: Function)`), so this is the
 * one place where the library's event names meet the harness's types — the same shape
 * `@iridium/collab-client` uses, and for the same reason.
 */
interface ProviderEvents {
  readonly stateless: { readonly payload: string };
  readonly close: { readonly event: { readonly code: number; readonly reason: string } };
  readonly authenticationFailed: { readonly reason: string };
}

function onProvider<TEvent extends keyof ProviderEvents>(
  provider: NonNullable<CollabProvider>,
  event: TEvent,
  listener: (data: ProviderEvents[TEvent]) => void,
): void {
  provider.on(event, listener);
}

/** A narrowing that is a real check rather than an assertion, so `find` keeps its result type. */
function hasType<T extends ServerNoteMessage['t']>(
  message: ServerNoteMessage,
  t: T,
): message is Extract<ServerNoteMessage, { t: T }> {
  return message.t === t;
}

/** The origin a `ws://host:port/collab` URL implies, which is what `PUBLIC_ORIGIN` is in a test. */
function originFromWsUrl(wsUrl: string): string {
  const url = new URL(wsUrl);
  return `${url.protocol === 'wss:' ? 'https:' : 'http:'}//${url.host}`;
}

class LiveNoteClient implements NoteClient {
  readonly userId: string;
  readonly sessionId: string | null;
  readonly documentName: string;
  readonly session: NoteSession;

  readonly #socket: CollabSocket;
  readonly #ownsSocket: boolean;
  readonly #clock: CollabClock;
  readonly #states: SaveState[] = [];
  readonly #stateless: ServerNoteMessage[] = [];
  readonly #closes: NoteClientClose[] = [];
  readonly #hooked = new WeakSet<object>();
  readonly #markers = new Map<string, MarkerSequence>();
  readonly #unsubscribe: () => void;
  #closed = false;

  constructor(o: {
    session: NoteSession;
    socket: CollabSocket;
    ownsSocket: boolean;
    clock: CollabClock;
    userId: string;
    sessionId: string | null;
    documentName: string;
  }) {
    this.session = o.session;
    this.#socket = o.socket;
    this.#ownsSocket = o.ownsSocket;
    this.#clock = o.clock;
    this.userId = o.userId;
    this.sessionId = o.sessionId;
    this.documentName = o.documentName;
    this.#states.push(o.session.saveState);
    this.#unsubscribe = o.session.subscribe(() => {
      this.#observe();
    });
  }

  // ---- what the session is ----

  get ydoc(): NoteDoc {
    return this.session.ydoc;
  }

  get text(): NoteText {
    return this.session.ytext;
  }

  get undo(): NoteUndoManager {
    return this.session.undoManager;
  }

  get provider(): CollabProvider {
    this.#observe();
    return this.session.provider;
  }

  get clientId(): number {
    return this.session.ydoc.clientID;
  }

  // ---- what the harness observed ----

  get saveState(): SaveState {
    return this.session.saveState;
  }

  get states(): readonly SaveState[] {
    return this.#states;
  }

  get stateless(): readonly ServerNoteMessage[] {
    return this.#stateless;
  }

  get closes(): readonly NoteClientClose[] {
    return this.#closes;
  }

  /**
   * Record whatever changed, and make sure the current provider is being listened to.
   *
   * A session replaces its provider on a re-attach and on a role upgrade (A20), and the replacement
   * is not an event a subscriber is told about — so the hook-up is re-checked here, which every
   * snapshot change and every poll of every waiter calls. `#hooked` makes it idempotent.
   */
  #observe(): void {
    const state = this.session.saveState;
    if (this.#states.at(-1) !== state) this.#states.push(state);

    const provider = this.session.provider;
    if (provider === null || this.#hooked.has(provider)) return;
    this.#hooked.add(provider);

    onProvider(provider, 'stateless', ({ payload }) => {
      const intake = receiveNoteStateless(payload, this.#clock.now());
      if (intake.kind === 'message') this.#stateless.push(intake.message);
    });
    onProvider(provider, 'close', ({ event }) => {
      this.#recordClose(event.code, event.reason, 'close-frame');
    });
    onProvider(provider, 'authenticationFailed', ({ reason }) => {
      const parsed = CollabCloseReason.safeParse(reason);
      this.#recordClose(
        parsed.success ? COLLAB_CLOSE_CODES[parsed.data] : 0,
        reason,
        'auth-denied',
      );
    });
  }

  #recordClose(code: number, reason: string, via: NoteClientClose['via']): void {
    const parsed = CollabCloseReason.safeParse(reason);
    this.#closes.push({
      code,
      reason,
      collabReason: parsed.success ? parsed.data : null,
      via,
    });
  }

  #probe<T>(
    probe: () => T | undefined | false,
    description: string,
    options: WaitOptions,
  ): Promise<T> {
    return waitFor(
      () => {
        this.#observe();
        return probe();
      },
      {
        timeoutMs: options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS,
        ...(options.intervalMs === undefined ? {} : { intervalMs: options.intervalMs }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        description: `${description} on ${this.documentName}`,
      },
    );
  }

  // ---- editing ----

  typeAt(position: number, text: string): void {
    this.session.ytext.insert(position, text);
  }

  deleteAt(position: number, length: number): void {
    this.session.ytext.delete(position, length);
  }

  /**
   * Append the next marker for `tag` and return it.
   *
   * The ordinal is this client's own sequence, so a test that opens two clients gives each its own
   * tag — two clients sharing one tag would both write `⟦tag:1⟧`, and a duplication bug that copied
   * one of them would be invisible to `markerCount`.
   */
  marker(tag: string): string {
    let sequence = this.#markers.get(tag);
    if (sequence === undefined) {
      sequence = createMarkerSequence(tag);
      this.#markers.set(tag, sequence);
    }
    const marker = sequence.next();
    this.session.ytext.insert(this.session.ytext.length, marker);
    return marker;
  }

  markerCount(tag: string): number {
    // `Y.Text.toJSON()` is the typed spelling of `toString()`: both return the plain text, and only
    // the first is declared to return a string.
    return countMarkers(this.session.ytext.toJSON(), tag);
  }

  // ---- waiting ----

  async waitFor(target: SaveStateTarget, options: WaitOptions = {}): Promise<void> {
    const matches = typeof target === 'function' ? target : (s: SaveState): boolean => s === target;
    const from = this.#states.length;
    const description =
      typeof target === 'function' ? 'a matching save state' : `save state "${target}"`;
    await this.#probe(
      () => matches(this.session.saveState) || this.#states.slice(from).some(matches) || undefined,
      description,
      options,
    );
  }

  async waitForAck(seq?: number, options: WaitOptions = {}): Promise<NoteAck> {
    const acks = (): Extract<ServerNoteMessage, { t: 'persisted' }>[] =>
      this.#stateless.filter((message): message is Extract<ServerNoteMessage, { t: 'persisted' }> =>
        hasType(message, 'persisted'),
      );
    const from = seq === undefined ? acks().length : 0;
    const message = await this.#probe(
      () => {
        const seen = acks();
        return (seq === undefined ? seen[from] : seen.find((ack) => ack.seq >= seq)) ?? undefined;
      },
      seq === undefined ? 'the next persisted acknowledgement' : `persisted seq >= ${String(seq)}`,
      options,
    );
    const sv = base64ToBytes(message.sv);
    if (sv === null) {
      // The session refuses such a frame before it reaches this log, so reaching here would mean the
      // two decoders disagree — which is worth a sentence rather than an empty array.
      throw new Error(
        `@iridium/testkit: persisted seq ${String(message.seq)} carried a state vector that does not decode`,
      );
    }
    return { seq: message.seq, sv, ds: message.ds };
  }

  waitForStateless<T extends ServerNoteMessage['t']>(
    t: T,
    options: WaitOptions = {},
  ): Promise<Extract<ServerNoteMessage, { t: T }>> {
    const from = this.#stateless.length;
    return this.#probe(
      () =>
        this.#stateless
          .slice(from)
          .find((message): message is Extract<ServerNoteMessage, { t: T }> => hasType(message, t)),
      `a stateless "${t}" message`,
      options,
    );
  }

  async waitSynced(options: WaitOptions = {}): Promise<void> {
    await this.#probe(() => this.session.input.synced || undefined, 'the initial sync', options);
  }

  waitClosed(options: WaitOptions = {}): Promise<NoteClientClose> {
    const from = this.#closes.length;
    return this.#probe(() => this.#closes[from], 'the connection to close', options);
  }

  // ---- the wire ----

  sv(): Uint8Array {
    return stateVector(this.session.ydoc);
  }

  async disconnectSocket(options: WaitOptions = {}): Promise<void> {
    this.#socket.disconnect();
    await this.#probe(
      () => this.session.input.socket === 'disconnected' || undefined,
      'the socket to report disconnected',
      options,
    );
  }

  async reconnectSocket(options: WaitOptions = {}): Promise<void> {
    let started = false;
    let failure: { readonly error: unknown } | undefined;
    const failed = (error: unknown): void => {
      failure ??= { error };
    };
    // The provider reports exhausted attempts as an event and resolves its connect promise.
    const onFailed = ({ error }: { readonly error: unknown }): void => failed(error);
    this.#socket.on('maxAttemptsFailed', onFailed);
    try {
      const result = await this.#probe<true | { readonly error: unknown }>(
        () => {
          if (!started) {
            started = true;
            // Begin inside the probe: its deadline must already cover connection initiation.
            // Join the existing retry, including its backoff, without disrupting shared notes.
            if (
              this.#socket.status !== WebSocketStatus.Connected &&
              (!this.#socket.shouldConnect ||
                (this.#socket.status !== WebSocketStatus.Connecting &&
                  this.#socket.cancelWebsocketRetry === undefined))
            ) {
              try {
                // HTTP open precedes this promise's first-protocol-message resolution. Observe
                // transport status instead, while consuming even a rejection after our deadline.
                void this.#socket.connect().catch(failed);
              } catch (error) {
                failed(error);
              }
            }
          }
          return failure ?? (this.#socket.status === WebSocketStatus.Connected || undefined);
        },
        'the socket to reconnect',
        { ...options, timeoutMs: options.timeoutMs ?? 35_000 },
      );
      // A throwing probe means "not yet" to waitFor; a terminal failure must leave it as a value.
      if (result !== true) throw result.error;
    } finally {
      this.#socket.off('maxAttemptsFailed', onFailed);
    }
  }

  sendRaw(bytes: Uint8Array): void {
    this.#socket.send(bytes);
  }

  sendStateless(payload: unknown): void {
    const provider = this.provider;
    if (provider === null) {
      throw new Error(
        '@iridium/testkit: sendStateless needs an attached provider; the session is detached, dormant or terminal. Use sendRaw() to drive the socket directly.',
      );
    }
    provider.sendStateless(typeof payload === 'string' ? payload : JSON.stringify(payload));
  }

  setAwareness(state: Readonly<Record<string, unknown>>): void {
    const provider = this.provider;
    if (provider === null) {
      throw new Error('@iridium/testkit: setAwareness needs an attached provider');
    }
    for (const [key, value] of Object.entries(state)) provider.setAwarenessField(key, value);
  }

  publishPresence(presence: { cursor?: unknown; mode?: PresenceMode }): void {
    this.session.publishPresence(presence);
  }

  sendAwarenessFrame(entries: readonly AwarenessEntry[]): void {
    this.sendRaw(awarenessFrame({ documentName: this.documentName, entries }));
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#unsubscribe();
    this.session.dispose();
    if (this.#ownsSocket) this.#socket.destroy();
    // `dispose()` and `destroy()` are synchronous; the await gives the provider's CLOSE frame a turn
    // on the event loop before a suite tears the server down underneath it.
    await Promise.resolve();
  }
}

/**
 * Open one note over the real wire.
 *
 * It does **not** wait for the connection: construction is construction, and a test that means "wait
 * until this client has synced" says `await client.waitSynced()`. That matters for the refusal cases
 * — a viewer, a ninth document over the admission budget, a revoked session — where waiting inside
 * the factory would turn the behaviour under test into a timeout.
 */
export function createNoteClient(options: NoteClientOptions): NoteClient {
  if (options.socket === undefined && options.wsUrl === undefined) {
    throw new Error('@iridium/testkit: createNoteClient needs either a wsUrl or a shared socket');
  }

  const wsUrl = options.wsUrl;
  const socket =
    options.socket ??
    createCollabSocket({
      url: wsUrl ?? '',
      webSocketPolyfill: noteClientWebSocket({
        defaultOrigin: originFromWsUrl(wsUrl ?? ''),
        ...(options.origin === undefined ? {} : { origin: options.origin }),
        ...(options.headers === undefined ? {} : { headers: options.headers }),
        ...(options.maxPayload === undefined ? {} : { maxPayload: options.maxPayload }),
        ...(options.localAddress === undefined ? {} : { localAddress: options.localAddress }),
      }),
      ...(options.autoConnect === undefined ? {} : { autoConnect: options.autoConnect }),
    });

  const session = new NoteSession({
    noteId: NoteId.parse(options.noteId),
    userId: UserId.parse(options.userId),
    socket,
    tickets: options.tickets,
    ...(options.role === undefined ? {} : { role: options.role }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.log === undefined ? {} : { log: options.log }),
    ...(options.gc === undefined ? {} : { gc: options.gc }),
    ...(options.flushDelayMs === undefined ? {} : { flushDelay: options.flushDelayMs }),
  });

  const client = new LiveNoteClient({
    session,
    socket,
    ownsSocket: options.socket === undefined,
    clock: options.clock ?? { now: () => Date.now(), after: neverScheduled },
    userId: options.userId,
    sessionId: options.sessionId ?? null,
    documentName: noteDocName(options.noteId),
  });
  session.attach();
  return client;
}

/**
 * The clock the harness reads timestamps from when the caller injected none.
 *
 * Only `now()` is ever called on it — the timers belong to the session's own clock — so scheduling
 * through it is a harness bug and says so rather than silently never firing.
 */
function neverScheduled(): never {
  throw new Error(
    '@iridium/testkit: NoteClient schedules no timers of its own; pass a clock to NoteSession instead',
  );
}
