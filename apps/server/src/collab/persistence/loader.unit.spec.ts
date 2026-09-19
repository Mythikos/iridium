/**
 * `collab.loader.unit` — the read half of the load path and the in-place apply
 * (05-collaboration-and-durability.md, "Loading a document"; 03-data-model.md §8.5), over the
 * in-memory store: every refusal in the plan's order, and a document reconstructed from the snapshot
 * plus the rows above `snapshot_through_seq`.
 */
import { newId, NoteId, VaultId } from '@iridium/contracts';
import {
  createNoteDoc,
  encodeState,
  getContent,
  projectMarkdown,
  stateVector,
} from '@iridium/crdt';
import { describe, expect, it } from 'vitest';

import { CollabRejection } from '../rejection.ts';
import { YJS_MAJOR } from './initial-state.ts';
import { applyLoaded, loadNote, recordedVectorOf } from './loader.ts';
import { HARNESS_ACTOR, recordingLogger } from './testing/harness.ts';
import { MemoryPersistenceStore } from './testing/memory-store.ts';
import { asV1Update } from './types.ts';

function seeded(markdown = 'hello'): {
  store: MemoryPersistenceStore;
  noteId: NoteId;
  vaultId: VaultId;
} {
  const store = new MemoryPersistenceStore();
  const noteId = NoteId.parse(newId());
  const vaultId = VaultId.parse(newId());
  store.seed({ noteId, vaultId, markdownLf: markdown, actor: HARNESS_ACTOR, now: new Date(0) });
  return { store, noteId, vaultId };
}

async function refusalOf(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
    return '';
  } catch (error) {
    return error instanceof CollabRejection ? error.reason : `unexpected: ${String(error)}`;
  }
}

describe('collab.loader.unit [area:collab]', () => {
  it('loads a seeded note: the snapshot, no rows above it, head 1', async () => {
    const { store, noteId, vaultId } = seeded('seeded text');
    const loaded = await loadNote(store, noteId, vaultId, recordingLogger());
    expect(loaded.headSeq).toBe(1);
    expect(loaded.snapshotThroughSeq).toBe(1);
    expect(loaded.updates).toEqual([]);
    expect(loaded.snapshotFormat).toBe(2);
    const doc = createNoteDoc();
    applyLoaded(doc, loaded);
    expect(projectMarkdown(doc)).toBe('seeded text');
    expect(recordedVectorOf(loaded)).toEqual(loaded.snapshotSv);
  });

  it('applies the V2 snapshot first and then every V1 row above it, in seq order', async () => {
    const { store, noteId, vaultId } = seeded('a');
    // Two client updates written after the snapshot, as the writer would write them.
    const shadow = createNoteDoc();
    const base = await loadNote(store, noteId, vaultId, recordingLogger());
    applyLoaded(shadow, base);
    const before = stateVector(shadow);
    getContent(shadow).insert(1, 'b');
    const row2 = encodeState(shadow, 1, before);
    const sv2 = stateVector(shadow);
    getContent(shadow).insert(2, 'c');
    const row3 = encodeState(shadow, 1, sv2);
    const sv3 = stateVector(shadow);
    await store.runWrite(noteId, async (tx) => {
      await tx.insertUpdates([
        {
          seq: 2,
          updateV1: row2,
          svAfter: sv2,
          actor: HARNESS_ACTOR,
          origin: 'connection',
          createdAt: new Date(0),
        },
        {
          seq: 3,
          updateV1: row3,
          svAfter: sv3,
          actor: HARNESS_ACTOR,
          origin: 'connection',
          createdAt: new Date(0),
        },
      ]);
      await tx.casHead(1, 3, new Date(0));
    });

    const loaded = await loadNote(store, noteId, vaultId, recordingLogger());
    expect(loaded.headSeq).toBe(3);
    expect(loaded.updates.map((row) => row.seq)).toEqual([2, 3]);
    const doc = createNoteDoc();
    applyLoaded(doc, loaded);
    expect(projectMarkdown(doc)).toBe('abc');
    expect(recordedVectorOf(loaded)).toEqual(sv3);
    // Re-applying a row the state already contains is a no-op: over-inclusion is harmless.
    applyLoaded(doc, loaded);
    expect(projectMarkdown(doc)).toBe('abc');
  });

  it('refuses an unknown note, an uninitialised note and a foreign vault alike: note-not-found', async () => {
    const { store, noteId, vaultId } = seeded();
    const logger = recordingLogger();
    expect(await refusalOf(() => loadNote(store, NoteId.parse(newId()), vaultId, logger))).toBe(
      'note-not-found',
    );
    expect(await refusalOf(() => loadNote(store, noteId, VaultId.parse(newId()), logger))).toBe(
      'note-not-found',
    );
    const note = store.note(noteId);
    if (note !== undefined) note.initializedAt = null;
    expect(await refusalOf(() => loadNote(store, noteId, vaultId, logger))).toBe('note-not-found');
  });

  it('refuses a trashed note with note-trashed', async () => {
    const { store, noteId, vaultId } = seeded();
    store.trash(noteId, new Date(1));
    expect(await refusalOf(() => loadNote(store, noteId, vaultId, recordingLogger()))).toBe(
      'note-trashed',
    );
  });

  it('refuses a row written by another Yjs major, with an alarm on the log line', async () => {
    const { store, noteId, vaultId } = seeded();
    const note = store.note(noteId);
    if (note !== undefined) note.yjsMajor = YJS_MAJOR + 1;
    const logger = recordingLogger();
    expect(await refusalOf(() => loadNote(store, noteId, vaultId, logger))).toBe('note-not-found');
    expect(logger.lines[0]?.fields).toMatchObject({ alarm: 'yjs_major_mismatch' });
  });

  it('brands log bytes without touching them', () => {
    const bytes = Uint8Array.from([1, 2, 3]);
    expect(asV1Update(bytes)).toBe(bytes);
  });
});
