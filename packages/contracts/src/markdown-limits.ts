/** Browser-required slice of the single limits policy; limits.ts aggregates these exact values. */
export const MARKDOWN_LIMITS = {
  /** Hard note cap in UTF-16 units: initialize, restore, repair and import refuse with 422. */
  NOTE_HARD_MAX_UTF16: 2_097_152,

  // ---- Markdown projection (08-markdown-pipeline-import-export.md; D08-03) ----------------
  /** Pre-scan cap on the UTF-8 byte length of the source. 2 MiB. */
  MARKDOWN_SOURCE_MAX_BYTES: 2_097_152,
  /** Pre-scan blockquote nesting cap; `too_complex`. */
  MARKDOWN_BLOCKQUOTE_MAX_DEPTH: 32,
  /** Pre-scan list indent cap in columns; `too_complex`. */
  MARKDOWN_LIST_INDENT_MAX_COLS: 64,
  /** Pre-scan lines-per-paragraph cap; `too_complex`. */
  MARKDOWN_LINES_PER_PARAGRAPH_MAX: 20_000,
  /** Pre-scan cap on `[^` footnote references; `too_complex` (`detail: 'footnotes'`). */
  MARKDOWN_FOOTNOTE_REFS_MAX: 10_000,
  /** Pre-scan cap on `[` characters; `too_complex` (`detail: 'brackets'`). */
  MARKDOWN_BRACKETS_MAX: 200_000,
  /** Frontmatter tag length. */
  FM_TAG_MAX_LEN: 64,
  /** Frontmatter tags per note. */
  FM_TAGS_MAX: 200,
  /** Frontmatter alias length. */
  FM_ALIAS_MAX_LEN: 255,
  /** Frontmatter aliases per note. */
  FM_ALIASES_MAX: 100,
  /** YAML expansion budget; aliases beyond this cannot enter projections. */
  YAML_MAX_ALIAS_COUNT: 100,
  /** Persisted link target length and resolver suggestion budget (08 section 5). */
  LINK_TARGET_MAX_CHARS: 2_048,
  LINK_FRAGMENT_MAX_CHARS: 255,
  MARKDOWN_LINKS_MAX: 10_000,
  LINK_CANDIDATES_MAX: 5,
  /** Fence-language metadata bounds. */
  CODE_LANGUAGE_MAX_CHARS: 32,
  CODE_LANGUAGES_MAX: 50,
  /** Detector diagnostics remain bounded independently of source size. */
  OBSIDIAN_FINDING_MAX_CHARS: 120,
  OBSIDIAN_FINDINGS_PER_CODE_MAX: 200,
  OBSIDIAN_FINDINGS_MAX: 1_000,
  /** MySQL VARCHAR(255), truncated at a complete grapheme. */
  HEADING_TITLE_MAX_CODEPOINTS: 255,
} as const;
