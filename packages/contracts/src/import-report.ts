/** Closed import and Obsidian vocabularies (08 §6.3 and §7.9, A45). */
import { z } from 'zod';

import type { EnumOf } from './schema.ts';

/** Findings emitted by the masked per-revision detector, including vault-level import findings. */
export const OBSIDIAN_CODES = [
  'wikilink',
  'embed',
  'block_id',
  'block_ref',
  'callout',
  'tag',
  'tag_invalid',
  'highlight',
  'comment',
  'inline_footnote',
  'math_inline',
  'math_block',
  'mermaid',
  'dataview',
  'dataviewjs',
  'query_block',
  'image_size_syntax',
  'non_gfm_task_state',
  'soft_break_reliance',
  'deprecated_frontmatter_key',
  'frontmatter_link_unquoted',
  'strict_line_breaks_off',
  'canvas',
  'bases',
  'obsidian_config',
  'obsidian_trash',
] as const;

/** One detector finding code; intentionally more precise than the report vocabulary. */
export type ObsidianCode = (typeof OBSIDIAN_CODES)[number];

/** Boundary validator for a detector finding code. */
export const ObsidianCode: EnumOf<typeof OBSIDIAN_CODES> = z.enum(OBSIDIAN_CODES);

/** Stable codes exposed by the import report; codes without a row stay in detector counts. */
export const IMPORT_REPORT_CODES = [
  'filename_collision',
  'unsafe_path',
  'invalid_utf8',
  'broken_link',
  'ambiguous_wikilink',
  'unsupported_file',
  'obsidian_config_skipped',
  'obsidian_trash_skipped',
  'canvas',
  'bases',
  'embed',
  'block_ref',
  'callout',
  'math',
  'mermaid',
  'dataview',
  'dataviewjs',
  'query_block',
  'non_gfm_task_state',
  'image_size_syntax',
  'inline_footnote',
  'tag_invalid',
  'deprecated_frontmatter_key',
  'soft_break_reliance',
  'bom_stripped',
  'crlf_normalized',
  'too_large',
  'too_complex',
] as const;

/** One externally visible import report code. */
export type ImportReportCode = (typeof IMPORT_REPORT_CODES)[number];

/** Boundary validator for a report code. */
export const ImportReportCode: EnumOf<typeof IMPORT_REPORT_CODES> = z.enum(IMPORT_REPORT_CODES);
