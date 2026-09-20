/**
 * `collab.persistence-hook.unit` — `IridiumPersistence`: the load, the attach, the latches, the
 * `baseline` and `flush` answers, the store, the veto and the unload, over the in-memory store
 * (05-collaboration-and-durability.md, "Loading a document", "The baseline", "flush", "Unload, veto,
 * and completing the unload"; HP-2).
 *
 * The document and the connection are Hocuspocus's own classes; the persistence layer, the writer,
 * the loader and the compactor are the product's. Only the store and the clock are doubles.
 */
import { decodeServerNoteMessage, LIMITS, noteDocName, vaultDocName } from '@iridium/contracts';
import { createNoteDoc, getContent, projectMarkdown } from '@iridium/crdt';
import { describe, expect, it, vi } from 'vitest';

import { CollabOwnershipLost } from '../owner-lease.ts';
import { PersistenceUnavailable } from '../persistence/kysely-store.ts';
import { createHarness, HARNESS_ACTOR, settle } from '../persistence/testing/harness.ts';
import { UnloadVeto } from '../rejection.ts';
import {
  closeReasons,
  fakeConnection,
  fakeDocumentOf,
  statelessPayloads,
  type FakeSocket,
} from '../testing/fake-hocuspocus.ts';
import { step2Frame, updateFrame } from '../testing/frames.ts';
import {
  afterLoadPayload,
  afterUnloadPayload,
  authenticatedContext,
  beforeUnloadPayload,
  connectedPayloadFor,
  hookHarness,
  hookOf,
  loadPayload,
  messagePayload,
  statelessPayload,
  storePayload,
} from '../testing/hook-deps.ts';
import { createPersistenceExtension } from './persistence.ts';

function messages(socket: FakeSocket): Array<{ t: string; [key: string]: unknown }> {
  return statelessPayloads(socket).flatMap((payload) => {
    const decoded = decodeServerNoteMessage(payload);
    return decoded.ok ? [decoded.message] : [];
  });
}

function scene(markdown = 'seed') {
  const harness = createHarness();
  const hooks = hookHarness();
  const loadFailures: string[] = [];
  const unloaded: string[] = [];
  const extension = createPersistenceExtension({
    persistence: harness.persistence,
    gateway: hooks.gateway,
    clock: harness.clock,
    logger: hooks.logger,
    metrics: () => hooks.metrics,
    onLoadFailed: (name) => loadFailures.push(name),
    onUnloaded: (name) => unloaded.push(name),
  });
  const vaultId = hooks.world.vault();
  const noteId = hooks.world.note(vaultId);
  harness.store.seed({
    noteId,
    vaultId,
    markdownLf: markdown,
    actor: HARNESS_ACTOR,
    now: harness.clock.date(),
  });
  const userId = hooks.world.user();
  const context = authenticatedContext(hooks.world.clock, {
    userId,
    sessionId: hooks.world.session(userId),
    vaultId,
    noteId,
  });
  const document = fakeDocumentOf(noteDocName(noteId));
  return { harness, hooks, extension, vaultId, noteId, context, document, loadFailures, unloaded };
}

/** The load path as Hocuspocus runs it: `onLoadDocument`, then `afterLoadDocument`. */
async function load(s: ReturnType<typeof scene>): Promise<void> {
  await hookOf(s.extension, 'onLoadDocument')(loadPayload(s.document, s.context));
  await hookOf(s.extension, 'afterLoadDocument')(afterLoadPayload(s.document, s.context));
}

/** One client keystroke through the connection's transaction origin. */
function type(s: ReturnType<typeof scene>, connection: unknown, text: string): void {
  s.document.transact(
    () => {
      getContent(s.document).insert(getContent(s.document).length, text);
    },
    { source: 'connection', connection },
  );
}

describe('collab.persistence-hook.unit [hp:HP-2]', () => {
  describe('loading', () => {
    it.each(
      (['content-invalid', 'oversize', 'writable'] as const).flatMap((kind) => [
        { kind, frameName: 'SyncStep2', frame: step2Frame },
        { kind, frameName: 'Update', frame: updateFrame },
      ]),
    )(
      'enforces $kind before a queued $frameName while connected hooks are still pending',
      async ({ kind, frame }) => {
        const s = scene();
        const stored = s.harness.store.note(s.noteId);
        if (stored === undefined) throw new Error('The fixture must be seeded.');
        stored.contentInvalid = kind === 'content-invalid';
        stored.oversize = kind === 'oversize';
        await load(s);
        const { connection, socket } = fakeConnection(s.document, s.context);
        const peer = createNoteDoc();
        let update: Uint8Array = new Uint8Array();
        peer.on('update', (bytes: Uint8Array) => {
          update = bytes;
        });
        getContent(peer).insert(0, 'queued-edit');
        connection.beforeHandleMessage(async (_connection, bytes) => {
          await hookOf(s.extension, 'beforeHandleMessage')(messagePayload(connection, bytes));
        });
        try {
          connection.handleMessage(frame(s.document.name, update));
          await connection.waitForPendingMessages();
          expect(connection.readOnly).toBe(kind !== 'writable');
          expect(projectMarkdown(s.document).includes('queued-edit')).toBe(kind === 'writable');
          await s.harness.persistence.writerOfDocument(s.document.name)?.drain();
          expect(s.harness.store.note(s.noteId)?.headSeq).toBe(kind === 'writable' ? 2 : 1);
          const notices = messages(socket).length;
          await hookOf(s.extension, 'connected')(connectedPayloadFor(connection));
          expect(messages(socket)).toHaveLength(notices);
        } finally {
          connection.close();
          s.harness.persistence.detach(s.document.name);
          s.document.destroy();
          peer.destroy();
        }
      },
    );

    it('loads the committed state into the document and attaches the writer with the vault index', async () => {
      const s = scene('hello');
      await load(s);
      expect(projectMarkdown(s.document)).toBe('hello');
      const writer = s.harness.persistence.writerOfDocument(s.document.name);
      expect(writer?.lastPersisted.seq).toBe(1);
      expect(s.hooks.gateway.vaultOf(s.document.name)).toBe(s.vaultId);
      expect(s.loadFailures).toEqual([]);
    });

    it('refuses an unknown note, a foreign vault and a missing context, releasing the reservation each time', async () => {
      const s = scene();
      const unknown = fakeDocumentOf(noteDocName(s.hooks.world.note(s.vaultId)));
      await expect(
        hookOf(s.extension, 'onLoadDocument')(loadPayload(unknown, s.context)),
      ).rejects.toMatchObject({ reason: 'note-not-found' });
      const foreign = { ...s.context, vaultId: s.hooks.world.vault() };
      await expect(
        hookOf(s.extension, 'onLoadDocument')(loadPayload(s.document, foreign)),
      ).rejects.toMatchObject({ reason: 'note-not-found' });
      const { vaultId: _dropped, ...withoutVault } = s.context;
      await expect(
        hookOf(s.extension, 'onLoadDocument')(loadPayload(s.document, withoutVault)),
      ).rejects.toMatchObject({ reason: 'note-not-found', auditReason: 'context_missing' });
      expect(s.loadFailures).toEqual([unknown.name, s.document.name, s.document.name]);
    });

    it.each([
      { code: 'ETIMEDOUT', syscall: 'getConnection' },
      { code: 'PROTOCOL_SEQUENCE_TIMEOUT' },
      { code: 'ECONNRESET' },
      { code: 'ER_LOCK_WAIT_TIMEOUT', errno: 1205 },
      { code: 'ER_LOCK_DEADLOCK', errno: 1213 },
    ])(
      'refuses a transient $code load as unavailable and loads the same valid note after recovery',
      async (fields) => {
        const s = scene('durable seed');
        const unavailable = Object.assign(new Error('fixture database unavailable'), fields);
        const read = vi.spyOn(s.harness.store, 'loadDoc').mockRejectedValueOnce(unavailable);
        try {
          await expect(
            hookOf(s.extension, 'onLoadDocument')(loadPayload(s.document, s.context)),
          ).rejects.toMatchObject({
            reason: 'unavailable',
            code: 4503,
            auditReason: 'load_unavailable',
          });
          expect(s.loadFailures).toEqual([s.document.name]);
          expect(s.harness.persistence.writers()).toEqual([]);
          expect(projectMarkdown(s.document)).toBe('');
          await load(s);
          expect(projectMarkdown(s.document)).toBe('durable seed');
          expect(s.harness.persistence.writerOfDocument(s.document.name)?.lastPersisted.seq).toBe(
            1,
          );
        } finally {
          read.mockRestore();
        }
      },
    );

    it('retries a store whose persistence pool has not connected without inventing a missing note', async () => {
      const s = scene();
      const read = vi
        .spyOn(s.harness.store, 'loadDoc')
        .mockRejectedValueOnce(new PersistenceUnavailable());
      try {
        await expect(
          hookOf(s.extension, 'onLoadDocument')(loadPayload(s.document, s.context)),
        ).rejects.toMatchObject({ reason: 'unavailable', code: 4503 });
        expect(s.loadFailures).toEqual([s.document.name]);
        expect(s.harness.persistence.writers()).toEqual([]);
        await load(s);
        expect(projectMarkdown(s.document)).toBe('seed');
      } finally {
        read.mockRestore();
      }
    });

    it('reports a lost captured owner generation as no-owner-lease without attaching a writer', async () => {
      const s = scene();
      const read = vi
        .spyOn(s.harness.store, 'loadDoc')
        .mockRejectedValueOnce(new CollabOwnershipLost());
      try {
        await expect(
          hookOf(s.extension, 'onLoadDocument')(loadPayload(s.document, s.context)),
        ).rejects.toMatchObject({ reason: 'no-owner-lease', code: 4503 });
        expect(s.loadFailures).toEqual([s.document.name]);
        expect(s.harness.persistence.writers()).toEqual([]);
      } finally {
        read.mockRestore();
      }
    });

    it('keeps corrupt persisted bytes terminal instead of repeatedly retrying a healthy database', async () => {
      const s = scene();
      const stored = s.harness.store.note(s.noteId);
      if (stored === undefined) throw new Error('The corruption fixture must have a stored note.');
      stored.snapshot = Uint8Array.of(255);
      await expect(
        hookOf(s.extension, 'onLoadDocument')(loadPayload(s.document, s.context)),
      ).rejects.toMatchObject({ reason: 'note-not-found', code: 4404, auditReason: 'load_failed' });
      expect(s.loadFailures).toEqual([s.document.name]);
      expect(s.harness.persistence.writers()).toEqual([]);
      expect(s.hooks.logger.events()).toContain('collab.hook.error');
    });

    it('leaves a vault document to the vault channel', async () => {
      const s = scene();
      const vault = fakeDocumentOf(vaultDocName(s.vaultId));
      await expect(
        hookOf(s.extension, 'onLoadDocument')(loadPayload(vault, s.context)),
      ).resolves.toBeUndefined();
      await expect(
        hookOf(s.extension, 'afterLoadDocument')(afterLoadPayload(vault, s.context)),
      ).resolves.toBeUndefined();
      expect(s.harness.persistence.writers()).toEqual([]);
    });

    it('latches content-invalid on hostile content and tells a later connection from its first frame', async () => {
      const s = scene();
      await hookOf(s.extension, 'onLoadDocument')(loadPayload(s.document, s.context));
      getContent(s.document).insert(0, 'a\rb');
      await hookOf(s.extension, 'afterLoadDocument')(afterLoadPayload(s.document, s.context));
      const writer = s.harness.persistence.writerOfDocument(s.document.name);
      expect(writer?.contentInvalid).toBe(true);
      const { connection, socket } = fakeConnection(s.document, s.context);
      await hookOf(s.extension, 'connected')(connectedPayloadFor(connection));
      expect(connection.readOnly).toBe(true);
      expect(messages(socket)).toEqual([{ v: 1, t: 'content-invalid', reason: 'cr' }]);
    });
  });

  describe('stateless', () => {
    it('answers baseline from the writer, then from the store once unloaded, and persist-failed when neither has it', async () => {
      const s = scene();
      await load(s);
      const { connection, socket } = fakeConnection(s.document, s.context);
      type(s, connection, 'x');
      await s.harness.persistence.writerOfDocument(s.document.name)?.drain();
      await hookOf(
        s.extension,
        'onStateless',
      )(statelessPayload(connection, '{"v":1,"t":"baseline"}'));
      expect(messages(socket).at(-1)).toMatchObject({ t: 'persisted', seq: 2 });

      await hookOf(s.extension, 'afterUnloadDocument')(afterUnloadPayload(s.document.name));
      await hookOf(
        s.extension,
        'onStateless',
      )(statelessPayload(connection, '{"v":1,"t":"baseline"}'));
      expect(messages(socket).at(-1)).toMatchObject({ t: 'persisted', seq: 2 });

      const stranger = fakeConnection(
        fakeDocumentOf(noteDocName(s.hooks.world.note(s.vaultId))),
        s.context,
      );
      await hookOf(
        s.extension,
        'onStateless',
      )(statelessPayload(stranger.connection, '{"v":1,"t":"baseline"}'));
      expect(messages(stranger.socket).at(-1)).toEqual({
        v: 1,
        t: 'persist-failed',
        reason: 'db_error',
        retryInMs: 1_000,
      });
    });

    it('adds the last failure to the baseline of a failed writer', async () => {
      const s = scene();
      await load(s);
      const { connection, socket } = fakeConnection(s.document, s.context);
      s.harness.store.failWrites(new Error('away'));
      type(s, connection, 'x');
      await settle(20);
      const writer = s.harness.persistence.writerOfDocument(s.document.name);
      expect(writer?.state).toBe('retrying');
      // The retry ladder ends in `failed` after ten attempts or thirty seconds, whichever first.
      for (let step = 0; step < 12; step += 1) {
        if (writer?.state === 'failed') break;
        // eslint-disable-next-line no-await-in-loop -- the ladder is climbed one backoff at a time
        await s.harness.clock.advance(5_000);
        // eslint-disable-next-line no-await-in-loop -- see above
        await settle(20);
      }
      expect(writer?.state).toBe('failed');
      await hookOf(
        s.extension,
        'onStateless',
      )(statelessPayload(connection, '{"v":1,"t":"baseline"}'));
      const last = messages(socket).slice(-2);
      expect(last[0]).toMatchObject({ t: 'persisted', seq: 1 });
      expect(last[1]).toMatchObject({ t: 'persist-failed' });
      // The outage ends: the failed cadence retries, commits and acknowledges.
      s.harness.store.failWrites(null);
      await s.harness.clock.advance(30_000);
      await writer?.drain();
      expect(writer?.lastPersisted.seq).toBe(2);
    });

    it('answers flush with projected after a compaction, and past the budget with the current seq and no work', async () => {
      const s = scene();
      await load(s);
      const { connection, socket } = fakeConnection(s.document, s.context);
      type(s, connection, 'x');
      await s.harness.persistence.writerOfDocument(s.document.name)?.drain();
      const before = s.harness.store.counts.compactions;
      for (let count = 0; count < LIMITS.FLUSH_PER_MINUTE; count += 1) {
        // eslint-disable-next-line no-await-in-loop -- each flush is one round trip
        await hookOf(
          s.extension,
          'onStateless',
        )(statelessPayload(connection, '{"v":1,"t":"flush"}'));
      }
      expect(s.harness.store.counts.compactions).toBe(before + LIMITS.FLUSH_PER_MINUTE);
      expect(messages(socket).at(-1)).toEqual({ v: 1, t: 'projected', seq: 2 });
      await hookOf(s.extension, 'onStateless')(statelessPayload(connection, '{"v":1,"t":"flush"}'));
      expect(s.harness.store.counts.compactions).toBe(before + LIMITS.FLUSH_PER_MINUTE);
      expect(messages(socket).at(-1)).toEqual({ v: 1, t: 'projected', seq: 2 });
      expect(closeReasons(socket)).toEqual([]);
    });

    it('closes the document connection on a malformed payload', async () => {
      const s = scene();
      await load(s);
      const { connection, socket } = fakeConnection(s.document, s.context);
      await hookOf(s.extension, 'onStateless')(statelessPayload(connection, '{"v":1,"t":"nope"}'));
      expect(closeReasons(socket)).toEqual(['protocol-error']);
      expect(s.hooks.logger.events()).toContain('collab.write.rejected');
    });
  });

  describe('storing, vetoing and unloading', () => {
    it('stores through the writer: an unload store writes the unload checkpoint at head', async () => {
      const s = scene();
      await load(s);
      const { connection } = fakeConnection(s.document, s.context);
      type(s, connection, 'x');
      await s.harness.persistence.writerOfDocument(s.document.name)?.drain();
      await hookOf(s.extension, 'onStoreDocument')(storePayload(s.document, s.context, 0));
      const stored = s.harness.store.note(s.noteId);
      expect(stored?.revisions.some((row) => row.kind === 'unload' && row.seq === 2)).toBe(true);
      expect(stored?.snapshotThroughSeq).toBe(2);
    });

    it('settles former-owner SQL and pending stores before unloading only that fenced document object', async () => {
      const s = scene();
      await load(s);
      const { connection, socket } = fakeConnection(s.document, s.context);
      const writer = s.harness.persistence.writerOfDocument(s.document.name);
      const gate = s.harness.store.holdWrites();
      type(s, connection, ':committing');
      await settle(40);
      expect(gate.waiting).toBe(1);
      type(s, connection, ':still-local');
      const pendingStore = hookOf(
        s.extension,
        'onStoreDocument',
      )(storePayload(s.document, s.context, 0));
      expect(writer?.pendingCompactions).toBe(1);

      const fencing = s.harness.persistence.fenceAll();
      expect(s.harness.persistence.isFenced(s.document)).toBe(true);
      expect(connection.readOnly).toBe(true);
      let unloaded = false;
      const unloading = hookOf(
        s.extension,
        'beforeUnloadDocument',
      )(beforeUnloadPayload(s.document)).then(() => {
        return (unloaded = true);
      });
      await hookOf(s.extension, 'onStoreDocument')(storePayload(s.document, s.context, 0));
      await settle();
      expect(unloaded).toBe(false);
      expect(s.harness.store.note(s.noteId)?.headSeq).toBe(1);
      expect(s.harness.store.counts.compactions).toBe(0);

      gate.release();
      await Promise.all([fencing, pendingStore, unloading]);
      expect(unloaded).toBe(true);
      expect(s.harness.persistence.writers()).toEqual([]);
      expect(s.harness.store.note(s.noteId)?.headSeq).toBe(2);
      expect(s.harness.store.note(s.noteId)?.snapshotThroughSeq).toBe(1);
      expect(s.harness.store.counts.compactions).toBe(0);
      expect(writer?.lastPersisted.seq).toBe(1);
      expect(messages(socket).filter((message) => message.t === 'persisted')).toEqual([]);
      expect(s.hooks.logger.events()).not.toContain('collab.hook.error');
      connection.close();
      await hookOf(s.extension, 'afterUnloadDocument')(afterUnloadPayload(s.document.name));
      expect(s.unloaded).toEqual([s.document.name]);
      expect(s.hooks.gateway.vaultOf(s.document.name)).toBeUndefined();

      const replacement = fakeDocumentOf(s.document.name);
      await hookOf(s.extension, 'onLoadDocument')(loadPayload(replacement, s.context));
      await hookOf(s.extension, 'afterLoadDocument')(afterLoadPayload(replacement, s.context));
      expect(s.harness.persistence.isFenced(replacement)).toBe(false);
      expect(s.harness.persistence.isFenced(s.document)).toBe(true);
      expect(projectMarkdown(replacement)).toBe('seed:committing');
      await expect(
        hookOf(s.extension, 'beforeUnloadDocument')(beforeUnloadPayload(replacement)),
      ).rejects.toBeInstanceOf(UnloadVeto);
      const replacementWriter = s.harness.persistence.writerOfDocument(replacement.name);
      expect(replacementWriter).not.toBe(writer);
      await replacementWriter?.drain();
      expect(s.harness.store.note(s.noteId)?.snapshotThroughSeq).toBe(2);
      expect(
        s.harness.store
          .note(s.noteId)
          ?.revisions.some((row) => row.kind === 'unload' && row.seq === 2),
      ).toBe(true);
      await hookOf(s.extension, 'beforeUnloadDocument')(beforeUnloadPayload(replacement));
      await hookOf(s.extension, 'afterUnloadDocument')(afterUnloadPayload(replacement.name));
      replacement.destroy();
      s.document.destroy();
    });

    it('warns and stores nothing for a document with no writer', async () => {
      const s = scene();
      await expect(
        hookOf(s.extension, 'onStoreDocument')(storePayload(s.document, s.context)),
      ).resolves.toBeUndefined();
      expect(s.hooks.logger.events()).toContain('persist.failed');
    });

    it('vetoes the unload while work is queued, and the writer completes it once drained and alone', async () => {
      const s = scene();
      await load(s);
      const { connection } = fakeConnection(s.document, s.context);
      const gate = s.harness.store.holdWrites();
      type(s, connection, 'x');
      await settle();
      await expect(
        hookOf(s.extension, 'beforeUnloadDocument')(beforeUnloadPayload(s.document)),
      ).rejects.toBeInstanceOf(UnloadVeto);
      const writer = s.harness.persistence.writerOfDocument(s.document.name);
      expect(writer?.unloadRequested).toBe(true);
      connection.close();
      gate.release();
      await writer?.drain();
      await settle(40);
      expect(s.harness.unloadRequests).toEqual([s.document.name]);
      expect(
        s.harness.store
          .note(s.noteId)
          ?.revisions.some((row) => row.kind === 'unload' && row.seq === 2),
      ).toBe(true);
      await expect(
        hookOf(s.extension, 'beforeUnloadDocument')(beforeUnloadPayload(s.document)),
      ).resolves.toBeUndefined();
      await hookOf(s.extension, 'afterUnloadDocument')(afterUnloadPayload(s.document.name));
      expect(s.harness.persistence.writerOfDocument(s.document.name)).toBeUndefined();
      expect(s.hooks.gateway.vaultOf(s.document.name)).toBeUndefined();
      expect(s.unloaded).toEqual([s.document.name]);
    });
  });
});
