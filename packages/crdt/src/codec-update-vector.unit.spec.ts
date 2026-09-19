import { describe, expect, it } from 'vitest';

import {
  applyV1,
  decodeStateVector,
  encodeState,
  mergeV1,
  sameDocumentState,
  stateVector,
  stateVectorFromV1,
} from './codec.ts';
import { createNoteDoc, getContent, projectMarkdown } from './doc.ts';

describe('crdt.codec-update-vector.unit [area:crdt]', () => {
  it('compares state vectors and deletion sets, including a delete-only change with an unchanged vector', () => {
    const original = createNoteDoc({ gc: true });
    const replica = createNoteDoc({ gc: true });
    try {
      getContent(original).insert(0, 'abcdef');
      applyV1(replica, encodeState(original, 1), null);
      expect(sameDocumentState(original, replica)).toBe(true);
      const before = stateVector(replica);
      getContent(replica).delete(1, 3);
      expect(stateVector(replica)).toEqual(before);
      expect(sameDocumentState(original, replica)).toBe(false);
      expect(sameDocumentState(replica, original)).toBe(false);
      applyV1(original, encodeState(replica, 1), null);
      expect(sameDocumentState(original, replica)).toBe(true);
      getContent(replica).insert(0, 'new');
      expect(sameDocumentState(original, replica)).toBe(false);
    } finally {
      original.destroy();
      replica.destroy();
    }
  });

  it('compares equivalent concurrent states independently of integration order', () => {
    const first = createNoteDoc({ gc: true });
    const second = createNoteDoc({ gc: true });
    const left = createNoteDoc({ gc: true });
    const right = createNoteDoc({ gc: true });
    try {
      getContent(first).insert(0, 'one');
      getContent(second).insert(0, 'two');
      const updates = [encodeState(first, 1), encodeState(second, 1)];
      for (const update of updates) applyV1(left, update, null);
      for (const update of updates.toReversed()) applyV1(right, update, null);
      expect(sameDocumentState(left, right)).toBe(true);
    } finally {
      first.destroy();
      second.destroy();
      left.destroy();
      right.destroy();
    }
  });
  it('derives the same vector from merged duplicate/concurrent V1 updates and the decoded document', () => {
    const first = createNoteDoc();
    const second = createNoteDoc();
    const mergedDoc = createNoteDoc();
    try {
      getContent(first).insert(0, 'seed 🚀');
      const seed = encodeState(first, 1);
      applyV1(second, seed, null);
      getContent(first).insert(0, 'A');
      getContent(second).insert(0, 'B');
      getContent(second).delete(2, 2);
      const merged = mergeV1([seed, encodeState(first, 1), encodeState(second, 1), seed]);
      applyV1(mergedDoc, merged, null);
      applyV1(first, merged, null);
      expect(decodeStateVector(stateVectorFromV1(merged))).toEqual(
        decodeStateVector(stateVector(mergedDoc)),
      );
      expect(decodeStateVector(stateVectorFromV1(merged))).toEqual(
        decodeStateVector(stateVector(first)),
      );
      expect(projectMarkdown(mergedDoc)).toBe(projectMarkdown(first));
    } finally {
      first.destroy();
      second.destroy();
      mergedDoc.destroy();
    }
  });
});
