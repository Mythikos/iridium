/** The fallback must retain existing reviewed syntax and every source address. */
import { describe, expect, it } from 'vitest';

import commonmark from '../../fixtures/commonmark-0.31.2.json' with { type: 'json' };
import { GOLDEN_FIXTURES } from '../../test/fixtures.ts';
import { parseRemarkBaseline } from '../../test/remark-baseline.ts';
import { parseMarkdownIt } from './parser.ts';

describe('markdown.parser-adapter.unit [area:markdown]', () => {
  it.each(GOLDEN_FIXTURES)(
    '$id retains the reviewed mdast and exact source positions',
    async ({ id, source }) => {
      await expect(`${JSON.stringify(parseMarkdownIt(source), null, 2)}\n`).toMatchFileSnapshot(
        `../../fixtures/golden/${id}.mdast.json`,
      );
    },
  );
  it.each(commonmark)(
    'CommonMark $example retains source-addressable semantics',
    ({ markdown }) => {
      expect(parseMarkdownIt(markdown)).toStrictEqual(parseRemarkBaseline(markdown));
    },
  );
  it('never silently drops source at a renderer nesting cutoff', () => {
    const source = Array.from(
      { length: 110 },
      (_, index) => `${'    '.repeat(index)}[^n${index}]: Level ${index}.`,
    ).join('\n');
    expect(parseMarkdownIt(source)).toStrictEqual(parseRemarkBaseline(source));
  });
  it('classifies astral symbols as Unicode punctuation under CommonMark 0.31.2 §2.1', () => {
    // remark's UTF-16 delimiter scanner misclassifies surrogate halves here. Preserve
    // the spec-correct upstream result rather than reproduce that old parser defect.
    const source = '**😀**m';
    const paragraph = parseMarkdownIt(source).children[0];
    expect(paragraph).toMatchObject({
      type: 'paragraph',
      children: [
        {
          type: 'text',
          value: source,
          position: { start: { offset: 0 }, end: { offset: source.length } },
        },
      ],
    });
    expect(parseRemarkBaseline(source).children[0]).not.toEqual(paragraph);
  });
  it.each([
    ['task whitespace', '- [x]\n- [ ]   spaced\n- [X]\tTabbed\n- [ ] **bold**\n'],
    ['table missing cells', '| a | b | c |\n| - | - | - |\n| one |\n'],
    ['table extra cells', '| a | b |\n| - | - |\n| one | two | extra |\n'],
    [
      'table escaped delimiters',
      '| a\\|b | `x\\|y` |\n| - | - |\n| \\*escaped\\* | ~~struck~~ |\n',
    ],
    ['table containers', '> - | a | b |\n>   | - | - |\n>   | one | two |\n'],
    ['table no outer pipes', ' a | b\n---|---\n one | two\n'],
    ['footnote case folding', 'Text[^up].\n\n[^UP]: A note.\n'],
    ['footnote spaces', 'Text[^a b].\n\n[^a b]: A note.\n'],
    ['footnote escaped bracket', 'Text[^a\\]].\n\n[^a\\]]: A note.\n'],
    [
      'footnote escaped opening and slash',
      'Text[^a\\[] and [^b\\\\].\n\n[^a\\[]: One.\n[^b\\\\]: Two.\n',
    ],
    ['footnote unicode case folding', 'Text[^ſ] and [^ß].\n\n[^S]: One.\n[^SS]: Two.\n'],
    ['footnote nonbreaking space', 'Text[^a\u00a0b].\n\n[^a\u00a0b]: One.\n'],
    ['footnote first-line whitespace', '[^n]:\t\tIndented body.\n\nReference[^n].\n'],
    [
      'footnote nested block',
      '[^n]: > Quoted.\n\n    - A list.\n\n    ```ts\n    const a = 1;\n    ```\n\nReference[^n].\n',
    ],
    [
      'footnote nested definition',
      '[^outer]: Parent.\n\n    [^inner]: Child.\n\nReference[^outer] and [^inner].\n',
    ],
    [
      'footnote unused and duplicate',
      '[^note]: First.\n\n[^note]: Second.\n\n[^unused]: Unused.\n\nText[^note].\n',
    ],
    ['footnote containers', '> [^n]: **quoted**\n>\n>     Next.\n>\n> Text[^n].\n'],
    ['footnote empty leading line', '[^n]:\n    Body.\n\nReference[^n].\n'],
    ['frontmatter empty', '---\n---\n# Heading\n'],
    ['frontmatter spaces', '---  \nname: value\n--- \n# Heading\n'],
    ['frontmatter missing close', '---\nname: value\n# Heading\n'],
    ['frontmatter dot terminator', '---\nname: value\n...\n# Heading\n'],
    ['strikethrough nesting', '~~~three~~~ ~~a *b*~~ ~single~ \\~~escaped~~\n'],
    ['quote tab in list', '>\t- first\n>\t\n>\t\t\tcode\n'],
    ['table escaped slashes', '| a | b |\n| - | - |\n| a\\\\|b | c |\n'],
    ['table empty cells', '| a | b |\n| - | - |\n| | | |\n| one ||\n'],
    ['table trailing whitespace', '| a | b |  \n| - | - |\n| one | two | three |   \n'],
  ])('%s retains GFM metadata and source addresses', (_name, source) => {
    expect(parseMarkdownIt(source)).toStrictEqual(parseRemarkBaseline(source));
  });
});
