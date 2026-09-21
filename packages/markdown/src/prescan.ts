/** Linear admission checks before the parser sees any untrusted source (08 §2.10). */
import { MARKDOWN_LIMITS as LIMITS } from '@iridium/contracts/markdown-limits';

/** The reason that a source cannot safely be parsed. */
export type PrescanDetail =
  | 'source_bytes'
  | 'source_chars'
  | 'blockquote_depth'
  | 'list_indent'
  | 'paragraph_lines'
  | 'footnotes'
  | 'brackets';

/** Admission includes source statistics even when the parser is skipped. */
export type PrescanResult =
  | { status: 'ok'; bytes: number; lineCount: number }
  | {
      status: 'too_large' | 'too_complex';
      detail: PrescanDetail;
      line: number;
      bytes: number;
      lineCount: number;
    };

const UTF8_ENCODER = new TextEncoder();
// Scratch space is reused only within this synchronous module. The byte count is
// exact for arbitrary source lengths without allocating a source-sized byte copy.
const UTF8_SCRATCH = new Uint8Array(64 * 1024);

function utf8ByteLength(text: string): number {
  let offset = 0;
  let bytes = 0;
  while (offset < text.length) {
    const { read, written } = UTF8_ENCODER.encodeInto(text.slice(offset), UTF8_SCRATCH);
    offset += read;
    bytes += written;
  }
  return bytes;
}

/** Native UTF-8 measurement plus a linear line scan avoid a JavaScript loop over every source unit. */
export function prescan(text: string): PrescanResult {
  const bytes = utf8ByteLength(text);
  let brackets = 0;
  let footnotes = 0;
  let line = 1;
  let lineStart = 0;
  let paragraphLines = 0;
  let fence = '';
  let fenceLength = 0;
  let refusal: { status: 'too_large' | 'too_complex'; detail: PrescanDetail; line: number } | null =
    text.length > LIMITS.NOTE_HARD_MAX_UTF16
      ? { status: 'too_large', detail: 'source_chars', line: 1 }
      : bytes > LIMITS.MARKDOWN_SOURCE_MAX_BYTES
        ? { status: 'too_large', detail: 'source_bytes', line: 1 }
        : null;
  while (lineStart <= text.length) {
    const newline = text.indexOf('\n', lineStart);
    const end = newline < 0 ? text.length : newline;
    const sourceLine = text.slice(lineStart, end);
    let bracketOffset = sourceLine.indexOf('[');
    while (bracketOffset >= 0 && refusal === null) {
      brackets += 1;
      if (sourceLine.charCodeAt(bracketOffset + 1) === 94) footnotes += 1;
      if (brackets > LIMITS.MARKDOWN_BRACKETS_MAX) {
        refusal ??= { status: 'too_complex', detail: 'brackets', line };
      }
      if (footnotes > LIMITS.MARKDOWN_FOOTNOTE_REFS_MAX) {
        refusal ??= { status: 'too_complex', detail: 'footnotes', line };
      }
      bracketOffset = sourceLine.indexOf('[', bracketOffset + 1);
    }
    let cursor = 0;
    let depth = 0;
    while (cursor < sourceLine.length) {
      let spaces = 0;
      while (sourceLine[cursor] === ' ' && spaces < 3) {
        cursor += 1;
        spaces += 1;
      }
      if (sourceLine[cursor] !== '>') break;
      depth += 1;
      cursor += 1;
      if (sourceLine[cursor] === ' ') cursor += 1;
    }
    const content = depth > 0 ? sourceLine.slice(cursor) : sourceLine;
    const first = content.charCodeAt(0);
    const fenceMatch =
      first === 32 || first === 96 || first === 126
        ? /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(content)
        : null;
    const marker = fenceMatch?.[1] ?? '';
    if (fence === '' && depth > LIMITS.MARKDOWN_BLOCKQUOTE_MAX_DEPTH) {
      refusal ??= { status: 'too_complex', detail: 'blockquote_depth', line };
    }
    if (fence !== '') {
      if (
        marker[0] === fence &&
        marker.length >= fenceLength &&
        /^\s*$/.test(fenceMatch?.[2] ?? '')
      ) {
        fence = '';
      }
      paragraphLines = 0;
    } else if (marker !== '' && !(marker[0] === '`' && (fenceMatch?.[2] ?? '').includes('`'))) {
      fence = marker[0] ?? '';
      fenceLength = marker.length;
      paragraphLines = 0;
    } else {
      const list =
        first <= 32 || first === 42 || first === 43 || first === 45 || (first >= 48 && first <= 57)
          ? /^(\s*)(?:[-+*]|\d{1,9}[.)])(?:\s|$)/.exec(content)
          : null;
      if (list !== null) {
        let columns = 0;
        for (const char of list[1] ?? '') columns += char === '\t' ? 4 : 1;
        if (columns > LIMITS.MARKDOWN_LIST_INDENT_MAX_COLS) {
          refusal ??= { status: 'too_complex', detail: 'list_indent', line };
        }
      }
      paragraphLines =
        content === '' || (first <= 32 && content.trim() === '') ? 0 : paragraphLines + 1;
      if (paragraphLines > LIMITS.MARKDOWN_LINES_PER_PARAGRAPH_MAX) {
        refusal ??= { status: 'too_complex', detail: 'paragraph_lines', line };
      }
    }
    if (newline < 0) break;
    line += 1;
    lineStart = newline + 1;
  }
  return refusal === null
    ? { status: 'ok', bytes, lineCount: line }
    : { ...refusal, bytes, lineCount: line };
}
