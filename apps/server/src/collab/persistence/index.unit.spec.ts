/** Public persistence seams: origin provenance, early boot, corruption, and lifecycle. */
import { newId, NoteId } from '@iridium/contracts';
import { deleteSetFingerprint, getContent, LOAD_ORIGIN, stateVector } from '@iridium/crdt';
import { describe, expect, it, vi } from 'vitest';

import { CollabOwnershipLost } from '../owner-lease.ts';
import { CollabPersistenceService, mapOrigin, PersistenceShutdownIncomplete } from './index.ts';
import { fakeDocument, localOrigin } from './testing/fake-document.ts';
import { createHarness, HARNESS_USER, SECOND_USER, settle } from './testing/harness.ts';
import { MemoryPersistenceStore } from './testing/memory-store.ts';

describe('collab.persistence.unit [hp:HP-1]', () => {
  it('maps only declared provenance and safely defaults missing connection and local actor fields', () => {
    expect(mapOrigin(LOAD_ORIGIN)).toBe('load');
    for (const origin of [
      undefined,
      null,
      { source: 'other' },
      { source: 'local' },
      { source: 'local', context: null },
      { source: 'local', context: { reason: 'import' } },
    ])
      expect(mapOrigin(origin)).toBeNull();
    expect(mapOrigin({ source: 'connection', connection: { context: {} } })).toMatchObject({
      actor: { userId: null, sessionId: null, actorType: 'user' },
      origin: 'connection',
    });
    expect(
      mapOrigin({ source: 'local', context: { reason: 'repair', userId: 'invalid' } }),
    ).toMatchObject({
      actor: { userId: null, actorType: 'system' },
      origin: 'repair',
      source: undefined,
    });
    expect(mapOrigin(localOrigin('restore', HARNESS_USER))).toMatchObject({
      actor: { userId: HARNESS_USER, sessionId: null, actorType: 'user' },
      origin: 'restore',
    });
  });

  it('keeps the update callback nonthrowing and unqueued when an origin accessor fails', async () => {
    const harness = createHarness();
    const note = await harness.openNote();
    const origin = {
      source: 'connection',
      get connection(): never {
        throw new Error('corrupt adapter origin');
      },
    };
    expect(() =>
      note.document.transact(() => getContent(note.document).insert(0, 'still-live'), origin),
    ).not.toThrow();
    expect(note.writer.queueLength).toBe(0);
    expect(harness.store.note(note.noteId)?.headSeq).toBe(1);
    expect(harness.logger.lines.at(-1)?.fields).toMatchObject({
      event: 'collab.hook.error',
      hook: 'update-listener',
    });
    expect(harness.metrics.count('persist_failures_total', { reason: 'db_error' })).toBe(1);
  });

  it('attaches idempotently, ignores loader updates, and tolerates an absent metrics registry during boot', async () => {
    const harness = createHarness();
    const seeded = await harness.openNote({ markdown: 'initial' });
    const layer = new CollabPersistenceService({
      store: harness.store,
      clock: harness.clock,
      logger: harness.logger,
      metrics: () => null,
      gauges: () => null,
      faults: harness.faults,
      limits: { compactionAwaitTimeoutMs: 1_000 },
      slots: 1,
      callbacks: {
        onTrashed: () => undefined,
        requestUnload: async () => undefined,
        onWriteRejected: () => undefined,
      },
    });
    const document = fakeDocument();
    layer.apply(document, seeded.loaded);
    const writer = layer.attach(document, seeded, seeded.loaded);
    expect(layer.attach(document, seeded, seeded.loaded)).toBe(writer);
    expect(layer.writerOfDocument(seeded.documentName)).toBe(writer);
    expect(layer.store).toBe(harness.store);
    document.transact(() => getContent(document).insert(0, 'load:'), LOAD_ORIGIN);
    expect(writer.queueLength).toBe(0);
    document.transact(
      () => getContent(document).insert(getContent(document).length, ':repair'),
      localOrigin('repair'),
    );
    await writer.drain();
    expect(writer.lastCommittedSeq).toBe(2);
    await writer.enqueueCompaction('flush');
    expect(harness.store.note(seeded.noteId)?.headSeq).toBe(2);
    layer.detach('note:absent');
    layer.detach(seeded.documentName);
    expect(layer.writers()).toEqual([]);
    expect(layer.stateOf(seeded.documentName)).toBeNull();
    expect(layer.writerOfDocument(seeded.documentName)).toBeUndefined();
  });

  it('returns no baseline for missing or concurrently removed notes rather than fabricating empty state', async () => {
    const harness = createHarness();
    expect(await harness.persistence.baselineOf(NoteId.parse(newId()))).toBeNull();
    const note = await harness.openNote();
    vi.spyOn(harness.store, 'loadDoc').mockResolvedValue(null);
    expect(await harness.persistence.baselineOf(note.noteId)).toBeNull();
    vi.restoreAllMocks();
  });

  it('reconstructs a deletion witness from durable rows and keeps it stable across compaction', async () => {
    const harness = createHarness();
    const note = await harness.openNote({ markdown: 'abcdef' });
    const before = note.writer.lastPersisted;
    note.document.transact(() => getContent(note.document).delete(0, 2), localOrigin('repair'));
    await note.writer.drain();
    const expected = {
      seq: 2,
      sv: stateVector(note.document),
      ds: deleteSetFingerprint(note.document),
    };
    expect(expected.sv).toEqual(before.sv);
    expect(expected.ds).not.toBe(before.ds);
    expect(await harness.persistence.baselineOf(note.noteId)).toEqual(expected);
    await note.writer.enqueueCompaction('flush');
    harness.store.prune(note.noteId, new Date(harness.clock.now() + 1));
    expect(await harness.persistence.baselineOf(note.noteId)).toEqual(expected);
    harness.persistence.detach(note.documentName);
  });

  it('does not label a later committed deletion with the earlier head captured for a baseline', async () => {
    const harness = createHarness();
    const note = await harness.openNote({ markdown: 'abcdef' });
    note.document.transact(() => getContent(note.document).delete(0, 1), localOrigin('repair'));
    await note.writer.drain();
    const earlier = note.writer.lastPersisted;
    const loadUpdates = harness.store.loadUpdatesAfter.bind(harness.store);
    const spy = vi
      .spyOn(harness.store, 'loadUpdatesAfter')
      .mockImplementationOnce(async (id, after) => {
        note.document.transact(() => getContent(note.document).delete(0, 1), localOrigin('repair'));
        await note.writer.drain();
        return loadUpdates(id, after);
      });
    try {
      expect(await harness.persistence.baselineOf(note.noteId)).toEqual(earlier);
      expect(note.writer.lastPersisted.seq).toBe(earlier.seq + 1);
      expect(note.writer.lastPersisted.ds).not.toBe(earlier.ds);
    } finally {
      spy.mockRestore();
      harness.persistence.detach(note.documentName);
    }
  });

  it.each(['missing-tail', 'gap'] as const)(
    'refuses a baseline with %s after concurrent log pruning',
    async (failure) => {
      const harness = createHarness();
      const note = await harness.openNote({ markdown: 'abcdef' });
      note.document.transact(() => getContent(note.document).delete(0, 1), localOrigin('repair'));
      await note.writer.drain();
      note.document.transact(() => getContent(note.document).delete(0, 1), localOrigin('repair'));
      await note.writer.drain();
      const updates = await harness.store.loadUpdatesAfter(note.noteId, 1);
      const spy = vi
        .spyOn(harness.store, 'loadUpdatesAfter')
        .mockResolvedValue(failure === 'gap' ? updates.filter((row) => row.seq === 3) : []);
      try {
        await expect(harness.persistence.baselineOf(note.noteId)).rejects.toThrow(
          'baseline log is incomplete',
        );
      } finally {
        spy.mockRestore();
        harness.persistence.detach(note.documentName);
      }
    },
  );

  it('applies persisted latches before a new connection can write even when no invalid reason was recorded', async () => {
    const harness = createHarness();
    const note = await harness.openNote();
    harness.persistence.detach(note.documentName);
    const writer = harness.persistence.attach(note.document, note, {
      ...note.loaded,
      contentInvalid: true,
      oversize: true,
    });
    const connection = {
      context: {},
      readOnly: false,
      sendStateless: vi.fn<(payload: string) => void>(),
    };
    writer.applyLatches(connection);
    expect(connection.readOnly).toBe(true);
    expect(connection.sendStateless).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({ v: 1, t: 'size-exceeded', size: 0, max: 1_000_000 }),
    );
    expect(writer.oversize).toBe(true);
    writer.dispose();
    await settle();
  });

  it('retains the exact store captured during load and rejects attachment after its owner lifetime ends', async () => {
    let active = true;
    const assertActive = vi.fn<() => void>(() => {
      if (!active) throw new CollabOwnershipLost();
    });
    const store = Object.assign(new MemoryPersistenceStore(), { assertActive });
    const factory = vi.fn<() => typeof store>(() => store);
    const harness = createHarness({ store, writerStore: factory });
    const note = await harness.openNote();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(assertActive).toHaveBeenCalledTimes(2);
    expect(harness.persistence.store).toBe(store);
    harness.persistence.detach(note.documentName);
    active = false;
    expect(() => harness.persistence.attach(note.document, note, note.loaded)).toThrow(
      CollabOwnershipLost,
    );
    await expect(harness.persistence.load(note.noteId, note.vaultId)).rejects.toBeInstanceOf(
      CollabOwnershipLost,
    );
  });

  it('ignores an unrelated principal and joins accepted work before its own barrier returns', async () => {
    const harness = createHarness();
    const note = await harness.openNote();
    const gate = harness.store.holdWrites();
    note.document.transact(
      () => getContent(note.document).insert(0, 'accepted'),
      localOrigin('repair', HARNESS_USER),
    );
    await settle();
    expect(note.writer.hasPendingFor(SECOND_USER)).toBe(false);
    await harness.persistence.drainForUser(SECOND_USER);
    let finished = false;
    const draining = harness.persistence.drainForUser(HARNESS_USER).then(() => {
      return (finished = true);
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    gate.release();
    await draining;
    expect(harness.store.note(note.noteId)?.headSeq).toBe(2);
    await harness.persistence.drainForUser(null);
  });
});

describe('collab.persistence.unit [hp:HP-2]', () => {
  it('retains an uncommitted captured note after ownership cleanup removes every live writer', async () => {
    const harness = createHarness();
    const note = await harness.openNote();
    harness.store.failWrites(new Error('database unavailable'));
    note.document.transact(
      () => getContent(note.document).insert(0, 'uncommitted'),
      localOrigin('repair'),
    );
    await settle();
    expect(note.writer.queueLength).toBe(1);
    harness.persistence.beginShutdown();
    await harness.persistence.fenceAll();
    expect(harness.persistence.writers()).toEqual([]);
    expect(harness.store.note(note.noteId)?.headSeq).toBe(1);
    expect(harness.persistence.undrained()).toEqual([note.noteId]);
    // A repeated signal must not replace the original cohort with today's empty live map.
    harness.persistence.beginShutdown();
    await expect(harness.persistence.drainAll()).rejects.toMatchObject({
      name: 'PersistenceShutdownIncomplete',
      undrained: [note.noteId],
    });
    expect(() => harness.persistence.assertShutdownComplete()).toThrow(
      PersistenceShutdownIncomplete,
    );
  });

  it('does not turn a completed ownership cleanup before shutdown into a permanent drain failure', async () => {
    const harness = createHarness();
    const note = await harness.openNote();
    await harness.persistence.fenceAll();
    expect(harness.persistence.isFenced(note.document)).toBe(true);
    await harness.persistence.settleFenced(note.document);
    await harness.persistence.drainAll();
    harness.persistence.assertShutdownComplete();
    harness.persistence.beginShutdown();
    await harness.persistence.drainAll();
    expect(harness.persistence.undrained()).toEqual([]);
    harness.persistence.assertShutdownComplete();
  });

  it('includes a load finishing during shutdown and requires both real unload checkpoints', async () => {
    const harness = createHarness();
    const first = await harness.openNote();
    harness.persistence.beginShutdown();
    const second = await harness.openNote();
    for (const note of [first, second]) {
      note.document.transact(
        () => getContent(note.document).insert(0, 'accepted'),
        localOrigin('repair'),
      );
    }
    await harness.persistence.drainAll();
    expect(() => harness.persistence.assertShutdownComplete()).toThrow(
      PersistenceShutdownIncomplete,
    );
    await Promise.all([first, second].map((note) => note.writer.enqueueCompaction('unload')));
    expect(await Promise.all([first, second].map((note) => note.writer.unloadVeto()))).toEqual([
      null,
      null,
    ]);
    for (const note of [first, second]) harness.persistence.detach(note.documentName);
    await harness.persistence.drainAll();
    expect(harness.persistence.undrained()).toEqual([]);
    harness.persistence.assertShutdownComplete();
  });

  it('still refuses clean shutdown when ownership is lost after writers drained but before unload', async () => {
    const harness = createHarness();
    const note = await harness.openNote();
    harness.persistence.beginShutdown();
    await harness.persistence.drainAll();
    await harness.persistence.fenceAll();
    expect(harness.persistence.writers()).toEqual([]);
    expect(harness.persistence.undrained()).toEqual([note.noteId]);
    expect(() => harness.persistence.assertShutdownComplete()).toThrow(
      PersistenceShutdownIncomplete,
    );
  });

  it('joins another captured writer before reporting the first lifetime failure', async () => {
    const harness = createHarness({ slots: 2 });
    const failed = await harness.openNote();
    const pending = await harness.openNote();
    harness.persistence.beginShutdown();
    failed.writer.fence();
    const gate = harness.store.holdWrites();
    pending.document.transact(
      () => getContent(pending.document).insert(0, 'commit-me'),
      localOrigin('repair'),
    );
    await settle();
    expect(gate.waiting).toBe(1);
    let finished = false;
    const draining = harness.persistence.drainAll().then(
      () => {
        finished = true;
        return null;
      },
      (error: unknown) => {
        finished = true;
        return error;
      },
    );
    await settle();
    expect(finished).toBe(false);
    gate.release();
    expect(await draining).toMatchObject({
      name: 'PersistenceShutdownIncomplete',
      undrained: [failed.noteId],
    });
    expect(harness.store.note(pending.noteId)?.headSeq).toBe(2);
    expect(pending.writer.queueLength).toBe(0);
  });
});
