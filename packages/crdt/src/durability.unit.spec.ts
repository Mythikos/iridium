import { describe, expect, it } from 'vitest';

import { applyV1, encodeState, loadState, stateVector } from './codec.ts';
import { createNoteDoc, getContent, projectMarkdown } from './doc.ts';
import { deleteSetFingerprint, EMPTY_DELETE_SET_FINGERPRINT } from './durability.ts';
import { createUndoManager } from './undo.ts';

describe('crdt.durability.unit [hp:HP-1]', () => {
  it('uses the independent SHA-256 golden for an empty delete set and excludes insertion clocks', () => {
    const doc = createNoteDoc();
    try {
      // Independently computed SHA-256 of canonical snapshot bytes [0, 0].
      expect(EMPTY_DELETE_SET_FINGERPRINT).toBe(
        '96a296d224f285c67bee93c30f8a309157f0daa35dc5b87e410b78630a09cfc7',
      );
      expect(deleteSetFingerprint(doc)).toBe(EMPTY_DELETE_SET_FINGERPRINT);
      getContent(doc).insert(0, 'insertion clocks have their own dominance witness');
      expect(deleteSetFingerprint(doc)).toBe(EMPTY_DELETE_SET_FINGERPRINT);
    } finally {
      doc.destroy();
    }
  });

  it('distinguishes delete-only state with an identical vector and converges after deletion replay', () => {
    const committed = createNoteDoc();
    const local = createNoteDoc();
    try {
      getContent(committed).insert(0, 'saved before deletion');
      applyV1(local, encodeState(committed, 1), null);
      const vector = stateVector(local);
      const before = deleteSetFingerprint(committed);
      getContent(local).delete(0, getContent(local).length);
      expect(stateVector(local)).toEqual(vector);
      expect(deleteSetFingerprint(local)).not.toBe(before);
      expect(projectMarkdown(committed)).toBe('saved before deletion');
      applyV1(committed, encodeState(local, 1, vector), null);
      expect(projectMarkdown(committed)).toBe('');
      expect(deleteSetFingerprint(committed)).toBe(deleteSetFingerprint(local));
    } finally {
      committed.destroy();
      local.destroy();
    }
  });

  it('canonicalizes concurrent deletions independently of apply order and garbage collection', () => {
    const first = createNoteDoc();
    const second = createNoteDoc();
    const left = createNoteDoc({ gc: true });
    const right = createNoteDoc({ gc: false });
    try {
      getContent(first).insert(0, 'first');
      getContent(second).insert(0, 'second');
      const firstSeed = encodeState(first, 1);
      const secondSeed = encodeState(second, 1);
      getContent(first).delete(1, 3);
      getContent(second).delete(0, 2);
      const updates = [firstSeed, secondSeed, encodeState(first, 1), encodeState(second, 1)];
      for (const update of updates) applyV1(left, update, null);
      for (const update of updates.toReversed()) applyV1(right, update, null);
      expect(stateVector(left)).toEqual(stateVector(right));
      expect(projectMarkdown(left)).toBe(projectMarkdown(right));
      expect(deleteSetFingerprint(left)).toBe(deleteSetFingerprint(right));
      expect(deleteSetFingerprint(left)).not.toBe(EMPTY_DELETE_SET_FINGERPRINT);
    } finally {
      first.destroy();
      second.destroy();
      left.destroy();
      right.destroy();
    }
  });

  it.each([1, 2] as const)(
    'preserves deleted identities through format %s compaction and duplicate replay',
    (format) => {
      const original = createNoteDoc();
      const restored = createNoteDoc();
      try {
        getContent(original).insert(0, '0123456789');
        getContent(original).delete(2, 3);
        getContent(original).delete(4, 2);
        const snapshot = encodeState(original, format);
        loadState(restored, snapshot, format, null);
        loadState(restored, snapshot, format, null);
        expect(stateVector(restored)).toEqual(stateVector(original));
        expect(deleteSetFingerprint(restored)).toBe(deleteSetFingerprint(original));
        expect(projectMarkdown(restored)).toBe(projectMarkdown(original));
      } finally {
        original.destroy();
        restored.destroy();
      }
    },
  );

  it('keeps the deletion witness on undo while the vector records the restored items, and changes on redo', () => {
    const doc = createNoteDoc();
    getContent(doc).insert(0, 'undo me');
    const undo = createUndoManager(getContent(doc), { captureTimeout: 0 });
    try {
      getContent(doc).delete(0, 7);
      const deletedVector = stateVector(doc);
      const deleted = deleteSetFingerprint(doc);
      undo.undo();
      expect(projectMarkdown(doc)).toBe('undo me');
      expect(stateVector(doc)).not.toEqual(deletedVector);
      expect(deleteSetFingerprint(doc)).toBe(deleted);
      undo.redo();
      expect(projectMarkdown(doc)).toBe('');
      expect(deleteSetFingerprint(doc)).not.toBe(deleted);
    } finally {
      undo.destroy();
      doc.destroy();
    }
  });

  it('keeps the retained witness fixed-size for thousands of separated deletion ranges', () => {
    const doc = createNoteDoc();
    try {
      getContent(doc).insert(0, 'ab'.repeat(4_096));
      doc.transact(() => {
        for (let index = getContent(doc).length - 2; index >= 0; index -= 2) {
          getContent(doc).delete(index, 1);
        }
      });
      const before = deleteSetFingerprint(doc);
      expect(before).toMatch(/^[0-9a-f]{64}$/);
      getContent(doc).delete(0, 1);
      expect(deleteSetFingerprint(doc)).toHaveLength(64);
      expect(deleteSetFingerprint(doc)).not.toBe(before);
    } finally {
      doc.destroy();
    }
  });
});
