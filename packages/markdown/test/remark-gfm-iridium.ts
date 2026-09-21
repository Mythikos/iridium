import type { Root } from 'mdast';
/** Frozen pre-S11 parser baseline for differential source-coordinate tests, never product code. */
import { gfmAutolinkLiteralFromMarkdown } from 'mdast-util-gfm-autolink-literal';
import { gfmFootnoteFromMarkdown } from 'mdast-util-gfm-footnote';
import { gfmStrikethroughFromMarkdown } from 'mdast-util-gfm-strikethrough';
import { gfmTableFromMarkdown } from 'mdast-util-gfm-table';
import { gfmTaskListItemFromMarkdown } from 'mdast-util-gfm-task-list-item';
import { gfmFootnote } from 'micromark-extension-gfm-footnote';
import { gfmStrikethrough } from 'micromark-extension-gfm-strikethrough';
import { gfmTable } from 'micromark-extension-gfm-table';
import { gfmTaskListItem } from 'micromark-extension-gfm-task-list-item';
import type { Plugin, Processor } from 'unified';

/** The transform-only autolinker runs after micromark and preserves source positions. */
function attachGfm(this: Processor): void {
  const data = this.data();
  const syntax = data.micromarkExtensions ?? (data.micromarkExtensions = []);
  const from = data.fromMarkdownExtensions ?? (data.fromMarkdownExtensions = []);
  syntax.push(
    gfmTable(),
    gfmStrikethrough({ singleTilde: false }),
    gfmFootnote(),
    gfmTaskListItem(),
  );
  from.push(
    gfmTableFromMarkdown(),
    gfmStrikethroughFromMarkdown(),
    gfmFootnoteFromMarkdown(),
    gfmTaskListItemFromMarkdown(),
    gfmAutolinkLiteralFromMarkdown(),
  );
}

/** unified invokes this attacher with its processor as the explicit receiver. */
export const remarkGfmIridium: Plugin<[], Root> = attachGfm;
