/**
 * `collab.no-reinit.guard` (10-testing-and-quality.md, "Guard tests"; principle 4; 05, "Document
 * model" and "The repair CLI"; 03-data-model.md §8.8).
 *
 * The writers of note content are a closed list: `NoteService.initialize` (through the CRDT
 * package's `initialNoteState`), the revision-restore path, the content-repair path, and tests.
 * Everything else reads. So the three spellings that write into the note body — `getText('content')`
 * itself, `getContent(...).insert(` and `insertChunked(` — may appear only in the allowlist below.
 * This is the guard against the "rebuild the doc from Markdown" bug class: a projection, an import
 * fix-up or a route that writes Markdown back into the document would show up here first.
 *
 * The last case proves the matcher refuses each shape.
 */
import { describe, expect, it } from 'vitest';

import { isTestPath, locate, sourceOf, sourcesUnder, type Source } from './source-scan.ts';

const SCANNED_DIRS: readonly string[] = ['apps', 'packages', 'tooling'];

/** The one module that names the note body by key. */
const BODY_ACCESSOR_OWNER = 'packages/crdt/src/doc.ts';

/** The writers of note content (10, the guard table), by path prefix. */
const ALLOWED_WRITERS: readonly string[] = [
  'packages/crdt/src/initial-state.ts', // NoteService.initialize's one Markdown → Y.Doc path
  'packages/crdt/src/insert-chunked.ts', // the chunker every allowed writer inserts through
  'apps/server/src/collab/gateway.ts', // fenced ServerEdit chunk insertion used by repair; never nested
  'apps/server/src/revisions/', // the revision-restore path (M2)
];

interface Finding {
  readonly kind: 'body-accessor' | 'content-write';
  readonly where: string;
}

/** Every write into the note body and every direct naming of it, in one source. */
function findings(source: Source): Finding[] {
  const found: Finding[] = [];
  for (const match of source.noComments.matchAll(
    /getText\s*\(\s*(?:'content'|"content"|CONTENT_KEY)\s*\)/g,
  )) {
    found.push({ kind: 'body-accessor', where: locate(source, match.index) });
  }
  // `getContent(doc).insert(` — possibly across a line break — and `insertChunked(`.
  for (const match of source.code.matchAll(/getContent\s*\([^()]*\)\s*\.\s*insert\s*\(/g)) {
    found.push({ kind: 'content-write', where: locate(source, match.index) });
  }
  for (const match of source.code.matchAll(/(?<![.\w$])insertChunked\s*\(/g)) {
    found.push({ kind: 'content-write', where: locate(source, match.index) });
  }
  return found;
}

function allowed(source: Source, finding: Finding): boolean {
  if (isTestPath(source.path)) return true;
  if (finding.kind === 'body-accessor') return source.path === BODY_ACCESSOR_OWNER;
  return ALLOWED_WRITERS.some((prefix) => source.path.startsWith(prefix));
}

const SOURCES = sourcesUnder(SCANNED_DIRS);

describe('collab.no-reinit.guard [area:collab]', () => {
  it('finds the allowed writers, so the scan is not vacuous', () => {
    const writers = SOURCES.flatMap((source) =>
      findings(source)
        .filter((finding) => finding.kind === 'content-write' && allowed(source, finding))
        .map(() => source.path),
    );
    expect(writers).toContain('packages/crdt/src/initial-state.ts');
    expect(writers).toContain('apps/server/src/collab/gateway.ts');
    const accessors = SOURCES.flatMap((source) =>
      findings(source)
        .filter((finding) => finding.kind === 'body-accessor')
        .map(() => source.path),
    );
    expect(accessors).toContain(BODY_ACCESSOR_OWNER);
  });

  it('finds no content write and no body accessor outside the allowlist', () => {
    const offenders = SOURCES.flatMap((source) =>
      findings(source)
        .filter((finding) => !allowed(source, finding))
        .map((finding) => `${finding.kind} ${finding.where}`),
    );
    expect(
      offenders,
      'Note content is written by NoteService.initialize, the revision restore and the content ' +
        'repair, and by nothing else (principle 4). Remedy: route the change through one of those ' +
        'paths, or read the committed projection instead of writing the document.',
    ).toEqual([]);
  });

  it('refuses each of the three shapes it exists to catch', () => {
    const forbidden = sourceOf(
      'apps/server/src/projection/rebuild.ts',
      [
        "import { getContent, insertChunked } from '@iridium/crdt';",
        'export function rebuild(doc: unknown, markdown: string) {',
        "  doc.getText('content').delete(0, 1);",
        '  getContent(doc).insert(0, markdown);',
        '  getContent(doc)',
        '    .insert(1, markdown);',
        '  insertChunked(getContent(doc), 0, markdown, null);',
        "  const prose = 'getContent(doc).insert(';",
        '  return prose;',
        '}',
      ].join('\n'),
    );
    const found = findings(forbidden);
    expect(found.map((finding) => finding.kind)).toEqual([
      'body-accessor',
      'content-write',
      'content-write',
      'content-write',
    ]);
    expect(found.every((finding) => !allowed(forbidden, finding))).toBe(true);
    // A read of the body is not a write.
    const clean = sourceOf(
      'apps/server/src/projection/read.ts',
      [
        "import { getContent, projectMarkdown } from '@iridium/crdt';",
        'export const text = (doc: unknown) => getContent(doc).toString() + projectMarkdown(doc);',
        '// getContent(doc).insert( appears in this comment only',
      ].join('\n'),
    );
    expect(findings(clean)).toEqual([]);
  });
});
