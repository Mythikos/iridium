// oxlint-disable vitest/no-standalone-expect -- it.prop(...)(name, fn) is the fast-check test block form.
import { it } from '@fast-check/vitest';
import * as fc from 'fast-check';
import { describe, expect } from 'vitest';

import { DOCUMENT, WORD } from '../test/generated-documents.ts';
import { PROP } from '../test/prop-budget.ts';
import { detectObsidianSyntax, parseNote, project, toPreviewTree } from './index.ts';

describe('markdown.obsidian-detector.prop [area:markdown] [spec:portability-and-safety]', () => {
  it.prop([DOCUMENT, WORD], PROP)(
    'findings are deterministic, correctly located and never rewrite the source',
    (prose, word) => {
      const source = `${prose}\n\n[[${word}]] ==${word}== #tag\n`;
      const parsed = parseNote(source);
      const before = JSON.stringify(parsed.mdast);
      const first = detectObsidianSyntax(source, parsed.mdast);
      toPreviewTree(parsed);
      project(parsed, source, { contentHash: 'hash' });
      expect(detectObsidianSyntax(source, parsed.mdast)).toEqual(first);
      expect(detectObsidianSyntax(source, parseNote(source).mdast)).toEqual(first);
      expect(parsed.source).toBe(source);
      expect(JSON.stringify(parsed.mdast)).toBe(before);
      for (const finding of first.findings)
        expect(source.slice(finding.offset, finding.endOffset)).toBe(finding.text);
    },
  );
  it.prop([fc.array(WORD, { maxLength: 15 })], PROP)(
    'plain prose has no Obsidian findings',
    (words) => {
      const source = words.join(' ');
      const result = detectObsidianSyntax(source, parseNote(source).mdast);
      expect(result.findings).toEqual([]);
      expect(Object.values(result.counts).every((count) => count === 0)).toBe(true);
    },
  );
});
