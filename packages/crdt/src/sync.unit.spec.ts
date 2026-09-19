import { describe, expect, it } from 'vitest';

import { decodeStateVector, encodeState, stateVector } from './codec.ts';
import { createNoteDoc, getContent, projectMarkdown } from './doc.ts';
import { encodeSyncStep1, receiveSyncMessage } from './sync.ts';

describe('crdt.sync.unit [area:crdt]', () => {
  it('exchanges real step 1 / step 2 in both directions and preserves each receive origin', () => {
    const left = createNoteDoc();
    const right = createNoteDoc();
    const leftOrigin = Symbol('left received');
    const rightOrigin = Symbol('right received');
    const origins: unknown[] = [];
    try {
      getContent(left).insert(0, 'left');
      getContent(right).insert(0, 'right');
      left.on('update', (_update, origin: unknown) => origins.push(origin));
      right.on('update', (_update, origin: unknown) => origins.push(origin));
      const response = receiveSyncMessage(right, encodeSyncStep1(left), rightOrigin);
      expect(response.type).toBe(0);
      expect(receiveSyncMessage(left, response.response, leftOrigin)).toEqual({
        type: 1,
        response: new Uint8Array(),
      });
      const reverse = receiveSyncMessage(left, encodeSyncStep1(right), leftOrigin);
      expect(receiveSyncMessage(right, reverse.response, rightOrigin).type).toBe(1);
      expect(projectMarkdown(left)).toBe(projectMarkdown(right));
      expect(decodeStateVector(stateVector(left))).toEqual(decodeStateVector(stateVector(right)));
      expect(origins).toEqual([leftOrigin, rightOrigin]);
      // An update message uses the same decoder; this is also the protocol's type-2 receive path.
      const emptyUpdate = encodeState(left, 1, stateVector(right));
      const updateMessage = Uint8Array.of(2, emptyUpdate.byteLength, ...emptyUpdate);
      expect(receiveSyncMessage(right, updateMessage, rightOrigin)).toEqual({
        type: 2,
        response: new Uint8Array(),
      });
    } finally {
      left.destroy();
      right.destroy();
    }
  });
  it('propagates unknown and malformed messages instead of silently completing a sync', () => {
    const doc = createNoteDoc();
    try {
      expect(() => receiveSyncMessage(doc, Uint8Array.of(99), null)).toThrow(
        'Unknown message type',
      );
      expect(() => receiveSyncMessage(doc, Uint8Array.of(1), null)).toThrow(/Unexpected end/);
    } finally {
      doc.destroy();
    }
  });
});
