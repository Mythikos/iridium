// oxlint-disable vitest/no-standalone-expect -- `it.prop(...)(name, fn)` is the
// @fast-check/vitest form of a test block, which this rule does not know about yet.
/**
 * `crdt.guards.unit` — the package's content guards (10-testing-and-quality.md, HP-4).
 *
 * Each guard is defence in depth behind something else: `assertLfOnly` behind `normalizeSource()`,
 * `assertNoAttributes` behind a client that only ever inserts plain strings, `assertWithinCaps`
 * behind the chunker. A guard that accepted the defect it owns would move the failure to the
 * compaction that flags the note read-only, so what matters here is both halves — valid state passes
 * untouched, and each defect raises its own typed error rather than a generic one.
 */

import { it } from '@fast-check/vitest';
import { LIMITS } from '@iridium/contracts';
import * as fc from 'fast-check';
import { describe, expect } from 'vitest';
import type * as Y from 'yjs';

import { hostileText, lfText } from '../test/arbitraries.ts';
import { PROP } from '../test/prop-budget.ts';
import { createNoteDoc, getContent, projectMarkdown } from './doc.ts';
import { CrdtError, type CrdtErrorCode } from './errors.ts';
import { assertLfOnly, assertNoAttributes, assertWithinCaps } from './guards.ts';
import { initialNoteState } from './initial-state.ts';

const ORIGIN = { source: 'test' };
const BOM = '\ufeff';

/** The `CrdtErrorCode` a call raised, or what it did instead — one comparable value, no branching. */
function outcomeOf(call: () => void): CrdtErrorCode | 'accepted' | 'untyped-error' {
  try {
    call();
    return 'accepted';
  } catch (error) {
    return error instanceof CrdtError ? error.code : 'untyped-error';
  }
}

function docWith(text: string): Y.Doc {
  const doc = createNoteDoc();
  doc.transact(() => {
    getContent(doc).insert(0, text);
  }, ORIGIN);
  return doc;
}

describe('crdt.guards.unit [hp:HP-4]', () => {
  describe('assertLfOnly', () => {
    it.prop([lfText()], PROP)('accepts normalised text', (text) => {
      fc.pre(!text.startsWith(BOM));
      expect(outcomeOf(() => assertLfOnly(text))).toBe('accepted');
    });

    it.prop([hostileText()], PROP)('refuses any carriage return', (text) => {
      fc.pre(text.includes('\r'));
      expect(outcomeOf(() => assertLfOnly(text))).toBe('cr');
    });

    it.prop([lfText()], PROP)('refuses a leading byte order mark', (rest) => {
      fc.pre(!rest.includes('\r'));
      expect(outcomeOf(() => assertLfOnly(BOM + rest))).toBe('bom');
    });

    it('accepts U+FEFF away from the start, where it is a zero-width no-break space', () => {
      expect(outcomeOf(() => assertLfOnly(`a${BOM}b`))).toBe('accepted');
      expect(outcomeOf(() => assertLfOnly(''))).toBe('accepted');
      expect(outcomeOf(() => assertLfOnly('one\ntwo\n'))).toBe('accepted');
    });
  });

  describe('assertNoAttributes', () => {
    it.prop([lfText()], PROP)('accepts a plain text document', (text) => {
      expect(outcomeOf(() => assertNoAttributes(docWith(text)))).toBe('accepted');
    });

    it('refuses a formatting run', () => {
      const doc = docWith('bold me');
      doc.transact(() => {
        getContent(doc).format(0, 4, { bold: true });
      }, ORIGIN);

      expect(outcomeOf(() => assertNoAttributes(doc))).toBe('attributes');
    });

    it('refuses an embed', () => {
      const doc = docWith('text');
      doc.transact(() => {
        getContent(doc).insertEmbed(2, { image: 'https://example.invalid/x.png' });
      }, ORIGIN);

      expect(outcomeOf(() => assertNoAttributes(doc))).toBe('attributes');
    });
  });

  describe('assertWithinCaps', () => {
    it('accepts a subject within every cap, and an empty subject', () => {
      const doc = docWith('a small note');

      expect(outcomeOf(() => assertWithinCaps({}))).toBe('accepted');
      expect(outcomeOf(() => assertWithinCaps({ insert: 'a small paste' }))).toBe('accepted');
      expect(
        outcomeOf(() => assertWithinCaps({ update: initialNoteState('a small note').update })),
      ).toBe('accepted');
      expect(projectMarkdown(doc)).toBe('a small note');
    });

    it('refuses an update above the single-update cap', () => {
      const oversized = initialNoteState('x'.repeat(LIMITS.YJS_UPDATE_MAX_BYTES + 1024)).update;

      expect(oversized.byteLength).toBeGreaterThan(LIMITS.YJS_UPDATE_MAX_BYTES);
      expect(outcomeOf(() => assertWithinCaps({ update: oversized }))).toBe('update-too-large');
    });

    it('refuses an insertion above the chunk cap, counted in UTF-8 bytes', () => {
      const ascii = 'x'.repeat(LIMITS.INSERT_CHUNK_MAX_BYTES + 1);
      const cjk = '\u6f22'.repeat(Math.ceil(LIMITS.INSERT_CHUNK_MAX_BYTES / 3) + 1);

      expect(outcomeOf(() => assertWithinCaps({ insert: ascii }))).toBe('insert-too-large');
      expect(outcomeOf(() => assertWithinCaps({ insert: cjk }))).toBe('insert-too-large');
      expect(
        outcomeOf(() => assertWithinCaps({ insert: 'x'.repeat(LIMITS.INSERT_CHUNK_MAX_BYTES) })),
      ).toBe('accepted');
    });
  });

  describe('initialNoteState', () => {
    it.prop([lfText()], PROP)('accepts normalised Markdown and reports its size', (markdown) => {
      fc.pre(!markdown.startsWith(BOM));
      const initial = initialNoteState(markdown);

      expect(initial.sizeChars).toBe(markdown.length);
      expect(initial.update.byteLength).toBeGreaterThan(0);
      expect(initial.snapshot.byteLength).toBeGreaterThan(0);
      expect(initial.sv.byteLength).toBeGreaterThan(0);
    });

    it('refuses text the four entry points should have normalised', () => {
      expect(outcomeOf(() => initialNoteState('one\r\ntwo'))).toBe('cr');
      expect(outcomeOf(() => initialNoteState(`${BOM}# Title`))).toBe('bom');
    });
  });

  describe('the LF invariant of the Markdown projection', () => {
    it.prop([lfText()], PROP)('never projects a carriage return', (markdown) => {
      fc.pre(!markdown.includes('\r'));
      expect(projectMarkdown(docWith(markdown))).not.toContain('\r');
    });
  });
});
