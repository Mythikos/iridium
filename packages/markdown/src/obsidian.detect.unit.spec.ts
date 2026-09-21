import { OBSIDIAN_CODES, type ObsidianCode } from '@iridium/contracts';
/** Every detector catalogue construct, including masked negatives, has an observable example. */
import { describe, expect, it } from 'vitest';

import {
  detectObsidianSyntax,
  parseNote,
  parseWikilinkTarget,
  renderHtml,
  toPreviewTree,
} from './index.ts';

const CASES: Record<ObsidianCode, string> = {
  wikilink: '[[Target#Heading|Alias]]',
  embed: '![[Target.png|300]]',
  block_id: 'Paragraph ^block-id',
  block_ref: '[[Target#^block-id]]',
  callout: '> [!WARNING]- Careful',
  tag: '#inbox/to-read',
  tag_invalid: '#1984',
  highlight: '==highlight==',
  comment: '%%visible\ncomment%%',
  inline_footnote: 'Claim^[the source]',
  math_inline: '$E=mc^2$',
  math_block: '$$\n\\int_0^1\n$$',
  mermaid: '```mermaid\ngraph LR; A-->B\n```',
  dataview: '```dataview\nTABLE FROM #tag\n```',
  dataviewjs: '```dataviewjs\ndv.table([])\n```',
  query_block: '```query\npath:Notes\n```',
  image_size_syntax: '![alt|100x145](image.png)',
  non_gfm_task_state: '- [/] partial',
  soft_break_reliance: 'first\nsecond\nthird',
  deprecated_frontmatter_key: '---\nalias: old\n---\nbody',
  frontmatter_link_unquoted: '---\nhome: [[Index]]\n---\nbody',
  strict_line_breaks_off: '',
  canvas: '',
  bases: '',
  obsidian_config: '',
  obsidian_trash: '',
};

describe('obsidian.detect.unit [area:markdown] [spec:portability-and-safety]', () => {
  it.each(OBSIDIAN_CODES)('detects %s with source coordinates and catalogue severity', (code) => {
    const source = CASES[code];
    const result = detectObsidianSyntax(source, parseNote(source).mdast, {
      files: ['.obsidian/app.json', '.trash/deleted.md', 'board.canvas', 'table.base'],
      strictLineBreaks: false,
    });
    expect(result.counts[code]).toBeGreaterThan(0);
    expect(
      result.findings.some(
        (finding) => finding.code === code && finding.line >= 1 && finding.offset >= 0,
      ),
    ).toBe(true);
  });

  it('masks code, inline code, frontmatter, HTML and link destinations without masking labels', () => {
    const source =
      '---\nvalue: "#hidden [[yaml]]"\n---\n\n```text\n#hidden [[code]]\n```\n\n`#hidden [[inline]]`\n\n<a title="[[html]]">\n\n[label #visible](https://example.com/#hidden "[[title]]")\n\n\\#escaped \\[[escaped]]\n';
    const result = detectObsidianSyntax(source, parseNote(source).mdast);
    expect(result.counts.wikilink).toBe(0);
    expect(result.counts.tag).toBe(1);
    expect(result.findings.find((finding) => finding.code === 'tag')?.text).toBe('#visible');
  });
  it('detects wikilinks even when a CommonMark reference definition splits their mdast nodes', () => {
    const source = '[[known]]\n\n[known]: /target\n';
    expect(detectObsidianSyntax(source, parseNote(source).mdast).counts.wikilink).toBe(1);
  });
  it('detects inline dataview but does not scan other inline code as prose', () => {
    const source = '`= this.file.name` `$= dv.current()` `#not-a-tag`';
    expect(detectObsidianSyntax(source, parseNote(source).mdast).counts).toMatchObject({
      dataview: 1,
      dataviewjs: 1,
      tag: 0,
    });
  });
  it('counts a nested callout once at the quote containing its opening paragraph', () => {
    const source = '> > [!note] Nested\n> > content\n\n> [!tip] Outer';
    const result = detectObsidianSyntax(source, parseNote(source).mdast);
    expect(result.counts.callout).toBe(2);
    expect(
      result.findings
        .filter((finding) => finding.code === 'callout')
        .map((finding) => finding.line),
    ).toEqual([1, 4]);
  });
  it('parses escaped pipes, empty targets and block fragments without evaluating anything', () => {
    expect(parseWikilinkTarget('![[A\\|B#^block|200]]')).toEqual({
      target: 'A|B#^block',
      alias: '200',
      block: true,
      embed: true,
    });
    expect(parseWikilinkTarget('[[ ]]')).toMatchObject({ target: '' });
    expect(parseWikilinkTarget('[ordinary]')).toBeNull();
  });

  it('reports literal unsupported syntax without rewriting or executing it', () => {
    const source =
      '[[Plan]] ![[image.png]] ==highlight== %%visible comment%% $math$\n\n> [!tip] ordinary quote';
    const parsed = parseNote(source);
    const before = JSON.stringify(parsed.mdast);
    const result = detectObsidianSyntax(source, parsed.mdast);
    const html = renderHtml(toPreviewTree(parsed).hast);
    expect(result.counts).toMatchObject({
      wikilink: 1,
      embed: 1,
      highlight: 1,
      comment: 1,
      math_inline: 1,
      callout: 1,
    });
    expect(html).toContain('[[Plan]] ![[image.png]] ==highlight== %%visible comment%% $math$');
    expect(html).toContain('[!tip] ordinary quote');
    expect(JSON.stringify(parsed.mdast)).toBe(before);
    expect(parsed.source).toBe(source);
  });
});
