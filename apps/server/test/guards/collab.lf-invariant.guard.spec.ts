/** The server content paths never introduce carriage-return literals (M1, HP-4). */
import { parseSync, Visitor } from 'oxc-parser';
import { describe, expect, it } from 'vitest';

import { isTestPath, locate, sourceOf, sourcesUnder, type Source } from './source-scan.ts';

const SOURCES = sourcesUnder([
  'apps/server/src/notes',
  'apps/server/src/transfer',
  'apps/server/src/collab',
]).filter((source) => !isTestPath(source.path));

/** Parse decoded literal values; regex quotes and nested templates must not hide a producer. */
function carriageReturnLiterals(source: Source): string[] {
  const parsed = parseSync(source.path, source.raw);
  if (parsed.errors.length > 0) {
    return parsed.errors.map(
      (error) => `${source.path}: source guard parse failed: ${error.message}`,
    );
  }
  const findings: string[] = [];
  new Visitor({
    Literal(node) {
      if (typeof node.value === 'string' && node.value.includes('\r')) {
        findings.push(locate(source, node.start));
      }
    },
    TemplateElement(node) {
      // Cooked values normalize physical CRLF source line endings to LF, as JavaScript does.
      if (node.value.cooked?.includes('\r')) findings.push(locate(source, node.start));
    },
  }).visit(parsed.program);
  return findings;
}

describe('collab.lf-invariant.guard [hp:HP-4]', () => {
  it('scans the live initialization, repair and persistence paths', () => {
    const paths = SOURCES.map((source) => source.path);
    expect(paths).toContain('apps/server/src/notes/service.ts');
    expect(paths).toContain('apps/server/src/notes/repair.ts');
    expect(paths).toContain('apps/server/src/collab/persistence/initial-state.ts');
    expect(paths).toContain('apps/server/src/collab/persistence/compactor.ts');
  });

  it('contains no carriage-return producer in the server content paths', () => {
    expect(
      SOURCES.flatMap(carriageReturnLiterals),
      'Normalize source through @iridium/markdown before initialization; server content paths ' +
        'must never construct carriage returns. Hostile input is checked by the CRDT scan.',
    ).toEqual([]);
  });

  it.each([
    String.raw`text.insert(0, '\r');`,
    String.raw`text.insert(0, "\r\n");`,
    String.raw`const newline = '\x0d';`,
    String.raw`const newline = '\u000D';`,
    String.raw`const newline = '\u{000d}';`,
    'text.insert(0, `line\\rbreak`);',
    String.raw`const apostrophe = /'/; text.insert(0, '\r');`,
    'text.insert(0, `outer ${`inner ${"\\r"}`}`);',
  ])('refuses a carriage-return producer: %s', (code) => {
    const source = sourceOf('apps/server/src/notes/invalid.ts', code);
    expect(carriageReturnLiterals(source)).toHaveLength(1);
  });

  it('accepts physical CRLF line endings in a multiline template because JavaScript cooks them to LF', () => {
    const source = sourceOf('apps/server/src/notes/valid.ts', 'const text = `line\r\nnext`;');
    expect(carriageReturnLiterals(source)).toEqual([]);
  });

  it('fails closed on syntax it cannot parse', () => {
    const source = sourceOf('apps/server/src/notes/broken.ts', 'const text = "unterminated');
    expect(carriageReturnLiterals(source)[0]).toContain('source guard parse failed');
  });

  it('ignores comments, escaped prose and ordinary LF text', () => {
    const source = sourceOf(
      'apps/server/src/notes/valid.ts',
      [
        String.raw`// Reject '\r' before initializing the note.`,
        String.raw`/* A CR is spelled '\r'. */`,
        String.raw`const explanation = '\\r is rejected';`,
        String.raw`text.insert(0, 'line\nnext');`,
        'const normalized = normalizeSource(input.markdown);',
      ].join('\n'),
    );
    expect(carriageReturnLiterals(source)).toEqual([]);
  });
});
