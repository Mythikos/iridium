/** Builds sanitized preview blocks without changing the mdast projection input. */
import { VFile } from 'vfile';

import { EMPTY_VAULT_INDEX, noteContextWithHeadings } from './context.ts';
import { createProcessor } from './processor.ts';
import type { ParsedNote, PreviewContext, PreviewTree } from './types.ts';

function fnv1a(source: string): string {
  let hash = 0x811c9dc5;
  for (let offset = 0; offset < source.length; offset += 1) {
    hash ^= source.charCodeAt(offset);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Produces only sanitized hast; all mapping and block hashing after it are read-only. */
export function toPreviewTree(parsed: ParsedNote, context: PreviewContext = {}): PreviewTree {
  const note = noteContextWithHeadings(context.note, []);
  const processor = createProcessor({
    flavor: parsed.flavor,
    softBreaks: context.softBreaks ?? false,
  });
  const file = new VFile({
    value: parsed.source,
    data: { iridium: { note, index: context.index ?? EMPTY_VAULT_INDEX, headings: [] } },
  });
  const hast = processor.runSync(structuredClone(parsed.mdast), file);
  // The context transform computes the revision's headings once for both links and outline.
  const outline = file.data.iridium?.headings ?? [];
  // remark-rehype inserts positionless newline nodes between block elements. They are HTML
  // serialization whitespace, not preview blocks; hashing the whole source for each separator
  // would make a many-paragraph preview quadratic (08 §2.9).
  const blocks = hast.children
    .filter(
      (node) => node.type !== 'text' || node.position !== undefined || node.value.trim() !== '',
    )
    .map((node) => {
      const startOffset = node.position?.start.offset ?? 0;
      const endOffset = node.position?.end.offset ?? parsed.source.length;
      const hash = fnv1a(parsed.source.slice(startOffset, endOffset));
      return { key: `${startOffset}:${hash}`, startOffset, endOffset, hash, hast: node };
    });
  return { hast, blocks, outline, diagnostics: [...parsed.diagnostics] };
}
