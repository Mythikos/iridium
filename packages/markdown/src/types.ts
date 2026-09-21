import type { ObsidianCode } from '@iridium/contracts';
/** Plain worker-transferable pipeline contracts (08 §2.5, §3.1 and §5). */
import type { Root as HastRoot, RootContent as HastRootContent } from 'hast';
import type { Root } from 'mdast';

import type { NoteContext, ResolvedLink, VaultIndex, VaultIndexSnapshot } from './links/resolve.ts';
import type { PrescanResult } from './prescan.ts';

/** Both recorded flavors render identically through 1.0 (G2). */
export type MarkdownFlavor = 'gfm' | 'obsidian-compat';

/** No preview-only option changes the parsed note used for projection. */
export interface ParseOptions {
  flavor?: MarkdownFlavor;
}

/** A source-positioned YAML diagnostic; parser errors never remove the source. */
export interface FrontmatterDiagnostic {
  code: string;
  message: string;
  line: number;
  col: number;
}

/** Exact frontmatter interior plus derived safe JSON data and source range. */
export interface Frontmatter {
  raw: string;
  range: { start: number; end: number; endLine: number };
  data: Record<string, unknown> | null;
  diagnostics: FrontmatterDiagnostic[];
}

/** Parse result; rejected admission carries an empty tree, never a partial parse. */
export interface ParsedNote {
  mdast: Root;
  source: string;
  flavor: MarkdownFlavor;
  frontmatter: Frontmatter | null;
  prescan: PrescanResult;
  diagnostics: Array<{ code: 'frontmatter_invalid' | 'prescan'; message: string; line?: number }>;
}

/** [body offset, source offset, length]; zero-length runs locate synthetic separators. */
export type TextRun = readonly [number, number, number];

/** Search prose with its UTF-16 map back to unchanged source. */
export interface BodyTextResult {
  text: string;
  runs: TextRun[];
  lineCount: number;
}

/** The outline uses the same per-document slugger as preview ids. */
export interface Heading {
  depth: 1 | 2 | 3 | 4 | 5 | 6;
  text: string;
  slug: string;
  line: number;
  offset: number;
}

/** An indexed reference with its source position and resolution, including literal wikilinks. */
export interface RawLink {
  ordinal: number;
  kind: 'markdown' | 'image' | 'wikilink' | 'embed' | 'definition';
  rawTarget: string;
  startOffset: number;
  endOffset: number;
  line: number;
  resolved: ResolvedLink;
}

/** A bounded detector sample; counts remain complete when samples are capped. */
export interface ObsidianFinding {
  code: ObsidianCode;
  severity: 'info' | 'warn';
  line: number;
  offset: number;
  endOffset: number;
  text: string;
  detail?: Record<string, string | number | boolean | string[]>;
}

/** Complete occurrence counts and bounded document-order samples. */
export interface ObsidianFindings {
  counts: Record<ObsidianCode, number>;
  findings: ObsidianFinding[];
  truncated: boolean;
}

/** Resolution and optional vault-file context for detecting import-only constructs. */
export interface DetectContext {
  note?: NoteContext;
  index?: VaultIndex;
  files?: string[];
  configFolder?: string;
  strictLineBreaks?: boolean;
}

/** Hashing belongs to the worker boundary; projection itself is synchronous and pure. */
export interface ProjectOptions {
  contentHash: string;
  note?: NoteContext;
  index?: VaultIndex;
}

/** Derived content consumed atomically by the server's projection writer. */
export interface NoteProjection {
  /** Only host queue admission emits pending; parsing and projection never do. */
  status: 'ok' | 'pending' | 'too_large' | 'too_complex' | 'timeout' | 'error' | 'invalid_content';
  pipelineVersion: number;
  contentHash: string;
  sizeChars: number;
  lineCount: number;
  wordCount: number;
  headingTitle: string | null;
  frontmatter: { raw: string; data: Record<string, unknown> | null; error: string | null } | null;
  fmTags: string[];
  fmAliases: string[];
  headings: Heading[];
  tasks: Array<{ line: number; offset: number; checked: boolean }>;
  codeLangs: string[];
  bodyText: string;
  bodyRuns: TextRun[];
  links: RawLink[];
  obsidian: ObsidianFindings;
  timings: { prescanMs: number; parseMs: number; projectMs: number };
}

/** Self-contained worker request; the worker cannot access a database. */
export interface ProjectionTask {
  noteId: string;
  vaultId: string;
  revision: number;
  markdown: string;
  note: NoteContext;
  vault: { flavor: MarkdownFlavor; softBreaks: boolean; attachmentFolder: string };
  index: VaultIndexSnapshot;
  pipelineVersion: number;
}

/** Preview-only options never alter a projection or source string. */
export interface PreviewContext {
  note?: NoteContext;
  index?: VaultIndex;
  softBreaks?: boolean;
}

/** A sanitized root child and stable source-content identity for scroll sync and memoization. */
export interface PreviewBlock {
  key: string;
  startOffset: number;
  endOffset: number;
  hash: string;
  hast: HastRootContent;
}

/** Sanitized hast is the only renderer output; consumers cannot request an unsafe intermediate. */
export interface PreviewTree {
  hast: HastRoot;
  blocks: PreviewBlock[];
  outline: Heading[];
  diagnostics: ParsedNote['diagnostics'];
}
