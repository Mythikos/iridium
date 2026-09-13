// oxlint-disable vitest/no-standalone-expect -- `it.prop(...)(name, fn)` is the
// @fast-check/vitest form of a test block, which this rule does not know about yet.
// oxlint-disable typescript/no-unsafe-type-assertion -- a codec property has to mint the brands
// itself: it builds the bytes the production boundary would brand, and asserts what happens to them.

/**
 * `crdt.codec.prop` — the V1/V2 codec (10-testing-and-quality.md, "Inventory completeness").
 *
 * The encoding split is the decision this file defends: the append log is V1 because that is what
 * arrives on the wire, the compacted snapshot is V2 because it is an order of magnitude smaller, and
 * a reader must never treat the two interchangeably (13-decision-log.md A15). What the loader does —
 * a V2 snapshot applied in place, then every V1 row above `snapshot_through_seq` in `seq` order —
 * has to reconstruct exactly the document the full V1 log reconstructs, and re-applying a row the
 * snapshot already contains has to be a no-op, or restart recovery duplicates or loses content.
 */
import { it } from '@fast-check/vitest';
import * as fc from 'fast-check';
import { describe, expect } from 'vitest';
import * as Y from 'yjs';

import { type Edit, edits } from '../test/arbitraries.ts';
import { PROP } from '../test/prop-budget.ts';
import { captureUpdates, runEdits } from '../test/session.ts';
import {
  applyV1,
  decodeStateVector,
  encodeState,
  loadState,
  mergeV1,
  recordedSv,
  stateVector,
  storedSv,
  SV_STORED_MAX_BYTES,
  type SnapshotFormat,
  type StateVector,
  type V1Update,
} from './codec.ts';
import { createNoteDoc, projectMarkdown } from './doc.ts';
import { CrdtError } from './errors.ts';

const ORIGIN = { source: 'test' };

function build(script: readonly Edit[]): { doc: Y.Doc; updates: V1Update[] } {
  const doc = createNoteDoc();
  const updates = captureUpdates(doc);
  runEdits(doc, script, ORIGIN);
  return { doc, updates };
}

function replay(updates: readonly V1Update[]): Y.Doc {
  const doc = createNoteDoc();
  for (const update of updates) applyV1(doc, update, ORIGIN);
  return doc;
}

describe('crdt.codec.prop [hp:HP-2]', () => {
  it.prop([edits()], PROP)('encodeState and loadState round-trip in V1 and V2', (script) => {
    const { doc } = build(script);

    for (const format of [1, 2] as const) {
      const restored = createNoteDoc();
      loadState(restored, encodeState(doc, format), format, ORIGIN);
      expect(projectMarkdown(restored)).toBe(projectMarkdown(doc));
      expect(stateVector(restored)).toStrictEqual(stateVector(doc));
    }
  });

  it.prop([edits()], PROP)('loadState is idempotent in both formats', (script) => {
    const { doc } = build(script);

    for (const format of [1, 2] as const) {
      const state = encodeState(doc, format);
      const restored = createNoteDoc();
      loadState(restored, state, format, ORIGIN);
      const afterOnce = encodeState(restored, 1);
      loadState(restored, state, format, ORIGIN);

      expect(projectMarkdown(restored)).toBe(projectMarkdown(doc));
      expect(encodeState(restored, 1)).toStrictEqual(afterOnce);
    }
  });

  it.prop([edits()], PROP)('an already-contained update changes nothing', (script) => {
    const { doc, updates } = build(script);
    fc.pre(updates.length > 0);
    const before = projectMarkdown(doc);
    const vector = stateVector(doc);

    for (const update of updates) applyV1(doc, update, ORIGIN);

    expect(projectMarkdown(doc)).toBe(before);
    expect(stateVector(doc)).toStrictEqual(vector);
  });

  it.prop([edits(), fc.nat()], PROP)(
    'a V2 snapshot plus its tail reconstructs the same document as the full V1 log',
    (script, cut) => {
      const { doc, updates } = build(script);
      fc.pre(updates.length > 0);
      const through = cut % (updates.length + 1);

      const snapshot = encodeState(replay(updates.slice(0, through)), 2);
      const loaded = createNoteDoc();
      loadState(loaded, snapshot, 2, ORIGIN);
      for (const update of updates.slice(through)) applyV1(loaded, update, ORIGIN);

      expect(projectMarkdown(loaded)).toBe(projectMarkdown(doc));
      expect(stateVector(loaded)).toStrictEqual(stateVector(doc));
    },
  );

  it.prop([edits(), fc.nat()], PROP)(
    'merging a run of updates applies exactly as the run does',
    (script, cut) => {
      const { doc, updates } = build(script);
      fc.pre(updates.length > 0);
      const from = cut % updates.length;

      const merged = replay(updates.slice(0, from));
      applyV1(merged, mergeV1(updates.slice(from)), ORIGIN);

      expect(projectMarkdown(merged)).toBe(projectMarkdown(doc));
      expect(stateVector(merged)).toStrictEqual(stateVector(doc));
    },
  );

  it.prop([edits()], PROP)('a state vector survives the branded codec unchanged', (script) => {
    const { doc } = build(script);
    const vector = stateVector(doc);

    expect(decodeStateVector(vector)).toStrictEqual(Y.decodeStateVector(vector));
    expect(Y.encodeStateVector(decodeStateVector(vector))).toStrictEqual(vector);
  });

  it('encodes an empty note as a short but non-empty update, so seq 1 always exists', () => {
    const doc = createNoteDoc();
    expect(projectMarkdown(doc)).toBe('');

    const update = encodeState(doc, 1);
    expect(update.byteLength).toBeGreaterThan(0);
    expect(projectMarkdown(replay([update]))).toBe('');
  });

  it('refuses a snapshot_format that is neither V1 nor V2', () => {
    const doc = createNoteDoc();
    const bogus = 3 as SnapshotFormat;

    expect(() => encodeState(doc, bogus)).toThrow(CrdtError);
    expect(() => loadState(doc, encodeState(doc, 1), bogus, ORIGIN)).toThrow(CrdtError);
  });

  it('degrades a state vector wider than the column to "not recorded", and back', () => {
    const doc = createNoteDoc();
    runEdits(doc, [{ kind: 'insert', at: 0, text: 'a note' }], ORIGIN);
    const narrow = stateVector(doc);
    const wide = Y.encodeStateVector(
      new Map(Array.from({ length: 2000 }, (_, index) => [index + 1, index + 1])),
    ) as StateVector;

    expect(wide.byteLength).toBeGreaterThan(SV_STORED_MAX_BYTES);
    expect(storedSv(narrow)).toStrictEqual(narrow);
    expect(storedSv(wide).byteLength).toBe(0);
    expect(recordedSv(storedSv(wide), doc)).toStrictEqual(narrow);
    expect(recordedSv(null, doc)).toStrictEqual(narrow);
    expect(recordedSv(undefined, doc)).toStrictEqual(narrow);
    expect(recordedSv(narrow, doc)).toStrictEqual(narrow);
  });
});
