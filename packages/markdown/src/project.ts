import { MARKDOWN_LIMITS as LIMITS } from '@iridium/contracts/markdown-limits';
/** Source-derived projection data; transactions, hashing and worker timing belong to the host. */
import type { Nodes } from 'mdast';

import { toBodyText } from './body-text.ts';
import { EMPTY_VAULT_INDEX, noteContextWithHeadings } from './context.ts';
import { frontmatterIndex } from './frontmatter.ts';
import { collectLinks } from './links/collect.ts';
import { emptyObsidianCounts } from './obsidian/catalogue.ts';
import { detectObsidianSyntax } from './obsidian/detect.ts';
import { collectHeadings, headingTitleOf } from './outline.ts';
import type { NoteProjection, ParsedNote, ProjectOptions } from './types.ts';
import { PIPELINE_VERSION } from './version.ts';

/** A parse cannot be paired with a different revision's text. */
export class ProjectionSourceMismatchError extends Error {
  constructor() {
    super(
      'project.ts: parsed source differs from projection source; parse the same committed revision before projecting.',
    );
    this.name = 'ProjectionSourceMismatchError';
  }
}

/** Expected failure output retains source statistics and hash; the writer stores NULL derived fields. */
export function emptyProjection(
  source: string,
  contentHash: string,
  status: Exclude<NoteProjection['status'], 'ok'>,
): NoteProjection {
  let lineCount = 1;
  for (const char of source) if (char === '\n') lineCount += 1;
  return {
    status,
    pipelineVersion: PIPELINE_VERSION,
    contentHash,
    sizeChars: source.length,
    lineCount,
    wordCount: 0,
    headingTitle: null,
    frontmatter: null,
    fmTags: [],
    fmAliases: [],
    headings: [],
    tasks: [],
    codeLangs: [],
    bodyText: '',
    bodyRuns: [],
    links: [],
    obsidian: { counts: emptyObsidianCounts(), findings: [], truncated: false },
    timings: { prescanMs: 0, parseMs: 0, projectMs: 0 },
  };
}

/** Derives all per-revision fields without mutating source, AST or supplied index. */
export function project(parsed: ParsedNote, text: string, options: ProjectOptions): NoteProjection {
  if (parsed.source !== text) throw new ProjectionSourceMismatchError();
  if (parsed.prescan.status !== 'ok')
    return emptyProjection(text, options.contentHash, parsed.prescan.status);
  const headings = collectHeadings(parsed.mdast);
  const body = toBodyText(parsed.mdast, text);
  const metadata = frontmatterIndex(parsed.frontmatter);
  const note = noteContextWithHeadings(options.note, headings);
  const index = options.index ?? EMPTY_VAULT_INDEX;
  const links = collectLinks(parsed.mdast, text, note, index);
  if (links.length > LIMITS.MARKDOWN_LINKS_MAX)
    return emptyProjection(text, options.contentHash, 'too_complex');
  const tasks: NoteProjection['tasks'] = [];
  const codeLangs: string[] = [];
  function walk(node: Nodes): void {
    if (node.type === 'listItem' && typeof node.checked === 'boolean') {
      const start = node.position?.start.offset ?? 0;
      const offset = text.indexOf('[', start);
      tasks.push({ line: node.position?.start.line ?? 1, offset, checked: node.checked });
    }
    if (node.type === 'code' && node.lang) {
      const language = node.lang.toLowerCase().slice(0, LIMITS.CODE_LANGUAGE_MAX_CHARS);
      if (!codeLangs.includes(language) && codeLangs.length < LIMITS.CODE_LANGUAGES_MAX)
        codeLangs.push(language);
    }
    if ('children' in node) for (const child of node.children) walk(child);
  }
  walk(parsed.mdast);
  return {
    status: 'ok',
    pipelineVersion: PIPELINE_VERSION,
    contentHash: options.contentHash,
    sizeChars: text.length,
    lineCount: body.lineCount,
    wordCount: (body.text.match(/[\p{L}\p{N}\p{M}_’']+/gu) ?? []).length,
    headingTitle: headingTitleOf(headings),
    frontmatter:
      parsed.frontmatter === null
        ? null
        : {
            raw: parsed.frontmatter.raw,
            data: parsed.frontmatter.data,
            error:
              parsed.frontmatter.data === null
                ? parsed.frontmatter.diagnostics.map((item) => item.message).join('; ')
                : null,
          },
    fmTags: metadata.tags,
    fmAliases: metadata.aliases,
    headings,
    tasks,
    codeLangs,
    bodyText: body.text,
    bodyRuns: body.runs,
    links,
    obsidian: detectObsidianSyntax(text, parsed.mdast, { note, index }),
    timings: { prescanMs: 0, parseMs: 0, projectMs: 0 },
  };
}
