/**
 * The Hocuspocus 4.7.0 wire protocol as a k6 client, written against `@hocuspocus/server`'s
 * `MessageReceiver` and `OutgoingMessage` rather than against `@hocuspocus/provider`.
 *
 * Spike S6 asks whether `yjs`, `lib0` and `y-protocols/sync` survive an esbuild bundle under k6's
 * Sobek engine. `@hocuspocus/provider` itself is deliberately *not* bundled: it carries an
 * `EventEmitter`, a reconnect scheduler and a `WebSocket` abstraction that would answer a different
 * question. What is bundled is exactly the three libraries the register names, plus the ~90 lines of
 * framing that sit between them and the socket.
 *
 * Frame layout (identical in both directions):
 *
 *     varString(documentName) varUint(MessageType) <payload>
 *
 * `MessageType.Sync` and `MessageType.SyncReply` both carry a `y-protocols/sync` message; the server
 * answers a client `SyncStep1` with its own first sync step as a `SyncReply` *and* the `SyncStep2`
 * for the client's state vector as a `Sync`, in that order.
 */
import { WebSocket } from 'k6/websockets';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
/*
 * A14 confines `yjs` to @iridium/crdt so the server holds one module instance. This file is not server
 * code: it is the source of a k6 bundle that runs in another process under another engine, and
 * bundling `yjs` is the question S6 exists to answer. The load lane declares `yjs` itself, and
 * pnpm-workspace.yaml's `overrides` pin it to `catalog:`, so the copy that lands in the bundle is the
 * one copy the lockfile resolves — @iridium/crdt's own.
 */
// oxlint-disable-next-line no-restricted-imports -- see the comment above.
import * as Y from 'yjs';

/** `@hocuspocus/server`'s `MessageType`. `BroadcastStateless` is server-internal and never sent. */
export const MessageType = {
  Sync: 0,
  Awareness: 1,
  Auth: 2,
  QueryAwareness: 3,
  SyncReply: 4,
  Stateless: 5,
  BroadcastStateless: 6,
  CLOSE: 7,
  SyncStatus: 8,
};

/** `@hocuspocus/common`'s `AuthMessageType`. */
export const AuthMessageType = { Token: 0, PermissionDenied: 1, Authenticated: 2 };

/** The trailing `varString` of the `Auth` frame: the server records it as `providerVersion`. */
export const PROVIDER_VERSION = '4.7.0';

/** `@iridium/crdt`'s `CONTENT_KEY` — the single `Y.Text` of a note document. */
export const CONTENT_KEY = 'content';

/** Transaction origin for everything the socket applies, so the update listener does not echo it. */
export const REMOTE_ORIGIN = 'iridium.s06.remote';

/**
 * `encoding.toUint8Array` returns a fresh, exactly sized `Uint8Array`, so its `buffer` is the frame.
 * k6's `WebSocket.send` accepts a string or an `ArrayBuffer` and nothing else.
 */
function frame(encoder) {
  return encoding.toUint8Array(encoder).buffer;
}

function startFrame(documentName, type) {
  const encoder = encoding.createEncoder();
  encoding.writeVarString(encoder, documentName);
  encoding.writeVarUint(encoder, type);
  return encoder;
}

/** k6 hands `ArrayBuffer` when `binaryType === 'arraybuffer'`; Sobek may also hand a `Uint8Array`. */
function asBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(0);
}

/**
 * One document on one socket: Auth, sync, updates, awareness and stateless messages.
 *
 * Every callback is optional and is called with plain values, so the k6 scenario file holds the
 * metrics and this file holds the protocol.
 */
export class NoteWireClient {
  constructor(options) {
    this.url = options.url;
    this.documentName = options.documentName;
    this.token = options.token;
    this.origin = options.origin;
    this.label = options.label ?? 'client';
    this.handlers = options.on ?? {};

    this.doc = new Y.Doc({ gc: true });
    /**
     * k6 2.2.0's `crypto.getRandomValues` writes one random **byte per element** regardless of the
     * element width: `new Uint32Array(4)` comes back as the raw bytes
     * `[182,0,0,0, 139,0,0,0, 4,0,0,0, 29,0,0,0]`, and 4 000 draws of `new Uint32Array(1)` never
     * exceed 255. `lib0/random.uint32()` is `getRandomValues(new Uint32Array(1))[0]` and yjs's
     * `generateNewClientId` *is* that function, so under k6 every `Y.Doc.clientID` falls in 0..255.
     * With 20 virtual users the birthday probability of a collision is ~54 %, and two documents
     * sharing a `clientID` produce conflicting items at the same `(client, clock)` — Yjs keeps one
     * and the other virtual user's edits disappear with no error anywhere.
     *
     * A load generator therefore MUST assign `clientID` itself. Set before the document has any
     * content, which is the only point at which it is safe to change.
     */
    if (typeof options.clientId === 'number') this.doc.clientID = options.clientId;
    this.text = this.doc.getText(CONTENT_KEY);
    this.awareness = options.awareness === true ? new awarenessProtocol.Awareness(this.doc) : null;

    /**
     * `Y.Text.observe` deltas, so a consumer never has to re-read the whole `Y.Text` per update.
     * Reading `toString()` on every incoming frame is O(document) and turns a propagation
     * measurement into a measurement of the generator itself once the document grows.
     */
    if (options.observeText === true) {
      this.text.observe((event) => {
        let inserted = '';
        for (const change of event.changes.delta) {
          if (typeof change.insert === 'string') inserted += change.insert;
        }
        if (inserted !== '') this.handlers.textInsert?.(this, inserted);
      });
    }

    this.socket = null;
    this.authenticated = false;
    this.scope = null;
    this.synced = false;
    this.closed = false;
    /** Frames received per `MessageType`, and the sync sub-types inside them. */
    this.received = { total: 0, byType: {}, syncBySubType: {} };
    this.sent = { total: 0, byType: {} };
    this.errors = [];

    this.doc.on('update', (update, updateOrigin) => {
      if (updateOrigin === REMOTE_ORIGIN) {
        this.handlers.remoteUpdate?.(this, update);
        return;
      }
      this.sendUpdate(update);
    });
  }

  /** Wall clock in ms. Sobek exposes no `performance`, so `Date.now()` is the only clock. */
  static now() {
    return Date.now();
  }

  connect() {
    const params = { headers: { Origin: this.origin }, tags: { s06_role: this.label } };
    const socket = new WebSocket(this.url, null, params);
    socket.binaryType = 'arraybuffer';
    this.socket = socket;
    this.connectStartedAt = NoteWireClient.now();

    socket.addEventListener('open', () => {
      this.openedAt = NoteWireClient.now();
      this.handlers.open?.(this, this.openedAt - this.connectStartedAt);
      this.sendAuth();
    });
    socket.addEventListener('message', (event) => {
      try {
        this.handleFrame(asBytes(event.data));
      } catch (error) {
        this.errors.push(`message: ${String(error)}`);
        this.handlers.error?.(this, error);
      }
    });
    socket.addEventListener('close', () => {
      this.closed = true;
      this.handlers.close?.(this);
    });
    socket.addEventListener('error', (event) => {
      this.errors.push(`socket: ${String(event?.error ?? event)}`);
      this.handlers.error?.(this, event);
    });
    return this;
  }

  send(encoder, type) {
    if (this.socket === null) throw new Error('send before connect');
    this.socket.send(frame(encoder));
    this.sent.total += 1;
    this.sent.byType[type] = (this.sent.byType[type] ?? 0) + 1;
  }

  sendAuth() {
    const encoder = startFrame(this.documentName, MessageType.Auth);
    encoding.writeVarUint(encoder, AuthMessageType.Token);
    encoding.writeVarString(encoder, this.token);
    encoding.writeVarString(encoder, PROVIDER_VERSION);
    this.send(encoder, MessageType.Auth);
  }

  sendSyncStep1() {
    const encoder = startFrame(this.documentName, MessageType.Sync);
    syncProtocol.writeSyncStep1(encoder, this.doc);
    this.send(encoder, MessageType.Sync);
  }

  sendUpdate(update) {
    if (!this.authenticated || this.closed) return;
    const encoder = startFrame(this.documentName, MessageType.Sync);
    syncProtocol.writeUpdate(encoder, update);
    this.send(encoder, MessageType.Sync);
  }

  sendStateless(payload) {
    const encoder = startFrame(this.documentName, MessageType.Stateless);
    encoding.writeVarString(encoder, payload);
    this.send(encoder, MessageType.Stateless);
  }

  sendAwareness(field, value) {
    if (this.awareness === null) throw new Error('awareness was not requested');
    this.awareness.setLocalStateField(field, value);
    const encoder = startFrame(this.documentName, MessageType.Awareness);
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.doc.clientID]),
    );
    this.send(encoder, MessageType.Awareness);
  }

  /** Append text in one transaction; the `update` listener turns it into a `Sync` frame. */
  append(value) {
    this.doc.transact(() => {
      this.text.insert(this.text.length, value);
    });
  }

  /**
   * The whole document as text. `toJSON()` rather than `toString()`: yjs 13.6.32's generated
   * declarations expose `Y.Text.toJSON(): string` but not `toString()`, which is the same call
   * (`YText.toJSON` is `return this.toString()`), so this is the spelling that carries a type.
   * Reading the document is O(document), so each scenario calls it once, in its closing `check`;
   * propagation is measured from `Y.Text.observe` deltas rather than by re-reading per frame (the S6
   * note's decision).
   */
  contents() {
    return this.text.toJSON();
  }

  handleFrame(bytes) {
    this.received.total += 1;
    const decoder = decoding.createDecoder(bytes);
    const address = decoding.readVarString(decoder);
    const type = decoding.readVarUint(decoder);
    this.received.byType[type] = (this.received.byType[type] ?? 0) + 1;

    switch (type) {
      case MessageType.Auth: {
        const sub = decoding.readVarUint(decoder);
        if (sub === AuthMessageType.Authenticated) {
          this.scope = decoding.readVarString(decoder);
          this.authenticated = true;
          this.handlers.authenticated?.(this, this.scope);
          this.sendSyncStep1();
        } else if (sub === AuthMessageType.PermissionDenied) {
          const reason = decoding.readVarString(decoder);
          this.handlers.permissionDenied?.(this, reason);
        } else {
          this.handlers.tokenSyncRequest?.(this);
        }
        return;
      }
      case MessageType.Sync:
      case MessageType.SyncReply: {
        const subType = decoding.peekVarUint(decoder);
        this.received.syncBySubType[subType] = (this.received.syncBySubType[subType] ?? 0) + 1;
        const reply = startFrame(this.documentName, MessageType.Sync);
        const emptyLength = encoding.length(reply);
        syncProtocol.readSyncMessage(decoder, reply, this.doc, REMOTE_ORIGIN);
        if (encoding.length(reply) > emptyLength) this.send(reply, MessageType.Sync);
        if (subType === syncProtocol.messageYjsSyncStep2 && !this.synced) {
          this.synced = true;
          this.handlers.synced?.(this);
        }
        return;
      }
      case MessageType.Awareness: {
        if (this.awareness !== null) {
          awarenessProtocol.applyAwarenessUpdate(
            this.awareness,
            decoding.readVarUint8Array(decoder),
            REMOTE_ORIGIN,
          );
        }
        this.handlers.awareness?.(this);
        return;
      }
      case MessageType.Stateless: {
        this.handlers.stateless?.(this, decoding.readVarString(decoder));
        return;
      }
      case MessageType.SyncStatus: {
        this.handlers.syncStatus?.(this, decoding.readVarUint(decoder) === 1);
        return;
      }
      case MessageType.CLOSE: {
        this.handlers.documentClose?.(this, address);
        return;
      }
      default: {
        this.errors.push(`unhandled message type ${String(type)}`);
        return;
      }
    }
  }

  close() {
    this.awareness?.destroy();
    this.doc.destroy();
    if (this.socket !== null && !this.closed) this.socket.close();
  }
}
