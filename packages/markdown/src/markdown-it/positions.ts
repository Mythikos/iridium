/** Source observations around public markdown-it rules; grammar decisions stay upstream. */
import {
  StateInline as MarkdownInlineState,
  type Ruler,
  type StateBlock,
  type StateInline,
  type Token,
  type TokenEngine as MarkdownParser,
} from 'markdown-it/parser';

export interface TokenSpan {
  start: number;
  end: number;
  /** Original source coordinates for inline content after container prefixes are removed. */
  offsets?: Int32Array;
  codeValue?: string;
}

const SPANS = new WeakMap<Token, TokenSpan>();

export function tokenSpan(token: Token): TokenSpan | undefined {
  return SPANS.get(token);
}

class PositionedInline extends MarkdownInlineState {
  pendingFrom = -1;

  override pushPending(): Token {
    const value = this.pending;
    const start = this.pendingFrom < 0 ? this.pos - value.length : this.pendingFrom;
    const token = super.pushPending();
    SPANS.set(token, { start, end: start + value.length });
    this.pendingFrom = -1;
    return token;
  }
}

/** Wrap cached public rule lists without reading or changing Ruler's private registry. */
function observeRules<Args extends unknown[], Result>(
  ruler: Ruler<Args, Result>,
  observe: (rule: (...args: Args) => Result) => (...args: Args) => Result,
): void {
  const getRules = ruler.getRules.bind(ruler);
  const observed = new WeakMap<
    Array<(...args: Args) => Result>,
    Array<(...args: Args) => Result>
  >();
  ruler.getRules = (chain) => {
    const original = getRules(chain);
    let wrapped = observed.get(original);
    if (wrapped === undefined) {
      wrapped = original.map(observe);
      observed.set(original, wrapped);
    }
    return wrapped;
  };
}

function observeInline(rule: (state: StateInline, silent: boolean) => boolean) {
  return (state: StateInline, silent: boolean): boolean => {
    const from = state.pos;
    if (
      !silent &&
      state instanceof PositionedInline &&
      state.pending !== '' &&
      state.pendingFrom < 0
    )
      state.pendingFrom = from - state.pending.length;
    const firstToken = state.tokens.length;
    const matched = rule(state, silent);
    if (!matched || silent) return matched;
    const to = state.pos;
    if (state instanceof PositionedInline) {
      if (state.pending === '') state.pendingFrom = -1;
      else if (state.pendingFrom < 0) state.pendingFrom = to - state.pending.length;
    }
    let marker = from;
    for (let index = firstToken; index < state.tokens.length; index += 1) {
      const token = state.tokens[index];
      if (token === undefined || SPANS.has(token)) continue;
      if (token.type === 'text' && /^[*_~]+$/.test(token.content)) {
        SPANS.set(token, { start: marker, end: marker + token.content.length });
        marker += token.content.length;
      } else if (token.type === 'code_inline') {
        let value = state.src.slice(from + token.markup.length, to - token.markup.length);
        if (/^[ \n]/.test(value) && /[ \n]$/.test(value) && /[^ \n]/.test(value))
          value = value.slice(1, -1);
        SPANS.set(token, { start: from, end: to, codeValue: value });
      } else SPANS.set(token, { start: from, end: to });
    }
    const produced = state.tokens.slice(firstToken);
    const opening = produced.find((token) => token.type === 'link_open');
    const closing = produced.findLast((token) => token.type === 'link_close');
    if (opening !== undefined && closing !== undefined) {
      SPANS.set(opening, { start: from, end: from + 1 });
      SPANS.set(closing, { start: to - 1, end: to });
      if (opening.info === 'auto') {
        const text = produced
          .slice(produced.indexOf(opening) + 1)
          .find((token) => token.type === 'text');
        if (text !== undefined) SPANS.set(text, { start: from + 1, end: to - 1 });
      }
    }
    const lineBreak = produced.find(
      (token) => token.type === 'hardbreak' || token.type === 'softbreak',
    );
    if (lineBreak !== undefined) {
      let start = from;
      if (lineBreak.type === 'hardbreak' && state.src[from] === '\n')
        while (start > 0 && state.src[start - 1] === ' ') start -= 1;
      const newline = state.src.indexOf('\n', from);
      SPANS.set(lineBreak, { start, end: newline < 0 ? to : newline + 1 });
    }
    return matched;
  };
}

/** Skip only container indentation, retaining ordinary continuation-line whitespace. */
function contentStart(state: StateBlock, line: number): number {
  const base = state.bMarks[line] ?? 0;
  let cursor = base;
  let columns = 0;
  // A quote's optional tab is one source unit even when upstream keeps its virtual remainder.
  if (state.src[cursor] === '\t' && state.src[cursor - 1] === '>') {
    cursor += 1;
    columns = 4 - ((state.bsCount[line] ?? 0) % 4);
  }
  while (cursor < (state.eMarks[line] ?? state.src.length) && columns < state.blkIndent) {
    const char = state.src.charCodeAt(cursor);
    if (char === 9) columns += 4 - ((columns + (state.bsCount[line] ?? 0)) % 4);
    else if (char === 32 || cursor - base < (state.tShift[line] ?? 0)) columns += 1;
    else break;
    cursor += 1;
  }
  return cursor;
}

/** Maps preserved inline characters through removed quote/list prefixes and table escapes. */
export function inlineOffsets(
  content: string,
  source: string,
  lines: readonly [number, number][],
): Int32Array {
  const offsets = new Int32Array(content.length + 1);
  let cursor = 0;
  let lineIndex = 0;
  for (const value of content.split('\n')) {
    const bounds = lines[lineIndex] ?? lines.at(-1) ?? [0, source.length];
    const [from, end] = bounds;
    const exact = source.indexOf(value, from);
    if (exact >= from && exact + value.length <= end) {
      for (let index = 0; index < value.length; index += 1) offsets[cursor + index] = exact + index;
    } else {
      let original = from;
      for (let index = 0; index < value.length; index += 1) {
        const char = value[index] ?? '';
        const found = source.indexOf(char, original);
        if (found >= original && found < end) original = found;
        offsets[cursor + index] = Math.min(original, end);
        if (original < end) original += 1;
      }
    }
    cursor += value.length;
    if (cursor < content.length) offsets[cursor++] = end;
    lineIndex += 1;
  }
  offsets[content.length] =
    content.length === 0 ? (lines[0]?.[0] ?? 0) : (offsets[content.length - 1] ?? 0) + 1;
  return offsets;
}

function observeBlock(
  rule: (state: StateBlock, startLine: number, endLine: number, silent: boolean) => boolean,
) {
  return (state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean => {
    const firstToken = state.tokens.length;
    const matched = rule(state, startLine, endLine, silent);
    if (!matched || silent) return matched;
    for (let index = firstToken; index < state.tokens.length; index += 1) {
      const token = state.tokens[index];
      if (token === undefined || SPANS.has(token)) continue;
      // The footnote definition block tokenizer brackets its body without a renderer line map.
      if (token.type === 'footnote_reference_open' && token.map === null)
        token.map = [startLine, state.line];
      if (token.map === null) continue;
      const [first, limit] = token.map;
      const start =
        token.type === 'code_block' || token.type === 'html_block'
          ? contentStart(state, first)
          : (state.bMarks[first] ?? 0) + (state.tShift[first] ?? 0);
      let finalLine = Math.max(first, limit - 1);
      while (finalLine > first) {
        const base = state.bMarks[finalLine] ?? 0;
        const rawLine = state.src.slice(
          state.src.lastIndexOf('\n', base - 1) + 1,
          state.eMarks[finalLine],
        );
        if (token.type === 'code_block' ? rawLine !== '' : rawLine.trim() !== '') break;
        finalLine -= 1;
      }
      let end = state.eMarks[finalLine] ?? state.src.length;
      if (token.type === 'code_block') {
        let trailing = limit;
        while (
          trailing < state.lineMax &&
          state.isEmpty(trailing) &&
          (state.sCount[trailing] ?? 0) - state.blkIndent >= 4
        ) {
          end = state.eMarks[trailing] ?? end;
          trailing += 1;
        }
      }
      if (token.type === 'html_block' && end + 1 === state.src.length) {
        const raw = token.content.trimStart();
        const unclosed =
          (/^<(?:script|pre|style|textarea)(?=[\s>]|$)/i.test(raw) &&
            !/<\/(?:script|pre|style|textarea)>/i.test(raw)) ||
          (raw.startsWith('<!--') && !raw.includes('-->')) ||
          (raw.startsWith('<?') && !raw.includes('?>')) ||
          (raw.startsWith('<![CDATA[') && !raw.includes(']]>'));
        if (unclosed) end = state.src.length;
      }
      if (token.type === 'fence' && end + 1 === state.src.length) {
        const tail = state.src.slice(contentStart(state, finalLine), end);
        const marker = tail.trim();
        const closes =
          (state.sCount[finalLine] ?? 0) - state.blkIndent < 4 &&
          marker.length >= token.markup.length &&
          (token.markup[0] === '`' ? /^`+$/.test(marker) : /^~+$/.test(marker));
        if (!closes || finalLine === first) end = state.src.length;
      }
      if (token.type === 'inline') {
        const lines: Array<[number, number]> = [];
        for (let line = first; line < limit; line += 1)
          lines.push([contentStart(state, line), state.eMarks[line] ?? state.src.length]);
        SPANS.set(token, { start, end, offsets: inlineOffsets(token.content, state.src, lines) });
      } else SPANS.set(token, { start, end });
    }
    return matched;
  };
}

/** Preserves token boundaries before the optional text-merging renderer optimizations run. */
export function observeSourcePositions(parser: MarkdownParser): void {
  parser.inline.State = PositionedInline;
  parser.inline.ruler2.disable('fragments_join');
  parser.core.ruler.disable('text_join');
  observeRules(parser.inline.ruler, observeInline);
  observeRules(parser.block.ruler, observeBlock);
}
