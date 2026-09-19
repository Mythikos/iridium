/**
 * `SimNet` — the socketless, deterministic multi-client harness the convergence model drives
 * (10-testing-and-quality.md, "`SimNet`"; a port of Yjs's own `tests/testHelper.js` design).
 *
 * N peer documents, each with an inbound queue from the server and an outbound queue to it; a server
 * document that is the product's own loaded `FakeDocument` with the **real** `NoteWriter`, loader and
 * compactor behind it (`createModelReal`). Delivery is explicit — `deliverOne`, `deliverAll` — so a
 * command sequence can hold a message back, disconnect a peer, restart the server or reload a client
 * at any point, and the oracles in `converge.ts` say what must still be true afterwards.
 *
 * Peers edit under the default (`null`) transaction origin, which is what a `Y.UndoManager` tracks by
 * construction, so `undo(peer)` reverts that peer's own edits and never a relayed one; a relayed
 * update is applied under `REMOTE_ORIGIN`.
 */
import {
  applyV1,
  createNoteDoc,
  createUndoManager,
  encodeState,
  getContent,
  encodeSyncStep1,
  receiveSyncMessage,
  type NoteDoc,
  type NoteText,
  type NoteUndoManager,
  type V1Update,
} from '@iridium/crdt';

import { connectionOrigin, type FakeConnection } from './fake-document.ts';
import type { ModelReal } from './model.ts';

/** The origin a peer applies a relayed update under: never tracked by its undo manager. */
export const REMOTE_ORIGIN: unique symbol = Symbol('sim-net.remote');

/** The capture window of a peer's undo manager: every edit is its own step, so `undo` is one edit. */
const UNDO_CAPTURE_TIMEOUT_MS = 0;

export interface SimPeer {
  readonly id: number;
  doc: NoteDoc;
  text: NoteText;
  undo: NoteUndoManager;
  /** Server → peer, oldest first. */
  inbound: V1Update[];
  /** Peer → server, oldest first. */
  outbound: V1Update[];
  connected: boolean;
  /** The server connection this peer's updates are attributed to. */
  connection: FakeConnection;
  /** Undo manager and update listener, torn down on reload. */
  detach: () => void;
}

/** The harness. */
export interface SimNet {
  readonly peers: readonly SimPeer[];
  readonly server: { readonly doc: NoteDoc; head(): number; loadedFromDb: boolean };
  insert(peer: number, position: number, text: string): void;
  delete(peer: number, position: number, length: number): void;
  undo(peer: number): void;
  redo(peer: number): void;
  /** Pops one queued message of the peer: an outbound one first, else an inbound one. */
  deliverOne(peer: number): boolean;
  /** Drains every queue until nothing moves. */
  deliverAll(): void;
  disconnect(peer: number): void;
  /** A real y-protocols sync (step 1 / step 2 both ways) against the server document. */
  reconnect(peer: number): void;
  /** Runs the real writer FIFO to completion. */
  persist(): Promise<void>;
  /** Runs the real compactor: snapshot, projection, checkpoint policy, content scan. */
  compact(): Promise<void>;
  /** Drops the server document and reloads it from the persisted state. */
  restartServer(): Promise<void>;
  /** Replaces the peer's document with a fresh one synced from the server. */
  reloadClient(peer: number): Promise<void>;
  /** Deletes the update-log rows the snapshot covers. */
  pruneUpdateLog(): Promise<void>;
  dispose(): void;
}

export interface SimNetOptions {
  readonly real: ModelReal;
  readonly peers: number;
}

/** Marker tokens are immutable test metadata, never user text. Unicode payload remains editable. */
const SENTINEL = /⟦(?:IMPORT-MARK|p\d+:\d+)⟧/g;
function characterBoundary(text: string, offset: number): number {
  const at = Math.min(text.length, Math.max(0, offset));
  const before = text.charCodeAt(at - 1);
  const after = text.charCodeAt(at);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff ? at + 1 : at;
}
function editablePosition(text: string, offset: number, deleting: boolean): number {
  let at = characterBoundary(text, offset);
  for (const match of text.matchAll(SENTINEL)) {
    const end = match.index + match[0].length;
    if ((deleting ? at >= match.index : at > match.index) && at < end) at = end;
  }
  return at;
}
/** Builds the net over an opened note. */
export function createSimNet(options: SimNetOptions): SimNet {
  const { real } = options;
  let serverListener: ((update: Uint8Array, origin: unknown) => void) | null = null;

  const peers: SimPeer[] = [];

  /** Fans one server update out to every connected peer but its author. */
  const fanOut = (update: Uint8Array, origin: unknown): void => {
    const author = peers.find(
      (peer) =>
        typeof origin === 'object' &&
        origin !== null &&
        Reflect.get(origin, 'connection') === peer.connection,
    );
    for (const peer of peers) {
      if (!peer.connected || peer === author) continue;
      peer.inbound.push(asV1(update));
    }
  };

  const listenToServer = (): void => {
    if (serverListener !== null) real.document.off('update', serverListener);
    serverListener = (update, origin) => fanOut(update, origin);
    real.document.on('update', serverListener);
  };

  /** Binds `doc` to `peer`: the text, a fresh undo manager and the outbound listener. */
  const attachPeer = (peer: SimPeer, doc: NoteDoc): void => {
    const text = getContent(doc);
    const undo = createUndoManager(text, { captureTimeout: UNDO_CAPTURE_TIMEOUT_MS });
    const listener = (update: Uint8Array, origin: unknown): void => {
      if (origin === REMOTE_ORIGIN) return;
      peer.outbound.push(asV1(update));
    };
    doc.on('update', listener);
    peer.doc = doc;
    peer.text = text;
    peer.undo = undo;
    peer.detach = () => {
      doc.off('update', listener);
      undo.destroy();
    };
  };

  const newPeer = (id: number, doc: NoteDoc, connection: FakeConnection): SimPeer => {
    const peer: SimPeer = {
      id,
      doc,
      text: getContent(doc),
      undo: createUndoManager(getContent(doc), { captureTimeout: UNDO_CAPTURE_TIMEOUT_MS }),
      inbound: [],
      outbound: [],
      connected: true,
      connection,
      detach: () => undefined,
    };
    peer.undo.destroy();
    attachPeer(peer, doc);
    return peer;
  };

  /** A fresh peer document synced from the server, as a client that just connected. */
  const freshPeerDoc = (): NoteDoc => {
    const doc = createNoteDoc({ gc: true });
    applyV1(doc, encodeState(real.document, 1), REMOTE_ORIGIN);
    return doc;
  };

  const applyAtServer = (peer: SimPeer, update: V1Update): void => {
    real.document.transact(() => {
      applyV1(real.document, update, connectionOrigin(peer.connection));
    }, connectionOrigin(peer.connection));
  };

  const sync = (peer: SimPeer): void => {
    // Exchange actual y-protocols messages, including its step tags and state-vector decoder.
    const origin = connectionOrigin(peer.connection);
    const fromServer = receiveSyncMessage(real.document, encodeSyncStep1(peer.doc), origin);
    receiveSyncMessage(peer.doc, fromServer.response, REMOTE_ORIGIN);
    const fromPeer = receiveSyncMessage(peer.doc, encodeSyncStep1(real.document), REMOTE_ORIGIN);
    receiveSyncMessage(real.document, fromPeer.response, origin);
  };

  for (let id = 0; id < options.peers; id += 1) {
    const connection = real.document.addConnection({
      role: 'editor',
      userId: real.actors[id % 2]?.userId ?? real.actors[0].userId,
      sessionId: real.actors[id % 2]?.sessionId ?? real.actors[0].sessionId,
    });
    peers.push(newPeer(id, freshPeerDoc(), connection));
  }
  listenToServer();

  const peerAt = (index: number): SimPeer => {
    const peer = peers[index];
    if (peer === undefined) throw new Error(`no peer ${String(index)}`);
    return peer;
  };

  const net: SimNet = {
    peers,
    server: {
      get doc(): NoteDoc {
        return real.document;
      },
      head: () => real.writer.lastCommittedSeq,
      loadedFromDb: false,
    },
    insert(index, position, text): void {
      const peer = peerAt(index);
      peer.doc.transact(() => {
        peer.text.insert(editablePosition(peer.text.toJSON(), position, false), text);
      });
    },
    delete(index, position, length): void {
      const peer = peerAt(index);
      const current = peer.text.toJSON();
      const start = editablePosition(current, position, true);
      let end = characterBoundary(current, start + length);
      for (const match of current.matchAll(SENTINEL)) {
        if (match.index >= start && match.index < end) end = match.index;
      }
      const count = end - start;
      if (count <= 0) return;
      peer.doc.transact(() => {
        peer.text.delete(start, count);
      });
    },
    undo(index): void {
      peerAt(index).undo.undo();
    },
    redo(index): void {
      peerAt(index).undo.redo();
    },
    deliverOne(index): boolean {
      const peer = peerAt(index);
      if (!peer.connected) return false;
      const toServer = peer.outbound.shift();
      if (toServer !== undefined) {
        applyAtServer(peer, toServer);
        return true;
      }
      const fromServer = peer.inbound.shift();
      if (fromServer === undefined) return false;
      applyV1(peer.doc, fromServer, REMOTE_ORIGIN);
      return true;
    },
    deliverAll(): void {
      let moved = true;
      while (moved) {
        moved = false;
        for (const peer of peers) {
          while (net.deliverOne(peer.id)) moved = true;
        }
      }
    },
    disconnect(index): void {
      const peer = peerAt(index);
      peer.connected = false;
      peer.inbound.length = 0;
      peer.outbound.length = 0;
    },
    reconnect(index): void {
      const peer = peerAt(index);
      peer.connected = true;
      sync(peer);
    },
    persist: () => real.writer.drain(),
    async compact(): Promise<void> {
      await real.persistence.compactNow(real.noteId, { trigger: 'flush' });
    },
    async restartServer(): Promise<void> {
      await real.reopen();
      net.server.loadedFromDb = true;
      // The successor fans out from its first update, so a peer's re-sync reaches every other peer.
      listenToServer();
      // The peers' connections belong to the old document; each connected peer re-attaches.
      for (const peer of peers) {
        peer.connection = real.document.addConnection({
          role: 'editor',
          userId: peer.connection.context.userId,
          sessionId: peer.connection.context.sessionId,
        });
        peer.inbound.length = 0;
        if (peer.connected) sync(peer);
      }
    },
    async reloadClient(index): Promise<void> {
      const peer = peerAt(index);
      peer.detach();
      peer.doc.destroy();
      attachPeer(peer, freshPeerDoc());
      peer.inbound.length = 0;
      peer.outbound.length = 0;
      peer.connected = true;
    },
    async pruneUpdateLog(): Promise<void> {
      await real.modelStore.prune(real.noteId, new Date(real.clock.now() + 1));
    },
    dispose(): void {
      for (const peer of peers) {
        peer.detach();
        peer.doc.destroy();
      }
      if (serverListener !== null) real.document.off('update', serverListener);
    },
  };
  return net;
}

function asV1(update: Uint8Array): V1Update {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a `doc.on('update')` payload is a V1 update by yjs's contract
  return update as V1Update;
}
