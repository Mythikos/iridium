import { LIMITS } from '@iridium/contracts/limits';
import { describe, expect, it } from 'vitest';

import { parseNote, project } from './index.ts';

describe('markdown.frontmatter.unit [area:markdown] [spec:portability-and-safety]', () => {
  it('retains invalid tab indentation and leaves an unclosed thematic break as Markdown', () => {
    const source = '---\nkey:\n\tchild: value\n---\nbody';
    const parsed = parseNote(source);
    expect(parsed.frontmatter?.raw).toBe('key:\n\tchild: value\n');
    expect(parsed.frontmatter?.data).toBeNull();
    expect(parsed.frontmatter?.diagnostics.some((entry) => entry.code === 'TAB_AS_INDENT')).toBe(
      true,
    );
    const thematic = parseNote('---\n\nA paragraph');
    expect(thematic.frontmatter).toBeNull();
    expect(thematic.mdast.children[0]?.type).toBe('thematicBreak');
  });
  it('maps YAML diagnostics to the exact source line and column after the opening fence', () => {
    const parsed = parseNote('---\nvalid: first\nvalid: second\n---\nbody');
    expect(parsed.frontmatter?.diagnostics).toEqual([
      expect.objectContaining({ code: 'DUPLICATE_KEY', line: 3, col: 1 }),
    ]);
  });
  it('preserves raw spacing and core-schema strings while normalizing index metadata only', () => {
    const source =
      '---\ntags: "#DRAFT, re\u0301sume\u0301, DRAFT"\nalias: ["A", "B"]\ndate: 2026-09-20\nflag: yes\n---\nbody';
    const parsed = parseNote(source);
    const result = project(parsed, source, { contentHash: 'hash' });
    expect(parsed.frontmatter?.raw).toBe(source.slice(4, source.indexOf('---', 4)));
    expect(parsed.frontmatter?.data).toMatchObject({ date: '2026-09-20', flag: 'yes' });
    expect(result.fmTags).toEqual(['draft', 'résumé']);
    expect(result.fmAliases).toEqual(['A', 'B']);
    expect(parsed.frontmatter?.range).toEqual({
      start: 0,
      end: source.indexOf('\nbody'),
      endLine: 6,
    });
    expect(parsed.source).toBe(source);
  });
  it.each([
    'key: [unclosed',
    'key: 1\nkey: 2',
    'self: &self [*self]',
    'number: .inf',
    'a: &a [1,2]\nb: [' + '*a,'.repeat(101) + ']',
  ])('retains invalid or non-JSON YAML and remains searchable: %s', (raw) => {
    const source = `---\n${raw}\n---\n# Search survives`;
    const parsed = parseNote(source);
    expect(parsed.frontmatter?.data).toBeNull();
    expect(parsed.diagnostics[0]?.code).toBe('frontmatter_invalid');
    expect(project(parsed, source, { contentHash: 'hash' }).bodyText).toContain('Search survives');
    expect(parsed.source).toBe(source);
  });
  it('enforces tag and alias index lengths/counts and records a diagnostic', () => {
    const tags = Array.from({ length: LIMITS.FM_TAGS_MAX + 1 }, (_, index) => `tag${index}`);
    const aliases = Array.from(
      { length: LIMITS.FM_ALIASES_MAX + 1 },
      (_, index) => `alias${index}`,
    );
    const source = `---\ntags: ${JSON.stringify([...tags, 'x'.repeat(LIMITS.FM_TAG_MAX_LEN + 1)])}\naliases: ${JSON.stringify([...aliases, 'x'.repeat(LIMITS.FM_ALIAS_MAX_LEN + 1)])}\n---\nbody`;
    const parsed = parseNote(source);
    const result = project(parsed, source, { contentHash: 'hash' });
    expect(result.fmTags).toHaveLength(LIMITS.FM_TAGS_MAX);
    expect(result.fmAliases).toHaveLength(LIMITS.FM_ALIASES_MAX);
    expect(parsed.frontmatter?.diagnostics.map((entry) => entry.code)).toContain('METADATA_LIMIT');
  });
});
