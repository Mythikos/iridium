/**
 * `NoteSession` — one open note on one client (12-milestones.md section 5.2,
 * `@iridium/collab-client`; 05-collaboration-and-durability.md, *The Saved protocol*, *Client state
 * machine*, *Reconnection semantics*, *Role change on a live connection*; 07-client-applications.md
 * section 5.2).
 *
 * The session is the durable object of the client: the `Y.Doc`, its `Y.Text`, the undo manager and
 * the last caret survive every provider, every reconnect and every `EditorView`, because a
 * `y-codemirror.next` view is disposable and a document is not (07 section 5.2, issue #36). A
 * provider, by contrast, is created and destroyed several times over a session's life — on a role
 * upgrade, after a transient close, after a ticket outage — which is why everything that must
 * survive lives in fields here rather than in the provider's configuration.
 *
 * The split with `save-state.ts` is deliberate and load-bearing: that module is a pure rule table
 * over a snapshot and owns no clock, and this one owns every timer, every retry and every side
 * effect. `reduceSaveInput` is the only way a signal becomes state, so there is exactly one path
 * from a wire message to what the indicator says (10-testing-and-quality.md, `save-state.machine.prop`).
 *
 * What the session deliberately does **not** own: the ticket batch (it holds a `TicketSource`, and
 * the REST client belongs to the host) and the session probe after a `revoked` or `unauthorized`
 * close (`onSessionProbe` hands that to the host, because only a `GET /auth/me` decides whether the
 * sign-in screen is right — 07-client-applications.md D07-40).
 */

import type { CloseEvent } from '@hocuspocus/common';
import {
  HocuspocusProvider,
  type HocuspocusProviderWebsocket,
  WebSocketStatus,
} from '@hocuspocus/provider';
import {
  CollabCloseReason,
  LIMITS,
  noteDocName,
  type NoteId,
  type PresenceMode,
  type Role,
  ROLES,
  type SaveStateInput,
  type ServerNoteMessage,
  type UserId,
} from '@iridium/contracts';
import {
  createNoteDoc,
  deleteSetFingerprint,
  createUndoManager,
  encodeState,
  FRAME_TYPE,
  peekFrame,
  peekStatelessPayload,
  getContent,
  type NoteDoc,
  type NoteText,
  type NoteUndoManager,
  stateVector,
  type StateVector as CrdtStateVector,
} from '@iridium/crdt';

import { type CollabClock, type CollabTimer, reattachDelayMs, systemCollabClock } from './clock.ts';
import { closePolicy } from './close-policy.ts';
import { baselinePayload, flushPayload, receiveNoteStateless } from './messages.ts';
import {
  DOMINANCE_DEADLINE_MS,
  initialSaveInput,
  reduceSaveInput,
  type SaveEvent,
  type SaveState,
  saveState,
  warnsBeforeUnload,
} from './save-state.ts';
import { createTicketGetter, type TicketSource } from './tickets.ts';

/** The provider may relay peer timeout removals; Iridium grants presence ownership per connection. */
class NotePresenceProvider extends HocuspocusProvider {
  override onMessage(event: Parameters<HocuspocusProvider['onMessage']>[0]): void {
    const data: unknown = event.data;
    const bytes =
      data instanceof Uint8Array ? data : data instanceof ArrayBuffer ? new Uint8Array(data) : null;
    if (bytes === null || peekFrame(bytes)?.type !== FRAME_TYPE.queryAwareness) {
      super.onMessage(event);
      return;
    }
    // Hocuspocus answers a query with every cached state. Iridium may display those peers, but
    // only this connection's clientID can be published back under its authenticated identity.
    if (this.awareness?.getLocalState() != null) {
      this.awarenessUpdateHandler(
        { added: [], updated: [this.document.clientID], removed: [] },
        null,
      );
    }
  }

  override awarenessUpdateHandler(
    changes: {
      readonly added: readonly number[];
      readonly updated: readonly number[];
      readonly removed: readonly number[];
    },
    origin: unknown,
  ): void {
    const ownId = this.document.clientID;
    const ownChanges = {
      added: changes.added.filter((clientId) => clientId === ownId),
      updated: changes.updated.filter((clientId) => clientId === ownId),
      removed: changes.removed.filter((clientId) => clientId === ownId),
    };
    if (ownChanges.added.length + ownChanges.updated.length + ownChanges.removed.length === 0)
      return;
    super.awarenessUpdateHandler(ownChanges, origin);
  }
}
// ---- the session's own types --------------------------------------------------------------------

/** The complete, server-authoritative participant list entry (09-api-reference.md section 3.4). */
export type NoteParticipant = Extract<ServerNoteMessage, { t: 'participants' }>['users'][number];

/**
 * The caret the session carries across `EditorView` rebuilds (07-client-applications.md section 5.2).
 *
 * `anchor` and `head` are Yjs *relative* positions, which are opaque here for the same reason they
 * are `z.unknown()` in `AwarenessState`: resolving one needs yjs, so only `@iridium/editor` ever
 * looks inside. The session's job is to keep them alive while views come and go.
 */
export interface NoteSelection {
  readonly anchor: unknown;
  readonly head: unknown;
  readonly scrollLine: number;
}

/** Where the session reports what it could not handle. The host supplies pino, or nothing. */
export interface CollabLog {
  warn(event: string, detail: Record<string, unknown>): void;
  error(event: string, detail: Record<string, unknown>): void;
}

const SILENT_LOG: CollabLog = Object.freeze({
  warn(): void {
    /* the default host has no logger; the session's observable state is the report */
  },
  error(): void {
    /* see above */
  },
});

// ---- policy constants (05-collaboration-and-durability.md) --------------------------------------

/** `Y.UndoManager` capture window: 500 ms (07-client-applications.md section 5.2). */
const UNDO_CAPTURE_TIMEOUT_MS = 500;

/**
 * How long the indicator may sit in `syncing` with nothing unsynced before the session re-requests
 * the baseline once (05-collaboration-and-durability.md, *The baseline*, D05-05). One request, then
 * back to waiting: a dropped broadcast becomes a one-round-trip delay instead of a stuck pill.
 */
const BASELINE_REREQUEST_MS = 5_000;

/** The grace window a `closing` message asks for when the server sends none. */
const DEFAULT_CLOSING_GRACE_MS = 2_000;

/** Role order, for deciding whether a `{t:'role'}` message upgraded the connection (A20). */
function roleRank(role: Role): number {
  return ROLES.indexOf(role);
}

// ---- the provider's event surface --------------------------------------------------------------

/**
 * The provider events the session listens to, and the payload each carries.
 *
 * `HocuspocusProvider` extends an untyped `EventEmitter` (`on(event: string, fn: Function)`), so
 * this is the one place where the library's event names meet Iridium's types; every listener below
 * is registered through `onProvider`, and nothing else in the package touches `provider.on`. The
 * payload shapes are 4.7.0's `onStatusParameters`, `onSyncedParameters` and their siblings, written
 * out here because the package compiles with `types: []` and those declarations reach into the DOM
 * lib for the events this session never reads.
 */
interface ProviderEvents {
  readonly status: { readonly status: SaveStateInput['socket'] };
  /** The socket opened. Its payload is the host's own event object, which nothing here reads. */
  readonly open: { readonly event: unknown };
  readonly synced: { readonly state: boolean };
  readonly authenticated: { readonly scope: 'read-write' | 'readonly' };
  readonly authenticationFailed: { readonly reason: string };
  readonly unsyncedChanges: { readonly number: number };
  readonly stateless: { readonly payload: string };
  readonly close: { readonly event: CloseEvent };
}

function onProvider<TEvent extends keyof ProviderEvents>(
  provider: HocuspocusProvider,
  event: TEvent,
  listener: (data: ProviderEvents[TEvent]) => void,
): void {
  provider.on(event, listener);
}

// ---- the session -------------------------------------------------------------------------------

/** Everything a `NoteSession` needs. */
export interface NoteSessionOptions {
  readonly noteId: NoteId;
  /** The authenticated user, published as `AwarenessState.user.id` and checked on every message. */
  readonly userId: UserId;
  /** The window's single multiplexed socket (09-api-reference.md section 3.1). */
  readonly socket: HocuspocusProviderWebsocket;
  readonly tickets: TicketSource;
  /** The role the membership says; `Authenticated {scope}` and `{t:'role'}` correct it. */
  readonly role?: Role;
  readonly clock?: CollabClock;
  readonly random?: () => number;
  readonly log?: CollabLog;
  /** `Y.Doc` garbage collection; `true` everywhere in Iridium (A17). */
  readonly gc?: boolean;
  /**
   * The provider's outgoing batching window. Set through options and never monkey-patched, so a
   * test drives the same code path the product runs (10-testing-and-quality.md, `NoteClient`).
   */
  readonly flushDelay?: false | number;
  /**
   * Called after a close whose policy says the session must be re-checked, with exactly one
   * `GET /auth/me` (07-client-applications.md D07-40). The close is never itself evidence about the
   * session, so this package reports and the host decides.
   */
  readonly onSessionProbe?: (reason: CollabCloseReason) => void;
}

/** What a subscriber sees. Every member changes only through `#settle`, so the object is stable. */
export interface NoteSnapshot {
  readonly saveState: SaveState;
  readonly role: Role;
  readonly participants: readonly NoteParticipant[];
  /** The provider is detached and will not come back without a human action (D05-25, D07-15). */
  readonly dormant: boolean;
  /** A close this client could not classify, for the generic "closed by the server" banner. */
  readonly closeDetail: string | null;
  /** `beforeunload` (web) and the Electron `close` handler warn while this is true. */
  readonly warnsBeforeUnload: boolean;
}

/**
 * One open note: the document, the provider that carries it, and the save state that is a pure
 * function of what the two of them report.
 */
export class NoteSession {
  readonly #noteId: NoteId;
  readonly #userId: UserId;
  readonly #socket: HocuspocusProviderWebsocket;
  readonly #token: () => Promise<string>;
  readonly #tickets: TicketSource;
  #lastTicket: string | null = null;
  #latestTicketRequest: symbol | null = null;
  readonly #clock: CollabClock;
  readonly #random: () => number;
  readonly #log: CollabLog;
  readonly #onSessionProbe: ((reason: CollabCloseReason) => void) | null;
  readonly #flushDelay: false | number;
  readonly #ydoc: NoteDoc;
  readonly #ytext: NoteText;
  readonly #undo: NoteUndoManager;
  readonly #listeners = new Set<() => void>();
  /** Close reasons whose policy allows one attempt and that have already had it. */
  readonly #retriedOnce = new Set<CollabCloseReason>();

  #provider: HocuspocusProvider | null = null;
  #input: SaveStateInput;
  #snapshot: NoteSnapshot;
  #participants: readonly NoteParticipant[] = [];
  #lastSelection: NoteSelection | null = null;
  #presence: { cursor?: unknown; mode?: PresenceMode } = {};
  #closeDetail: string | null = null;
  #closingGraceMs = DEFAULT_CLOSING_GRACE_MS;
  #attempt = 0;
  #reattachTimer: CollabTimer | null = null;
  #deadlineTimer: CollabTimer | null = null;
  #baselineTimer: CollabTimer | null = null;
  #baselineProbed = false;
  #dormant = false;
  #disposed = false;
  #cancelCloseHandshake: (() => void) | null = null;
  #attachAfterClose = false;

  constructor(options: NoteSessionOptions) {
    this.#noteId = options.noteId;
    this.#userId = options.userId;
    this.#socket = options.socket;
    this.#clock = options.clock ?? systemCollabClock;
    this.#random = options.random ?? Math.random;
    this.#log = options.log ?? SILENT_LOG;
    this.#onSessionProbe = options.onSessionProbe ?? null;
    this.#flushDelay = options.flushDelay ?? false;
    this.#tickets = options.tickets;
    const getTicket = createTicketGetter({
      source: options.tickets,
      clock: this.#clock,
      random: this.#random,
    });
    this.#token = async () => {
      const request = Symbol();
      this.#latestTicketRequest = request;
      const ticket = await getTicket();
      // An older socket's slow ticket request cannot replace the credential used by its successor.
      if (this.#latestTicketRequest === request) this.#lastTicket = ticket;
      return ticket;
    };
    this.#ydoc = createNoteDoc(options.gc === undefined ? undefined : { gc: options.gc });
    this.#ytext = getContent(this.#ydoc);
    this.#undo = createUndoManager(this.#ytext, { captureTimeout: UNDO_CAPTURE_TIMEOUT_MS });
    this.#input = initialSaveInput({
      role: options.role ?? 'viewer',
      localSv: stateVector(this.#ydoc),
      localDs: deleteSetFingerprint(this.#ydoc),
      now: this.#clock.now(),
    });
    this.#snapshot = this.#buildSnapshot();
    this.#ydoc.on('update', this.#onDocumentUpdate);
  }

  // ---- what the document is ----

  /** The note's document. One per note per window, for the life of the session (05, A17). */
  get ydoc(): NoteDoc {
    return this.#ydoc;
  }

  /** The note body. */
  get ytext(): NoteText {
    return this.#ytext;
  }

  /** The live provider, or `null` while the session is detached, dormant or terminal. */
  get provider(): HocuspocusProvider | null {
    return this.#provider;
  }

  /**
   * The undo manager, which outlives every `EditorView` (07-client-applications.md section 5.2).
   *
   * It exists for the life of the session rather than being installed by whoever mounts a view, so
   * undo history survives tab switches, mode switches and reconnects, and `yCollab` is handed an
   * instance that has been tracking this document since it was opened.
   */
  get undoManager(): NoteUndoManager {
    return this.#undo;
  }

  /** The caret to restore when a view is rebuilt. */
  get lastSelection(): NoteSelection | null {
    return this.#lastSelection;
  }

  /** Record the caret before a view is destroyed. */
  setLastSelection(selection: NoteSelection | null): void {
    this.#lastSelection = selection;
  }

  // ---- what the session reports ----

  /** The indicator (05-collaboration-and-durability.md, *Client state machine*). */
  get saveState(): SaveState {
    return this.#snapshot.saveState;
  }

  /** The snapshot `useSyncExternalStore` reads; the reference changes only when a member does. */
  get snapshot(): NoteSnapshot {
    return this.#snapshot;
  }

  /** The inputs the state is computed from, for tests and for diagnostics. @internal */
  get input(): SaveStateInput {
    return this.#input;
  }

  /** Subscribe to snapshot changes; the returned function unsubscribes. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return (): void => {
      this.#listeners.delete(listener);
    };
  }

  // ---- attaching and detaching ----

  /**
   * Attach a provider for this note: measure the delta, take a fresh ticket, hand the document to
   * the shared socket.
   *
   * Step 0 of *Reconnection semantics* happens before the provider exists, and it is the only point
   * at which a client can refuse to send: `writeSyncStep2` emits one `Y.encodeStateAsUpdate(doc, sv)`
   * for the whole offline delta, which `insertChunked` cannot bound because it bounds updates and
   * not handshakes. A delta above `YJS_UPDATE_MAX_BYTES` therefore ends the session in `too-large`
   * with the text still readable and exportable, instead of a close/reconnect loop against a frame
   * the server will refuse every time.
   */
  attach(): void {
    if (this.#disposed || this.#provider !== null) return;
    this.#cancelReattach();
    if (this.#cancelCloseHandshake !== null) {
      this.#attachAfterClose = true;
      return;
    }

    // The re-seed comes first so that both outcomes are described by the new attachment: a document
    // refused for its delta reports `too-large` rather than whatever transient close sent it here.
    this.#dormant = false;
    this.#reseed();

    if (this.#deltaExceedsUpdateCap()) {
      this.#log.error('collab.oversize-frame', { noteId: this.#noteId, kind: 'sync-step-2' });
      this.#apply({ e: 'oversizeDelta' });
      return;
    }

    const provider = new NotePresenceProvider({
      name: noteDocName(this.#noteId),
      document: this.#ydoc,
      websocketProvider: this.#socket,
      token: this.#token,
      // A41: awareness is per document, so the document name is the routing key and the server's
      // `parseDocName` sees exactly `note:<uuid>`.
      sessionAwareness: false,
      flushDelay: this.#flushDelay,
    });
    this.#provider = provider;
    this.#registerListeners(provider);
    // The socket emits `status` only when it changes, so a document attached to an already-open
    // socket would never hear one and would sit in `connecting` for ever. The current status is
    // read once here; every later move arrives as an event.
    this.#apply({ e: 'status', socket: this.#socket.status });
    provider.attach();
    this.#publishPresenceFields();
    this.#settle();
  }

  /**
   * Detach and destroy the provider, leaving the document, the undo history and the caret alone.
   *
   * Destroying the provider is what sends the document's `CLOSE` frame and frees the user's
   * attachment on the server, which is why a dormant session releases its provider rather than
   * merely ignoring it.
   */
  detach(notifyServer = true): void {
    const provider = this.#provider;
    if (provider === null) return;
    this.#provider = null;
    if (
      notifyServer &&
      !this.#disposed &&
      provider.isAuthenticated &&
      this.#socket.status === WebSocketStatus.Connected
    ) {
      this.#waitForCloseHandshake();
    }
    // The server has already removed a refused attachment. A second CLOSE can race the next
    // authentication and close its replacement; dispose locally before flushing awareness/updates.
    if (!notifyServer) provider.detach(false);
    provider.destroy();
  }

  /**
   * A routing key has one attachment generation. Hocuspocus echoes the old provider's CLOSE after
   * removing its server connection; attaching sooner lets that echo reset the replacement. Keep
   * the key vacant until the echo arrives, or until the socket closes and all old attachments die.
   */
  #waitForCloseHandshake(): void {
    const finish = (): void => {
      this.#cancelCloseHandshake?.();
      if (!this.#attachAfterClose) return;
      this.#attachAfterClose = false;
      this.attach();
    };
    const onMessage = ({ data }: { readonly data: unknown }): void => {
      const bytes =
        data instanceof Uint8Array
          ? data
          : data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : null;
      if (bytes === null) return;
      const header = peekFrame(bytes);
      if (header?.documentName !== noteDocName(this.#noteId) || header.type !== FRAME_TYPE.close)
        return;
      if (peekStatelessPayload(bytes, header) !== 'provider_initiated') return;
      finish();
    };
    const onStatus = ({ status }: { readonly status: SaveStateInput['socket'] }): void => {
      if (status !== 'connected') finish();
    };
    this.#cancelCloseHandshake = (): void => {
      this.#socket.off('message', onMessage);
      this.#socket.off('status', onStatus);
      this.#cancelCloseHandshake = null;
    };
    this.#socket.on('message', onMessage);
    this.#socket.on('status', onStatus);
  }

  /** Release everything with a lifetime. The session is unusable afterwards. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#cancelCloseHandshake?.();
    this.#attachAfterClose = false;
    this.#cancelReattach();
    this.#cancelDeadline();
    this.#cancelBaselineProbe();
    this.detach();
    this.#ydoc.off('update', this.#onDocumentUpdate);
    this.#undo.destroy();
    this.#listeners.clear();
    this.#ydoc.destroy();
  }

  // ---- what the client sends ----

  /**
   * Ask for a `persisted` on this connection (skeleton A19). Sent after every `synced` event, and
   * once more by the stall probe of D05-05.
   */
  requestBaseline(): void {
    if (this.#provider === null) return;
    this.#provider.sendStateless(baselinePayload());
    this.#apply({ e: 'baselineSent' });
  }

  /**
   * Force compaction and projection now (Ctrl/Cmd+S).
   *
   * Over the per-connection budget the server answers with the current `projected {seq}` and never
   * with `persist-failed`, so a redundant save on a committed note cannot turn the pill red
   * (05-collaboration-and-durability.md, *Forcing currency*).
   */
  flush(): void {
    this.#provider?.sendStateless(flushPayload());
  }

  /**
   * Publish this client's presence: `{user: {id}, cursor?, mode?}` and nothing else.
   *
   * Names, colours and roles are never published — the UI maps them from the `participants` message
   * — so a client cannot present an identity it chose itself (skeleton A25/F6). `user.id` is
   * re-validated against the authenticated user on every message server-side, and a mismatch closes
   * the connection with `awareness-spoof`.
   */
  publishPresence(presence: { readonly cursor?: unknown; readonly mode?: PresenceMode }): void {
    this.#presence = {
      ...(presence.cursor === undefined ? {} : { cursor: presence.cursor }),
      ...(presence.mode === undefined ? {} : { mode: presence.mode }),
    };
    this.#publishPresenceFields();
  }

  // ---- provider wiring ----

  #registerListeners(provider: HocuspocusProvider): void {
    onProvider(provider, 'status', ({ status }) => {
      this.#apply({ e: 'status', socket: status });
    });
    onProvider(provider, 'open', () => {
      // A reopened socket re-runs this document's handshake: the provider sends a fresh ticket and
      // a new `SyncStep1` before anything else. Without folding it, a session that was `saved` when
      // the socket dropped would still be holding `synced` and `authenticated` when it came back,
      // and would claim `saved` for a connection that has not re-authorized yet.
      this.#apply({ e: 'open' });
    });
    onProvider(provider, 'authenticated', ({ scope }) => {
      // 09-api-reference.md section 3.9: `role` is seeded from `Authenticated {scope}` and corrected
      // by the `role` message. A `readonly` scope is exactly `viewer`; a `read-write` scope only
      // says "at least editor", so it lifts a `viewer` seed and leaves a manager alone.
      const seeded: Role =
        scope === 'readonly'
          ? 'viewer'
          : this.#input.role === 'viewer'
            ? 'editor'
            : this.#input.role;
      this.#apply({ e: 'authenticated' }, { e: 'role', role: seeded });
    });
    onProvider(provider, 'synced', ({ state }) => {
      if (!state) return;
      this.#attempt = 0;
      this.#retriedOnce.clear();
      this.#baselineProbed = false;
      this.#apply({ e: 'synced' });
      this.requestBaseline();
    });
    onProvider(provider, 'unsyncedChanges', ({ number }) => {
      this.#apply({ e: 'unsyncedChanges', n: number });
    });
    onProvider(provider, 'stateless', ({ payload }) => {
      this.#onStateless(payload);
    });
    onProvider(provider, 'authenticationFailed', ({ reason }) => {
      this.#onRefusal(reason, 'auth-denied');
    });
    onProvider(provider, 'close', ({ event }) => {
      this.#onRefusal(event.reason, 'close-frame');
    });
  }

  #onStateless(payload: string): void {
    const intake = receiveNoteStateless(payload, this.#clock.now());
    if (intake.kind === 'ignored') return; // forward compatibility (09-api-reference.md section 7.2)
    if (intake.kind === 'invalid') {
      this.#log.warn('collab.stateless-rejected', {
        noteId: this.#noteId,
        reason: intake.reason,
        detail: intake.detail,
      });
      return;
    }

    const message = intake.message;
    if (message.t === 'persisted') this.#baselineProbed = false;
    if (message.t === 'participants') this.#participants = message.users;
    if (message.t === 'closing') this.#closingGraceMs = message.graceMs;

    // Read before the fold, because the fold is what makes the two roles equal.
    const needsResync =
      message.t === 'role' &&
      (message.recovered === true || roleRank(message.role) > roleRank(this.#input.role));

    this.#apply(...intake.events);
    // Three messages carry no save-state input at all (09-api-reference.md section 3.9) and two of
    // them still change what a subscriber sees, so the snapshot is rebuilt here rather than only
    // where an event was folded.
    this.#settle();

    // The re-attach of skeleton A20 happens after the fold, so a new handshake resends refused local edits and resets document latches only after explicit
    // resolved write barrier. An ordinary membership notification cannot clear an invalid-content latch.
    if (needsResync) this.#reattachForWriteAccess();
  }

  /**
   * A per-document refusal: a `CLOSE(7)` frame, or a `PermissionDenied` the provider reports as
   * `authenticationFailed`.
   *
   * The same listener sees the socket's own close, which carries no Iridium reason: the `status`
   * event has already moved `socket` to `disconnected`, rule 8 already says `disconnected`, and
   * there is nothing for a close policy to decide, so an unclassifiable reason is recorded for the
   * banner and nothing else happens (05-collaboration-and-durability.md, *Message schemas*: the
   * reason string is the contract, and an unknown one is never guessed at).
   */
  #onRefusal(reason: string, via: 'close-frame' | 'auth-denied'): void {
    const parsed = CollabCloseReason.safeParse(reason);
    if (!parsed.success) {
      this.#closeDetail = reason === '' ? null : reason;
      this.#settle();
      return;
    }
    this.#closeDetail = null;
    this.#apply({ e: 'close', reason: parsed.data, via });

    const policy = closePolicy(parsed.data, via);
    this.detach(false);
    this.#dormant = policy.dormant;
    if (policy.probesSession) this.#onSessionProbe?.(parsed.data);

    if (policy.reattach === 'never') {
      this.#settle();
      return;
    }
    if (policy.reattach === 'once') {
      if (this.#retriedOnce.has(parsed.data)) {
        this.#settle();
        return;
      }
      this.#retriedOnce.add(parsed.data);
    }
    if (parsed.data === 'unauthorized' && this.#lastTicket !== null) {
      this.#tickets.invalidate(this.#lastTicket);
      this.#lastTicket = null;
    }
    this.#scheduleReattach(policy.when);
  }

  /**
   * Skeleton A20: a role upgrade or resolved write barrier needs a fresh provider on the same `Y.Doc`.
   *
   * Flipping `readOnly` server-side is not enough — the provider has already counted its refused
   * updates in `unsyncedChanges` and will never resend them, so the indicator would stay stuck and
   * the text the viewer typed would never reach the server. A fresh provider re-runs
   * `SyncStep1`/`SyncStep2` over the document, which still holds every one of those edits.
   */
  #reattachForWriteAccess(): void {
    this.detach();
    this.attach();
  }

  #scheduleReattach(when: 'immediate' | 'backoff' | 'grace'): void {
    this.#cancelReattach();
    this.#attempt += 1;
    const delay =
      when === 'immediate'
        ? 0
        : when === 'grace'
          ? this.#closingGraceMs
          : reattachDelayMs(this.#attempt, this.#random);
    this.#reattachTimer = this.#clock.after(delay, () => {
      this.#reattachTimer = null;
      this.attach();
    });
    this.#settle();
  }

  // ---- the document's own updates ----

  /**
   * Every update to the document, local or relayed.
   *
   * The origin decides which of the two events it is: the provider is the origin of everything it
   * applies from the wire, so anything else is this client's own edit. Both move `localSv`, because
   * dominance is checked over the whole vector and a relayed edit the writer has not committed yet
   * must hold the indicator back (05-collaboration-and-durability.md, *Definition*); only the local
   * one counts as unsaved work and restarts rule 12's deadline.
   */
  readonly #onDocumentUpdate = (_update: Uint8Array, origin: unknown): void => {
    const localSv = stateVector(this.#ydoc);
    const localDs = deleteSetFingerprint(this.#ydoc);
    if (this.#provider !== null && origin === this.#provider) {
      this.#apply({ e: 'remoteUpdate', localSv, localDs });
      return;
    }
    this.#apply({ e: 'localUpdate', localSv, localDs, at: this.#clock.now() });
  };

  // ---- state ----

  #apply(...events: SaveEvent[]): void {
    if (events.length === 0) return;
    let next = this.#input;
    for (const event of events) next = reduceSaveInput(next, event);
    this.#input = next;
    this.#settle();
  }

  /** Recompute the snapshot, re-arm the two deadlines, and notify only on an observable change. */
  #settle(): void {
    // A reconnect may have outlived the canceled timer. Every observation folds the current clock
    // before deciding whether the edit deadline is still in the future (D05-26).
    this.#input = reduceSaveInput(this.#input, { e: 'tick', now: this.#clock.now() });
    const next = this.#buildSnapshot();
    const previous = this.#snapshot;
    const changed =
      next.saveState !== previous.saveState ||
      next.role !== previous.role ||
      next.participants !== previous.participants ||
      next.dormant !== previous.dormant ||
      next.closeDetail !== previous.closeDetail ||
      next.warnsBeforeUnload !== previous.warnsBeforeUnload;
    if (changed) this.#snapshot = next;

    this.#armDominanceDeadline();
    this.#armBaselineProbe();

    if (!changed) return;
    for (const listener of this.#listeners) listener();
  }

  #buildSnapshot(): NoteSnapshot {
    return {
      saveState: saveState(this.#input),
      role: this.#input.role,
      participants: this.#participants,
      dormant: this.#dormant,
      closeDetail: this.#closeDetail,
      warnsBeforeUnload: warnsBeforeUnload(this.#input),
    };
  }

  /**
   * Rule 12's 15 s deadline, delivered as a `tick`.
   *
   * The rule table holds no timer (D05-26), so the session arms one for the moment the deadline
   * falls due and folds the clock in when it fires. A keystroke moves `lastLocalEditAt` forward, so
   * an armed timer can fire early; rule 12 then simply does not match and the timer is re-armed
   * from the new edit, which is cheaper than cancelling one per keystroke.
   */
  #armDominanceDeadline(): void {
    const editedAt = this.#input.lastLocalEditAt;
    // The deadline can only ever move `syncing` to `save-failed`, so no other state needs a timer,
    // and a deadline already in the past has either taken the state or cannot take it at all — a
    // note whose acknowledgement now dominates stays `syncing` on an unsynced count alone. Arming
    // for a due time that has passed would re-arm from inside its own callback.
    const due = editedAt === null ? 0 : editedAt + DOMINANCE_DEADLINE_MS + 1 - this.#clock.now();
    if (this.#snapshot.saveState !== 'syncing' || due <= 0) {
      this.#cancelDeadline();
      return;
    }
    if (this.#deadlineTimer !== null) return;
    this.#deadlineTimer = this.#clock.after(due, () => {
      this.#deadlineTimer = null;
      this.#apply({ e: 'tick', now: this.#clock.now() });
    });
  }

  /** D05-05: one baseline re-request after 5 s of `syncing` with nothing unsynced, then wait. */
  #armBaselineProbe(): void {
    const wanted =
      this.#provider !== null &&
      this.#snapshot.saveState === 'syncing' &&
      this.#input.unsynced === 0 &&
      !this.#baselineProbed;
    if (!wanted) {
      this.#cancelBaselineProbe();
      return;
    }
    if (this.#baselineTimer !== null) return;
    this.#baselineTimer = this.#clock.after(BASELINE_REREQUEST_MS, () => {
      this.#baselineTimer = null;
      this.#baselineProbed = true;
      this.requestBaseline();
    });
  }

  #cancelDeadline(): void {
    this.#deadlineTimer?.cancel();
    this.#deadlineTimer = null;
  }

  #cancelBaselineProbe(): void {
    this.#baselineTimer?.cancel();
    this.#baselineTimer = null;
  }

  #cancelReattach(): void {
    this.#reattachTimer?.cancel();
    this.#reattachTimer = null;
  }

  /**
   * The snapshot a fresh attachment starts from.
   *
   * A re-attach is a new snapshot rather than an event because `reduceSaveInput` never clears
   * `closeReason` — that is where "terminal" lives — and only the transient reasons of
   * `close-policy.ts` ever reach this path, so the reset can never resurrect a terminal document.
   * The document's edit time and committed baseline survive with its text and undo history. Only
   * connection state and explicitly resolved document latches are reset; replacement is no ack.
   */
  #reseed(): void {
    const previous = this.#input;
    this.#input = {
      ...initialSaveInput({
        role: previous.role,
        localSv: stateVector(this.#ydoc),
        localDs: deleteSetFingerprint(this.#ydoc),
        now: this.#clock.now(),
      }),
      persisted: previous.persisted,
      persistFailed: previous.persistFailed,
      projectedSeq: previous.projectedSeq,
      lastLocalEditAt: previous.lastLocalEditAt,
    };
    this.#baselineProbed = false;
  }

  #deltaExceedsUpdateCap(): boolean {
    const from = this.#input.persisted?.sv;
    if (from === undefined) return false;
    // The branding boundary of A14: the wire carries the acknowledged vector as bytes and
    // `@iridium/crdt` brands the same bytes.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above
    const acknowledged = from as CrdtStateVector;
    return encodeState(this.#ydoc, 1, acknowledged).byteLength > LIMITS.YJS_UPDATE_MAX_BYTES;
  }

  #publishPresenceFields(): void {
    const provider = this.#provider;
    if (provider === null) return;
    provider.setAwarenessField('user', { id: this.#userId });
    provider.setAwarenessField('cursor', this.#presence.cursor ?? null);
    if (this.#presence.mode !== undefined) provider.setAwarenessField('mode', this.#presence.mode);
  }
}
