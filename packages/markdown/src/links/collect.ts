import { MARKDOWN_LIMITS as LIMITS } from '@iridium/contracts/markdown-limits';
/** Link occurrences, not distinct destinations, are the unit of the per-revision link index. */
import type { Definition, Nodes, Root } from 'mdast';

import { lineOf, lineStartsOf } from '../body-text.ts';
import { collectWikiOccurrences } from '../obsidian/detect.ts';
import { truncateChars } from '../truncate.ts';
import type { RawLink } from '../types.ts';
import { resolveLink, type NoteContext, type VaultIndex } from './resolve.ts';

function visit(node: Nodes, visitor: (node: Nodes) => void): void {
  visitor(node);
  if ('children' in node) for (const child of node.children) visit(child, visitor);
}

/** Collects Markdown/reference/image and literal Obsidian links in source order. */
export function collectLinks(
  tree: Root,
  source: string,
  note: NoteContext,
  index: VaultIndex,
): RawLink[] {
  const links: RawLink[] = [];
  const definitions = new Map<string, Definition>();
  const used = new Set<string>();
  const wiki = collectWikiOccurrences(source, tree);
  const starts = lineStartsOf(source);
  visit(tree, (node) => {
    if (node.type === 'definition' && !definitions.has(node.identifier))
      definitions.set(node.identifier, node);
    if (node.type === 'linkReference' || node.type === 'imageReference') used.add(node.identifier);
  });
  function add(
    kind: RawLink['kind'],
    rawTarget: string,
    startOffset: number,
    endOffset: number,
    wikilink = false,
  ): void {
    links.push({
      ordinal: 0,
      kind,
      rawTarget: truncateChars(rawTarget, LIMITS.LINK_TARGET_MAX_CHARS),
      startOffset,
      endOffset,
      line: lineOf(starts, startOffset),
      resolved: resolveLink(rawTarget, note, index, { wikilink }),
    });
  }
  visit(tree, (node) => {
    const start = node.position?.start.offset ?? 0;
    const end = node.position?.end.offset ?? start;
    if (wiki.some((reference) => start >= reference.offset && end <= reference.endOffset)) return;
    if (node.type === 'link') add('markdown', node.url, start, end);
    if (node.type === 'image') add('image', node.url, start, end);
    if (node.type === 'definition' && !used.has(node.identifier))
      add('definition', node.url, start, end);
    if (node.type === 'linkReference' || node.type === 'imageReference') {
      const definition = definitions.get(node.identifier);
      if (definition !== undefined)
        add(node.type === 'linkReference' ? 'markdown' : 'image', definition.url, start, end);
    }
  });
  for (const reference of wiki)
    add(
      reference.embed ? 'embed' : 'wikilink',
      reference.target,
      reference.offset,
      reference.endOffset,
      true,
    );
  const ordered = links.toSorted(
    (left, right) => left.startOffset - right.startOffset || left.endOffset - right.endOffset,
  );
  for (const [ordinal, link] of ordered.entries()) link.ordinal = ordinal;
  return ordered;
}
