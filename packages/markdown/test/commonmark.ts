/** Comparison ignores Iridium metadata and equivalent HTML serialization choices, never content. */
import type { Nodes } from 'hast';

import { parseNote, renderHtml, toPreviewTree } from '../src/index.ts';

/** CommonMark's HTML uses different but equivalent entity spellings and XHTML void tags. */
export function canonicalHtml(html: string): string {
  return html
    .replaceAll(/<(hr|br)(?: \/)?>/g, '<$1>')
    .replaceAll(/(<img\b[^>]*?) \/>/g, '$1>')
    .replaceAll(/&#x3c;/gi, '&lt;')
    .replaceAll(/&#x3e;/gi, '&gt;')
    .replaceAll(/&#x26;/gi, '&amp;')
    .replaceAll(/&#x22;/gi, '&quot;')
    .replaceAll(/&#x27;/gi, '&#39;')
    .replaceAll('&#xA;', '\n')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll(/href="(?:http|https|mailto):/gi, (match) => match.toLowerCase())
    .trimEnd();
}

/** Removes only generated navigation/source metadata; structural and text differences stay visible. */
function walk(node: Nodes): void {
  if (node.type === 'element') {
    for (const key of Object.keys(node.properties))
      if (key.startsWith('data')) delete node.properties[key];
    if (/^h[1-6]$/.test(node.tagName)) delete node.properties.id;
    if (typeof node.properties.href === 'string')
      node.properties.href = node.properties.href.replace(/^#user-content-/, '#');
    if (Array.isArray(node.properties.className)) {
      node.properties.className = node.properties.className.filter((name) => name !== 'hljs');
      if (node.properties.className.length === 0) delete node.properties.className;
    }
  }
  if ('children' in node) for (const child of node.children) walk(child);
}

/** Removes only generated navigation/source metadata; structural and text differences stay visible. */
export function renderCommonmark(source: string): string {
  const tree = toPreviewTree(parseNote(source)).hast;
  walk(tree);
  return canonicalHtml(renderHtml(tree));
}
