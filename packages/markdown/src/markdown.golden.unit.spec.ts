import { describe, expect, it } from 'vitest';

import manifest from '../fixtures/golden/manifest.json' with { type: 'json' };
import { GOLDEN_FIXTURES } from '../test/fixtures.ts';
import { elements, NOTE, INDEX } from '../test/pipeline-context.ts';
import {
  parseNote,
  toPreviewTree,
  project,
  renderHtml,
  emptyProjection,
  PIPELINE_VERSION,
} from './index.ts';

describe('markdown.golden.unit [area:markdown] [spec:portability-and-safety]', () => {
  it('ties every reviewed artifact to the current projection version and fixture manifest', () => {
    expect(manifest.pipelineVersion).toBe(PIPELINE_VERSION);
    expect(manifest.fixtureVersion).toBeGreaterThan(0);
    for (const { id } of GOLDEN_FIXTURES)
      for (const suffix of ['md', 'mdast.json', 'hast.json', 'html', 'projection.json'])
        expect(Object.keys(manifest.files)).toContain(`${id}.${suffix}`);
  });
  it.each(GOLDEN_FIXTURES)(
    '$id has stable AST, preview, HTML and projection',
    async ({ id, source }) => {
      const parsed = parseNote(source);
      const preview = toPreviewTree(parsed, { note: NOTE, index: INDEX });
      const projection = project(parsed, source, {
        contentHash: 'fixture-hash',
        note: NOTE,
        index: INDEX,
      });
      await expect(source).toMatchFileSnapshot(`../fixtures/golden/${id}.md`);
      await expect(`${JSON.stringify(parsed.mdast, null, 2)}\n`).toMatchFileSnapshot(
        `../fixtures/golden/${id}.mdast.json`,
      );
      await expect(`${JSON.stringify(preview.hast, null, 2)}\n`).toMatchFileSnapshot(
        `../fixtures/golden/${id}.hast.json`,
      );
      await expect(`${renderHtml(preview.hast)}\n`).toMatchFileSnapshot(
        `../fixtures/golden/${id}.html`,
      );
      await expect(`${JSON.stringify(projection, null, 2)}\n`).toMatchFileSnapshot(
        `../fixtures/golden/${id}.projection.json`,
      );
      expect(parsed.source).toBe(source);
    },
  );

  it('shares exact heading and task offsets with the source editor and does not serialize Markdown', () => {
    const source = '# Heading\n\n## Duplicate\n\n## Duplicate\n\n- [X] ready\n';
    const parsed = parseNote(source);
    const result = project(parsed, source, { contentHash: 'hash' });
    expect(result.headings.map((heading) => heading.slug)).toEqual([
      'heading',
      'duplicate',
      'duplicate-1',
    ]);
    expect(result.tasks).toEqual([{ line: 7, offset: source.indexOf('[X]'), checked: true }]);
    expect(result.headingTitle).toBe('Heading');
    expect(
      elements(toPreviewTree(parsed).hast)
        .filter((node) => /^h\d$/.test(node.tagName))
        .map((node) => node.properties.id),
    ).toEqual(result.headings.map((heading) => `user-content-${heading.slug}`));
    expect(result.contentHash).toBe('hash');
    expect(result.lineCount).toBe(8);
  });

  it('restores source positions erased by the transform-only autolinker', () => {
    const source = 'prefix https://example.com suffix\n\nwww.example.org and a@example.org\n';
    const result = project(parseNote(source), source, { contentHash: 'hash' });
    expect(result.links.map((link) => source.slice(link.startOffset, link.endOffset))).toEqual([
      'https://example.com',
      'www.example.org',
      'a@example.org',
    ]);
    for (const run of result.bodyRuns) {
      expect(source.slice(run[1], run[1] + run[2])).toBe(
        result.bodyText.slice(run[0], run[0] + run[2]),
      );
    }
  });

  it('keeps frontmatter and raw HTML out of the search body and separates table cells', () => {
    const source =
      '---\nsecret: metadata\n---\n\n| alpha | beta |\n| --- | --- |\n| gamma | delta |\n\n<div>hidden prose</div>\n\n**ter**m `code`\n';
    const result = project(parseNote(source), source, { contentHash: 'hash' });
    expect(result.bodyText).toBe('alpha\nbeta\ngamma\ndelta\nterm code\n');
    expect(result.bodyText).not.toContain('secret');
    expect(result.bodyText).not.toContain('hidden');
  });

  it('refuses projecting an AST against another source and exposes explicit worker failure shapes', () => {
    expect(() => project(parseNote('before'), 'after', { contentHash: 'hash' })).toThrow(
      /same committed revision/,
    );
    expect(emptyProjection('raw\ntext', 'hash', 'timeout')).toMatchObject({
      status: 'timeout',
      lineCount: 2,
      sizeChars: 8,
      contentHash: 'hash',
      links: [],
      bodyText: '',
    });
    expect(emptyProjection('queued raw', 'hash', 'pending')).toMatchObject({
      status: 'pending',
      contentHash: 'hash',
      sizeChars: 10,
      bodyText: '',
      links: [],
    });
  });
});
