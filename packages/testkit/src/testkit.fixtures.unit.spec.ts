import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  COMMONMARK_SPEC_PATH,
  HOSTILE_CORPUS_PATH,
  IRIDIUM_FIXTURE_VERSION,
  fixtureVaultPath,
  listFixtureFiles,
  readCommonMarkExamples,
  readFixtureBytes,
  readHostileCorpus,
  readHostileFixture,
} from './fixtures/index.ts';
import {
  FIXTURES_ROOT,
  MYSQL_CONF_FILE,
  MYSQL_INIT_ROLES_FILE,
  OPENAPI_DOCUMENT,
  REPO_ROOT,
  SERVER_APP_MODULE,
  SERVER_DIST_ENTRY,
  TESTKIT_PACKAGE_ROOT,
  requireExistingPath,
} from './paths.ts';

/** 5 MB, the cap `scripts/check-fixture-size.ts` enforces (fixture policy rule 5). */
const FIXTURE_WEIGHT_CAP_BYTES = 5 * 1024 * 1024;

describe('testkit.fixtures.unit [area:testkit]', () => {
  it('anchors every path on the package root, from src and from dist alike', () => {
    // `src/paths.ts` compiles to `dist/paths.js`, so `../` is the package root in both layouts.
    // A new directory level under either would silently move every fixture path.
    const manifest: { name?: string } = JSON.parse(
      readFileSync(join(TESTKIT_PACKAGE_ROOT, 'package.json'), 'utf8'),
    );
    expect(manifest.name).toBe('@iridium/testkit');
    expect(existsSync(join(REPO_ROOT, 'pnpm-workspace.yaml'))).toBe(true);
    expect(FIXTURES_ROOT.endsWith(join('packages', 'testkit', 'src', 'fixtures'))).toBe(true);
  });

  it('points the infrastructure paths at the artefacts infra/ owns, never at a copy', () => {
    expect(MYSQL_CONF_FILE.endsWith(join('infra', 'docker', 'mysql', 'my.cnf'))).toBe(true);
    expect(
      MYSQL_INIT_ROLES_FILE.endsWith(join('infra', 'docker', 'mysql', 'init', '01_roles.sh')),
    ).toBe(true);
    expect(SERVER_DIST_ENTRY.endsWith(join('apps', 'server', 'dist', 'main.mjs'))).toBe(true);
    expect(SERVER_APP_MODULE.endsWith(join('apps', 'server', 'src', 'app.ts'))).toBe(true);
    expect(
      OPENAPI_DOCUMENT.endsWith(join('packages', 'contracts', 'openapi', 'openapi.json')),
    ).toBe(true);
  });

  it('names the artefact and the fix when a harness input is missing', () => {
    expect(() =>
      requireExistingPath(join(REPO_ROOT, 'no', 'such', 'file'), 'the thing', 'Do the fix.'),
    ).toThrow(/the thing is missing at .*no.*such.*file\. Do the fix\./);
  });

  it('carries the 42-note demo vault with its three attachments', () => {
    const files = listFixtureFiles(fixtureVaultPath('demo'));
    const markdown = files.filter((f) => f.path.endsWith('.md'));
    expect(markdown).toHaveLength(42);
    expect(files.filter((f) => f.path.startsWith('attachments/'))).toHaveLength(3);
    // Nested four deep: Guides/Collaboration/Conflicts/Resolution.md
    expect(files.map((f) => f.path)).toContain('Guides/Collaboration/Conflicts/Resolution.md');
    expect(Math.max(...files.map((f) => f.path.split('/').length))).toBeGreaterThanOrEqual(4);
  });

  it('carries the demo vault edge cases the fixture inventory names', () => {
    const root = fixtureVaultPath('demo');
    // "one note with 10 000 lines" (fixture policy rule 5): counted as lines of text, so the file's
    // single trailing newline is a terminator rather than an eleven-thousand-and-first empty line.
    const longNote = readFixtureBytes(join(root, 'Reference', 'Long Log.md')).toString('utf8');
    expect(longNote.replace(/\n$/, '').split('\n')).toHaveLength(10_000);
    const broken = readFixtureBytes(join(root, 'Inbox', 'Broken Frontmatter.md')).toString('utf8');
    expect(broken.startsWith('---\n')).toBe(true);
    expect(broken).toContain('title: duplicated');
    expect(readFixtureBytes(join(root, 'Inbox', 'Empty.md'))).toHaveLength(0);
  });

  it('keeps the demo vault free of CR bytes, which only the Obsidian sample carries', () => {
    for (const file of listFixtureFiles(fixtureVaultPath('demo'))) {
      if (!file.path.endsWith('.md')) {
        continue;
      }
      expect({
        path: file.path,
        hasCr: readFixtureBytes(file.absolutePath).includes(0x0d),
      }).toStrictEqual({ path: file.path, hasCr: false });
    }
  });

  it('carries the Obsidian sample with .obsidian/, .trash/ and a .canvas file', () => {
    const paths = listFixtureFiles(fixtureVaultPath('obsidian-sample')).map((f) => f.path);
    expect(paths).toContain('.obsidian/app.json');
    expect(paths).toContain('.trash/Deleted Note.md');
    expect(paths).toContain('Canvas Board.canvas');
    // Two notes with the same basename in different folders: an ambiguous wikilink target.
    expect(paths.filter((p) => p.endsWith('/Duplicate.md'))).toHaveLength(2);
  });

  it('carries the CRLF, CR, mixed and BOM files byte for byte', () => {
    const root = fixtureVaultPath('obsidian-sample');
    const crlf = readFixtureBytes(join(root, 'CRLF Note.md'));
    expect(crlf.includes(Buffer.from('\r\n'))).toBe(true);
    expect(
      crlf
        .toString('utf8')
        .split('\n')
        .every((line) => line === '' || line.endsWith('\r')),
    ).toBe(true);

    const cr = readFixtureBytes(join(root, 'CR Note.md'));
    expect(cr.includes(0x0d)).toBe(true);
    expect(cr.includes(0x0a)).toBe(false);

    const mixed = readFixtureBytes(join(root, 'Mixed Endings.md')).toString('utf8');
    expect(mixed).toContain('\r\n');
    expect(mixed).toMatch(/A CR line\.\rEnd\./);

    const bom = readFixtureBytes(join(root, 'BOM Note.md'));
    expect(bom.subarray(0, 3)).toStrictEqual(Buffer.from([0xef, 0xbb, 0xbf]));

    const tabbed = readFixtureBytes(join(root, 'Tab Frontmatter.md')).toString('utf8');
    expect(tabbed).toContain('\n\t- one');
  });

  it('maps every hostile fixture to an expectation and every expectation to a file', () => {
    const corpus = readHostileCorpus();
    const onDisk = listFixtureFiles(HOSTILE_CORPUS_PATH)
      .filter((f) => f.path.endsWith('.md'))
      .map((f) => f.path)
      .toSorted();
    expect(Object.keys(corpus.files).toSorted()).toStrictEqual(onDisk);
    expect(onDisk.length).toBeGreaterThanOrEqual(11);
    expect(corpus.sinkHost).toBe('sink.invalid');
    expect(corpus.fixtureVersion).toBe(IRIDIUM_FIXTURE_VERSION);
  });

  it('gives every hostile fixture something to forbid', () => {
    const corpus = readHostileCorpus();
    const summary = Object.entries(corpus.files).map(([name, expectation]) => ({
      name,
      forbidden:
        expectation.forbiddenTags.length +
          expectation.forbiddenAttributes.length +
          expectation.forbiddenUrlSchemes.length +
          (expectation.forbiddenIds?.length ?? 0) +
          (expectation.forbiddenClassPrefixes?.length ?? 0) >
        0,
      effects: expectation.forbiddenEffects.length > 0,
      classed: expectation.class !== '',
      // The corpus is only useful if the source actually contains the vector.
      sourced: readHostileFixture(name).length > 0,
    }));
    expect(
      summary.filter((s) => !s.forbidden || !s.effects || !s.classed || !s.sourced),
    ).toStrictEqual([]);
  });

  it('keeps the positive half of the property: hostile markup inside a fence stays text', () => {
    const source = readHostileFixture('markdown-specific.md');
    const corpus = readHostileCorpus();
    for (const literal of corpus.files['markdown-specific.md']?.mustContain ?? []) {
      expect(source).toContain(literal);
    }
  });

  it('carries the 652 examples of CommonMark 0.31.2 with their provenance', () => {
    const examples = readCommonMarkExamples();
    expect(examples).toHaveLength(652);
    expect(examples[0]?.section).toBe('Tabs');
    expect(examples.at(-1)?.section).toBe('Textual content');
    expect(new Set(examples.map((e) => e.section)).size).toBe(26);
    for (const example of examples) {
      expect(typeof example.markdown).toBe('string');
      expect(typeof example.html).toBe('string');
    }
    const provenance = readFileSync(join(FIXTURES_ROOT, 'commonmark', 'PROVENANCE.md'), 'utf8');
    expect(provenance).toContain('CommonMark **0.31.2**');
    expect(provenance).toContain('CC-BY-SA 4.0');
    expect(existsSync(COMMONMARK_SPEC_PATH)).toBe(true);
  });

  it('stays under the 5 MB committed-fixture cap', () => {
    const total = listFixtureFiles(FIXTURES_ROOT)
      .filter((f) => !f.path.endsWith('.ts'))
      .reduce((sum, f) => sum + f.bytes, 0);
    expect(total).toBeLessThan(FIXTURE_WEIGHT_CAP_BYTES);
  });
});
