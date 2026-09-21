/** Parsing owns neither normalization nor rendering: source is already the LF text of record. */
import type { Root } from 'mdast';

import { frontmatterIndex, readFrontmatter } from './frontmatter.ts';
import { restoreGeneratedPositions } from './positions.ts';
import { prescan } from './prescan.ts';
import { createProcessor } from './processor.ts';
import type { ParseOptions, ParsedNote } from './types.ts';

/** Parses admitted source once; pre-scan failures return status and the untouched source. */
export function parseNote(text: string, options: ParseOptions = {}): ParsedNote {
  const admission = prescan(text);
  const flavor = options.flavor ?? 'gfm';
  if (admission.status !== 'ok') {
    return {
      source: text,
      flavor,
      mdast: { type: 'root', children: [] },
      frontmatter: null,
      prescan: admission,
      diagnostics: [{ code: 'prescan', message: admission.detail, line: admission.line }],
    };
  }
  const processor = createProcessor({ flavor });
  const mdast: Root = processor.parse(text);
  restoreGeneratedPositions(mdast, text);
  const frontmatter = readFrontmatter(mdast, text);
  if (frontmatter !== null)
    frontmatter.diagnostics.push(...frontmatterIndex(frontmatter).diagnostics);
  return {
    source: text,
    flavor,
    mdast,
    frontmatter,
    prescan: admission,
    diagnostics:
      frontmatter?.data === null
        ? [
            {
              code: 'frontmatter_invalid',
              message: frontmatter.diagnostics.map((item) => item.message).join('; '),
              line: 1,
            },
          ]
        : [],
  };
}
