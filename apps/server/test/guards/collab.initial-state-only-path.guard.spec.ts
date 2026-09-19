/**
 * `collab.initial-state-only-path.guard` (10-testing-and-quality.md, "Guard tests"; principle 4 of
 * the repository guide; 05-collaboration-and-durability.md, "Document model"; A14).
 *
 * The Yjs state is authoritative and is never rebuilt from Markdown: a note's document is
 * constructed once, on the initial-state path, and loaded from its persisted binary afterwards. So
 * `new Y.Doc(` — under whatever binding `yjs`'s `Doc` was imported — may appear only in
 * `packages/crdt/src/**` (the one package that imports yjs, where `createNoteDoc` lives), in the
 * server's initial-state module, in test files and in `@iridium/testkit`. Anywhere else it is a
 * second document construction site, which is exactly the "rebuild the doc from Markdown" bug class.
 *
 * The scan masks comments and strings, because this file and `packages/crdt/src/doc.ts` both write
 * the construct in prose. The last case proves the matcher refuses the shape it exists to catch.
 */
import { describe, expect, it } from 'vitest';

import {
  escapeForRegExp,
  isTestPath,
  locate,
  sourceOf,
  sourcesUnder,
  type Source,
} from './source-scan.ts';

/** Every first-party source tree. */
const SCANNED_DIRS: readonly string[] = ['apps', 'packages', 'tooling'];

/** Where a document may be constructed (10, the guard table). */
const ALLOWED_PATHS: readonly string[] = [
  'packages/crdt/src/',
  'apps/server/src/collab/persistence/initial-state.ts',
  'packages/testkit/src/',
];

/** The local names `yjs`'s `Doc` is bound to in one file: `Y.Doc`, `Doc`, or an alias. */
function docBindings(noComments: string): string[] {
  const bindings: string[] = [];
  const clauses = /import\s+([^;]*?)\s+from\s*['"`]yjs['"`]/g;
  for (const match of noComments.matchAll(clauses)) {
    const clause = match[1] ?? '';
    const namespace = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(clause);
    if (namespace !== null) bindings.push(`${namespace[1] ?? 'Y'}.Doc`);
    const named = /\{[^}]*\bDoc\b(?:\s+as\s+([A-Za-z_$][\w$]*))?[^}]*\}/s.exec(clause);
    if (named !== null) bindings.push(named[1] ?? 'Doc');
  }
  return bindings;
}

/** Every `new <Doc binding>(` in one source, as `file:line: text`. */
function constructionSites(source: Source): string[] {
  const hits: string[] = [];
  for (const binding of docBindings(source.noComments)) {
    const pattern = new RegExp(`new\\s+${escapeForRegExp(binding)}\\s*\\(`, 'g');
    for (const match of source.code.matchAll(pattern)) hits.push(locate(source, match.index));
  }
  return hits;
}

function allowed(path: string): boolean {
  return isTestPath(path) || ALLOWED_PATHS.some((prefix) => path.startsWith(prefix));
}

const SOURCES = sourcesUnder(SCANNED_DIRS);

describe('collab.initial-state-only-path.guard [area:collab]', () => {
  it('scans the first-party trees, and finds the one construction site the CRDT package owns', () => {
    expect(SOURCES.length).toBeGreaterThan(0);
    const inCrdt = SOURCES.filter((source) => source.path.startsWith('packages/crdt/src/')).flatMap(
      (source) => constructionSites(source),
    );
    expect(inCrdt.length, 'createNoteDoc constructs the document').toBeGreaterThanOrEqual(1);
  });

  it('finds no `new Y.Doc(` outside the allowed paths', () => {
    const offenders = SOURCES.filter((source) => !allowed(source.path)).flatMap((source) =>
      constructionSites(source),
    );
    expect(
      offenders,
      'A note document is constructed once, by `createNoteDoc` on the initial-state path, and ' +
        'loaded from its persisted binary afterwards (principle 4). Remedy: load the document, or ' +
        'use `createNoteDoc` from @iridium/crdt inside an allowed module.',
    ).toEqual([]);
  });

  it('refuses the shape it exists to catch, under every import spelling', () => {
    const forbidden = sourceOf(
      'apps/server/src/notes/rebuild.ts',
      [
        "import * as Y from 'yjs';",
        "import { Doc as YDoc } from 'yjs';",
        'export function rebuild(markdown: string) {',
        '  const a = new Y.Doc({ gc: true });',
        '  const b = new YDoc();',
        '  return [a, b, markdown];',
        '}',
      ].join('\n'),
    );
    expect(constructionSites(forbidden)).toEqual([
      'apps/server/src/notes/rebuild.ts:4: const a = new Y.Doc({ gc: true });',
      'apps/server/src/notes/rebuild.ts:5: const b = new YDoc();',
    ]);
    expect(allowed(forbidden.path)).toBe(false);
    // Prose and a `createNoteDoc` call are not construction sites.
    const clean = sourceOf(
      'apps/server/src/notes/load.ts',
      [
        "import { createNoteDoc } from '@iridium/crdt';",
        '// never `new Y.Doc(` here',
        "const note = 'new Y.Doc(';",
        'export const doc = createNoteDoc({ gc: true });',
      ].join('\n'),
    );
    expect(constructionSites(clean)).toEqual([]);
  });
});
