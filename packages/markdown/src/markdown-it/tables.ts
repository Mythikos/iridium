/** GFM source tables preserve ragged rows and escaped-pipe parity before inline parsing. */
import type { TokenEngine as MarkdownIt, StateBlock } from 'markdown-it/parser';

export interface SourceCell {
  from: number;
  to: number;
  content: string;
}

/** Cell ranges include their preceding separator, and the final range includes an outer pipe. */
export function splitTableRow(raw: string): SourceCell[] {
  const pipes: number[] = [];
  for (let offset = 0; offset < raw.length; offset += 1) {
    if (raw[offset] === '\\') offset += 1;
    else if (raw[offset] === '|') pipes.push(offset);
  }
  const trimmedEnd = raw.trimEnd().length;
  const outer = pipes.at(-1) === trimmedEnd - 1 ? trimmedEnd - 1 : -1;
  const bounds = [0, ...pipes.filter((offset) => offset > 0 && offset !== outer), raw.length];
  return bounds.slice(0, -1).map((from, index) => {
    const to = bounds[index + 1] ?? raw.length;
    const start = raw[from] === '|' ? from + 1 : from;
    const end = index + 2 === bounds.length && outer >= start ? outer : to;
    return { from, to, content: raw.slice(start, end).trim().replace(/\\\|/g, '|') };
  });
}

function lineText(state: StateBlock, line: number): string {
  return state.src.slice((state.bMarks[line] ?? 0) + (state.tShift[line] ?? 0), state.eMarks[line]);
}

function row(
  state: StateBlock,
  line: number,
  cells: readonly SourceCell[],
  align?: readonly (string | null)[],
): void {
  state.push('tr_open', 'tr', 1).map = [line, line + 1];
  for (let index = 0; index < cells.length; index += 1) {
    const tag = align === undefined ? 'td' : 'th';
    const opening = state.push(`${tag}_open`, tag, 1);
    const alignment = align?.[index];
    if (alignment !== undefined && alignment !== null)
      opening.attrSet('style', `text-align:${alignment}`);
    const inline = state.push('inline', '', 0);
    inline.content = cells[index]?.content ?? '';
    inline.children = [];
    state.push(`${tag}_close`, tag, -1);
  }
  state.push('tr_close', 'tr', -1);
}

/** This public block extension corrects HTML tokenizers' padding and escaped-pipe behavior. */
export function installTables(parser: MarkdownIt): void {
  parser.block.ruler.at(
    'table',
    (state, first, last, silent) => {
      if (first + 1 >= last || (state.sCount[first] ?? 0) - state.blkIndent >= 4) return false;
      const delimiterIndent = (state.sCount[first + 1] ?? 0) - state.blkIndent;
      if (delimiterIndent < 0 || delimiterIndent >= 4) return false;
      const header = lineText(state, first);
      const delimiter = lineText(state, first + 1);
      if (!header.includes('|') || !/^[|:\-\t ]+$/.test(delimiter)) return false;
      const headerCells = splitTableRow(header);
      const delimiters = splitTableRow(delimiter);
      if (
        headerCells.length !== delimiters.length ||
        delimiters.some(({ content }) => !/^:?-+:?$/.test(content))
      )
        return false;
      if (silent) return true;
      const aligns = delimiters.map(({ content }) =>
        content.endsWith(':')
          ? content.startsWith(':')
            ? 'center'
            : 'right'
          : content.startsWith(':')
            ? 'left'
            : null,
      );
      const parentType = state.parentType;
      state.parentType = 'table';
      const opening = state.push('table_open', 'table', 1);
      row(state, first, headerCells, aligns);
      const terminators = state.md.block.ruler.getRules('blockquote');
      let next = first + 2;
      try {
        for (; next < last; next += 1) {
          const indent = (state.sCount[next] ?? 0) - state.blkIndent;
          if (indent < 0 || indent >= 4 || state.isEmpty(next)) break;
          if (terminators.some((rule) => rule(state, next, last, true))) break;
          row(state, next, splitTableRow(lineText(state, next)));
        }
      } finally {
        state.parentType = parentType;
      }
      opening.map = [first, next];
      state.push('table_close', 'table', -1);
      state.line = next;
      return true;
    },
    { alt: ['paragraph', 'reference'] },
  );
}
