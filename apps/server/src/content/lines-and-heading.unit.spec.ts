import { createHash } from 'node:crypto';

import type { NoteHeading } from '@iridium/contracts';
import { parseNote, project } from '@iridium/markdown';
import { describe, expect, it } from 'vitest';

import { capGraphemes, selectSource } from './read/slices.ts';

describe('content.lines-and-heading.unit [area:content]', () => {
  const source = '# First\nα\n## Child\nfamily 👨‍👩‍👧\n# Second\nend\n';
  const headings: readonly NoteHeading[] = [
    { depth: 1, text: 'First', slug: 'first', line: 1, offset: 0 },
    { depth: 2, text: 'Child', slug: 'child', line: 3, offset: 10 },
    { depth: 1, text: 'Second', slug: 'second', line: 5, offset: 34 },
  ];
  it('preserves source bytes and uses inclusive one-based lines including the terminal empty line', () => {
    expect(selectSource(source, headings).markdown).toBe(source);
    expect(selectSource(source, headings, { lines: { start: 2, end: 4 } })).toMatchObject({
      markdown: 'α\n## Child\nfamily 👨‍👩‍👧',
      lineCount: 7,
      returnedRange: [2, 4],
    });
    expect(selectSource(source, headings, { lines: { start: 99, end: 100 } })).toMatchObject({
      markdown: '',
      returnedRange: [7, 7],
    });
  });
  it('keeps child headings inside a section and stops at the next peer', () => {
    expect(selectSource(source, headings, { heading: 'first' })).toMatchObject({
      markdown: '# First\nα\n## Child\nfamily 👨‍👩‍👧',
      returnedRange: [1, 4],
      sliceReason: 'heading',
    });
    expect(selectSource(source, headings, { heading: 'Child' }).returnedRange).toEqual([3, 4]);
    expect(() => selectSource(source, headings, { heading: 'missing' })).toThrow('heading');
  });
  it('never cuts an extended grapheme or surrogate pair at a character budget', () => {
    for (const text of ['a👨‍👩‍👧b', 'aéb', 'a😀b']) {
      for (let size = 1; size < text.length; size += 1) {
        const result = capGraphemes(text, size);
        expect(result.length).toBeLessThanOrEqual(size);
        expect(
          [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(text)].some(
            (segment) => segment.index === result.length,
          ),
        ).toBe(true);
      }
    }
    expect(selectSource(source, headings, { maxChars: 5 })).toMatchObject({
      markdown: '# Fir',
      truncated: true,
      sliceReason: 'char_cap',
      returnedRange: [1, 1],
    });
  });
  it('refuses inverted, zero and non-integer ranges', () => {
    for (const lines of [
      { start: 0 },
      { start: 4, end: 2 },
      { start: 1.5 },
      { start: 1, end: Number.POSITIVE_INFINITY },
    ])
      expect(() => selectSource(source, headings, { lines })).toThrow('Some fields need attention');
  });
  it('uses the projection outline and extracted H1 title without rewriting source', () => {
    const projected = project(parseNote(source), source, {
      contentHash: createHash('sha256').update(source).digest('hex'),
    });
    expect(projected.headingTitle).toBe('First');
    expect(
      selectSource(source, projected.headings, { heading: projected.headings[1]?.slug ?? '' })
        .markdown,
    ).toBe('## Child\nfamily 👨‍👩‍👧');
  });
});
