// oxlint-disable vitest/no-standalone-expect -- `it.prop(...)(name, fn)` is the
// @fast-check/vitest form of a test block, which this rule does not know about yet.
/**
 * `crdt.insert-chunking.prop` — the producer-side bound that makes the update cap unreachable.
 *
 * A 900 000-character CJK paste passes the UTF-16 note cap and is about 2.7 MB of UTF-8: as a single
 * Yjs update it is closed `too-large` and re-sent on every reconnect, which is an unbounded close/
 * reconnect loop over text the user can never save. `insertChunked` is what makes that state
 * unreachable, so this file asserts the three things the loop depends on — every emitted update is
 * within `YJS_UPDATE_MAX_BYTES`, the concatenation of the applied chunks is exactly the input, and
 * no seam falls inside a surrogate pair, because a seam that did would manufacture the lone
 * surrogates `scanHostileContent` and `normalizeSource` exist to reject
 * (05-collaboration-and-durability.md D05-16).
 */

import { it } from '@fast-check/vitest';
import { LIMITS } from '@iridium/contracts';
import * as fc from 'fast-check';
import { describe, expect } from 'vitest';
import type * as Y from 'yjs';

import { PROP } from '../test/prop-budget.ts';
import { createNoteDoc, getContent, projectMarkdown } from './doc.ts';
import { CrdtError } from './errors.ts';
import { insertChunked } from './insert-chunked.ts';
import { scanHostileContent } from './scan.ts';
import { isHighSurrogate, isLowSurrogate, utf8ByteLength } from './unicode.ts';

const ORIGIN = { source: 'test' };
const CHUNK_CAP = LIMITS.INSERT_CHUNK_MAX_BYTES;

/** Astral-plane and CJK code points, plus ASCII, so a byte cap lands inside characters of every width. */
const PASTE_UNITS = ['a', ' ', '\n', '\u00e9', '\u6f22', '\u3042', '\u{1f600}', '\u{1d11e}'];

/** A repeated base, sized in UTF-8 bytes, so a large paste is cheap to generate and still random. */
const paste = fc
  .tuple(
    fc.array(fc.constantFrom(...PASTE_UNITS), { minLength: 1, maxLength: 48 }),
    fc.oneof(
      { arbitrary: fc.integer({ min: 0, max: 4096 }), weight: 3 },
      { arbitrary: fc.integer({ min: CHUNK_CAP - 8, max: CHUNK_CAP + 8 }), weight: 2 },
      { arbitrary: fc.integer({ min: CHUNK_CAP, max: 3 * CHUNK_CAP }), weight: 1 },
    ),
  )
  .map(([units, targetBytes]) => grow(units, targetBytes));

function grow(units: readonly string[], targetBytes: number): string {
  const cycle = units.join('');
  const cycleBytes = utf8ByteLength(cycle);
  const pieces: string[] = [];
  let bytes = 0;
  while (bytes + cycleBytes <= targetBytes) {
    pieces.push(cycle);
    bytes += cycleBytes;
  }
  for (const unit of units) {
    if (bytes >= targetBytes) break;
    pieces.push(unit);
    bytes += utf8ByteLength(unit);
  }
  return pieces.join('');
}

interface DeltaOp {
  readonly insert?: unknown;
}

/** Record the string inserted by each transaction, which is one chunk per transaction. */
function captureChunks(text: Y.Text): string[] {
  const chunks: string[] = [];
  text.observe((event) => {
    const delta: DeltaOp[] = event.delta;
    for (const op of delta) {
      if (typeof op.insert === 'string') chunks.push(op.insert);
    }
  });
  return chunks;
}

/** The UTF-8 width of the code point a chunk starts with: what had to fit for the seam to move. */
function firstCodePointBytes(text: string): number {
  const point = text.codePointAt(0);
  return point === undefined ? 0 : utf8ByteLength(String.fromCodePoint(point));
}

/** Code points, counted without splitting a pair — the unit a chunk boundary must respect. */
function codePointCount(text: string): number {
  let count = 0;
  for (let index = 0; index < text.length; index++) {
    if (isHighSurrogate(text.charCodeAt(index)) && isLowSurrogate(text.charCodeAt(index + 1))) {
      index++;
    }
    count++;
  }
  return count;
}

describe('crdt.insert-chunking.prop [area:contracts]', () => {
  it.prop([paste], PROP)('emits no update above the single-update cap', (text) => {
    const doc = createNoteDoc();
    const sizes: number[] = [];
    doc.on('update', (update: Uint8Array) => {
      sizes.push(update.byteLength);
    });

    insertChunked(getContent(doc), 0, text, ORIGIN);

    expect(Math.max(0, ...sizes)).toBeLessThanOrEqual(LIMITS.YJS_UPDATE_MAX_BYTES);
  });

  it.prop([paste], PROP)('inserts exactly the input, chunked at code-point boundaries', (text) => {
    const doc = createNoteDoc();
    const content = getContent(doc);
    const chunks = captureChunks(content);

    insertChunked(content, 0, text, ORIGIN);

    expect(chunks.join('')).toBe(text);
    expect(projectMarkdown(doc)).toBe(text);
    expect(scanHostileContent(doc)).toStrictEqual({ ok: true });
  });

  it.prop([paste], PROP)('never splits a surrogate pair and never fragments needlessly', (text) => {
    const doc = createNoteDoc();
    const content = getContent(doc);
    const chunks = captureChunks(content);

    insertChunked(content, 0, text, ORIGIN);

    for (const chunk of chunks) {
      expect(utf8ByteLength(chunk)).toBeLessThanOrEqual(CHUNK_CAP);
    }
    // A chunk that is not the last one is closed only because the next code point would not fit.
    const seams = chunks.slice(1).map((next, index) => ({ chunk: chunks[index] ?? '', next }));
    for (const { chunk, next } of seams) {
      expect(utf8ByteLength(chunk) + firstCodePointBytes(next)).toBeGreaterThan(CHUNK_CAP);
    }
    // Every chunk is whole code points: a seam inside a pair would count two where the joined text
    // counts one, so the sums can only agree when no boundary split a surrogate pair.
    expect(codePointCount(chunks.join(''))).toBe(
      chunks.reduce((sum, chunk) => sum + codePointCount(chunk), 0),
    );
  });

  it.prop([paste, fc.nat()], PROP)(
    'inserts at an interior index without disturbing its neighbours',
    (text, at) => {
      const doc = createNoteDoc();
      const content = getContent(doc);
      const before = 'head\n';
      const after = '\ntail';
      doc.transact(() => {
        content.insert(0, before + after);
      }, ORIGIN);
      const index = at % (before.length + 1);

      insertChunked(content, index, text, ORIGIN);

      const original = before + after;
      expect(projectMarkdown(doc)).toBe(original.slice(0, index) + text + original.slice(index));
    },
  );

  it('inserts nothing and opens no transaction for an empty string', () => {
    const doc = createNoteDoc();
    let transactions = 0;
    doc.on('update', () => {
      transactions++;
    });

    insertChunked(getContent(doc), 0, '', ORIGIN);

    expect(transactions).toBe(0);
    expect(projectMarkdown(doc)).toBe('');
  });

  it('refuses a Y.Text that is not integrated into a document', () => {
    const doc = createNoteDoc();
    const detached = getContent(doc).clone();

    expect(() => insertChunked(detached, 0, 'text', ORIGIN)).toThrow(CrdtError);
  });
});
