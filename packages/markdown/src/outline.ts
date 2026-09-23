import { MARKDOWN_LIMITS as LIMITS } from '@iridium/contracts/markdown-limits';
/** Shared slugs are used by projection, link anchors and preview ids (08 §2.6 and §3.4). */
import GithubSlugger from 'github-slugger';
import type { Nodes, Root } from 'mdast';
import { toString } from 'mdast-util-to-string';

import { truncateChars } from './truncate.ts';
import type { Heading } from './types.ts';

/** Walks headings in document order with one fresh slugger, so repeated headings deduplicate. */
export function collectHeadings(tree: Root): Heading[] {
  const slugger = new GithubSlugger();
  const headings: Heading[] = [];
  function walk(node: Nodes): void {
    if (node.type === 'heading') {
      const text = toString(node).replaceAll(/\s+/gu, ' ').trim();
      headings.push({
        depth: node.depth,
        text,
        slug: slugger.slug(text),
        line: node.position?.start.line ?? 1,
        offset: node.position?.start.offset ?? 0,
      });
    }
    if ('children' in node) for (const child of node.children) walk(child);
  }
  walk(tree);
  return headings;
}

/** Truncates at complete combining sequences while honoring MySQL's code-point length. */
export function headingTitleOf(headings: readonly Heading[]): string | null {
  const first = headings.find((heading) => heading.depth === 1);
  if (first === undefined) return null;
  return truncateChars(first.text, LIMITS.HEADING_TITLE_MAX_CODEPOINTS);
}
