/** Mapped fallback executes inside the same bounded projection pool, never the main event loop. */
import { LIMITS, type ParsedSearchQuery, type SearchSnippet } from '@iridium/contracts';
import { lineOf, lineStartsOf, parseNote, sourceOffsetOf, toBodyText } from '@iridium/markdown';

import {
  firstSnippetMatch,
  foldSnippetText,
  snippetFromRanges,
  snippetNeedles,
  unfoldSnippetRange,
  type SnippetRange,
} from './snippet-text.ts';

/** Only committed source and a parsed query cross the worker boundary. */
export interface MappedSnippetTask {
  readonly markdown: string;
  readonly query: ParsedSearchQuery;
  readonly snippetChars: number;
}

/** Finds formatted-text matches, then maps each contributing character to Markdown source lines. */
export default function mappedSnippetTask(task: MappedSnippetTask): SearchSnippet[] {
  const parsed = parseNote(task.markdown);
  if (parsed.prescan.status !== 'ok') return [];
  const body = toBodyText(parsed.mdast, task.markdown);
  const folded = foldSnippetText(body.text, true);
  const needles = snippetNeedles(task.query);
  const lines = task.markdown.split('\n');
  const starts = lineStartsOf(task.markdown);
  const matches = new Map<number, SnippetRange[]>();
  let cursor = 0;
  while (cursor < folded.text.length && matches.size < LIMITS.SNIPPET_MAX_LINES) {
    const match = firstSnippetMatch(folded.text, needles, cursor);
    if (match === null) break;
    const range = unfoldSnippetRange(folded, match);
    for (let offset = range.start; offset < range.end; offset += 1) {
      const sourceOffset = sourceOffsetOf(body.runs, offset);
      const line = lineOf(starts, sourceOffset);
      if (matches.size >= LIMITS.SNIPPET_MAX_LINES && !matches.has(line)) break;
      const existing = matches.get(line) ?? [];
      const column = sourceOffset - (starts[line - 1] ?? 0);
      // Synthetic paragraph separators and decoded entities locate a line but do not claim a
      // literal character range; every highlighted source unit really contributed to the match.
      if (task.markdown[sourceOffset] === body.text[offset] && body.text[offset] !== '\n')
        existing.push({ start: column, end: column + 1 });
      matches.set(line, existing);
    }
    cursor = match.end;
  }
  return [...matches]
    .toSorted(([left], [right]) => left - right)
    .map(([line, ranges]) =>
      snippetFromRanges(line, lines[line - 1] ?? '', ranges, task.snippetChars),
    );
}
