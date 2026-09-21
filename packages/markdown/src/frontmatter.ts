import { MARKDOWN_LIMITS as LIMITS } from '@iridium/contracts/markdown-limits';
/** YAML is metadata only; its original interior and fences never get serialized (08 §2.5). */
import type { Root } from 'mdast';
import { parseDocument } from 'yaml';

import { lineOf, lineStartsOf } from './body-text.ts';
import type { Frontmatter, FrontmatterDiagnostic } from './types.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jsonSafe(value: unknown, ancestors: Set<object>): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || ancestors.has(value)) return false;
  ancestors.add(value);
  const safe = Object.values(value).every((item: unknown) => jsonSafe(item, ancestors));
  ancestors.delete(value);
  return safe;
}

/** Reads only the leading YAML node; duplicate keys and expansion failures become diagnostics. */
export function readFrontmatter(tree: Root, source: string): Frontmatter | null {
  const node = tree.children[0];
  if (node?.type !== 'yaml' || node.position?.start.offset !== 0) return null;
  const end = node.position.end.offset ?? 0;
  const whole = source.slice(0, end);
  const openingEnd = whole.indexOf('\n');
  const closingStart = whole.lastIndexOf('\n');
  const raw =
    openingEnd < 0 || closingStart <= openingEnd
      ? ''
      : whole.slice(openingEnd + 1, closingStart + 1);
  const parsed = parseDocument(raw, { uniqueKeys: true, schema: 'core', prettyErrors: false });
  const starts = lineStartsOf(raw);
  const diagnostics: FrontmatterDiagnostic[] = [...parsed.errors, ...parsed.warnings].map(
    (error) => {
      const offset = error.pos[0];
      const line = lineOf(starts, offset);
      return {
        code: error.code,
        message: error.message,
        line: line + 1,
        col: offset - (starts[line - 1] ?? 0) + 1,
      };
    },
  );
  let data: Record<string, unknown> | null = null;
  if (parsed.errors.length === 0) {
    try {
      const value: unknown = parsed.toJS({ maxAliasCount: LIMITS.YAML_MAX_ALIAS_COUNT });
      if (value !== null && (!isRecord(value) || !jsonSafe(value, new Set()))) {
        diagnostics.push({
          code: 'INVALID_DATA',
          message: 'Frontmatter must be a finite JSON mapping without cyclic aliases.',
          line: 2,
          col: 1,
        });
      } else data = isRecord(value) ? value : {};
    } catch (error) {
      diagnostics.push({
        code: 'ALIAS_LIMIT',
        message: error instanceof Error ? error.message : 'YAML alias expansion was refused.',
        line: 2,
        col: 1,
      });
    }
  }
  return { raw, range: { start: 0, end, endLine: node.position.end.line }, data, diagnostics };
}

/** Index-only normalization; diagnostics describe dropped metadata without editing the note. */
export function frontmatterIndex(frontmatter: Frontmatter | null): {
  tags: string[];
  aliases: string[];
  diagnostics: FrontmatterDiagnostic[];
} {
  const diagnostics: FrontmatterDiagnostic[] = [];
  function values(
    names: readonly string[],
    maxLength: number,
    maxCount: number,
    tags: boolean,
  ): string[] {
    const normalized: string[] = [];
    for (const name of names) {
      const value = frontmatter?.data?.[name];
      const entries =
        typeof value === 'string' ? value.split(',') : Array.isArray(value) ? value : [];
      for (const entry of entries) {
        if (typeof entry !== 'string') continue;
        const trimmed = entry.trim().normalize('NFC');
        const item = tags ? trimmed.replace(/^#+/, '').toLowerCase() : trimmed;
        if (item === '' || normalized.includes(item)) continue;
        if (Array.from(item).length > maxLength || normalized.length >= maxCount) {
          diagnostics.push({
            code: 'METADATA_LIMIT',
            message: `${name} entry exceeds the index length or count limit.`,
            line: 2,
            col: 1,
          });
        } else normalized.push(item);
      }
    }
    return normalized;
  }
  return {
    tags: values(['tags', 'tag'], LIMITS.FM_TAG_MAX_LEN, LIMITS.FM_TAGS_MAX, true),
    aliases: values(['aliases', 'alias'], LIMITS.FM_ALIAS_MAX_LEN, LIMITS.FM_ALIASES_MAX, false),
    diagnostics,
  };
}
