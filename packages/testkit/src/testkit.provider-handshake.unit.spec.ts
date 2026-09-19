/** A pending ticket belongs to one real provider connection generation, never its successor. */
import {
  HocuspocusProvider,
  HocuspocusProviderWebsocket,
  MessageType,
  type onOutgoingMessageParameters,
} from '@hocuspocus/provider';
import { NoteSession } from '@iridium/collab-client';
import { NoteId, noteDocName, UserId } from '@iridium/contracts';
import {
  createNoteDoc,
  createUndoManager,
  decodeAwarenessEntries,
  FRAME_TYPE,
  getContent,
  peekFrame,
  projectMarkdown,
} from '@iridium/crdt';
import { describe, expect, it, vi } from 'vitest';

import { awarenessFrame } from './clients/awareness-frame.ts';

/** A live physical transport whose close delivery can be held at the browser I/O boundary. */
class HandshakeTransport extends EventTarget {
  readyState = 1;
  binaryType = 'arraybuffer';
  holdClose = false;

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 2;
    if (this.holdClose) return;
    this.finishClose();
  }

  finishClose(): void {
    this.readyState = 3;
    this.dispatchEvent(new Event('close'));
  }
}

/** Only the physical transport is replaced; provider authentication and sync code are real. */
class RecordingSocket extends HocuspocusProviderWebsocket {
  readonly frames: Uint8Array[] = [];

  constructor() {
    super({
      url: 'ws://127.0.0.1:1/collab',
      autoConnect: false,
      WebSocketPolyfill: HandshakeTransport,
    });
  }

  override send(frame: unknown): void {
    if (!(frame instanceof Uint8Array)) throw new Error('The provider must send binary frames.');
    this.frames.push(frame);
  }
}

function fixture() {
  const socket = new RecordingSocket();
  const connecting = socket.connect();
  const transport = socket.webSocket;
  if (!(transport instanceof HandshakeTransport))
    throw new Error('The fixture needs an owned physical transport.');
  const document = createNoteDoc();
  const text = getContent(document);
  const undo = createUndoManager(text, { captureTimeout: 0 });
  const tokens = vi.fn<() => Promise<string>>();
  const provider = new HocuspocusProvider({
    name: 'note:primary',
    document,
    awareness: null,
    websocketProvider: socket,
    token: tokens,
  });
  const peerDocument = createNoteDoc();
  const peer = new HocuspocusProvider({
    name: 'note:peer',
    document: peerDocument,
    awareness: null,
    websocketProvider: socket,
  });
  provider.attach();
  peer.attach();
  peer.authenticatedHandler('read-write');
  text.insert(0, 'pending edit');
  socket.frames.length = 0;
  return {
    socket,
    document,
    text,
    undo,
    provider,
    peer,
    tokens,
    transport,
    async close(): Promise<void> {
      provider.destroy();
      peer.destroy();
      socket.destroy();
      transport.finishClose();
      undo.destroy();
      document.destroy();
      peerDocument.destroy();
      await connecting;
    },
  };
}

describe('testkit.provider-handshake.unit [area:testkit]', () => {
  it.each(['bytes', 'buffer'] as const)(
    'answers a query from %s with only local presence while preserving cached peers',
    (payload) => {
      const socket = new RecordingSocket();
      const noteId = NoteId.parse('0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b');
      const userId = UserId.parse('0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c');
      const remote = { user: { id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5d' }, cursor: null };
      const session = new NoteSession({
        noteId,
        userId,
        socket,
        tickets: { next: async () => 'ticket', invalidate: () => undefined },
        role: 'editor',
      });
      try {
        session.attach();
        const provider = session.provider;
        if (provider === null) throw new Error('The note must have an attached provider.');
        const ownId = session.ydoc.clientID;
        const peerId = ownId === 1 ? 2 : 1;
        const peerFrame = awarenessFrame({
          documentName: noteDocName(noteId),
          entries: [{ clientId: peerId, clock: 1, state: remote }],
        });
        provider.onMessage(new MessageEvent('message', { data: peerFrame }));
        expect(provider.awareness?.getStates().get(peerId)).toEqual(remote);
        socket.frames.length = 0;
        const name = new TextEncoder().encode(noteDocName(noteId));
        const query = Uint8Array.of(name.length, ...name, FRAME_TYPE.queryAwareness);
        provider.onMessage(
          new MessageEvent('message', { data: payload === 'bytes' ? query : query.buffer }),
        );
        expect(socket.frames).toHaveLength(1);
        const response = socket.frames[0];
        if (response === undefined) throw new Error('An awareness query must have a reply.');
        const header = peekFrame(response);
        if (header === null) throw new Error('An awareness reply must have a valid frame header.');
        expect(header.type).toBe(FRAME_TYPE.awareness);
        const entries = decodeAwarenessEntries(response, header);
        expect(entries?.map((entry) => entry.clientId)).toEqual([ownId]);
        expect(entries?.[0]?.state).toEqual({ user: { id: userId }, cursor: null });
        expect(provider.awareness?.getStates().get(peerId)).toEqual(remote);
        expect(provider.awareness?.getStates().size).toBe(2);
      } finally {
        session.dispose();
        socket.destroy();
      }
    },
  );

  it.each([
    { retirement: 'close', outcome: 'resolve' },
    { retirement: 'close', outcome: 'reject' },
    { retirement: 'detach', outcome: 'resolve' },
    { retirement: 'detach', outcome: 'reject' },
  ] as const)(
    'ignores a retired $retirement token that later $outcome while the current handshake stays usable',
    async ({ retirement, outcome }) => {
      const state = fixture();
      const oldTicket = Promise.withResolvers<string>();
      const currentTicket = Promise.withResolvers<string>();
      const denied = vi.fn<(event: unknown) => void>();
      state.provider.on('authenticationFailed', denied);
      state.tokens
        .mockReturnValueOnce(oldTicket.promise)
        .mockReturnValueOnce(currentTicket.promise);
      try {
        const oldOpen = state.provider.onOpen(new Event('open'));
        if (retirement === 'close') state.provider.onClose();
        else {
          state.provider.detach(false);
          state.provider.attach();
        }
        const currentOpen = state.provider.onOpen(new Event('open'));
        currentTicket.resolve('current-ticket');
        await currentOpen;
        expect(state.socket.frames.map((frame) => peekFrame(frame)?.type)).toEqual([
          FRAME_TYPE.auth,
          FRAME_TYPE.sync,
        ]);
        state.provider.authenticatedHandler('read-write');
        state.provider.synced = true;
        state.provider.incrementUnsyncedChanges();
        const currentFrames = [...state.socket.frames];
        const currentUnsynced = state.provider.unsyncedChanges;
        if (outcome === 'resolve') oldTicket.resolve('retired-ticket');
        else oldTicket.reject(new Error('retired ticket request failed'));
        await oldOpen;
        expect([...state.socket.frames]).toEqual(currentFrames);
        expect(denied).not.toHaveBeenCalled();
        expect(state.provider.isAuthenticated).toBe(true);
        expect(state.provider.synced).toBe(true);
        expect(state.provider.unsyncedChanges).toBe(currentUnsynced);
        expect(state.provider.document).toBe(state.document);
        expect(projectMarkdown(state.document)).toBe('pending edit');
        expect(state.undo.canUndo()).toBe(true);
        state.undo.undo();
        expect(projectMarkdown(state.document)).toBe('');
        expect(state.socket.configuration.providerMap.get('note:peer')).toBe(state.peer);
        expect(state.peer.isAuthenticated).toBe(true);
        expect(state.socket.shouldConnect).toBe(true);
      } finally {
        await state.close();
      }
    },
  );

  it('does not start sync when the current token request fails', async () => {
    const state = fixture();
    const denied = vi.fn<(event: unknown) => void>();
    state.provider.on('authenticationFailed', denied);
    state.tokens.mockRejectedValue(new Error('ticket request failed'));
    try {
      await state.provider.onOpen(new Event('open'));
      expect(denied).toHaveBeenCalledOnce();
      expect([...state.socket.frames]).toEqual([]);
      expect(state.provider.isAuthenticated).toBe(false);
      expect(state.provider.synced).toBe(false);
      expect(projectMarkdown(state.document)).toBe('pending edit');
    } finally {
      await state.close();
    }
  });

  it('joins a destroyed provider token without sending or resetting sync', async () => {
    const state = fixture();
    const ticket = Promise.withResolvers<string>();
    state.tokens.mockReturnValue(ticket.promise);
    const sync = vi.spyOn(state.provider, 'startSync');
    try {
      const opening = state.provider.onOpen(new Event('open'));
      state.provider.destroy();
      const frames = [...state.socket.frames];
      ticket.resolve('retired-ticket');
      await opening;
      expect([...state.socket.frames]).toEqual(frames);
      expect(sync).not.toHaveBeenCalled();
      expect(state.socket.configuration.providerMap.get('note:peer')).toBe(state.peer);
      expect(projectMarkdown(state.document)).toBe('pending edit');
    } finally {
      await state.close();
    }
  });

  it('discards a manual token refresh when its connection closes', async () => {
    const state = fixture();
    const ticket = Promise.withResolvers<string>();
    state.tokens.mockReturnValue(ticket.promise);
    try {
      const refreshing = state.provider.sendToken();
      state.provider.onClose();
      ticket.resolve('retired-ticket');
      await refreshing;
      expect([...state.socket.frames]).toEqual([]);
      expect(state.peer.isAuthenticated).toBe(true);
    } finally {
      await state.close();
    }
  });
  it.each([
    { retirement: 'cleanup', outcome: 'resolve' },
    { retirement: 'cleanup', outcome: 'reject' },
    { retirement: 'closing', outcome: 'resolve' },
    { retirement: 'closing', outcome: 'reject' },
  ] as const)(
    'discards a token that later $outcome after physical $retirement without a document close callback',
    async ({ retirement, outcome }) => {
      const state = fixture();
      const ticket = Promise.withResolvers<string>();
      const denied = vi.fn<(event: unknown) => void>();
      state.tokens.mockReturnValue(ticket.promise);
      state.provider.on('authenticationFailed', denied);
      state.provider.incrementUnsyncedChanges();
      const unsynced = state.provider.unsyncedChanges;
      try {
        const opening = state.provider.onOpen(new Event('open'));
        if (retirement === 'cleanup') {
          // This is the actual cleanup called when a browser fails to finish its close handshake.
          // It does not emit the document provider's close callback.
          state.socket.onClose({ event: { code: 4408, reason: 'forced' } });
        } else {
          state.transport.holdClose = true;
          state.socket.disconnect();
        }
        expect(state.socket.webSocket).toBe(retirement === 'cleanup' ? null : state.transport);
        expect(state.transport.readyState).toBe(retirement === 'cleanup' ? 3 : 2);
        if (outcome === 'resolve') ticket.resolve('retired-ticket');
        else ticket.reject(new Error('retired ticket failed'));
        await opening;
        expect([...state.socket.frames]).toEqual([]);
        expect(denied).not.toHaveBeenCalled();
        expect(state.provider.unsyncedChanges).toBe(unsynced);
        expect(state.provider.document).toBe(state.document);
        expect(projectMarkdown(state.document)).toBe('pending edit');
        expect(state.undo.canUndo()).toBe(true);
      } finally {
        await state.close();
      }
    },
  );

  it.each(['synchronous', 'microtask'] as const)(
    'does not continue auth or sync when an outgoing auth observer retires its transport in a %s callback',
    async (timing) => {
      const state = fixture();
      state.tokens.mockResolvedValue('current-ticket');
      state.provider.incrementUnsyncedChanges();
      const unsynced = state.provider.unsyncedChanges;
      state.provider.on('outgoingMessage', ({ message }: onOutgoingMessageParameters) => {
        if (message.type !== MessageType.Auth) return;
        const retire = (): void => {
          state.socket.onClose({ event: { code: 4408, reason: 'forced' } });
        };
        if (timing === 'synchronous') retire();
        else queueMicrotask(retire);
      });
      try {
        await state.provider.onOpen(new Event('open'));
        expect(state.socket.frames.map((frame) => peekFrame(frame)?.type)).toEqual(
          timing === 'synchronous' ? [] : [FRAME_TYPE.auth],
        );
        expect(state.provider.unsyncedChanges).toBe(unsynced);
        expect(state.provider.document).toBe(state.document);
        expect(projectMarkdown(state.document)).toBe('pending edit');
        expect(state.undo.canUndo()).toBe(true);
      } finally {
        await state.close();
      }
    },
  );

  it('captures the opening transport before an open observer replaces it', async () => {
    const state = fixture();
    state.tokens.mockResolvedValue('retired-ticket');
    let replacement: Promise<unknown> | undefined;
    state.provider.on('open', () => {
      state.socket.onClose({ event: { code: 4408, reason: 'forced' } });
      replacement = state.socket.connect();
    });
    try {
      await state.provider.onOpen(new Event('open'));
      expect(state.socket.webSocket).not.toBe(state.transport);
      expect([...state.socket.frames]).toEqual([]);
      expect(projectMarkdown(state.document)).toBe('pending edit');
      expect(state.undo.canUndo()).toBe(true);
    } finally {
      await state.close();
      await replacement;
    }
  });

  it('allows a current token refresh on the same open transport without restarting sync', async () => {
    const state = fixture();
    state.tokens.mockResolvedValue('current-ticket');
    state.provider.authenticatedHandler('read-write');
    state.provider.synced = true;
    const unsynced = state.provider.unsyncedChanges;
    try {
      await state.provider.sendToken();
      expect(state.socket.webSocket).toBe(state.transport);
      expect(state.socket.frames.map((frame) => peekFrame(frame)?.type)).toEqual([FRAME_TYPE.auth]);
      expect(state.provider.isAuthenticated).toBe(true);
      expect(state.provider.synced).toBe(true);
      expect(state.provider.unsyncedChanges).toBe(unsynced);
      expect(state.provider.document).toBe(state.document);
      expect(projectMarkdown(state.document)).toBe('pending edit');
      expect(state.undo.canUndo()).toBe(true);
    } finally {
      await state.close();
    }
  });
});
