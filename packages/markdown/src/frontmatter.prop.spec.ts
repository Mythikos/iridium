// oxlint-disable vitest/no-standalone-expect -- it.prop(...)(name, fn) is the fast-check test block form.
import { it } from '@fast-check/vitest';
import * as fc from 'fast-check';
import { describe, expect } from 'vitest';

import { WORD } from '../test/generated-documents.ts';
import { PROP } from '../test/prop-budget.ts';
import { parseNote, project } from './index.ts';

const RAW = fc
  .array(
    fc.string({
      unit: fc.constantFrom('a', ' ', '\t', ':', '[', ']', '{', '}', '"', "'", '&', '*', '1'),
      maxLength: 30,
    }),
    { maxLength: 8 },
  )
  .map((lines) => lines.join('\n'));

describe('markdown.frontmatter.prop [area:markdown] [spec:portability-and-safety]', () => {
  it.prop([RAW], PROP)(
    'every YAML interior is preserved and produces data or an explicit error',
    (raw) => {
      const source = `---\n${raw}\n---\nbody`;
      const parsed = parseNote(source);
      const projected = project(parsed, source, { contentHash: 'hash' });
      expect(parsed.frontmatter?.raw).toBe(`${raw}\n`);
      expect(projected.frontmatter?.raw).toBe(`${raw}\n`);
      expect(parsed.source).toBe(source);
      if (parsed.frontmatter?.data === null) expect(projected.frontmatter?.error).toBeTruthy();
      else expect(projected.frontmatter?.data).toBeTypeOf('object');
      expect(projected.bodyText).toBe('body\n');
    },
  );
  it.prop([fc.dictionary(WORD, fc.jsonValue({ maxDepth: 2 }), { maxKeys: 5 })], PROP)(
    'JSON mappings remain the same data under YAML 1.2 core semantics',
    (data) => {
      const raw = JSON.stringify(data);
      const parsed = parseNote(`---\n${raw}\n---\nbody`);
      // JSON serialization canonicalizes negative zero before the YAML parser sees it.
      expect(parsed.frontmatter?.data).toEqual(JSON.parse(raw));
      expect(parsed.frontmatter?.raw).toBe(`${raw}\n`);
    },
  );
  it.prop([WORD], PROP)('thematic breaks without a closing YAML fence stay Markdown', (word) => {
    const source = `---\n\n${word}`;
    const parsed = parseNote(source);
    expect(parsed.frontmatter).toBeNull();
    expect(parsed.mdast.children[0]?.type).toBe('thematicBreak');
    expect(parsed.source).toBe(source);
  });
});
