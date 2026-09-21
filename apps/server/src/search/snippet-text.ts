/** Source-preserving text folding and excerpt construction, shared by both snippet stages. */
import { LIMITS, type ParsedSearchQuery, type SearchSnippet } from '@iridium/contracts';

/** UTF-16 offsets within the displayed string; end is exclusive. */
export interface SnippetRange {
  readonly start: number;
  readonly end: number;
}

/** Normalized matching text and a map back to its original UTF-16 coordinates. */
export interface FoldedSnippetText {
  readonly text: string;
  readonly starts: readonly number[] | null;
  readonly ends: readonly number[] | null;
}

/** NFC/case folding preserves coordinates, including decomposed accents and expanding case folds. */
export function foldSnippetText(source: string, collapseWhitespace = false): FoldedSnippetText {
  const normalized = source.normalize('NFC');
  const lower = normalized.toLowerCase();
  if (!collapseWhitespace && normalized === source && lower.length === source.length) {
    return { text: lower, starts: null, ends: null };
  }
  const chunks: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  let previousSpace = false;
  const segmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });
  for (const segment of segmenter.segment(source)) {
    const space = collapseWhitespace && /^\s+$/u.test(segment.segment);
    const text = space ? ' ' : segment.segment.normalize('NFC').toLowerCase();
    const end = segment.index + segment.segment.length;
    if (space && previousSpace) {
      ends[ends.length - 1] = end;
      continue;
    }
    for (let index = 0; index < text.length; index += 1) {
      starts.push(segment.index);
      ends.push(end);
    }
    chunks.push(text);
    previousSpace = space;
  }
  return { text: chunks.join(''), starts, ends };
}

/** Maps one match in folded text to the exact original source span. */
export function unfoldSnippetRange(text: FoldedSnippetText, range: SnippetRange): SnippetRange {
  return {
    start: text.starts?.[range.start] ?? range.start,
    end: text.ends?.[range.end - 1] ?? range.end,
  };
}

/** Only positive terms and phrases contribute highlights; filters and exclusions never do. */
export function snippetNeedles(query: ParsedSearchQuery): string[] {
  const terms = query.terms.flatMap((term) => term.match(/[\p{L}\p{N}\p{M}_’']+/gu) ?? []);
  return [
    ...new Set(
      [...terms, ...query.phrases]
        .map((value) => value.normalize('NFC').toLowerCase().replaceAll(/\s+/gu, ' ').trim())
        .filter(Boolean),
    ),
  ];
}

/** Earliest match wins; a longer matching phrase wins a same-position tie. */
export function firstSnippetMatch(
  text: string,
  needles: readonly string[],
  from = 0,
): SnippetRange | null {
  let first: SnippetRange | null = null;
  for (const needle of needles) {
    const index = text.indexOf(needle, from);
    if (
      index >= 0 &&
      (first === null ||
        index < first.start ||
        (index === first.start && needle.length > first.end - first.start))
    ) {
      first = { start: index, end: index + needle.length };
    }
  }
  return first;
}

/** Clips an excerpt around its first match, with ranges into the returned text including ellipses. */
export function snippetFromRanges(
  line: number,
  source: string,
  ranges: readonly SnippetRange[],
  maxChars: number,
): SearchSnippet {
  const first = ranges[0] ?? { start: 0, end: 0 };
  let start = Math.max(
    0,
    first.start - Math.floor(Math.max(0, maxChars - (first.end - first.start)) / 2),
  );
  const prefix = start > 0;
  let end = Math.min(source.length, start + maxChars - (prefix ? 1 : 0));
  const suffix = end < source.length;
  if (suffix) end -= 1;
  const startUnit = source.charCodeAt(start);
  if (startUnit >= 0xdc00 && startUnit <= 0xdfff) start += 1;
  const endUnit = source.charCodeAt(end - 1);
  if (endUnit >= 0xd800 && endUnit <= 0xdbff) end -= 1;
  const offset = prefix ? 1 : 0;
  const displayed: SnippetRange[] = [];
  for (const range of ranges.toSorted(
    (left, right) => left.start - right.start || left.end - right.end,
  )) {
    const clipped = {
      start: Math.max(start, range.start) - start + offset,
      end: Math.min(end, range.end) - start + offset,
    };
    if (clipped.end <= clipped.start) continue;
    const previous = displayed.at(-1);
    if (previous !== undefined && previous.end >= clipped.start)
      displayed[displayed.length - 1] = {
        start: previous.start,
        end: Math.max(previous.end, clipped.end),
      };
    else displayed.push(clipped);
  }
  return {
    line,
    text: `${prefix ? '…' : ''}${source.slice(start, end)}${suffix ? '…' : ''}`,
    ranges: displayed,
  };
}

/** Source-only stage: frontmatter is skipped, and no parser runs on the server main thread. */
export function sourceSnippets(
  markdown: string,
  query: ParsedSearchQuery,
  maxChars: number = LIMITS.SNIPPET_MAX_CHARS,
): SearchSnippet[] {
  const needles = snippetNeedles(query);
  if (needles.length === 0) return [];
  const lines = markdown.split('\n');
  let start = 0;
  if (lines[0] === '---') {
    const closing = lines.findIndex((line, index) => index > 0 && /^---\s*$/.test(line));
    if (closing > 0) start = closing + 1;
  }
  const result: SearchSnippet[] = [];
  for (
    let index = start;
    index < lines.length && result.length < LIMITS.SNIPPET_MAX_LINES;
    index += 1
  ) {
    const source = lines[index] ?? '';
    const folded = foldSnippetText(source);
    const first = firstSnippetMatch(folded.text, needles);
    if (first === null) continue;
    const range = unfoldSnippetRange(folded, first);
    // Collect only the bounded displayed window after locating the first match on a source line.
    const last = range.start + maxChars;
    const ranges = [range];
    let cursor = first.end;
    while (cursor < folded.text.length) {
      const next = firstSnippetMatch(folded.text, needles, cursor);
      if (next === null) break;
      const unwrapped = unfoldSnippetRange(folded, next);
      if (unwrapped.start > last) break;
      ranges.push(unwrapped);
      cursor = next.end;
    }
    result.push(snippetFromRanges(index + 1, source, ranges, maxChars));
  }
  return result;
}
