/** The Iridium hints are added before sanitization; no transform follows the security boundary. */
import type { Root } from 'hast';
import type { VFile } from 'vfile';

import { EMPTY_VAULT_INDEX, noteContextWithHeadings } from '../context.ts';
import { walkElements as walk } from '../hast-walk.ts';
import { resolveLink, type NoteContext, type VaultIndex } from '../links/resolve.ts';
import type { Heading } from '../types.ts';

declare module 'vfile' {
  interface DataMap {
    iridium?: { note: NoteContext; index: VaultIndex; headings: Heading[] };
  }
}

/** Shares mdast heading slugs and fixes the library's hardcoded footnote label before sanitization. */
export function rehypeIridiumIds(): (tree: Root, file: VFile) => void {
  return (tree, file) => {
    const headings = file.data.iridium?.headings ?? [];
    const byOffset = new Map(headings.map((heading) => [heading.offset, heading.slug]));
    walk(tree, (node) => {
      if (/^h[1-6]$/.test(node.tagName) && node.position?.start.offset !== undefined) {
        const slug = byOffset.get(node.position.start.offset);
        if (slug !== undefined) node.properties.id = `user-content-${slug}`;
      }
      if (node.properties.id === 'footnote-label')
        node.properties.id = 'user-content-footnote-label';
      if (Array.isArray(node.properties.ariaDescribedBy)) {
        node.properties.ariaDescribedBy = node.properties.ariaDescribedBy.map((value) =>
          value === 'footnote-label' ? 'user-content-footnote-label' : value,
        );
      }
    });
  };
}

/** Adds source UTF-16 coordinates only when the parser knows them. */
export function rehypeIridiumPositions(): (tree: Root) => void {
  return (tree) =>
    walk(tree, (node) => {
      if (node.position !== undefined) {
        node.properties.dataLine = node.position.start.line;
        if (node.position.start.offset !== undefined)
          node.properties.dataOffset = node.position.start.offset;
        if (node.position.end.offset !== undefined)
          node.properties.dataEndOffset = node.position.end.offset;
      }
    });
}

/** Classifies every produced link; blocked and unresolved URLs never retain a navigable property. */
export function rehypeIridiumLinks(): (tree: Root, file: VFile) => void {
  return (tree, file) => {
    const context = file.data.iridium;
    const note = context?.note ?? noteContextWithHeadings(undefined, []);
    const index = context?.index ?? EMPTY_VAULT_INDEX;
    walk(tree, (node) => {
      const property = node.tagName === 'a' ? 'href' : node.tagName === 'img' ? 'src' : null;
      if (property === null) return;
      const raw = node.properties[property];
      if (typeof raw !== 'string') return;
      if (
        node.properties.dataFootnoteRef !== undefined ||
        node.properties.dataFootnoteBackref !== undefined
      ) {
        node.properties.dataLinkKind = 'anchor';
        node.properties.dataFragment = raw.replace(/^#user-content-/, '');
        return;
      }
      const resolved = resolveLink(raw, note, index);
      node.properties.dataLinkKind = resolved.kind;
      if (resolved.kind === 'external')
        node.properties[property] = raw.replace(/^[a-z]+:/i, `${resolved.scheme}:`);
      if (resolved.kind === 'vault') node.properties.dataNoteId = resolved.nodeId;
      if (resolved.kind === 'attachment') node.properties.dataAttachmentId = resolved.attachmentId;
      if ('fragment' in resolved && resolved.fragment !== null)
        node.properties.dataFragment = resolved.fragment;
      if (resolved.kind === 'ambiguous')
        node.properties.dataCandidates = JSON.stringify(resolved.candidates);
      if (resolved.kind === 'anchor') node.properties.href = `#user-content-${resolved.fragment}`;
      if (resolved.kind === 'blocked') delete node.properties[property];
    });
  };
}
