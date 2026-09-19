import { setImmediate as nextTurn } from 'node:timers/promises';

import { HocuspocusProviderWebsocket, WebSocketStatus } from '@hocuspocus/provider';
import { createCollabSocket, type TicketSource } from '@iridium/collab-client';
import { encodeStateless, newId, UserId, type ServerNoteMessage } from '@iridium/contracts';
import { deleteSetFingerprint, stateVector } from '@iridium/crdt';
import { afterEach, describe, expect, it } from 'vitest';

import { createNoteClient, type CollabSocket, type NoteClient } from './clients/note-client.ts';
import { createDeferred, WaitTimeoutError } from './harness/deadline.ts';

/**
 * The waiters, the logs and the editing helpers, driven over a real `NoteSession` and a real
 * `HocuspocusProvider` attached to a socket that never opens.
 *
 * Building the session for real rather than faking it is the point: `NoteSession` carries
 * `#private` fields, so a structural double is impossible, and a double of the save-state machine
 * would be exactly the divergence between harness and UI the plan forbids
 * (10-testing-and-quality.md, `NoteClient`). With `autoConnect: false` the socket never dials, so
 * the only thing missing is the network — and the provider's own `receiveStateless`,
 * `forwardClose` and `synced` setter are public, which is how a server's half of the conversation
 * is delivered without one.
 */

const NEVER_DIALLED = 'ws://127.0.0.1:1/collab';

/** A ticket source that never has to answer: the socket never opens, so the getter is never called. */
const IDLE_TICKETS: TicketSource = {
  invalidate: () => undefined,
  next: () => Promise.reject(new Error('the unit harness never opens a socket')),
};

const open: { client: NoteClient; socket: CollabSocket }[] = [];

function attached(
  socket: CollabSocket = createCollabSocket({ url: NEVER_DIALLED, autoConnect: false }),
): { client: NoteClient; socket: CollabSocket } {
  const client = createNoteClient({
    socket,
    noteId: newId(),
    userId: newId(),
    tickets:
      socket instanceof ControlledSocket
        ? { next: async () => 'controlled-ticket', invalidate: () => undefined }
        : IDLE_TICKETS,
  });
  const pair = { client, socket };
  open.push(pair);
  return pair;
}

/** The provider the session attached, which the test drives in the server's place. */
function provider(client: NoteClient): NonNullable<NoteClient['provider']> {
  const live = client.provider;
  if (live === null) throw new Error('the session attached no provider');
  return live;
}

function deliver(client: NoteClient, message: ServerNoteMessage): void {
  provider(client).receiveStateless(encodeStateless(message));
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

afterEach(async () => {
  const closing = open.splice(0);
  await Promise.all(closing.map(({ client }) => client.close()));
  for (const socket of new Set(closing.map((pair) => pair.socket))) socket.destroy();
});

/** The physical I/O seam; opening this transport invokes the installed provider's actual handlers. */
class ControlledTransport extends EventTarget {
  readyState = 0;
  binaryType = 'arraybuffer';
  readonly frames: Uint8Array[] = [];

  open(): void {
    this.readyState = 1;
    this.dispatchEvent(new Event('open'));
  }

  send(frame: unknown): void {
    if (!(frame instanceof Uint8Array)) throw new Error('The provider must send binary frames.');
    this.frames.push(frame);
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatchEvent(new Event('close'));
  }
}

/** Only the connect result and initial backoff are controlled; docs and physical-open dispatch are real. */
class ControlledSocket extends HocuspocusProviderWebsocket {
  readonly attempt = createDeferred<void>();
  connectAction = (): Promise<void> => this.attempt.promise;
  connectCalls = 0;
  cancellations = 0;
  destructions = 0;

  constructor() {
    super({
      url: NEVER_DIALLED,
      autoConnect: false,
      WebSocketPolyfill: ControlledTransport,
    });
  }

  override connect(): Promise<void> {
    this.connectCalls += 1;
    void super.connect();
    return this.connectAction();
  }

  automatic(state: 'connecting' | 'backoff'): void {
    this.shouldConnect = true;
    this.status =
      state === 'connecting' ? WebSocketStatus.Connecting : WebSocketStatus.Disconnected;
    this.emit('status', { status: this.status });
    // A connecting transport is itself evidence of an active attempt, even without a retry handle.
    if (state === 'backoff') {
      this.cancelWebsocketRetry = (): void => {
        this.cancellations += 1;
      };
    }
  }

  connected(): void {
    if (this.webSocket === null) {
      // The controlled automatic backoff has finished naturally; opening does not cancel it.
      delete this.cancelWebsocketRetry;
      void super.connect();
    }
    const transport = this.webSocket;
    if (!(transport instanceof ControlledTransport))
      throw new Error('The reconnect fixture needs an owned physical transport.');
    // Actual HTTP-open dispatch runs before the connect promise receives a protocol message.
    transport.open();
  }

  terminalFailure(error: unknown): void {
    this.emit('maxAttemptsFailed', { error });
  }

  override destroy(): void {
    this.destructions += 1;
    super.destroy();
  }
}

describe('testkit.note-client.unit [area:testkit]', () => {
  it('reports the product save state and logs every transition once', () => {
    const { client } = attached();

    expect(client.states).toStrictEqual([client.saveState]);

    provider(client).synced = true;
    expect(client.states.at(-1)).toBe(client.saveState);
    // A repeated state is not a transition, so the log never grows without one.
    const before = client.states.length;
    provider(client).synced = true;
    expect(client.states).toHaveLength(before);
  });

  it('waitFor reads the product machine, by state and by predicate', async () => {
    const { client } = attached();
    // A session whose socket is not connected reports `disconnected`, which is rule 8 of
    // 05-collaboration-and-durability.md's ordered table rather than the state diagram's
    // `[*] --> connecting`. Asserting the table is asserting the product.
    expect(client.saveState).toBe('disconnected');
    await client.waitFor('disconnected', { timeoutMs: 1_000 });
    await client.waitFor((state) => state !== 'saved', { timeoutMs: 1_000 });
  });

  it('waitFor names the document and the state it gave up on', async () => {
    const { client } = attached();
    await expect(client.waitFor('saved', { timeoutMs: 50 })).rejects.toThrow(WaitTimeoutError);
    await expect(client.waitFor('saved', { timeoutMs: 50 })).rejects.toThrow(
      /save state "saved" on note:/,
    );
  });

  it('logs every decoded stateless message and waits for the next of a type', async () => {
    const { client } = attached();

    const pending = client.waitForStateless('participants', { timeoutMs: 1_000 });
    deliver(client, {
      v: 1,
      t: 'participants',
      users: [
        {
          id: UserId.parse(newId()),
          name: 'Editor A',
          colorHue: 10,
          role: 'editor',
          mode: 'source',
        },
      ],
    });
    const message = await pending;

    expect(message.t).toBe('participants');
    expect(client.stateless.map((m) => m.t)).toStrictEqual(['participants']);
  });

  it('ignores a message the codec refuses rather than logging it', () => {
    const { client } = attached();
    provider(client).receiveStateless('{"v":1,"t":"not-a-message"}');
    provider(client).receiveStateless('not json at all');
    // A struct vector alone cannot attest a deletion; preserve this missing-witness refusal.
    provider(client).receiveStateless(
      JSON.stringify({ v: 1, t: 'persisted', seq: 1, sv: base64(stateVector(client.ydoc)) }),
    );
    expect(client.stateless).toStrictEqual([]);
  });

  it('waitForAck returns the acknowledged seq, decoded vector and actual deletion witness', async () => {
    const { client } = attached();
    const beforeDeletion = deleteSetFingerprint(client.ydoc);
    client.typeAt(0, 'deleted and retained');
    client.deleteAt(0, 8);
    const sv = stateVector(client.ydoc);
    const ds = deleteSetFingerprint(client.ydoc);

    const pending = client.waitForAck(undefined, { timeoutMs: 1_000 });
    deliver(client, { v: 1, t: 'persisted', seq: 7, sv: base64(sv), ds });
    const ack = await pending;

    expect(ack.seq).toBe(7);
    expect(ack.sv).toStrictEqual(sv);
    expect(ack.ds).toBe(ds);
    expect(ack.ds).not.toBe(beforeDeletion);
  });

  it('waitForAck with a seq accepts an acknowledgement that already arrived', async () => {
    const { client } = attached();
    deliver(client, {
      v: 1,
      t: 'persisted',
      seq: 4,
      sv: base64(stateVector(client.ydoc)),
      ds: deleteSetFingerprint(client.ydoc),
    });

    await expect(client.waitForAck(4, { timeoutMs: 1_000 })).resolves.toMatchObject({ seq: 4 });
    // A higher requirement is not met by a lower acknowledgement.
    await expect(client.waitForAck(5, { timeoutMs: 50 })).rejects.toThrow(WaitTimeoutError);
  });

  it('records a close with its reason, and parses only a reason in the vocabulary', async () => {
    const { client } = attached();

    // A reason outside the vocabulary is recorded and produces no state change and no retry, so the
    // provider survives it — which is why this case comes first.
    const unknown = client.waitClosed({ timeoutMs: 1_000 });
    provider(client).forwardClose({ event: { code: 1006, reason: 'something-new' } });
    await expect(unknown).resolves.toMatchObject({
      code: 1006,
      reason: 'something-new',
      collabReason: null,
      via: 'close-frame',
    });

    const terminal = client.waitClosed({ timeoutMs: 1_000 });
    provider(client).forwardClose({ event: { code: 1000, reason: 'revoked' } });
    await expect(terminal).resolves.toMatchObject({
      code: 1000,
      reason: 'revoked',
      collabReason: 'revoked',
    });
    // `revoked` is terminal: the session detaches, and a destroyed provider drops every listener.
    expect(client.saveState).toBe('revoked');
    expect(client.provider).toBeNull();
  });

  it('edits the document and counts markers, duplicates included', () => {
    const { client } = attached();

    client.typeAt(0, 'hello world');
    expect(client.text.toJSON()).toBe('hello world');

    client.deleteAt(5, 6);
    expect(client.text.toJSON()).toBe('hello');

    const first = client.marker('edit');
    const second = client.marker('edit');
    expect(first).toBe('⟦edit:1⟧');
    expect(second).toBe('⟦edit:2⟧');
    expect(client.markerCount('edit')).toBe(2);

    // The oracle the duplication suites rely on: a second copy of the same marker is visible.
    client.typeAt(client.text.length, first);
    expect(client.markerCount('edit')).toBe(3);
  });

  it('exposes the document, undo manager and client id the session owns', () => {
    const { client } = attached();

    expect(client.ydoc).toBe(client.session.ydoc);
    expect(client.text).toBe(client.session.ytext);
    expect(client.undo).toBe(client.session.undoManager);
    expect(client.clientId).toBe(client.session.ydoc.clientID);
    expect(client.documentName).toMatch(/^note:/);
  });

  it('refuses a stateless send with no attached provider, naming the alternative', async () => {
    const { client } = attached();
    await client.close();
    expect(() => {
      client.sendStateless({ v: 1, t: 'baseline' });
    }).toThrow(/sendRaw/);
  });
  it('bounds a pending connection attempt and consumes its late rejection without losing local work', async () => {
    const socket = new ControlledSocket();
    const { client } = attached(socket);
    client.marker('pending-reconnect');
    const document = client.ydoc;
    const undo = client.undo;
    const text = client.text.toJSON();
    const listeners = socket.callbacks['maxAttemptsFailed']?.length ?? 0;
    const unhandled: unknown[] = [];
    const rejected = (error: unknown): void => {
      unhandled.push(error);
    };
    process.on('unhandledRejection', rejected);
    try {
      await expect(client.reconnectSocket({ timeoutMs: 25, intervalMs: 1 })).rejects.toMatchObject({
        name: 'WaitTimeoutError',
        timeoutMs: 25,
        description: `the socket to reconnect on ${client.documentName}`,
      });
      expect(socket.connectCalls).toBe(1);
      expect(socket.callbacks['maxAttemptsFailed']).toHaveLength(listeners);
      expect(socket.destructions).toBe(0);
      expect(socket.cancellations).toBe(0);
      expect(client.ydoc).toBe(document);
      expect(client.undo).toBe(undo);
      expect(client.text.toJSON()).toBe(text);
      socket.attempt.reject(new Error('connection failed after the harness deadline'));
      // Observe the rejection checkpoint, rather than hiding it with a catch in the test.
      await nextTurn();
      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener('unhandledRejection', rejected);
    }
  });

  it('observes HTTP open without awaiting the first protocol message', async () => {
    const socket = new ControlledSocket();
    const { client } = attached(socket);
    const reconnecting = client.reconnectSocket({ timeoutMs: 250, intervalMs: 1 });
    expect(socket.connectCalls).toBe(1);
    socket.connected();
    // The attempt remains unresolved; open is sufficient for this transport-only helper.
    await reconnecting;
    expect(socket.webSocket?.readyState).toBe(1);
    expect(socket.shouldConnect).toBe(true);
    expect(client.session.input.socket).toBe('connected');
    expect(client.session.input.authenticated).toBe(false);
    socket.attempt.resolve(undefined);
  });

  it.each(['connecting', 'backoff'] as const)(
    'joins an automatic %s attempt without replacing either shared note',
    async (state) => {
      const socket = new ControlledSocket();
      const first = attached(socket).client;
      const second = attached(socket).client;
      const clients = [first, second].map((client) => {
        client.marker('pending-shared');
        return {
          client,
          document: client.ydoc,
          undo: client.undo,
          provider: client.provider,
          text: client.text.toJSON(),
        };
      });
      socket.automatic(state);
      const reconnecting = Promise.all(
        clients.map(({ client }) => client.reconnectSocket({ timeoutMs: 250, intervalMs: 1 })),
      );
      expect(socket.connectCalls).toBe(0);
      socket.connected();
      await reconnecting;
      expect(socket.webSocket?.readyState).toBe(1);
      expect(socket.shouldConnect).toBe(true);
      expect(socket.connectCalls).toBe(0);
      expect(socket.cancellations).toBe(0);
      expect(socket.destructions).toBe(0);
      expect(socket.configuration.providerMap.size).toBe(2);
      for (const original of clients) {
        expect(original.client.ydoc).toBe(original.document);
        expect(original.client.undo).toBe(original.undo);
        expect(original.client.provider).toBe(original.provider);
        expect(original.client.text.toJSON()).toBe(original.text);
      }
    },
  );

  it('returns for an already connected transport even when this note is detached', async () => {
    const socket = new ControlledSocket();
    const { client } = attached(socket);
    client.session.detach(false);
    socket.connected();
    expect(socket.webSocket?.readyState).toBe(1);
    expect(socket.shouldConnect).toBe(true);
    expect(client.session.input.socket).toBe('disconnected');
    await client.reconnectSocket({ timeoutMs: 0 });
    expect(socket.connectCalls).toBe(0);
    expect(client.provider).toBeNull();
  });

  it.each(['throw', 'reject', 'reject-undefined'] as const)(
    'surfaces a connect %s as its original failure',
    async (mode) => {
      const socket = new ControlledSocket();
      const { client } = attached(socket);
      const error = new Error('connect could not start');
      const reason = mode === 'reject-undefined' ? undefined : error;
      socket.connectAction = (): Promise<void> => {
        if (mode === 'throw') throw error;
        return Promise.reject(reason);
      };
      const listeners = socket.callbacks['maxAttemptsFailed']?.length ?? 0;
      await expect(client.reconnectSocket({ timeoutMs: 250, intervalMs: 1 })).rejects.toBe(reason);
      expect(socket.connectCalls).toBe(1);
      expect(socket.callbacks['maxAttemptsFailed']).toHaveLength(listeners);
    },
  );

  it.each(['started', 'joined'] as const)(
    'surfaces the terminal event from a %s attempt even though connect does not reject',
    async (mode) => {
      const socket = new ControlledSocket();
      const { client } = attached(socket);
      const error = new Error('transport retries exhausted');
      if (mode === 'joined') socket.automatic('backoff');
      socket.connectAction = () => Promise.resolve();
      const listeners = socket.callbacks['maxAttemptsFailed']?.length ?? 0;
      const reconnecting = client.reconnectSocket({ timeoutMs: 250, intervalMs: 1 });
      socket.terminalFailure(error);
      await expect(reconnecting).rejects.toBe(error);
      expect(socket.connectCalls).toBe(mode === 'started' ? 1 : 0);
      expect(socket.callbacks['maxAttemptsFailed']).toHaveLength(listeners);
    },
  );

  it('honors an already aborted deadline without initiating or retaining a listener', async () => {
    const socket = new ControlledSocket();
    const { client } = attached(socket);
    const error = new Error('test owner stopped waiting');
    const listeners = socket.callbacks['maxAttemptsFailed']?.length ?? 0;
    await expect(client.reconnectSocket({ signal: AbortSignal.abort(error) })).rejects.toBe(error);
    expect(socket.connectCalls).toBe(0);
    expect(socket.callbacks['maxAttemptsFailed']).toHaveLength(listeners);
  });
});
