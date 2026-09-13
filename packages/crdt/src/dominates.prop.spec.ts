// oxlint-disable vitest/no-standalone-expect -- `it.prop(...)(name, fn)` is the
// @fast-check/vitest form of a test block, which this rule does not know about yet.
// oxlint-disable typescript/no-unsafe-type-assertion -- the properties here generate the bytes the
// production boundary would brand (encoded clock maps, raw fuzz input, the zero-length degradation)
// and must hand them to the branded API as the real call sites do.

/**
 * `crdt.dominates.prop` — the dominance test behind *Saved* (10-testing-and-quality.md, HP-1).
 *
 * *Saved* is shown only when a committed state vector dominates the client's whole local vector, so
 * every way a local clock can appear under a client ID the caller never authored — a relayed update
 * from a second tab, a client ID that Hocuspocus changed mid-session (issue #845) — must hold the
 * indicator back. This file asserts that dominance is a partial order, that it is exactly the
 * containment of clocks, and that decoding a vector is total: a wrong answer here is a false
 * *Saved*, which is the one failure the product may not have (13-decision-log.md A19).
 */
import { it } from '@fast-check/vitest';
import * as fc from 'fast-check';
import { describe, expect } from 'vitest';
import * as Y from 'yjs';

import { edits, lfText } from '../test/arbitraries.ts';
import { PROP } from '../test/prop-budget.ts';
import { captureUpdates, runEdits } from '../test/session.ts';
import { applyV1, decodeStateVector, encodeState, stateVector, type StateVector } from './codec.ts';
import { createNoteDoc } from './doc.ts';
import { dominates } from './dominates.ts';
import { CrdtError } from './errors.ts';

const ORIGIN = { source: 'test' };

/** `(clientID → clock)` pairs with non-zero clocks: clock 0 is indistinguishable from absence. */
const clocks = fc
  .array(
    fc.tuple(fc.integer({ min: 1, max: 2_147_483_647 }), fc.integer({ min: 1, max: 1_000_000 })),
    { maxLength: 8 },
  )
  .map((pairs) => new Map(pairs));

function encode(map: Map<number, number>): StateVector {
  return Y.encodeStateVector(map) as StateVector;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

type DecodeVerdict = 'canonical' | 'malformed-state-vector' | 'wrong-answer' | 'unexpected-error';

/** What `decodeStateVector` did with these bytes, as one comparable verdict. */
function decodeVerdict(bytes: Uint8Array): DecodeVerdict {
  try {
    const decoded = decodeStateVector(bytes as StateVector);
    // A zero-length vector is D03-01's "not recorded" marker and decodes to no clocks at all; every
    // other accepted input must re-encode to exactly the bytes it came from.
    const accepted =
      bytes.length === 0 ? decoded.size === 0 : sameBytes(Y.encodeStateVector(decoded), bytes);
    return accepted ? 'canonical' : 'wrong-answer';
  } catch (error) {
    return error instanceof CrdtError && error.code === 'malformed-state-vector'
      ? 'malformed-state-vector'
      : 'unexpected-error';
  }
}

describe('crdt.dominates.prop [hp:HP-1]', () => {
  it.prop([clocks], PROP)('is reflexive, in both the map and the byte form', (map) => {
    expect(dominates(map, map)).toBe(true);
    expect(dominates(encode(map), encode(map))).toBe(true);
    expect(dominates(map, encode(map))).toBe(true);
  });

  it.prop([clocks, clocks, clocks], PROP)('is transitive', (a, b, c) => {
    fc.pre(dominates(a, b) && dominates(b, c));
    expect(dominates(a, c)).toBe(true);
  });

  it.prop([clocks, clocks], PROP)('is antisymmetric up to equality', (a, b) => {
    fc.pre(dominates(a, b) && dominates(b, a));
    expect(a).toStrictEqual(b);
  });

  it.prop([clocks, fc.nat()], PROP)(
    'a vector missing any single clientID never dominates',
    (map, pick) => {
      fc.pre(map.size > 0);
      const keys = [...map.keys()];
      const without = new Map(map);
      without.delete(keys[pick % keys.length] as number);

      expect(dominates(without, map)).toBe(false);
      expect(dominates(encode(without), encode(map))).toBe(false);
    },
  );

  it.prop([edits()], PROP)('a document dominates the vector of its own encoded state', (script) => {
    const doc = createNoteDoc();
    runEdits(doc, script, ORIGIN);
    const fromDoc = stateVector(doc);
    const fromUpdate = Y.encodeStateVectorFromUpdate(encodeState(doc, 1)) as StateVector;

    expect(dominates(fromDoc, fromUpdate)).toBe(true);
    expect(dominates(fromUpdate, fromDoc)).toBe(true);
  });

  it.prop([edits(), edits()], PROP)(
    'applying an update makes the new vector dominate the old, strictly when it carried something',
    (own, incoming) => {
      const doc = createNoteDoc();
      runEdits(doc, own, ORIGIN);
      const before = stateVector(doc);

      const other = createNoteDoc();
      const fromOther = captureUpdates(other);
      runEdits(other, incoming, ORIGIN);
      for (const update of fromOther) applyV1(doc, update, ORIGIN);
      const after = stateVector(doc);

      expect(dominates(after, before)).toBe(true);
      expect(dominates(before, after)).toBe(fromOther.length === 0);
    },
  );

  it.prop([lfText(), lfText()], PROP)(
    'a relayed update never makes a client dominate a persisted vector that lacks its clock',
    (mine, relayed) => {
      fc.pre(relayed.length > 0);

      const mineDoc = createNoteDoc();
      const mineUpdates = captureUpdates(mineDoc);
      runEdits(mineDoc, [{ kind: 'insert', at: 0, text: mine }], ORIGIN);

      const secondTab = createNoteDoc();
      const relayedUpdates = captureUpdates(secondTab);
      runEdits(secondTab, [{ kind: 'insert', at: 0, text: relayed }], ORIGIN);

      // The server committed only this client's own update, so that is the persisted baseline.
      const server = createNoteDoc();
      for (const update of mineUpdates) applyV1(server, update, ORIGIN);
      const persisted = stateVector(server);

      // The relayed update reaches the client through the sync protocol, unpersisted.
      for (const update of relayedUpdates) applyV1(mineDoc, update, ORIGIN);

      expect(dominates(persisted, stateVector(mineDoc))).toBe(false);
    },
  );

  it.prop([lfText(), lfText()], PROP)(
    'a client ID that changes mid-session is still covered by the local vector',
    (before, after) => {
      fc.pre(before.length > 0 && after.length > 0);
      const doc = createNoteDoc();
      const updates = captureUpdates(doc);
      runEdits(doc, [{ kind: 'insert', at: 0, text: before }], ORIGIN);

      const server = createNoteDoc();
      for (const update of updates) applyV1(server, update, ORIGIN);
      const persisted = stateVector(server);
      expect(dominates(persisted, stateVector(doc))).toBe(true);

      // Hocuspocus issue #845: maxDebounce can change the client ID under a live session.
      doc.clientID += 1;
      runEdits(doc, [{ kind: 'insert', at: 0, text: after }], ORIGIN);

      expect(dominates(persisted, stateVector(doc))).toBe(false);
    },
  );

  it.prop([fc.uint8Array({ maxLength: 48 })], PROP)(
    'decoding is total: canonical bytes decode, anything else raises a typed error',
    (bytes) => {
      expect(['canonical', 'malformed-state-vector']).toContain(decodeVerdict(bytes));
    },
  );

  it('treats a zero-length vector as the "not recorded" degradation, which dominates nothing', () => {
    const doc = createNoteDoc();
    runEdits(doc, [{ kind: 'insert', at: 0, text: 'content' }], ORIGIN);
    const empty = new Uint8Array(0) as StateVector;

    expect(dominates(empty, stateVector(doc))).toBe(false);
    expect(dominates(stateVector(doc), empty)).toBe(true);
  });
});
