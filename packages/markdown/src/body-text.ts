/** Plain text and source positions are produced together; no Markdown serializer is involved. */
import type { Nodes, Root } from 'mdast';

import type { BodyTextResult, TextRun } from './types.ts';

/** Builds the source's line-start table once for all source-offset queries. */
export function lineStartsOf(source: string): Int32Array {
  const starts = [0];
  for (let offset = 0; offset < source.length; offset += 1)
    if (source.charCodeAt(offset) === 10) starts.push(offset + 1);
  return Int32Array.from(starts);
}

/** Binary-searches a source offset to its one-based source line. */
export function lineOf(lineStarts: Int32Array, sourceOffset: number): number {
  let low = 0;
  let high = lineStarts.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((lineStarts[middle] ?? 0) <= sourceOffset) low = middle + 1;
    else high = middle;
  }
  return Math.max(1, low);
}

/** Maps synthetic separators to the source end of the preceding contribution. */
export function sourceOffsetOf(runs: readonly TextRun[], bodyOffset: number): number {
  let low = 0;
  let high = runs.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((runs[middle]?.[0] ?? 0) <= bodyOffset) low = middle + 1;
    else high = middle;
  }
  const run = runs[low - 1];
  return run === undefined ? 0 : run[1] + Math.min(Math.max(0, bodyOffset - run[0]), run[2]);
}

/** Walks prose and code, skipping YAML/HTML/definitions and separating every semantic block. */
export function toBodyText(tree: Root, source: string): BodyTextResult {
  const chunks: string[] = [];
  const runs: TextRun[] = [];
  let bodyOffset = 0;
  let previousEnd = 0;
  function separator(): void {
    runs.push([bodyOffset, previousEnd, 0]);
    chunks.push('\n');
    bodyOffset += 1;
  }
  function value(text: string, node: Nodes, skip: number): void {
    const end = node.position?.end.offset ?? source.length;
    let cursor = (node.position?.start.offset ?? previousEnd) + skip;
    if (cursor + text.length <= end && source.startsWith(text, cursor)) {
      if (text.length > 0) runs.push([bodyOffset, cursor, text.length]);
      chunks.push(text);
      bodyOffset += text.length;
      previousEnd = Math.max(previousEnd, cursor + text.length);
      return;
    }
    // Character-occurrence queues make decoded entities and normalized code whitespace linear.
    // Repeated indexOf() for an absent decoded character would repeatedly scan the entire note.
    const occurrences = new Map<number, number[]>();
    const consumed = new Map<number, number>();
    for (let offset = cursor; offset < end; offset += 1) {
      const unit = source.charCodeAt(offset);
      const positions = occurrences.get(unit);
      if (positions === undefined) occurrences.set(unit, [offset]);
      else positions.push(offset);
    }
    let active: [number, number, number] | null = null;
    for (let offset = 0; offset < text.length; offset += 1) {
      const unit = text.charCodeAt(offset);
      const positions = occurrences.get(unit) ?? [];
      let positionIndex = consumed.get(unit) ?? 0;
      while (positionIndex < positions.length && (positions[positionIndex] ?? end) < cursor)
        positionIndex += 1;
      const found = positions[positionIndex] ?? -1;
      consumed.set(unit, positionIndex + 1);
      // Entity expansion and normalized code whitespace can have no literal source character.
      // Zero-length anchor runs make that distinction explicit instead of claiming false offsets.
      if (found < 0 || found >= end) {
        active = null;
        runs.push([bodyOffset + offset, cursor, 0]);
        continue;
      }
      if (active !== null && active[1] + active[2] === found) active[2] += 1;
      else {
        active = [bodyOffset + offset, found, 1];
        runs.push(active);
      }
      cursor = found + 1;
    }
    previousEnd = Math.max(previousEnd, cursor);
    chunks.push(text);
    bodyOffset += text.length;
  }
  function walk(node: Nodes): void {
    if (node.type === 'yaml' || node.type === 'html' || node.type === 'definition') return;
    if (node.type === 'text') value(node.value, node, 0);
    else if (node.type === 'inlineCode') {
      const start = node.position?.start.offset ?? 0;
      const ticks = /^`+/.exec(source.slice(start))?.[0].length ?? 0;
      value(node.value, node, ticks);
    } else if (node.type === 'code') {
      const start = node.position?.start.offset ?? 0;
      const firstLine = source.slice(
        start,
        source.indexOf('\n', start) < 0 ? source.length : source.indexOf('\n', start),
      );
      const fenced = /^ {0,3}(?:`{3,}|~{3,})/.test(firstLine);
      value(node.value, node, fenced ? firstLine.length + 1 : 0);
      separator();
    } else if (node.type === 'image' || node.type === 'imageReference') {
      if (node.alt) value(node.alt, node, 2);
    } else if (node.type === 'break' || node.type === 'thematicBreak') separator();
    else if ('children' in node) {
      for (const child of node.children) walk(child);
      if (
        [
          'paragraph',
          'heading',
          'listItem',
          'tableCell',
          'blockquote',
          'footnoteDefinition',
        ].includes(node.type)
      )
        separator();
    }
  }
  walk(tree);
  return { text: chunks.join(''), runs, lineCount: lineStartsOf(source).length };
}
