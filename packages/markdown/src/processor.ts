/** Stateless processors are shared per flavor/break tuple inside each worker (08 §2.3). */
import type { Root as HastRoot, Text } from 'hast';
import type { Html, Root } from 'mdast';
import type { State } from 'mdast-util-to-hast';
import rehypeSanitize from 'rehype-sanitize';
import remarkBreaks from 'remark-breaks';
import remarkRehype from 'remark-rehype';
import { unified, type Processor } from 'unified';
import type { VFile } from 'vfile';

import { EMPTY_VAULT_INDEX, noteContextWithHeadings } from './context.ts';
import { gfmFlavor, obsidianCompatFlavor, type FlavorPlugin } from './flavors.ts';
import { remarkMarkdownIt } from './markdown-it/parser.ts';
import { collectHeadings } from './outline.ts';
import { rehypeHighlightIridium } from './plugins/rehype-highlight-iridium.ts';
import {
  rehypeIridiumIds,
  rehypeIridiumLinks,
  rehypeIridiumPositions,
} from './plugins/rehype-iridium.ts';
import { restoreGeneratedPositions } from './positions.ts';
import { mergeSanitizeSchema } from './sanitize/schema.ts';
import type { MarkdownFlavor } from './types.ts';

/** The preview compiler has no stringifier; its terminal value is sanitized hast. */
export type MarkdownProcessor = Processor<Root, Root, HastRoot>;

/** Custom flavors exercise the reserved seam; only the two built-in empty flavors ship. */
export interface ProcessorOptions {
  flavor?: MarkdownFlavor | FlavorPlugin;
  softBreaks?: boolean;
}

function htmlAsText(state: State, node: Html): Text {
  const result: Text = { type: 'text', value: node.value };
  state.patch(node, result);
  return result;
}

function remarkIridiumContext(): (tree: Root, file: VFile) => void {
  return (tree, file) => {
    restoreGeneratedPositions(tree, String(file.value));
    const headings = collectHeadings(tree);
    file.data.iridium = {
      note: noteContextWithHeadings(file.data.iridium?.note, headings),
      index: file.data.iridium?.index ?? EMPTY_VAULT_INDEX,
      headings,
    };
  };
}

function buildProcessor(flavor: FlavorPlugin, softBreaks: boolean): MarkdownProcessor {
  const parser = unified().use(remarkMarkdownIt).use(flavor.remark).use(remarkIridiumContext);
  if (softBreaks) parser.use(remarkBreaks);
  return parser
    .use(remarkRehype, {
      allowDangerousHtml: false,
      clobberPrefix: 'user-content-',
      footnoteLabel: 'Footnotes',
      footnoteLabelTagName: 'h2',
      footnoteLabelProperties: { className: ['sr-only'] },
      handlers: { html: htmlAsText },
    })
    .use(rehypeIridiumIds)
    .use(rehypeIridiumPositions)
    .use(rehypeIridiumLinks)
    .use(flavor.rehype)
    .use(rehypeHighlightIridium)
    .use(rehypeSanitize, mergeSanitizeSchema(flavor.sanitizeExtension))
    .freeze();
}

const PROCESSORS = Object.freeze({
  gfm: Object.freeze({
    strict: buildProcessor(gfmFlavor, false),
    soft: buildProcessor(gfmFlavor, true),
  }),
  'obsidian-compat': Object.freeze({
    strict: buildProcessor(obsidianCompatFlavor, false),
    soft: buildProcessor(obsidianCompatFlavor, true),
  }),
});

/** Returns a frozen processor whose final transform is always rehype-sanitize. */
export function createProcessor(options: ProcessorOptions = {}): MarkdownProcessor {
  const flavor = options.flavor ?? 'gfm';
  if (typeof flavor !== 'string') return buildProcessor(flavor, options.softBreaks ?? false);
  return PROCESSORS[flavor][options.softBreaks ? 'soft' : 'strict'];
}
