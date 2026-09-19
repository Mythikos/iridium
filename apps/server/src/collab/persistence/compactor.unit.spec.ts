/**
 * `collab.compactor.unit` — the compaction transaction, step by step, over the in-memory store
 * (05-collaboration-and-durability.md, "The compaction job", "Checkpoint policy"; 03-data-model.md
 * §8.6, §8.6.1).
 *
 * Each of the three terminal outcomes resolves and commits what the plan says it commits; the
 * trashed guard commits nothing; the checkpoint policy fires on a hash change after the interval, on
 * an unload with no row at the head, and writes `head-unverified` from an invalid head.
 */
import { LIMITS, newId, NoteId, VaultId } from '@iridium/contracts';
import {
  createNoteDoc,
  loadState,
  LOAD_ORIGIN,
  encodeState,
  getContent,
  stateVector,
  SV_STORED_MAX_BYTES,
  type NoteDoc,
} from '@iridium/crdt';
import { describe, expect, it } from 'vitest';

import { ManualClock } from '../../../test/support/manual-clock.ts';
import { FaultRegistry } from '../../ops/faults.ts';
import {
  capture,
  HEAD_UNVERIFIED_LABEL,
  NO_COMPACTION_FAULTS,
  runCompaction,
  type CompactionFaults,
  type RunCompactionOptions,
} from './compactor.ts';
import { NoteDocMissing } from './errors.ts';
import { applyLoaded, loadNote } from './loader.ts';
import { fakeDocument } from './testing/fake-document.ts';
import { HARNESS_ACTOR, recordingLogger } from './testing/harness.ts';
import { MemoryPersistenceStore } from './testing/memory-store.ts';
import type { CompactOutcome, CompactTrigger } from './types.ts';

interface Fixture {
  readonly store: MemoryPersistenceStore;
  readonly noteId: NoteId;
  readonly vaultId: VaultId;
  readonly doc: NoteDoc;
  readonly clock: ManualClock;
  readonly stateVectorOversizes: readonly number[];
  readonly compact: (options?: {
    readonly trigger?: CompactTrigger;
    readonly throughSeq?: number;
    readonly faults?: CompactionFaults;
  }) => Promise<CompactOutcome>;
}

async function fixture(markdown = 'first', intervalMinutes = 10): Promise<Fixture> {
  const store = new MemoryPersistenceStore();
  const clock = new ManualClock();
  const noteId = NoteId.parse(newId());
  const vaultId = VaultId.parse(newId());
  store.seed({
    noteId,
    vaultId,
    markdownLf: markdown,
    actor: HARNESS_ACTOR,
    now: clock.date(),
    checkpointIntervalMinutes: intervalMinutes,
  });
  const doc = fakeDocument();
  applyLoaded(doc, await loadNote(store, noteId, vaultId, recordingLogger()));
  const oversize: number[] = [];
  const compact = async (
    options: Parameters<Fixture['compact']>[0] = {},
  ): Promise<CompactOutcome> => {
    // Compaction receives only a committed head. Mirror that precondition through the store port
    // instead of claiming a new sequence while leaving the fixture's database at the seed.
    const throughSeq = options.throughSeq ?? 1;
    const existing = store.note(noteId);
    if (existing !== undefined && existing.deletedAt === null && throughSeq > existing.headSeq) {
      await store.runWrite(noteId, async (transaction) => {
        const head = await transaction.lockHead();
        if (head === null) throw new Error('The compactor fixture lost its note head.');
        if (throughSeq !== head.headSeq + 1)
          throw new Error('The fixture must append exactly one sequence.');
        await transaction.insertUpdates([
          {
            seq: throughSeq,
            updateV1: encodeState(doc, 1),
            svAfter: stateVector(doc),
            actor: HARNESS_ACTOR,
            origin: 'connection',
            createdAt: clock.date(),
          },
        ]);
        if (!(await transaction.casHead(head.headSeq, throughSeq, clock.date())))
          throw new Error('The fixture lost its head lock.');
      });
    }
    const captured = capture(doc, {
      lastCommittedSeq: options.throughSeq ?? 1,
      lastEditor: { userId: HARNESS_ACTOR.userId, at: clock.date() },
    });
    const run: RunCompactionOptions = {
      noteId,
      vaultId,
      captured,
      trigger: options.trigger ?? 'debounce',
      now: clock.date(),
      faults: options.faults ?? NO_COMPACTION_FAULTS,
      actor: HARNESS_ACTOR,
      onStateVectorOversize: (bytes) => void oversize.push(bytes),
    };
    return runCompaction(store, run);
  };
  return { store, noteId, vaultId, doc, clock, compact, stateVectorOversizes: oversize };
}

describe('collab.compactor.unit [area:collab]', () => {
  it('captures the state, the vector, the markdown, its hash and the scan synchronously', async () => {
    const { doc } = await fixture('text');
    const captured = capture(doc, { lastCommittedSeq: 7, lastEditor: null });
    expect(captured.throughSeq).toBe(7);
    expect(captured.markdown).toBe('text');
    expect(captured.sizeChars).toBe(4);
    expect(captured.scan).toEqual({ ok: true });
    expect(captured.stateV2.byteLength).toBeGreaterThan(0);
    expect(captured.contentHash).toHaveLength(32);
  });

  it('commits the normal outcome: snapshot, projection, notes metadata and projected_seq last', async () => {
    const { store, noteId, doc, compact, clock } = await fixture('first');
    getContent(doc).insert(5, ' edit');
    const outcome = await compact({ throughSeq: 2 });
    expect(outcome.status).toBe('ok');
    expect(outcome.projected).toBe(true);
    expect(outcome.contentInvalid).toBeNull();
    const note = store.note(noteId);
    expect(note?.snapshotThroughSeq).toBe(2);
    expect(note?.projectedSeq).toBe(2);
    expect(note?.projection?.markdown).toBe('first edit');
    expect(note?.projection?.revision).toBe(2);
    expect(note?.projection?.status).toBe('ok');
    expect(note?.sizeChars).toBe(10);
    expect(note?.lastEditedBy).toBe(HARNESS_ACTOR.userId);
    expect(note?.lastEditedAt?.getTime()).toBe(clock.now());
    expect(store.counts.compactions).toBe(1);
    expect(store.counts.rollbacks).toBe(0);
  });

  it('writes a checkpoint when the hash changed and the interval elapsed, and not otherwise', async () => {
    const { store, noteId, doc, compact, clock } = await fixture('first', 10);
    getContent(doc).insert(0, 'x');
    // The seed wrote no last_checkpoint_at, so the first change is always due.
    const first = await compact({ throughSeq: 2 });
    expect(first.revision?.kind).toBe('checkpoint');
    expect(store.note(noteId)?.lastCheckpointAt?.getTime()).toBe(clock.now());

    // The same content again: no new row.
    const same = await compact({ throughSeq: 2 });
    expect(same.revision).toBeNull();

    // A change inside the interval: no row yet; after the interval: a row.
    getContent(doc).insert(0, 'y');
    clock.jump(clock.now() + 5 * 60_000);
    expect((await compact({ throughSeq: 3 })).revision).toBeNull();
    clock.jump(clock.now() + 5 * 60_000);
    const later = await compact({ throughSeq: 3 });
    expect(later.revision?.kind).toBe('checkpoint');
    expect(store.note(noteId)?.revisions.map((row) => [row.seq, row.kind])).toEqual([
      [1, 'create'],
      [2, 'checkpoint'],
      [3, 'checkpoint'],
    ]);
  });

  it('is idempotent: a second run at the same head changes nothing and inserts no second row', async () => {
    const { store, noteId, doc, compact } = await fixture();
    getContent(doc).insert(0, 'z');
    await compact({ throughSeq: 2, trigger: 'unload' });
    const before = structuredClone(store.note(noteId));
    const again = await compact({ throughSeq: 2, trigger: 'unload' });
    expect(again.revision).toBeNull();
    const after = store.note(noteId);
    expect(after?.revisions).toHaveLength(before?.revisions.length ?? 0);
    expect(after?.snapshotThroughSeq).toBe(before?.snapshotThroughSeq);
    expect(after?.projection?.contentHash).toEqual(before?.projection?.contentHash);
  });

  it('writes the unload checkpoint when no row exists at the head, whatever the interval', async () => {
    const { store, noteId, doc, compact } = await fixture('first', 10);
    getContent(doc).insert(0, 'u');
    await compact({ throughSeq: 2 });
    getContent(doc).insert(0, 'v');
    const unload = await compact({ throughSeq: 3, trigger: 'unload' });
    expect(unload.revision?.kind).toBe('unload');
    expect(
      store.note(noteId)?.revisions.some((row) => row.seq === 3 && row.kind === 'unload'),
    ).toBe(true);
  });

  it('skips the projection and audits when the scan fails, and labels the unload row head-unverified', async () => {
    const { store, noteId, doc, compact } = await fixture('clean');
    getContent(doc).insert(0, 'bad\r');
    const outcome = await compact({ throughSeq: 2, trigger: 'unload' });
    expect(outcome.status).toBe('ok');
    expect(outcome.projected).toBe(false);
    expect(outcome.contentInvalid).toEqual({ reason: 'cr' });
    expect(outcome.revision?.kind).toBe('unload');
    expect(outcome.revision?.label).toBe(HEAD_UNVERIFIED_LABEL);
    const note = store.note(noteId);
    expect(note?.contentInvalid).toBe(true);
    expect(note?.projection?.status).toBe('invalid_content');
    expect(note?.projection?.revision).toBe(1);
    expect(note?.projection?.markdown).toBe('clean');
    expect(note?.projectedSeq).toBe(1);
    expect(note?.snapshotThroughSeq).toBe(2);
    expect(store.audits.map((event) => [event.action, event.reason])).toEqual([
      ['note.content.invalid', 'cr'],
    ]);
  });

  it('refuses the blob above the ceiling, commits everything else and latches oversize', async () => {
    const { store, noteId, doc, compact } = await fixture('first');
    getContent(doc).insert(0, 'big');
    const clock = new ManualClock();
    const faults = new FaultRegistry({ nodeEnv: 'test', clock, logger: recordingLogger() });
    faults.arm({ point: 'compact.snapshot-oversize' });
    const outcome = await compact({
      throughSeq: 2,
      trigger: 'unload',
      faults: {
        beforeSnapshot: () => faults.maybeThrow('compact.throw', () => new Error('unused')),
        snapshotRefusedByFault: () => faults.fire('compact.snapshot-oversize').fired,
      },
    });
    expect(outcome.status).toBe('refused');
    expect(outcome.snapshotRefused).toBe(true);
    expect(outcome.oversize).toBe(true);
    expect(outcome.projected).toBe(true);
    expect(outcome.revision?.kind).toBe('unload');
    const note = store.note(noteId);
    expect(note?.snapshotThroughSeq).toBe(1);
    expect(note?.projectedSeq).toBe(2);
    expect(note?.oversize).toBe(true);
  });

  it('latches oversize from the soft character cap', async () => {
    const { compact, doc } = await fixture('');
    getContent(doc).insert(0, 'x'.repeat(LIMITS.NOTE_SOFT_MAX_UTF16 + 1));
    const outcome = await compact({ throughSeq: 2 });
    expect(outcome.oversize).toBe(true);
    expect(outcome.status).toBe('ok');
  });

  it('writes nothing and resolves skipped_trashed for a trashed note', async () => {
    const { store, noteId, doc, compact } = await fixture('first');
    getContent(doc).insert(0, 'late');
    store.trash(noteId, new Date(5));
    const before = structuredClone(store.note(noteId));
    const outcome = await compact({ throughSeq: 2, trigger: 'unload' });
    expect(outcome.status).toBe('skipped_trashed');
    expect(store.note(noteId)).toEqual(before);
    expect(store.audits).toEqual([]);
  });

  it('rejects with the store failure and commits nothing on an I/O error', async () => {
    const { store, noteId, doc, compact } = await fixture('first');
    getContent(doc).insert(0, 'w');
    store.failNext({ kind: 'compaction', error: new Error('disk') });
    await expect(compact({ throughSeq: 2 })).rejects.toThrow('disk');
    expect(store.note(noteId)?.snapshotThroughSeq).toBe(1);
    expect(store.counts.rollbacks).toBe(1);
  });

  it('honours compact.throw before the snapshot is written', async () => {
    const { store, noteId, doc, compact } = await fixture('first');
    getContent(doc).insert(0, 'w');
    const clock = new ManualClock();
    const faults = new FaultRegistry({ nodeEnv: 'test', clock, logger: recordingLogger() });
    faults.arm({ point: 'compact.throw', count: 1 });
    await expect(
      compact({
        throughSeq: 2,
        faults: {
          beforeSnapshot: () =>
            faults.maybeThrow('compact.throw', () => new Error('compact.throw')),
          snapshotRefusedByFault: () => false,
        },
      }),
    ).rejects.toThrow('compact.throw');
    expect(store.note(noteId)?.snapshotThroughSeq).toBe(1);
  });

  it('treats a missing note_docs row as corruption, never as an empty note', async () => {
    const { store, doc } = await fixture();
    const captured = capture(doc, { lastCommittedSeq: 1, lastEditor: null });
    await expect(
      runCompaction(store, {
        noteId: NoteId.parse(newId()),
        vaultId: VaultId.parse(newId()),
        captured,
        trigger: 'debounce',
        now: new Date(0),
        faults: NO_COMPACTION_FAULTS,
        actor: HARNESS_ACTOR,
        onStateVectorOversize: () => undefined,
      }),
    ).rejects.toBeInstanceOf(NoteDocMissing);
  });
});

describe('collab.compactor.unit: degraded durable metadata', () => {
  it('repairs a malformed historical hash through a new immutable checkpoint', async () => {
    const { store, noteId, compact } = await fixture('original');
    const note = store.note(noteId);
    const newest = note?.revisions[0];
    if (note === undefined || newest === undefined) throw new Error('Missing seed revision.');
    note.revisions[0] = { ...newest, contentHash: Buffer.alloc(0) };
    const first = await compact({ trigger: 'unload' });
    expect(first.revision?.kind).toBe('unload');
    expect(store.note(noteId)?.revisions.at(-1)?.contentHash).toHaveLength(32);
    // An existing immutable (note, seq, kind) still wins if its stored hash is damaged.
    const current = store.note(noteId);
    if (current === undefined) throw new Error('Missing committed revision.');
    current.revisions = current.revisions.map((row) => ({
      ...row,
      contentHash: Buffer.alloc(0),
    }));
    const duplicate = await compact({ trigger: 'unload' });
    expect(duplicate.revision).toBeNull();
    expect(current.revisions).toHaveLength(2);
  });

  it('stores a real wide state vector as the zero-length sentinel and omits large revision blobs', async () => {
    const { store, noteId, doc, compact, stateVectorOversizes } = await fixture('');
    for (let index = 0; index < 1_000; index++) {
      const peer = createNoteDoc({ gc: true });
      getContent(peer).insert(0, 'p');
      loadState(doc, encodeState(peer, 1), 1, LOAD_ORIGIN);
      peer.destroy();
    }
    getContent(doc).insert(0, 'a'.repeat(4_000_000));
    const vector = stateVector(doc);
    expect(vector.byteLength).toBeGreaterThan(SV_STORED_MAX_BYTES);
    const result = await compact({ throughSeq: 2, trigger: 'unload' });
    expect(result.status).toBe('ok');
    expect(stateVectorOversizes).toEqual([vector.byteLength]);
    expect(store.note(noteId)?.snapshotSv).toHaveLength(0);
    expect(store.note(noteId)?.revisions.at(-1)).toMatchObject({
      snapshot: null,
      snapshotSv: null,
    });
  });
});
