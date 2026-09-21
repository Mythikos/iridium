import { it } from '@fast-check/vitest';
import * as fc from 'fast-check';
import type { Nodes, Element } from 'hast';
import { describe, expect } from 'vitest';

import { PROP } from '../test/prop-budget.ts';
import { createProcessor, gfmFlavor, parseNote, toPreviewTree } from './index.ts';

// Independent acceptance policy, deliberately not read from the production schema.
const TAGS = new Set(
  'a blockquote br code del em h1 h2 h3 h4 h5 h6 hr img input li ol p pre section span strong sup table tbody td th thead tr ul'.split(
    ' ',
  ),
);
const GLOBAL = new Set(
  'dataLine dataOffset dataEndOffset dataLinkKind dataNoteId dataAttachmentId dataFragment dataCandidates'.split(
    ' ',
  ),
);
const ATTRIBUTES: Record<string, readonly string[]> = {
  a: [
    'href',
    'title',
    'id',
    'ariaDescribedBy',
    'ariaLabel',
    'dataFootnoteRef',
    'dataFootnoteBackref',
    'className',
  ],
  img: ['src', 'alt', 'title'],
  input: ['type', 'disabled', 'checked'],
  code: ['className'],
  span: ['className'],
  h1: ['id'],
  h2: ['id', 'className'],
  h3: ['id'],
  h4: ['id'],
  h5: ['id'],
  h6: ['id'],
  li: ['id', 'className'],
  ul: ['className'],
  ol: ['start', 'className'],
  td: ['align'],
  th: ['align'],
  section: ['dataFootnotes', 'className'],
};
function inspectElement(node: Element): void {
  expect(TAGS.has(node.tagName)).toBe(true);
  for (const [name, value] of Object.entries(node.properties)) {
    expect(GLOBAL.has(name) || ATTRIBUTES[node.tagName]?.includes(name)).toBe(true);
    expect(name).not.toMatch(/^(on|style$|name$)/i);
    if (name === 'id' || name === 'ariaDescribedBy')
      expect(value).toMatch(/^user-content-[^\s"'<>&]+$/);
    if (name === 'href' || name === 'src') {
      expect(typeof value).toBe('string');
      const scheme = /^[^:/?#]*:/.exec(String(value))?.[0].toLowerCase();
      if (scheme !== undefined)
        expect(name === 'src' ? ['http:', 'https:'] : ['http:', 'https:', 'mailto:']).toContain(
          scheme,
        );
    }
  }
  if (node.tagName === 'input')
    expect(node.properties).toMatchObject({ type: 'checkbox', disabled: true });
}
function inspect(node: Nodes): void {
  expect(['root', 'element', 'text']).toContain(node.type);
  if (node.type === 'element') inspectElement(node);
  if ('children' in node) for (const child of node.children) inspect(child);
}
const TAG = fc.constantFrom(
  'a',
  'img',
  'span',
  'input',
  'h1',
  'script',
  'svg',
  'iframe',
  'meta',
  'object',
  'style',
  'form',
);
const NAME = fc.constantFrom(
  'href',
  'src',
  'onerror',
  'onclick',
  'style',
  'name',
  'id',
  'class',
  'data-secret',
  'title',
  'type',
);
const VALUE = fc.oneof(
  fc.constantFrom(
    'javascript:alert(1)',
    'data:text/html,x',
    'vbscript:run()',
    'https://example.com',
    'mailto:a@example.com',
    '/relative',
    'location',
    'user-content-safe',
    'checkbox',
  ),
  fc.string({ maxLength: 60 }),
);

describe('markdown.sanitize.prop [area:markdown] [spec:portability-and-safety] [hp:HP-4]', () => {
  it.prop([TAG, NAME, VALUE, fc.string({ maxLength: 80 })], PROP)(
    'raw HTML, URL-like data and arbitrary Markdown satisfy an independent output policy',
    (tag, name, value, text) => {
      const source = `<${tag} ${name}="${value}">${text}</${tag}>\n\n[link](${value}) ![alt](${value})\n\n${text}`;
      inspect(toPreviewTree(parseNote(source)).hast);
    },
  );
  it.prop([TAG, NAME, VALUE], PROP)(
    'sanitize-last also removes unsafe properties inserted by a preceding transform',
    (tagName, property, value) => {
      const processor = createProcessor({
        flavor: {
          ...gfmFlavor,
          rehype: [
            () => () => ({
              type: 'root',
              children: [
                {
                  type: 'element',
                  tagName,
                  properties: { [property]: value },
                  children: [{ type: 'text', value: 'payload' }],
                },
              ],
            }),
          ],
        },
      });
      inspect(processor.runSync(processor.parse('unchanged'), 'unchanged'));
    },
  );
});
