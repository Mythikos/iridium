import type { ObsidianCode } from '@iridium/contracts/import-report';
import { MARKDOWN_LIMITS as LIMITS } from '@iridium/contracts/markdown-limits';
/** A masked source scan catches reference-definition collisions without inspecting code as prose. */
import type { Nodes, Root } from 'mdast';

import { lineOf, lineStartsOf } from '../body-text.ts';
import { resolveLink } from '../links/resolve.ts';
import { truncateChars } from '../truncate.ts';
import type { DetectContext, ObsidianFinding, ObsidianFindings } from '../types.ts';
import { OBSIDIAN_CATALOGUE, emptyObsidianCounts } from './catalogue.ts';
import { parseWikilinkTarget } from './wikilink.ts';

/** Source ranges that are syntax/data rather than prose, plus escaped punctuation. */
export function detectionMask(text: string, tree: Root): Uint8Array {
  const mask = new Uint8Array(text.length);
  function walk(node: Nodes): void {
    const start = node.position?.start.offset ?? 0;
    const end = node.position?.end.offset ?? start;
    if (['code', 'inlineCode', 'yaml', 'html', 'definition'].includes(node.type)) {
      mask.fill(1, start, end);
      return;
    }
    if (node.type === 'link' || node.type === 'image') {
      const source = text.slice(start, end);
      const destination = source.lastIndexOf('](');
      if (destination >= 0) mask.fill(1, start + destination + 2, end);
      else if (source.startsWith('<')) mask.fill(1, start, end);
    }
    if ('children' in node) for (const child of node.children) walk(child);
  }
  walk(tree);
  for (let offset = 0; offset < text.length; offset += 1) {
    if (text[offset] === '\\') {
      mask[offset + 1] = 1;
      offset += 1;
    }
  }
  return mask;
}

/** A source-only wikilink occurrence, also consumed by the link index without sample truncation. */
export interface WikiOccurrence {
  offset: number;
  endOffset: number;
  raw: string;
  target: string;
  embed: boolean;
  block: boolean;
  alias: string | null;
}

/** Returns every unmasked wikilink with bounded matching work per opening bracket. */
export function collectWikiOccurrences(text: string, tree: Root): WikiOccurrence[] {
  const mask = detectionMask(text, tree);
  const result: WikiOccurrence[] = [];
  for (let offset = 0; offset < text.length; offset += 1) {
    if (mask[offset]) continue;
    const embed = text.startsWith('![[', offset);
    if (!embed && !text.startsWith('[[', offset)) continue;
    const length = embed ? 3 : 2;
    const candidate = text.slice(offset, offset + LIMITS.LINK_TARGET_MAX_CHARS + length + 2);
    const closing = candidate.indexOf(']]', length);
    if (closing < 0 || candidate.slice(0, closing).includes('\n')) continue;
    const endOffset = offset + closing + 2;
    let masked = false;
    for (let index = offset; index < endOffset; index += 1)
      if (mask[index]) {
        masked = true;
        break;
      }
    if (masked) continue;
    const raw = text.slice(offset, endOffset);
    const parsed = parseWikilinkTarget(raw);
    if (parsed !== null) result.push({ offset, endOffset, raw, ...parsed });
    offset = endOffset - 1;
  }
  return result;
}

/** Counts all catalogue occurrences while retaining only bounded, document-order samples. */
export function detectObsidianSyntax(
  text: string,
  tree: Root,
  context: DetectContext = {},
): ObsidianFindings {
  const counts = emptyObsidianCounts();
  const candidates: ObsidianFinding[] = [];
  const mask = detectionMask(text, tree);
  const starts = lineStartsOf(text);
  const retained = emptyObsidianCounts();
  let truncated = false;
  function emit(
    code: ObsidianCode,
    offset: number,
    endOffset: number,
    detail?: ObsidianFinding['detail'],
  ): void {
    counts[code] += 1;
    if (retained[code] >= LIMITS.OBSIDIAN_FINDINGS_PER_CODE_MAX) {
      truncated = true;
      return;
    }
    retained[code] += 1;
    candidates.push({
      code,
      severity: OBSIDIAN_CATALOGUE[code].severity,
      line: lineOf(starts, offset),
      offset,
      endOffset,
      text: truncateChars(text.slice(offset, endOffset), LIMITS.OBSIDIAN_FINDING_MAX_CHARS),
      ...(detail === undefined ? {} : { detail }),
    });
  }
  for (const wiki of collectWikiOccurrences(text, tree)) {
    let detail: ObsidianFinding['detail'] = { target: wiki.target };
    if (context.note !== undefined && context.index !== undefined) {
      const resolved = resolveLink(wiki.target, context.note, context.index, { wikilink: true });
      detail = {
        ...detail,
        resolution: resolved.kind,
        ...(resolved.kind === 'ambiguous' ? { candidates: resolved.candidates } : {}),
      };
    }
    emit(wiki.embed ? 'embed' : 'wikilink', wiki.offset, wiki.endOffset, detail);
    if (wiki.block) emit('block_ref', wiki.offset, wiki.endOffset);
    if (wiki.embed && wiki.alias !== null && /^\d+(?:x\d+)?$/.test(wiki.alias))
      emit('image_size_syntax', wiki.offset, wiki.endOffset);
    mask.fill(1, wiki.offset, wiki.endOffset);
  }
  for (let offset = 0; offset < text.length; offset += 1) {
    if (mask[offset]) continue;
    const char = text[offset];
    const before = text[offset - 1] ?? '\n';
    const fragment = text.slice(offset, offset + LIMITS.LINK_TARGET_MAX_CHARS);
    let match: RegExpExecArray | null = null;
    if (char === '#' && /[\s([{]/u.test(before)) {
      match = /^#([\p{L}\p{N}\p{M}_\-/]+)(?=$|[\s.,;:!?)}\]])/u.exec(fragment);
      if (match !== null) {
        const tag = match[1] ?? '';
        emit(/^[\d/]+$/.test(tag) ? 'tag_invalid' : 'tag', offset, offset + match[0].length, {
          tag,
        });
      }
    } else if (char === '^' && fragment.startsWith('^[') && before !== '[') {
      match = /^\^\[[^\]\n]+\]/.exec(fragment);
      if (match !== null) emit('inline_footnote', offset, offset + match[0].length);
    } else if (char === '^' && /\s/u.test(before)) {
      match = /^\^[A-Za-z0-9-]{1,64}(?=\s*(?:\n|$))/.exec(fragment);
      if (match !== null) emit('block_id', offset, offset + match[0].length);
    } else if (fragment.startsWith('==')) {
      match = /^==(?=\S)(?:[^=\n]|=(?!=))+==/.exec(fragment);
      if (match !== null) emit('highlight', offset, offset + match[0].length);
    } else if (fragment.startsWith('%%')) {
      const close = text.indexOf('%%', offset + 2);
      if (close >= 0) {
        emit('comment', offset, close + 2);
        offset = close + 1;
        continue;
      }
    } else if (char === '$' && fragment.startsWith('$$')) {
      const close = text.indexOf('$$', offset + 2);
      if (close >= 0) {
        emit('math_block', offset, close + 2);
        offset = close + 1;
        continue;
      }
    } else if (char === '$') {
      match = /^\$(?=\S)[^$\n]+\$/.exec(fragment);
      if (match !== null) emit('math_inline', offset, offset + match[0].length);
    }
    if (match !== null) offset += match[0].length - 1;
  }
  let shortLinesReported = false;
  function structural(node: Nodes): void {
    const start = node.position?.start.offset ?? 0;
    const end = node.position?.end.offset ?? start;
    const raw = text.slice(start, end);
    if (node.type === 'code') {
      const language = node.lang?.toLowerCase();
      if (language === 'mermaid' || language === 'dataview' || language === 'dataviewjs')
        emit(language, start, end);
      if (language === 'query') emit('query_block', start, end);
    } else if (node.type === 'inlineCode') {
      if (node.value.startsWith('= ')) emit('dataview', start, end);
      if (node.value.startsWith('$= ')) emit('dataviewjs', start, end);
    } else if (node.type === 'image' && /\|\d+(?:x\d+)?$/.test(node.alt ?? '')) {
      emit('image_size_syntax', start, end);
    } else if (
      node.type === 'listItem' &&
      node.checked == null &&
      /^(?:[-+*]|\d+[.)])\s+\[[^ xX\]]\]/.test(raw)
    ) {
      emit('non_gfm_task_state', start, end);
    } else if (node.type === 'blockquote' && node.children[0]?.type === 'paragraph') {
      const callout = /^(?: {0,3}>\s*)+\[!([\w-]+)\][+-]?[^\n]*/i.exec(raw);
      if (callout !== null)
        emit('callout', start, start + callout[0].length, {
          type: (callout[1] ?? '').toLowerCase(),
        });
    } else if (node.type === 'paragraph' && !shortLinesReported) {
      let consecutive = 0;
      for (const line of raw.split('\n')) {
        consecutive = line.trim() !== '' && line.length < 60 ? consecutive + 1 : 0;
        if (consecutive >= 3) {
          emit('soft_break_reliance', start, end);
          shortLinesReported = true;
          break;
        }
      }
    } else if (node.type === 'yaml') {
      let cursor = start;
      for (const line of raw.split('\n')) {
        if (/^(tag|alias|cssclass):/.test(line))
          emit('deprecated_frontmatter_key', cursor, cursor + line.length);
        if (/^[^:#]+:\s*\[\[/.test(line))
          emit('frontmatter_link_unquoted', cursor, cursor + line.length, {
            reason: 'unquoted_link',
          });
        cursor += line.length + 1;
      }
    }
    if ('children' in node) for (const child of node.children) structural(child);
  }
  structural(tree);
  const configFolder = context.configFolder ?? '.obsidian';
  const files = context.files ?? [];
  if (
    files.some((file) => file.startsWith(`${configFolder}/`)) &&
    context.strictLineBreaks !== true
  )
    emit('strict_line_breaks_off', 0, 0);
  for (const path of files) {
    if (path.startsWith(`${configFolder}/`)) emit('obsidian_config', 0, 0, { path });
    else if (path.startsWith('.trash/')) emit('obsidian_trash', 0, 0, { path });
    else if (/\.canvas$/i.test(path)) emit('canvas', 0, 0, { path });
    else if (/\.base$/i.test(path)) emit('bases', 0, 0, { path });
  }
  const ordered = candidates.toSorted(
    (left, right) => left.offset - right.offset || left.code.localeCompare(right.code),
  );
  if (candidates.length > LIMITS.OBSIDIAN_FINDINGS_MAX) truncated = true;
  return { counts, findings: ordered.slice(0, LIMITS.OBSIDIAN_FINDINGS_MAX), truncated };
}
