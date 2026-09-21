/** GFM footnotes retain definitions in source order and allow escaped label brackets. */
import type { TokenEngine as MarkdownIt } from 'markdown-it/parser';

const FOOTNOTES = Symbol('iridium.footnoteLabels');

/** CommonMark case folding includes the uppercase expansion before the final lowercase. */
export function identifier(label: string): string {
  return label
    .replace(/[\t\n\r ]+/g, ' ')
    .trim()
    .toLowerCase()
    .toUpperCase()
    .toLowerCase();
}

/** GFM labels allow up to 999 source units and escape only brackets and backslashes. */
function labelEnd(source: string, start: number, end: number): number {
  if (source[start] !== '[' || source[start + 1] !== '^') return -1;
  const first = start + 2;
  for (let cursor = first; cursor < end && cursor - first <= 999; cursor += 1) {
    const char = source[cursor];
    if (char === ']') return cursor === first ? -1 : cursor;
    if (char === '[' || char === ' ' || char === '\t' || char === '\n' || char === '\r') return -1;
    if (char === '\\' && /[[\]\\]/.test(source[cursor + 1] ?? '')) cursor += 1;
  }
  return -1;
}

/** Uses only public rule/state interfaces; source text is never modified. */
export function installFootnotes(parser: MarkdownIt): void {
  parser.block.ruler.before(
    'reference',
    'iridium_footnote_definition',
    (state, first, last, silent) => {
      const base = state.bMarks[first] ?? 0;
      const shift = state.tShift[first] ?? 0;
      const end = state.eMarks[first] ?? state.src.length;
      const close = labelEnd(state.src, base + shift, end);
      if (close < 0 || state.src[close + 1] !== ':') return false;
      if (silent) return true;
      const opening = state.push('footnote_reference_open', '', 1);
      opening.meta = { label: state.src.slice(base + shift + 2, close) };
      const count = state.sCount[first] ?? 0;
      const indent = state.blkIndent;
      const parentType = state.parentType;
      let body = close + 2;
      while (body < end && (state.src[body] === ' ' || state.src[body] === '\t')) body += 1;
      // The marker consumes all following whitespace; it cannot create first-line code.
      state.bMarks[first] = body;
      state.tShift[first] = 0;
      state.sCount[first] = indent + 4;
      state.blkIndent = indent + 4;
      state.parentType = 'footnote';
      try {
        state.md.block.tokenize(state, first, last);
      } finally {
        state.bMarks[first] = base;
        state.tShift[first] = shift;
        state.sCount[first] = count;
        state.blkIndent = indent;
        state.parentType = parentType;
      }
      opening.map = [first, state.line];
      state.push('footnote_reference_close', '', -1);
      return true;
    },
    { alt: ['paragraph', 'reference'] },
  );
  parser.core.ruler.before('inline', 'iridium_footnote_labels', (state) => {
    state.env[FOOTNOTES] = new Set(
      state.tokens.flatMap((token) => {
        const label = token.meta?.label;
        return token.type === 'footnote_reference_open' && typeof label === 'string'
          ? [identifier(label)]
          : [];
      }),
    );
  });
  parser.inline.ruler.before('link', 'iridium_footnote_ref', (state, silent) => {
    const labels = state.env[FOOTNOTES];
    if (!(labels instanceof Set)) return false;
    const close = labelEnd(state.src, state.pos, state.posMax);
    if (close < 0) return false;
    const label = state.src.slice(state.pos + 2, close);
    if (!labels.has(identifier(label))) return false;
    if (!silent) state.push('iridium_footnote_ref', '', 0).meta = { label };
    state.pos = close + 1;
    return true;
  });
}
