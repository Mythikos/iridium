/** The transform-only autolinker creates nodes without positions; restore them from its source. */
import type { Nodes, Root } from 'mdast';
import { toString } from 'mdast-util-to-string';

import { lineOf, lineStartsOf } from './body-text.ts';

/** Repairs generated literal nodes without altering an existing parser coordinate. */
export function restoreGeneratedPositions(tree: Root, source: string): void {
  // Most nodes retain micromark positions. Build the line index only for generated literals.
  let starts: ReturnType<typeof lineStartsOf> | undefined;
  function point(offset: number): { line: number; column: number; offset: number } {
    starts ??= lineStartsOf(source);
    const line = lineOf(starts, offset);
    return { line, column: offset - (starts[line - 1] ?? 0) + 1, offset };
  }
  function walk(node: Nodes, from: number, limit: number): number {
    if (node.position === undefined) {
      const literal = toString(node);
      const found = source.indexOf(literal, from);
      if (found >= from && found + literal.length <= limit) {
        node.position = { start: point(found), end: point(found + literal.length) };
      }
    }
    let cursor = node.position?.start.offset ?? from;
    const end = node.position?.end.offset ?? limit;
    if ('children' in node) for (const child of node.children) cursor = walk(child, cursor, end);
    return node.position?.end.offset ?? cursor;
  }
  walk(tree, 0, source.length);
}
