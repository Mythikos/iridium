import { it } from '@fast-check/vitest';
import * as fc from 'fast-check';
import type { Nodes } from 'mdast';
import { describe, expect } from 'vitest';

import { DOCUMENT, WORD } from '../test/generated-documents.ts';
import { PROP } from '../test/prop-budget.ts';
import { parseNote } from './index.ts';

const FRAGMENT = fc
  .tuple(WORD, fc.constantFrom('heading', 'quote', 'list', 'table', 'code', 'reference'))
  .map(([word, kind]) => {
    if (kind === 'heading') return `## ${word}`;
    if (kind === 'quote') return `> **${word}**\n> next`;
    if (kind === 'list') return `- [x] ${word}\n  - nested`;
    if (kind === 'table') return `| ${word} | b |\n| - | - |\n| c |`;
    if (kind === 'code') return `\`\`\`text\n${word}\n\`\`\``;
    return `[${word}][target]\n\n[target]: path.md`;
  });
function check(node: Nodes, source: string, from = 0, to = source.length): void {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  expect(start).toBeDefined();
  expect(end).toBeDefined();
  if (start === undefined || end === undefined)
    throw new Error('Every generated source node needs a position.');
  expect(start).toBeGreaterThanOrEqual(from);
  expect(end).toBeLessThanOrEqual(to);
  expect(end).toBeGreaterThanOrEqual(start);
  for (const [offset, point] of [
    [start, node.position?.start],
    [end, node.position?.end],
  ] as const) {
    const preceding = source.slice(0, offset).split('\n');
    expect(point?.line).toBe(preceding.length);
    expect(point?.column).toBe((preceding.at(-1)?.length ?? 0) + 1);
  }
  const raw = source.slice(start, end);
  // This deliberately small decoder describes the generator, not the implementation.
  // It catches shifted boundaries even when both line/column and offsets shift together.
  if (node.type === 'text')
    expect(raw.replaceAll('\n> ', '\n').replaceAll('&amp;', '&').replaceAll('&#169;', '©')).toBe(
      node.value,
    );
  if (node.type === 'inlineCode') expect(raw.slice(1, -1)).toBe(node.value);
  if (node.type === 'strong') expect(raw).toMatch(/^\*\*[\s\S]+\*\*$/);
  if (node.type === 'image') expect(raw).toBe(`![${node.alt ?? ''}](${node.url})`);
  if (node.type === 'heading') expect(raw).toMatch(/^## /);
  if (node.type === 'code') expect(raw).toBe(`\`\`\`text\n${node.value}\n\`\`\``);
  if (node.type === 'definition') expect(raw).toBe('[target]: path.md');
  if ('children' in node) for (const child of node.children) check(child, source, start, end);
}

describe('markdown.offsets.prop [area:markdown] [spec:portability-and-safety]', () => {
  it.prop([fc.tuple(DOCUMENT, fc.array(FRAGMENT, { maxLength: 8 }))], PROP)(
    'all source slices and coordinates agree with independent source arithmetic and generated syntax',
    ([prose, fragments]) => {
      const source = [prose, ...fragments].join('\n\n');
      const tree = parseNote(source).mdast;
      check(tree, source);
    },
  );
});
