/** Detector severities and the stable import vocabulary are separate contracts (08 §6.3). */
import type { ImportReportCode, ObsidianCode } from '@iridium/contracts';

/** Import presentation metadata for one detected construct. */
export interface ObsidianCatalogueEntry {
  severity: 'info' | 'warn';
  reportCode: ImportReportCode | null;
}

/** Every detector code has an explicit reporting policy, including count-only constructs. */
export const OBSIDIAN_CATALOGUE: Readonly<Record<ObsidianCode, ObsidianCatalogueEntry>> =
  Object.freeze({
    wikilink: { severity: 'info', reportCode: null },
    embed: { severity: 'warn', reportCode: 'embed' },
    block_id: { severity: 'info', reportCode: null },
    block_ref: { severity: 'warn', reportCode: 'block_ref' },
    callout: { severity: 'warn', reportCode: 'callout' },
    tag: { severity: 'info', reportCode: null },
    tag_invalid: { severity: 'info', reportCode: 'tag_invalid' },
    highlight: { severity: 'info', reportCode: null },
    comment: { severity: 'warn', reportCode: null },
    inline_footnote: { severity: 'warn', reportCode: 'inline_footnote' },
    math_inline: { severity: 'warn', reportCode: 'math' },
    math_block: { severity: 'warn', reportCode: 'math' },
    mermaid: { severity: 'warn', reportCode: 'mermaid' },
    dataview: { severity: 'warn', reportCode: 'dataview' },
    dataviewjs: { severity: 'warn', reportCode: 'dataviewjs' },
    query_block: { severity: 'warn', reportCode: 'query_block' },
    image_size_syntax: { severity: 'info', reportCode: 'image_size_syntax' },
    non_gfm_task_state: { severity: 'info', reportCode: 'non_gfm_task_state' },
    soft_break_reliance: { severity: 'info', reportCode: 'soft_break_reliance' },
    deprecated_frontmatter_key: { severity: 'info', reportCode: 'deprecated_frontmatter_key' },
    frontmatter_link_unquoted: { severity: 'warn', reportCode: 'deprecated_frontmatter_key' },
    strict_line_breaks_off: { severity: 'info', reportCode: 'soft_break_reliance' },
    canvas: { severity: 'warn', reportCode: 'canvas' },
    bases: { severity: 'warn', reportCode: 'bases' },
    obsidian_config: { severity: 'warn', reportCode: 'obsidian_config_skipped' },
    obsidian_trash: { severity: 'info', reportCode: 'obsidian_trash_skipped' },
  });

/** Fresh complete count map; a missing detector occurrence is represented by zero. */
export function emptyObsidianCounts(): Record<ObsidianCode, number> {
  return {
    wikilink: 0,
    embed: 0,
    block_id: 0,
    block_ref: 0,
    callout: 0,
    tag: 0,
    tag_invalid: 0,
    highlight: 0,
    comment: 0,
    inline_footnote: 0,
    math_inline: 0,
    math_block: 0,
    mermaid: 0,
    dataview: 0,
    dataviewjs: 0,
    query_block: 0,
    image_size_syntax: 0,
    non_gfm_task_state: 0,
    soft_break_reliance: 0,
    deprecated_frontmatter_key: 0,
    frontmatter_link_unquoted: 0,
    strict_line_breaks_off: 0,
    canvas: 0,
    bases: 0,
    obsidian_config: 0,
    obsidian_trash: 0,
  };
}
