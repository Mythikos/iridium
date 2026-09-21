/** Every CommonMark 0.31.2 example runs; policy deviations have checked-in exact output. */
import { describe, expect, it } from 'vitest';

import corpus from '../fixtures/commonmark-0.31.2.json' with { type: 'json' };
import deviations from '../fixtures/commonmark-deviations.json' with { type: 'json' };
import { canonicalHtml, renderCommonmark } from '../test/commonmark.ts';

const DEVIATIONS = new Map(deviations.map((entry) => [entry.example, entry]));

describe('markdown.commonmark.unit [area:markdown] [spec:portability-and-safety]', () => {
  it('pins the complete official corpus and rejects a stale or vague deviation allowlist', () => {
    expect(corpus).toHaveLength(652);
    expect(new Set(corpus.map((example) => example.example)).size).toBe(652);
    expect(DEVIATIONS.size).toBe(deviations.length);
    for (const deviation of deviations) {
      expect(corpus.some((entry) => entry.example === deviation.example)).toBe(true);
      expect(deviation.reason).toMatch(/08 section 2\.[458]/);
      expect(deviation.reason).not.toContain('UNREVIEWED');
    }
  });
  it.each(corpus)('example $example ($section)', (entry) => {
    const expected = DEVIATIONS.get(entry.example)?.html ?? canonicalHtml(entry.html);
    expect(renderCommonmark(entry.markdown)).toBe(expected);
  });
  it.each(deviations)('deviation $example still needs its documented exception', (deviation) => {
    expect(deviation.html).not.toBe(
      canonicalHtml(corpus.find((entry) => entry.example === deviation.example)?.html ?? ''),
    );
  });
});
