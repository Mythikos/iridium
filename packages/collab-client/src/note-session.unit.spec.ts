/**
 * `note-session.unit` — the session's side effects: the handshake, the baseline, the re-attach on a
 * role upgrade, the ticket retry, the close policies and the two deadlines
 * (12-milestones.md section 5.2; 05-collaboration-and-durability.md, *The baseline*, *Role change on
 * a live connection*, *Reconnection semantics*; 09-api-reference.md section 3.2).
 *
 * `save-state.machine.prop` proves what the indicator says about a snapshot; this file proves that
 * the session produces the right snapshots and does the right things around them, which is the half
 * a pure rule table cannot cover. The provider is the one thing faked — it is the I/O adapter of
 * this module, and the alternative is a real socket — while the `Y.Doc`, the codec, the rule table
 * and the close policy are all the shipped ones.
 */

import { encodeStateless, LIMITS, NoteId, UserId } from '@iridium/contracts';
import {
  applyV1,
  createNoteDoc,
  deleteSetFingerprint,
  encodeState,
  getContent,
  projectMarkdown,
  stateVector,
} from '@iridium/crdt';
import { describe, expect, it, vi } from 'vitest';

import { ManualClock, ScriptedTickets } from '../test/fakes.ts';
import { toBase64 } from '../test/save-state-model.ts';
import { NoteSession, type NoteSessionOptions } from './note-session.ts';
import { NoteSessionRegistry } from './registry.ts';
import { DOMINANCE_DEADLINE_MS } from './save-state.ts';
import { CollabTicketError, createTicketGetter } from './tickets.ts';

const fakes = vi.hoisted(() => {
  type Listener = (data: never) => void;

  /** The `HocuspocusProvider` surface `NoteSession` uses, and nothing else. */
  class FakeProvider {
    static readonly instances: FakeProvider[] = [];

    readonly configuration: { readonly name: string; readonly token: () => Promise<string> };
    readonly listeners = new Map<string, Listener[]>();
    readonly sent: string[] = [];
    readonly awarenessUpdates: Array<{
      readonly changes: {
        readonly added: readonly number[];
        readonly updated: readonly number[];
        readonly removed: readonly number[];
      };
      readonly origin: unknown;
    }> = [];
    readonly document: { readonly clientID: number };
    readonly awareness = new Map<string, unknown>();
    isAuthenticated = false;
    attached = false;
    destroyed = false;
    detachedLocally = false;

    constructor(configuration: {
      readonly name: string;
      readonly token: () => Promise<string>;
      readonly document: { readonly clientID: number };
    }) {
      this.configuration = configuration;
      this.document = configuration.document;
      FakeProvider.instances.push(this);
    }

    on(event: string, listener: Listener): this {
      const existing = this.listeners.get(event) ?? [];
      existing.push(listener);
      this.listeners.set(event, existing);
      return this;
    }

    attach(): void {
      this.attached = true;
    }

    detach(notifyServer = true): void {
      this.detachedLocally = !notifyServer;
      this.attached = false;
    }

    destroy(): void {
      this.destroyed = true;
    }

    sendStateless(payload: string): void {
      this.sent.push(payload);
    }

    awarenessUpdateHandler(
      changes: {
        readonly added: readonly number[];
        readonly updated: readonly number[];
        readonly removed: readonly number[];
      },
      origin: unknown,
    ): void {
      this.awarenessUpdates.push({ changes, origin });
    }
    setAwarenessField(key: string, value: unknown): void {
      this.awareness.set(key, value);
    }

    emit(event: string, data: unknown): void {
      if (event === 'authenticated') this.isAuthenticated = true;
      if (event === 'close') this.isAuthenticated = false;
      for (const listener of this.listeners.get(event) ?? []) {
        // The real provider extends an untyped emitter, which is exactly what this fake stands in
        // for: the payload's shape is the session's declaration, asserted by each test's call.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above
        listener(data as never);
      }
    }
  }

  class FakeSocket {
    status: 'connecting' | 'connected' | 'disconnected' = 'connected';
    readonly forcedCloses: Array<{ code: number; reason: string }> = [];
    readonly listeners = new Map<string, Set<Listener>>();
    on(event: string, listener: Listener): void {
      const listeners = this.listeners.get(event) ?? new Set<Listener>();
      listeners.add(listener);
      this.listeners.set(event, listeners);
    }
    off(event: string, listener: Listener): void {
      this.listeners.get(event)?.delete(listener);
    }
    onClose({ event }: { event: { code: number; reason: string } }): void {
      this.forcedCloses.push(event);
      this.status = 'disconnected';
      this.emit('status', { status: 'disconnected' });
    }
    emit(event: string, data: unknown): void {
      for (const listener of this.listeners.get(event) ?? []) {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the socket is the I/O adapter fake
        listener(data as never);
      }
    }
  }

  return { FakeProvider, FakeSocket };
});

vi.mock('@hocuspocus/provider', () => ({
  HocuspocusProvider: fakes.FakeProvider,
  HocuspocusProviderWebsocket: fakes.FakeSocket,
  WebSocketStatus: {
    Connected: 'connected',
    Connecting: 'connecting',
    Disconnected: 'disconnected',
  },
}));

const NOTE_ID = NoteId.parse('0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b');
const USER_ID = UserId.parse('0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c');

interface Harness {
  readonly session: NoteSession;
  readonly clock: ManualClock;
  readonly tickets: ScriptedTickets;
  readonly socket: InstanceType<typeof fakes.FakeSocket>;
  readonly probes: string[];
  latest(): InstanceType<typeof fakes.FakeProvider>;
}

function build(
  options: {
    readonly role?: 'viewer' | 'editor' | 'manager';
    readonly log?: NoteSessionOptions['log'];
    readonly random?: () => number;
  } = {},
): Harness {
  fakes.FakeProvider.instances.length = 0;
  const clock = new ManualClock();
  const tickets = new ScriptedTickets();
  const socket = new fakes.FakeSocket();
  const probes: string[] = [];
  const session = new NoteSession({
    noteId: NOTE_ID,
    userId: USER_ID,
    // The fake stands in for the one member of the socket the session reads, and the provider
    // module itself is mocked above.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above
    socket: socket as unknown as NoteSessionOptions['socket'],
    tickets,
    clock,
    random: options.random ?? (() => 0),
    ...(options.log === undefined ? {} : { log: options.log }),
    ...(options.role === undefined ? {} : { role: options.role }),
    onSessionProbe: (reason): void => {
      probes.push(reason);
    },
  });
  return {
    session,
    clock,
    tickets,
    socket,
    probes,
    latest(): InstanceType<typeof fakes.FakeProvider> {
      const provider = fakes.FakeProvider.instances.at(-1);
      if (provider === undefined) throw new Error('no provider was created');
      return provider;
    },
  };
}

/** Bring a freshly attached session to `saved`: authenticated, synced, and acknowledged. */
function settle(harness: Harness): void {
  const provider = harness.latest();
  provider.emit('authenticated', { scope: 'read-write' });
  provider.emit('synced', { state: true });
  acknowledge(harness, 1);
}

/** The server acknowledges everything the document currently holds. */
function acknowledge(harness: Harness, seq: number): void {
  harness.latest().emit('stateless', {
    payload: encodeStateless({
      v: 1,
      t: 'persisted',
      ds: deleteSetFingerprint(harness.session.ydoc),
      seq,
      sv: toBase64(stateVector(harness.session.ydoc)),
    }),
  });
}

function decodeSent(provider: InstanceType<typeof fakes.FakeProvider>): unknown[] {
  return provider.sent.map((payload) => JSON.parse(payload) as unknown);
}

describe('note-session.unit [hp:HP-1]', () => {
  describe('the handshake', () => {
    it('attaches one provider on the note document name and publishes only the user id', () => {
      const harness = build();
      harness.session.attach();

      const provider = harness.latest();
      expect(fakes.FakeProvider.instances).toHaveLength(1);
      expect(provider.configuration.name).toBe(`note:${NOTE_ID}`);
      expect(provider.attached).toBe(true);
      // Awareness carries the identity and nothing a client could choose for itself (A25/F6).
      expect([...harness.latest().awareness.keys()]).toEqual(['user', 'cursor']);
      expect(provider.awareness.get('user')).toEqual({ id: USER_ID });
    });

    it('publishes only its own awareness id, including its removal, while leaving peer states visible', () => {
      const harness = build();
      harness.session.attach();
      const provider = harness.latest();
      const ownId = harness.session.ydoc.clientID;
      const peerId = ownId + 1;
      provider.awareness.set('peer', { user: { id: 'peer' } });
      provider.awarenessUpdateHandler(
        { added: [peerId], updated: [], removed: [peerId] },
        'timeout',
      );
      expect(provider.awarenessUpdates).toEqual([]);
      provider.awarenessUpdateHandler(
        { added: [peerId, ownId], updated: [ownId, peerId], removed: [] },
        'local',
      );
      provider.awarenessUpdateHandler(
        { added: [], updated: [], removed: [ownId, peerId] },
        'provider destroy',
      );
      expect(provider.awarenessUpdates).toEqual([
        { changes: { added: [ownId], updated: [ownId], removed: [] }, origin: 'local' },
        { changes: { added: [], updated: [], removed: [ownId] }, origin: 'provider destroy' },
      ]);
      expect(provider.awareness.get('peer')).toEqual({ user: { id: 'peer' } });
      harness.session.dispose();
    });
    it('takes a fresh ticket for every attachment, through the auth message', async () => {
      const harness = build();
      harness.session.attach();
      await expect(harness.latest().configuration.token()).resolves.toBe('irid_tkt_1');
      await expect(harness.latest().configuration.token()).resolves.toBe('irid_tkt_2');
      expect(harness.tickets.issued).toEqual(['irid_tkt_1', 'irid_tkt_2']);
    });

    it('sends one baseline after every synced event and reaches saved on its answer', () => {
      const harness = build();
      harness.session.attach();
      expect(harness.session.saveState).toBe('connecting');

      harness.latest().emit('authenticated', { scope: 'read-write' });
      harness.latest().emit('synced', { state: true });
      expect(decodeSent(harness.latest())).toEqual([{ v: 1, t: 'baseline' }]);
      expect(harness.session.saveState).toBe('syncing');

      acknowledge(harness, 1);
      expect(harness.session.saveState).toBe('saved');
    });

    it('reports a disconnected socket before the handshake and a connected one after it', () => {
      const harness = build();
      harness.socket.status = 'disconnected';
      harness.session.attach();
      expect(harness.session.saveState).toBe('disconnected');

      harness.latest().emit('status', { status: 'connected' });
      expect(harness.session.saveState).toBe('connecting');
    });

    it('re-runs the handshake when the socket comes back and claims nothing in between', () => {
      const harness = build({ role: 'editor' });
      harness.session.attach();
      settle(harness);
      expect(harness.session.saveState).toBe('saved');

      harness.latest().emit('status', { status: 'disconnected' });
      expect(harness.session.saveState).toBe('disconnected');

      harness.latest().emit('open', { event: null });
      harness.latest().emit('status', { status: 'connected' });
      // The provider has not re-authenticated or re-synced yet: a stale handshake would have let
      // the old acknowledgement report `saved` for a connection that has no authorization.
      expect(harness.session.saveState).toBe('connecting');

      harness.latest().emit('authenticated', { scope: 'read-write' });
      harness.latest().emit('synced', { state: true });
      acknowledge(harness, 2);
      expect(harness.session.saveState).toBe('saved');
    });

    it('seeds the role from the authenticated scope and corrects it from the role message', () => {
      const harness = build();
      harness.session.attach();
      harness.latest().emit('authenticated', { scope: 'readonly' });
      expect(harness.session.snapshot.role).toBe('viewer');

      harness.latest().emit('stateless', {
        payload: encodeStateless({ v: 1, t: 'role', role: 'manager' }),
      });
      expect(harness.session.snapshot.role).toBe('manager');
    });
  });

  describe('what the document reports', () => {
    it('treats this user’s edit as unsaved work and a relayed edit as neither saved nor unsaved work', () => {
      const harness = build({ role: 'editor' });
      harness.session.attach();
      settle(harness);
      expect(harness.session.saveState).toBe('saved');

      harness.session.ytext.insert(0, 'local');
      expect(harness.session.saveState).toBe('syncing');
      expect(harness.session.snapshot.warnsBeforeUnload).toBe(true);
      expect(harness.session.input.lastLocalEditAt).toBe(harness.clock.now());

      acknowledge(harness, 2);
      harness.latest().emit('unsyncedChanges', { number: 0 });
      expect(harness.session.saveState).toBe('saved');

      // A relayed edit carries the provider as its transaction origin, exactly as the provider
      // applies one from the wire. It moves the vector, so the note is not saved until the writer
      // commits it, but it is not this user's unsent text and it restarts no deadline.
      harness.session.ydoc.transact(() => {
        harness.session.ytext.insert(0, 'remote');
      }, harness.latest());
      expect(harness.session.saveState).toBe('syncing');
      expect(harness.session.input.unsynced).toBe(0);
    });

    it('owns an undo manager that survives the provider and tracks only this user', () => {
      const harness = build({ role: 'editor' });
      harness.session.attach();
      settle(harness);

      // 07-client-applications.md section 5.2 fixes the capture window; consecutive keystrokes
      // inside it are one undo step, which is why the manager lives on the session.
      expect(harness.session.undoManager.captureTimeout).toBe(500);

      harness.session.ytext.insert(0, 'mine');
      harness.session.ydoc.transact(() => {
        harness.session.ytext.insert(0, 'theirs ');
      }, harness.latest());
      expect(projectMarkdown(harness.session.ydoc)).toBe('theirs mine');

      harness.session.undoManager.undo();
      // Only this client's transaction is reverted: an undo may never take back a participant's
      // edit, and the default tracked-origin set is what guarantees it.
      expect(projectMarkdown(harness.session.ydoc)).toBe('theirs ');

      const beforeUpgrade = harness.session.undoManager;
      harness.latest().emit('stateless', {
        payload: encodeStateless({ v: 1, t: 'role', role: 'manager' }),
      });
      expect(harness.session.undoManager).toBe(beforeUpgrade);
    });

    it('turns red when the acknowledgement has not contained the edit for fifteen seconds', async () => {
      const harness = build({ role: 'editor' });
      harness.session.attach();
      settle(harness);
      harness.session.ytext.insert(0, 'unacknowledged');
      harness.latest().emit('unsyncedChanges', { number: 0 });
      expect(harness.session.saveState).toBe('syncing');

      await harness.clock.advance(DOMINANCE_DEADLINE_MS + 1);
      expect(harness.session.saveState).toBe('save-failed');
    });

    it.each(['AQs=', 'AAAB', 'AgsDCwQ=', 'gQALAw=='])(
      'rejects noncanonical persisted vector %s without poisoning future edits or attachments',
      (sv) => {
        const log = {
          warn: vi.fn<NonNullable<NoteSessionOptions['log']>['warn']>(),
          error: vi.fn<NonNullable<NoteSessionOptions['log']>['error']>(),
        };
        const harness = build({ role: 'editor', log });
        try {
          harness.session.attach();
          settle(harness);
          const savedInput = harness.session.input;
          const savedSnapshot = harness.session.snapshot;
          expect(() =>
            harness.latest().emit('stateless', {
              payload: encodeStateless({
                v: 1,
                t: 'persisted',
                ds: deleteSetFingerprint(harness.session.ydoc),
                seq: 99,
                sv,
              }),
            }),
          ).not.toThrow();
          expect(harness.session.input).toBe(savedInput);
          expect(harness.session.snapshot).toBe(savedSnapshot);
          expect(harness.session.saveState).toBe('saved');
          expect(log.warn).toHaveBeenCalledWith('collab.stateless-rejected', {
            noteId: NOTE_ID,
            reason: 'invalid_payload',
            detail: expect.any(String),
          });
          expect(() => harness.session.ytext.insert(0, 'still editable')).not.toThrow();
          expect(harness.session.saveState).toBe('syncing');
          expect(harness.session.snapshot.warnsBeforeUnload).toBe(true);
          harness.session.detach(false);
          expect(() => harness.session.attach()).not.toThrow();
          acknowledge(harness, 2);
          harness.latest().emit('authenticated', { scope: 'read-write' });
          harness.latest().emit('synced', { state: true });
          harness.latest().emit('unsyncedChanges', { number: 0 });
          expect(harness.session.input.persisted?.seq).toBe(2);
          expect(harness.session.saveState).toBe('saved');
          expect(projectMarkdown(harness.session.ydoc)).toBe('still editable');
        } finally {
          harness.session.dispose();
        }
      },
    );

    it('reports an overdue unacknowledged edit immediately after a long socket outage', async () => {
      const harness = build({ role: 'editor' });
      try {
        harness.session.attach();
        settle(harness);
        harness.session.ytext.insert(0, 'pending');
        const editedAt = harness.session.input.lastLocalEditAt;
        harness.latest().emit('status', { status: 'disconnected' });
        await harness.clock.advance(DOMINANCE_DEADLINE_MS + 1);
        expect(harness.session.saveState).toBe('disconnected');
        harness.latest().emit('open', { event: null });
        harness.latest().emit('status', { status: 'connected' });
        harness.latest().emit('authenticated', { scope: 'read-write' });
        harness.latest().emit('synced', { state: true });
        harness.latest().emit('unsyncedChanges', { number: 0 });
        expect(harness.session.input.lastLocalEditAt).toBe(editedAt);
        expect(harness.session.input.now).toBe(harness.clock.now());
        expect(harness.session.saveState).toBe('save-failed');
        expect(harness.session.snapshot.warnsBeforeUnload).toBe(true);
        expect(harness.clock.armed).toBe(0);
        acknowledge(harness, 2);
        expect(harness.session.saveState).toBe('saved');
        expect(harness.session.snapshot.warnsBeforeUnload).toBe(false);
      } finally {
        harness.session.dispose();
      }
    });

    it('preserves the pending edit deadline and committed baseline across a fresh provider', async () => {
      const harness = build({ role: 'editor' });
      try {
        harness.session.attach();
        settle(harness);
        const document = harness.session.ydoc;
        const undo = harness.session.undoManager;
        harness.session.ytext.insert(0, 'pending');
        const editedAt = harness.session.input.lastLocalEditAt;
        const persisted = harness.session.input.persisted;
        harness.latest().emit('close', { event: { code: 4503, reason: 'unavailable' } });
        await harness.clock.advance(DOMINANCE_DEADLINE_MS + 1);
        expect(fakes.FakeProvider.instances).toHaveLength(2);
        expect(harness.session.input.lastLocalEditAt).toBe(editedAt);
        expect(harness.session.input.persisted).toBe(persisted);
        harness.latest().emit('authenticated', { scope: 'read-write' });
        harness.latest().emit('synced', { state: true });
        harness.latest().emit('unsyncedChanges', { number: 0 });
        expect(harness.session.saveState).toBe('save-failed');
        expect(harness.session.snapshot.warnsBeforeUnload).toBe(true);
        expect(harness.session.ydoc).toBe(document);
        expect(harness.session.undoManager).toBe(undo);
        acknowledge(harness, 2);
        expect(harness.session.saveState).toBe('saved');
        expect(harness.session.snapshot.warnsBeforeUnload).toBe(false);
        harness.session.undoManager.undo();
        expect(projectMarkdown(document)).toBe('');
      } finally {
        harness.session.dispose();
      }
    });

    it('keeps the original remaining deadline across short reattachments and renews it for a later edit', async () => {
      const harness = build({ role: 'editor' });
      try {
        harness.session.ytext.insert(0, 'before attach');
        const firstEditAt = harness.clock.now();
        await harness.clock.advance(5_000);
        harness.session.attach();
        harness.latest().emit('authenticated', { scope: 'read-write' });
        harness.latest().emit('synced', { state: true });
        harness.latest().emit('unsyncedChanges', { number: 0 });
        expect(harness.session.input.lastLocalEditAt).toBe(firstEditAt);
        await harness.clock.advance(5_000);
        harness.session.ytext.insert(harness.session.ytext.length, ' and later');
        const lastEditAt = harness.clock.now();
        harness.latest().emit('unsyncedChanges', { number: 0 });
        await harness.clock.advance(DOMINANCE_DEADLINE_MS - 5_000 + 1);
        expect(harness.session.saveState).toBe('syncing');
        expect(harness.session.input.lastLocalEditAt).toBe(lastEditAt);
        await harness.clock.advance(5_000);
        expect(harness.session.saveState).toBe('save-failed');
        expect(harness.clock.armed).toBe(0);
      } finally {
        harness.session.dispose();
      }
    });

    it('re-requests the baseline once after five seconds of silence, and then waits', async () => {
      const harness = build({ role: 'editor' });
      harness.session.attach();
      harness.latest().emit('authenticated', { scope: 'read-write' });
      harness.latest().emit('synced', { state: true });
      expect(decodeSent(harness.latest())).toHaveLength(1);

      await harness.clock.advance(5_000);
      expect(decodeSent(harness.latest())).toEqual([
        { v: 1, t: 'baseline' },
        { v: 1, t: 'baseline' },
      ]);

      await harness.clock.advance(60_000);
      expect(decodeSent(harness.latest())).toHaveLength(2);
    });

    it('forces compaction and projection on demand without unsettling saved', () => {
      const harness = build({ role: 'editor' });
      harness.session.attach();
      settle(harness);
      harness.session.flush();
      expect(decodeSent(harness.latest()).at(-1)).toEqual({ v: 1, t: 'flush' });

      harness.latest().emit('stateless', {
        payload: encodeStateless({ v: 1, t: 'projected', seq: 1 }),
      });
      expect(harness.session.saveState).toBe('saved');
    });

    it('ignores a message a newer server added and keeps the participant list server-authoritative', () => {
      const harness = build({ role: 'editor' });
      harness.session.attach();
      settle(harness);

      harness.latest().emit('stateless', { payload: JSON.stringify({ v: 1, t: 'compacted' }) });
      expect(harness.session.saveState).toBe('saved');

      harness.latest().emit('stateless', {
        payload: encodeStateless({
          v: 1,
          t: 'participants',
          users: [{ id: USER_ID, name: 'A', colorHue: 10, role: 'editor' }],
        }),
      });
      expect(harness.session.snapshot.participants).toEqual([
        { id: USER_ID, name: 'A', colorHue: 10, role: 'editor' },
      ]);
      expect(harness.session.saveState).toBe('saved');
    });
  });

  describe('deletion durability', () => {
    it('keeps a delete-only edit unsaved after transport acceptance and stale or unrelated acknowledgements', () => {
      const harness = build({ role: 'editor' });
      try {
        harness.session.ytext.insert(0, 'saved text');
        harness.session.attach();
        settle(harness);
        const vector = stateVector(harness.session.ydoc);
        const before = deleteSetFingerprint(harness.session.ydoc);
        harness.session.ytext.delete(0, harness.session.ytext.length);
        harness.latest().emit('unsyncedChanges', { number: 0 });
        expect(stateVector(harness.session.ydoc)).toEqual(vector);
        expect(harness.session.saveState).toBe('syncing');
        expect(harness.session.snapshot.warnsBeforeUnload).toBe(true);
        for (const seq of [1, 2]) {
          harness.latest().emit('stateless', {
            payload: encodeStateless({
              v: 1,
              t: 'persisted',
              seq,
              sv: toBase64(vector),
              ds: before,
            }),
          });
          expect(harness.session.saveState).toBe('syncing');
          expect(harness.session.snapshot.warnsBeforeUnload).toBe(true);
        }
        acknowledge(harness, 3);
        expect(harness.session.saveState).toBe('saved');
        expect(harness.session.snapshot.warnsBeforeUnload).toBe(false);
      } finally {
        harness.session.dispose();
      }
    });

    it('requires a new committed deletion witness for relayed deletes without inventing local unsynced work', () => {
      const harness = build({ role: 'editor' });
      const peer = createNoteDoc();
      try {
        harness.session.ytext.insert(0, 'abcdef');
        harness.session.attach();
        settle(harness);
        const editedAt = harness.session.input.lastLocalEditAt;
        applyV1(peer, encodeState(harness.session.ydoc, 1), null);
        const vector = stateVector(peer);
        getContent(peer).delete(1, 3);
        applyV1(harness.session.ydoc, encodeState(peer, 1, vector), harness.latest());
        expect(harness.session.input.localSv).toEqual(vector);
        expect(harness.session.input.unsynced).toBe(0);
        expect(harness.session.input.lastLocalEditAt).toBe(editedAt);
        expect(harness.session.saveState).toBe('syncing');
        expect(harness.session.snapshot.warnsBeforeUnload).toBe(true);
        acknowledge(harness, 2);
        expect(harness.session.saveState).toBe('saved');
        expect(projectMarkdown(harness.session.ydoc)).toBe('aef');
      } finally {
        peer.destroy();
        harness.session.dispose();
      }
    });

    it('preserves an overdue delete and its old committed witness through provider replacement', async () => {
      const harness = build({ role: 'editor' });
      try {
        harness.session.ytext.insert(0, 'durable before delete');
        harness.session.attach();
        settle(harness);
        const before = harness.session.input.persisted;
        harness.session.ytext.delete(0, harness.session.ytext.length);
        harness.latest().emit('unsyncedChanges', { number: 0 });
        const editedAt = harness.session.input.lastLocalEditAt;
        const pendingDs = harness.session.input.localDs;
        harness.latest().emit('close', { event: { code: 4503, reason: 'unavailable' } });
        await harness.clock.advance(DOMINANCE_DEADLINE_MS + 1);
        harness.latest().emit('authenticated', { scope: 'read-write' });
        harness.latest().emit('synced', { state: true });
        harness.latest().emit('unsyncedChanges', { number: 0 });
        expect(harness.session.input.persisted).toBe(before);
        expect(harness.session.input.localDs).toBe(pendingDs);
        expect(harness.session.input.lastLocalEditAt).toBe(editedAt);
        expect(harness.session.saveState).toBe('save-failed');
        expect(harness.session.snapshot.warnsBeforeUnload).toBe(true);
        acknowledge(harness, 2);
        expect(harness.session.saveState).toBe('saved');
        expect(harness.session.snapshot.warnsBeforeUnload).toBe(false);
      } finally {
        harness.session.dispose();
      }
    });
  });

  describe('role changes on a live connection', () => {
    it('retires the socket generation at a missing CLOSE deadline and retains pending edits', async () => {
      const harness = build({ role: 'viewer' });
      try {
        harness.session.attach();
        harness.latest().emit('authenticated', { scope: 'readonly' });
        const document = harness.session.ydoc;
        const undo = harness.session.undoManager;
        harness.session.ytext.insert(0, 'pending through a lost CLOSE');
        harness.latest().emit('stateless', {
          payload: encodeStateless({ v: 1, t: 'role', role: 'editor' }),
        });
        await harness.clock.advance(4_999);
        expect(harness.session.provider).toBeNull();
        expect(harness.socket.forcedCloses).toEqual([]);
        await harness.clock.advance(1);
        expect(harness.socket.forcedCloses).toEqual([
          { code: 4408, reason: 'close-handshake-timeout' },
        ]);
        expect(fakes.FakeProvider.instances).toHaveLength(2);
        expect(harness.session.input.socket).toBe('disconnected');
        expect(harness.session.ydoc).toBe(document);
        expect(harness.session.undoManager).toBe(undo);
        expect(projectMarkdown(document)).toBe('pending through a lost CLOSE');
        expect(harness.session.saveState).not.toBe('saved');
        expect(harness.socket.listeners.get('message')?.size).toBe(0);
        harness.socket.status = 'connected';
        harness.latest().emit('status', { status: 'connected' });
        settle(harness);
        expect(harness.session.saveState).toBe('saved');
        undo.undo();
        expect(projectMarkdown(document)).toBe('');
      } finally {
        harness.session.dispose();
      }
      expect(harness.clock.armed).toBe(0);
    });

    it.each(['echo', 'disconnect', 'dispose'] as const)(
      'cancels the CLOSE deadline after %s without a later socket reset',
      async (completion) => {
        const harness = build({ role: 'viewer' });
        try {
          harness.session.attach();
          harness.latest().emit('authenticated', { scope: 'readonly' });
          harness.latest().emit('stateless', {
            payload: encodeStateless({ v: 1, t: 'role', role: 'editor' }),
          });
          if (completion === 'echo') {
            const name = Uint8Array.from(`note:${NOTE_ID}`, (character) => character.charCodeAt(0));
            const reason = Uint8Array.from('provider_initiated', (character) =>
              character.charCodeAt(0),
            );
            harness.socket.emit('message', {
              data: Uint8Array.from([name.length, ...name, 7, reason.length, ...reason]),
            });
          } else if (completion === 'disconnect') {
            harness.socket.status = 'disconnected';
            harness.socket.emit('status', { status: 'disconnected' });
          } else {
            harness.session.dispose();
          }
          await harness.clock.advance(60_000);
          expect(harness.socket.forcedCloses).toEqual([]);
          expect(fakes.FakeProvider.instances).toHaveLength(completion === 'dispose' ? 1 : 2);
          expect(harness.clock.armed).toBe(0);
        } finally {
          harness.session.dispose();
        }
      },
    );

    it.each([
      { v: 1, t: 'content-invalid', reason: 'attributes' },
      { v: 1, t: 'size-exceeded', size: 1_000_001, max: 1_000_000 },
      { v: 1, t: 'persist-failed', reason: 'db_unavailable', retryInMs: 1000 },
    ] as const)(
      'resynchronizes the same editor after explicit $t recovery, preserving document and undo',
      (failure) => {
        const harness = build({ role: 'editor' });
        try {
          harness.session.attach();
          settle(harness);
          const document = harness.session.ydoc;
          const clientId = document.clientID;
          harness.latest().emit('stateless', { payload: encodeStateless(failure) });
          harness.session.ytext.insert(0, 'refused local text');
          harness.latest().emit('unsyncedChanges', { number: 1 });
          // A partial commit may precede recovery. The recovery signal must not depend on the
          // persist-failed field remaining set after an acknowledgement.
          acknowledge(harness, 2);
          const blocked = harness.latest();
          blocked.emit('stateless', {
            payload: encodeStateless({ v: 1, t: 'role', role: 'editor' }),
          });
          expect(blocked.destroyed).toBe(false);
          expect(fakes.FakeProvider.instances).toHaveLength(1);
          blocked.emit('stateless', {
            payload: encodeStateless({ v: 1, t: 'role', role: 'editor', recovered: true }),
          });
          expect(blocked.destroyed).toBe(true);
          const name = Uint8Array.from(`note:${NOTE_ID}`, (character) => character.charCodeAt(0));
          const reason = Uint8Array.from('provider_initiated', (character) =>
            character.charCodeAt(0),
          );
          harness.socket.emit('message', {
            data: Uint8Array.from([name.length, ...name, 7, reason.length, ...reason]).buffer,
          });
          expect(fakes.FakeProvider.instances).toHaveLength(2);
          expect(harness.session.ydoc).toBe(document);
          expect(document.clientID).toBe(clientId);
          expect(projectMarkdown(document)).toBe('refused local text');
          expect(harness.session.input).toMatchObject({
            contentInvalid: false,
            oversize: false,
            authenticated: false,
            synced: false,
          });
          settle(harness);
          harness.latest().emit('unsyncedChanges', { number: 0 });
          acknowledge(harness, 3);
          expect(harness.session.saveState).toBe('saved');
          harness.session.undoManager.undo();
          expect(projectMarkdown(document)).toBe('');
        } finally {
          harness.session.dispose();
        }
      },
    );

    it('replaces the provider on an upgrade so the refused text is resent (A20)', () => {
      const harness = build({ role: 'viewer' });
      harness.session.attach();
      harness.latest().emit('authenticated', { scope: 'readonly' });
      harness.latest().emit('synced', { state: true });
      harness.session.ytext.insert(0, 'typed while read-only');
      harness.latest().emit('unsyncedChanges', { number: 1 });
      expect(harness.session.saveState).toBe('rejected');

      const refused = harness.latest();
      harness.latest().emit('stateless', {
        payload: encodeStateless({ v: 1, t: 'role', role: 'editor' }),
      });

      expect(refused.destroyed).toBe(true);
      expect(fakes.FakeProvider.instances).toHaveLength(1);
      const name = Uint8Array.from(`note:${NOTE_ID}`, (character) => character.charCodeAt(0));
      const reason = Uint8Array.from('provider_initiated', (character) => character.charCodeAt(0));
      const frame = Uint8Array.from([name.length, ...name, 7, reason.length, ...reason]);
      harness.socket.emit('message', { data: frame.buffer });
      expect(fakes.FakeProvider.instances).toHaveLength(2);
      expect(harness.latest().attached).toBe(true);
      expect(harness.session.snapshot.role).toBe('editor');
      // The document is untouched by the re-attach: the text the viewer typed is still there and is
      // what the new provider's SyncStep2 carries.
      expect(projectMarkdown(harness.session.ydoc)).toBe('typed while read-only');
    });

    it('releases the old attachment when the socket closes before its close acknowledgement', () => {
      const harness = build({ role: 'viewer' });
      harness.session.attach();
      harness.latest().emit('authenticated', { scope: 'readonly' });
      harness
        .latest()
        .emit('stateless', { payload: encodeStateless({ v: 1, t: 'role', role: 'editor' }) });
      expect(fakes.FakeProvider.instances).toHaveLength(1);
      harness.socket.status = 'disconnected';
      harness.socket.emit('status', { status: 'disconnected' });
      expect(fakes.FakeProvider.instances).toHaveLength(2);
      expect(harness.session.provider).not.toBeNull();
      expect(harness.socket.listeners.get('message')?.size).toBe(0);
      harness.session.dispose();
    });

    it('keeps the provider on a downgrade and reports the refusal instead', () => {
      const harness = build({ role: 'manager' });
      harness.session.attach();
      settle(harness);
      const provider = harness.latest();

      provider.emit('stateless', { payload: encodeStateless({ v: 1, t: 'role', role: 'viewer' }) });
      expect(provider.destroyed).toBe(false);
      expect(fakes.FakeProvider.instances).toHaveLength(1);
      expect(harness.session.saveState).toBe('read-only');

      provider.emit('unsyncedChanges', { number: 1 });
      expect(harness.session.saveState).toBe('rejected');
    });
  });

  describe('closes', () => {
    it.each([0, 12_000])(
      'backs off repeated note-closing refusals with grace %i',
      async (graceMs) => {
        const harness = build({ role: 'editor', random: () => 1 });
        try {
          harness.session.attach();
          settle(harness);
          harness.session.ytext.insert(0, 'pending while closing');
          const document = harness.session.ydoc;
          const delays = [5_000, 10_000, 20_000, 40_000, 60_000, 60_000];
          for (const [index, backoff] of delays.entries()) {
            harness.latest().emit('stateless', {
              payload: encodeStateless({ v: 1, t: 'closing', reason: 'note-trashed', graceMs }),
            });
            harness.latest().emit('close', { event: { code: 1000, reason: 'note-closing' } });
            // eslint-disable-next-line no-await-in-loop -- each refusal advances the same retry ladder
            await harness.clock.advance(Math.max(graceMs, backoff) - 1);
            expect(fakes.FakeProvider.instances).toHaveLength(index + 1);
            // eslint-disable-next-line no-await-in-loop -- observe the exact deadline of this attempt
            await harness.clock.advance(1);
            expect(fakes.FakeProvider.instances).toHaveLength(index + 2);
            expect(harness.session.ydoc).toBe(document);
            expect(harness.session.saveState).not.toBe('saved');
          }
          expect(projectMarkdown(document)).toBe('pending while closing');
        } finally {
          harness.session.dispose();
        }
      },
    );

    it('destroys the provider and never retries a terminal close', async () => {
      const harness = build({ role: 'editor' });
      harness.session.attach();
      settle(harness);

      harness.latest().emit('close', { event: { code: 1000, reason: 'revoked' } });
      expect(harness.latest().destroyed).toBe(true);
      expect(harness.session.saveState).toBe('revoked');
      expect(harness.session.provider).toBeNull();
      expect(harness.probes).toEqual(['revoked']);

      await harness.clock.advance(5 * 60_000);
      expect(fakes.FakeProvider.instances).toHaveLength(1);
    });

    it('re-attaches a transient close on the backoff ladder', async () => {
      const harness = build({ role: 'editor' });
      harness.session.attach();
      settle(harness);

      harness.latest().emit('close', { event: { code: 1000, reason: 'capacity' } });
      expect(harness.session.saveState).toBe('capacity');

      await harness.clock.advance(4_999);
      expect(fakes.FakeProvider.instances).toHaveLength(1);

      await harness.clock.advance(2);
      expect(fakes.FakeProvider.instances).toHaveLength(2);
      // The re-attach is a fresh snapshot, so the transient close does not outlive it.
      expect(harness.session.saveState).toBe('connecting');
      expect(harness.session.input.closeReason).toBeNull();
    });

    it.each(['close-frame', 'auth-denied'] as const)(
      'recovers unavailable via %s with the same document and pending edits',
      async (via) => {
        const harness = build({ role: 'editor' });
        harness.session.attach();
        settle(harness);
        const document = harness.session.ydoc;
        const undo = harness.session.undoManager;
        harness.session.ytext.insert(0, 'pending during outage');
        const original = harness.latest();
        if (via === 'auth-denied') original.emit('authenticationFailed', { reason: 'unavailable' });
        else original.emit('close', { event: { code: 1000, reason: 'unavailable' } });
        expect(harness.session.saveState).toBe('disconnected');
        expect(harness.session.provider).toBeNull();
        expect(harness.probes).toEqual([]);
        expect(harness.session.snapshot.dormant).toBe(false);
        await harness.clock.advance(4_999);
        expect(fakes.FakeProvider.instances).toHaveLength(1);
        await harness.clock.advance(2);
        expect(fakes.FakeProvider.instances).toHaveLength(2);
        expect(harness.session.ydoc).toBe(document);
        expect(harness.session.undoManager).toBe(undo);
        expect(projectMarkdown(harness.session.ydoc)).toBe('pending during outage');
        expect(harness.session.saveState).toBe('connecting');
        expect(harness.session.input.closeReason).toBeNull();
        settle(harness);
        expect(harness.session.saveState).toBe('saved');
        harness.session.dispose();
      },
    );

    it('makes the session dormant when the attachment cap refuses it, and does not loop', async () => {
      const harness = build({ role: 'editor' });
      harness.session.attach();
      settle(harness);

      harness.latest().emit('authenticationFailed', { reason: 'rate-limited' });
      expect(harness.session.snapshot.dormant).toBe(true);
      expect(harness.session.saveState).toBe('closed');

      await harness.clock.advance(10 * 60_000);
      expect(fakes.FakeProvider.instances).toHaveLength(1);
    });

    it('invalidates the current ticket batch when an older getter completes after a reconnect', async () => {
      const harness = build({ role: 'editor' });
      const oldTicket = Promise.withResolvers<string>();
      const currentTicket = Promise.withResolvers<string>();
      vi.spyOn(harness.tickets, 'next')
        .mockReturnValueOnce(oldTicket.promise)
        .mockReturnValueOnce(currentTicket.promise);
      try {
        harness.session.attach();
        const document = harness.session.ydoc;
        const undo = harness.session.undoManager;
        harness.session.ytext.insert(0, 'pending edit');
        const provider = harness.latest();
        const old = provider.configuration.token();
        provider.emit('close', { event: { code: 1006, reason: '' } });
        provider.emit('open', { event: {} });
        const current = provider.configuration.token();
        currentTicket.resolve('irid_tkt_current-batch');
        await current;
        oldTicket.resolve('irid_tkt_retired-batch');
        await old;
        provider.emit('authenticationFailed', { reason: 'unauthorized' });
        expect(harness.tickets.invalidated).toEqual(['irid_tkt_current-batch']);
        expect(harness.session.ydoc).toBe(document);
        expect(harness.session.undoManager).toBe(undo);
        expect(projectMarkdown(harness.session.ydoc)).toBe('pending edit');
      } finally {
        harness.session.dispose();
      }
    });

    it('retries a routine ticket expiry once and then stops', async () => {
      const harness = build({ role: 'editor' });
      harness.session.attach();
      settle(harness);

      const previous = harness.latest();
      const rejected = await previous.configuration.token();
      harness.latest().emit('close', { event: { code: 1000, reason: 'unauthorized' } });
      expect(harness.tickets.invalidated).toEqual([rejected]);
      expect(previous.detachedLocally).toBe(true);
      await harness.clock.advance(1);
      expect(fakes.FakeProvider.instances).toHaveLength(2);

      harness.latest().emit('close', { event: { code: 1000, reason: 'unauthorized' } });
      await harness.clock.advance(60_000);
      expect(fakes.FakeProvider.instances).toHaveLength(2);
      expect(harness.probes).toEqual(['unauthorized', 'unauthorized']);
    });

    it('records a close it cannot classify rather than guessing at a policy', () => {
      const harness = build({ role: 'editor' });
      harness.session.attach();
      settle(harness);

      harness.latest().emit('close', { event: { code: 1006, reason: '' } });
      expect(harness.session.input.closeReason).toBeNull();
      expect(harness.session.snapshot.closeDetail).toBeNull();

      harness.latest().emit('close', { event: { code: 1000, reason: 'something-new' } });
      expect(harness.session.snapshot.closeDetail).toBe('something-new');
      expect(harness.session.input.closeReason).toBeNull();
    });

    it('refuses to attach an offline delta larger than one update may be (step 0)', async () => {
      const harness = build({ role: 'editor' });
      harness.session.attach();
      settle(harness);

      harness.session.ytext.insert(0, 'x'.repeat(LIMITS.YJS_UPDATE_MAX_BYTES + 1_024));
      harness.latest().emit('close', { event: { code: 1000, reason: 'capacity' } });
      await harness.clock.advance(60_000);

      // The provider is never created, so nothing is sent and nothing is refused: the text stays
      // readable and exportable and the note never enters a close/reconnect loop.
      expect(fakes.FakeProvider.instances).toHaveLength(1);
      expect(harness.session.saveState).toBe('too-large');
    });
  });

  describe('the ticket getter', () => {
    it('retries a rate limit and a network failure, and returns the ticket', async () => {
      const clock = new ManualClock();
      const tickets = new ScriptedTickets([
        new CollabTicketError('rate limited', { status: 429 }),
        new CollabTicketError('no response', { status: null }),
        'irid_tkt_good',
      ]);
      const getter = createTicketGetter({ source: tickets, clock, random: () => 1 });

      const pending = getter();
      await clock.advance(200);
      await clock.advance(400);
      await expect(pending).resolves.toBe('irid_tkt_good');
    });

    it('gives up after three retries rather than holding a socket open', async () => {
      const clock = new ManualClock();
      const limited = new CollabTicketError('rate limited', { status: 429 });
      const tickets = new ScriptedTickets([limited, limited, limited, limited, 'irid_tkt_late']);
      const getter = createTicketGetter({ source: tickets, clock, random: () => 1 });

      // The rejection is captured at once, so the failure never floats while the clock is moved.
      const settled = getter().catch((error: unknown) => error);
      await clock.advance(200);
      await clock.advance(400);
      await clock.advance(800);
      await expect(settled).resolves.toBe(limited);
    });

    it('does not retry a refusal the server meant', async () => {
      const clock = new ManualClock();
      const denied = new CollabTicketError('session expired', { status: 401 });
      const tickets = new ScriptedTickets([denied, 'irid_tkt_never']);
      const getter = createTicketGetter({ source: tickets, clock, random: () => 1 });

      await expect(getter()).rejects.toBe(denied);
      expect(clock.armed).toBe(0);
    });
  });

  describe('disposal', () => {
    it('releases the provider, the timers and the document', async () => {
      const harness = build({ role: 'editor' });
      harness.session.attach();
      settle(harness);
      harness.session.ytext.insert(0, 'pending');

      const undo = harness.session.undoManager;
      expect(undo.undoStack.length).toBeGreaterThan(0);

      harness.session.dispose();
      expect(harness.latest().destroyed).toBe(true);
      expect(harness.session.provider).toBeNull();
      expect(harness.clock.armed).toBe(0);
      // `UndoManager.destroy` is what removes the manager from its own tracked origins and detaches
      // its transaction handler, so this is the observable evidence that the session released it.
      expect(undo.trackedOrigins.has(undo)).toBe(false);

      await harness.clock.advance(10 * 60_000);
      expect(fakes.FakeProvider.instances).toHaveLength(1);
    });
  });

  describe('the registry', () => {
    it('gives every holder of a note the same session and attaches it once', () => {
      fakes.FakeProvider.instances.length = 0;
      const clock = new ManualClock();
      const registry = new NoteSessionRegistry({
        create: () => build({ role: 'editor' }).session,
        clock,
      });

      const first = registry.acquire('note-a');
      const second = registry.acquire('note-a');
      expect(second).toBe(first);
      expect(registry.size).toBe(1);
      expect(first.provider).not.toBeNull();
    });

    it('keeps a released session for a minute, so closing and reopening a tab loses nothing', async () => {
      const clock = new ManualClock();
      const registry = new NoteSessionRegistry({
        create: () => build({ role: 'editor' }).session,
        clock,
      });

      const session = registry.acquire('note-a');
      registry.release('note-a');
      await clock.advance(59_000);
      expect(registry.acquire('note-a')).toBe(session);

      registry.release('note-a');
      registry.release('note-a');
      await clock.advance(60_001);
      expect(registry.size).toBe(0);
      expect(registry.acquire('note-a')).not.toBe(session);
    });

    it('refuses to hand out a session after the window closed', () => {
      const registry = new NoteSessionRegistry({
        create: () => build().session,
        clock: new ManualClock(),
      });
      registry.acquire('note-a');
      registry.dispose();
      expect(() => registry.acquire('note-a')).toThrow(/after dispose/);
    });
  });
});
