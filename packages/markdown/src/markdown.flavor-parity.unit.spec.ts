import { describe, expect, it } from 'vitest';

import { GOLDEN_FIXTURES } from '../test/fixtures.ts';
import { elements } from '../test/pipeline-context.ts';
import {
  createProcessor,
  gfmFlavor,
  obsidianCompatFlavor,
  parseNote,
  toPreviewTree,
} from './index.ts';

describe('markdown.flavor-parity.unit [area:markdown] [spec:portability-and-safety]', () => {
  it('keeps the reserved Obsidian seam empty', () => {
    expect(gfmFlavor).toEqual({ id: 'gfm', remark: [], rehype: [], sanitizeExtension: {} });
    expect(obsidianCompatFlavor).toEqual({ ...gfmFlavor, id: 'obsidian-compat' });
  });
  it.each(GOLDEN_FIXTURES)('$id renders identically in both recorded flavors', ({ source }) => {
    expect(toPreviewTree(parseNote(source, { flavor: 'obsidian-compat' })).hast).toEqual(
      toPreviewTree(parseNote(source, { flavor: 'gfm' })).hast,
    );
    expect(createProcessor({ flavor: 'gfm' })).toBe(createProcessor({ flavor: 'gfm' }));
  });
  it('soft breaks affect a cloned preview AST only', () => {
    const source = 'first\nsecond\nthird';
    const parsed = parseNote(source);
    const baseline = JSON.stringify(parsed.mdast);
    const soft = toPreviewTree(parsed, { softBreaks: true });
    expect(elements(soft.hast).filter((node) => node.tagName === 'br')).toHaveLength(2);
    expect(
      elements(toPreviewTree(parsed).hast).filter((node) => node.tagName === 'br'),
    ).toHaveLength(0);
    expect(JSON.stringify(parsed.mdast)).toBe(baseline);
  });
  it('does not turn positionless serialization separators into whole-document preview blocks', () => {
    const source = '# Heading\n\nfirst paragraph\n\nsecond paragraph';
    const result = toPreviewTree(parseNote(source));
    expect(result.blocks).toHaveLength(3);
    expect(result.blocks.map((block) => source.slice(block.startOffset, block.endOffset))).toEqual([
      '# Heading',
      'first paragraph',
      'second paragraph',
    ]);
  });
});
