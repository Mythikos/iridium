/** Pure source slicing. Line and heading boundaries always refer to unchanged Markdown. */
import type { NoteHeading } from '@iridium/contracts';

import { ProblemError } from '../../security/problem.ts';

/** The optional source selection, shared across surfaces. */
export interface SourceSelection {
  readonly lines?: { readonly start: number; readonly end?: number };
  readonly heading?: string;
  readonly maxChars?: number;
}
/** The source identity is supplied by the caller; slicing never hashes a different document. */
export interface SourceSlice {
  readonly markdown: string;
  readonly lineCount: number;
  readonly returnedRange: readonly [number, number];
  readonly truncated: boolean;
  readonly sliceReason: 'whole' | 'line_range' | 'heading' | 'char_cap';
}
const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });

/** Long source excerpts stop before a grapheme, even when it is a multi-codepoint emoji. */
export function capGraphemes(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  let end = 0;
  for (const segment of graphemes.segment(text)) {
    const next = segment.index + segment.segment.length;
    if (next > maxChars) break;
    end = next;
  }
  return text.slice(0, end);
}

/** Clamps valid one-based ranges, and locates sections by the committed outline's own slug. */
export function selectSource(
  markdown: string,
  headings: readonly NoteHeading[],
  selection: SourceSelection = {},
): SourceSlice {
  const lines = markdown.split('\n');
  let start = 1;
  let end = lines.length;
  let reason: SourceSlice['sliceReason'] = 'whole';
  if (selection.heading !== undefined) {
    const wanted = selection.heading.replace(/^#/, '').normalize('NFC');
    const heading =
      headings.find((item) => item.slug === wanted) ??
      headings.find((item) => item.text.normalize('NFC') === wanted);
    if (heading === undefined)
      throw new ProblemError('not_found', {
        detail: 'The selected heading is not present in this revision.',
      });
    start = heading.line;
    end =
      (headings.find((item) => item.line > start && item.depth <= heading.depth)?.line ??
        lines.length + 1) - 1;
    reason = 'heading';
  }
  if (selection.lines !== undefined) {
    const requestedStart = selection.lines.start;
    const requestedEnd = selection.lines.end ?? lines.length;
    if (
      !Number.isSafeInteger(requestedStart) ||
      !Number.isSafeInteger(requestedEnd) ||
      requestedStart < 1 ||
      requestedEnd < requestedStart
    )
      throw new ProblemError('validation_failed', {
        errors: [
          {
            path: 'lines',
            message: 'Expected an ordered one-based line range.',
            code: 'lines_invalid',
          },
        ],
      });
    start = Math.max(start, Math.min(requestedStart, end));
    end = Math.min(end, Math.max(start, requestedEnd));
    reason = 'line_range';
  }
  const selected = lines.slice(start - 1, end).join('\n');
  let text = selected;
  if (selection.maxChars !== undefined) {
    if (!Number.isSafeInteger(selection.maxChars) || selection.maxChars < 1)
      throw new ProblemError('validation_failed', {
        detail: 'maxChars must be a positive safe integer.',
      });
    text = capGraphemes(selected, selection.maxChars);
    if (text.length < selected.length) {
      end = start + text.split('\n').length - 1;
      reason = 'char_cap';
    }
  }
  return {
    markdown: text,
    lineCount: lines.length,
    returnedRange: [start, end],
    truncated: text.length < selected.length,
    sliceReason: reason,
  };
}
