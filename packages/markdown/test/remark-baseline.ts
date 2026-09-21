/** Retains the pre-fallback grammar only as an independent compatibility oracle. */
import type { Root } from 'mdast';
import remarkFrontmatter from 'remark-frontmatter';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

import { restoreGeneratedPositions } from '../src/positions.ts';
import { remarkGfmIridium } from './remark-gfm-iridium.ts';

const BASELINE = unified()
  .use(remarkParse)
  .use(remarkGfmIridium)
  .use(remarkFrontmatter, ['yaml'])
  .freeze();

/** The old parser is never reachable through the package's public production entry. */
export function parseRemarkBaseline(source: string): Root {
  const tree = BASELINE.parse(source);
  restoreGeneratedPositions(tree, source);
  return tree;
}
