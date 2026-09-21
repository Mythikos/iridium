/** A42 fallback: markdown-it owns syntax; this adapter emits the existing mdast contract. */
import {
  TokenEngine,
  type Env,
  type Token,
  type TokenEngine as MarkdownParser,
} from 'markdown-it/parser';
import type { Root } from 'mdast';
import { gfmAutolinkLiteralFromMarkdown } from 'mdast-util-gfm-autolink-literal';
import type { Plugin, Processor } from 'unified';

import { restoreGeneratedPositions } from '../positions.ts';
import { installFootnotes } from './footnotes.ts';
import { observeSourcePositions } from './positions.ts';
import { installTables } from './tables.ts';
import { tokensToMdast } from './tree.ts';

const AUTOLINK_TRANSFORMS = gfmAutolinkLiteralFromMarkdown().transforms ?? [];

function installFrontmatter(parser: MarkdownParser): void {
  parser.block.ruler.before('hr', 'iridium_frontmatter', (state, first, last, silent) => {
    if (
      first !== 0 ||
      state.bMarks[first] !== 0 ||
      !/^---[\t ]*$/.test(state.src.slice(0, state.eMarks[0]))
    )
      return false;
    let close = first + 1;
    while (
      close < last &&
      !/^---[\t ]*$/.test(state.src.slice(state.bMarks[close], state.eMarks[close]))
    )
      close += 1;
    if (close === last) return false;
    if (silent) return true;
    const token = state.push('iridium_yaml', '', 0);
    token.map = [first, close + 1];
    token.content = state.src.slice(
      (state.eMarks[first] ?? 0) + 1,
      Math.max((state.bMarks[close] ?? 0) - 1, (state.eMarks[first] ?? 0) + 1),
    );
    state.line = close + 1;
    return true;
  });
}

const PARSER = new TokenEngine({
  html: true,
  // The shared admission policy and worker deadlines are authoritative. markdown-it's
  // renderer-oriented nesting cap silently discards source, which projections cannot do.
  maxNesting: Number.POSITIVE_INFINITY,
});
PARSER.enable(['table', 'strikethrough']);
PARSER.core.ruler.disable('strip_references');
// Destinations remain source-derived data. The shared resolver and sanitize-last pipeline
// classify and remove unsafe schemes; a parser-level filter would silently drop link rows.
installFrontmatter(PARSER);
installFootnotes(PARSER);
installTables(PARSER);
observeSourcePositions(PARSER);

/** Parses complete source without HTML serialization or re-parsing. */
export function parseMarkdownIt(source: string): Root {
  const env: Env = {};
  const tokens: Token[] = PARSER.parse(source, env);
  let tree = tokensToMdast(tokens, source, env, PARSER);
  for (const transform of AUTOLINK_TRANSFORMS) tree = transform(tree) ?? tree;
  restoreGeneratedPositions(tree, source);
  return tree;
}

/** Installs the replacement parser behind unified's unchanged parse/run boundary. */
function attachParser(this: Processor): void {
  this.parser = parseMarkdownIt;
}

export const remarkMarkdownIt: Plugin<[], string, Root> = attachParser;
