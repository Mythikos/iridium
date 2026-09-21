import type { Root } from 'hast';
import { sanitize } from 'hast-util-sanitize';
import { describe, expect, it } from 'vitest';

import { HOSTILE_FIXTURES } from '../test/fixtures.ts';
import { elements, visibleText } from '../test/pipeline-context.ts';
import { SHARED_HOSTILE_EXPECTATIONS, SHARED_HOSTILE_SOURCES } from '../test/shared-hostile.ts';
import {
  parseNote,
  toPreviewTree,
  iridiumSanitizeSchema,
  gfmFlavor,
  createProcessor,
} from './index.ts';

describe('markdown.xss-corpus.unit [area:markdown] [spec:portability-and-safety] [hp:HP-4]', () => {
  it('covers every declared shared fixture with an explicit inert asset import', () => {
    expect(Object.keys(SHARED_HOSTILE_SOURCES).toSorted()).toEqual(
      Object.keys(SHARED_HOSTILE_EXPECTATIONS).toSorted(),
    );
    expect(SHARED_HOSTILE_SOURCES).not.toHaveProperty('CHANGELOG.md');
  });
  it.each(Object.entries(SHARED_HOSTILE_EXPECTATIONS))(
    'shared testkit corpus %s is inert through the exact pipeline',
    (fixtureName, policy) => {
      const source = SHARED_HOSTILE_SOURCES[fixtureName];
      expect(source).toBeDefined();
      if (source === undefined)
        throw new Error(`Missing inert asset import for declared hostile fixture ${fixtureName}`);
      const tree = toPreviewTree(parseNote(source)).hast;
      const produced = elements(tree);
      for (const node of produced) {
        expect(policy.forbiddenTags).not.toContain(node.tagName);
        for (const attribute of Object.keys(node.properties))
          expect(policy.forbiddenAttributes).not.toContain(attribute);
        for (const url of [node.properties.href, node.properties.src]) {
          expect(
            typeof url !== 'string' ||
              !policy.forbiddenUrlSchemes.some((scheme) => url.toLowerCase().startsWith(scheme)),
          ).toBe(true);
        }
        const id = node.properties.id;
        expect(typeof id !== 'string' || !(policy.forbiddenIds ?? []).includes(id)).toBe(true);
        expect(
          typeof id !== 'string' ||
            policy.requiredIdPrefix === undefined ||
            id.startsWith(policy.requiredIdPrefix),
        ).toBe(true);
        const classes = Array.isArray(node.properties.className) ? node.properties.className : [];
        for (const className of classes)
          expect(
            (policy.forbiddenClassPrefixes ?? []).some((prefix) => className.startsWith(prefix)),
          ).toBe(false);
      }
      for (const text of policy.mustContain) expect(visibleText(tree)).toContain(text);
      expect(produced.every((node) => iridiumSanitizeSchema.tagNames?.includes(node.tagName))).toBe(
        true,
      );
      expect(
        produced
          .flatMap((node) => Object.keys(node.properties))
          .filter((name) => /^(?:on|style$|name$|srcset$|target$)/i.test(name)),
      ).toEqual([]);
      expect(
        produced
          .flatMap((node) => [node.properties.href, node.properties.src])
          .filter(
            (url) =>
              typeof url === 'string' && /^(?:javascript|vbscript|data|file|ftp|tel):/i.test(url),
          ),
      ).toEqual([]);
      expect(
        produced
          .map((node) => node.properties.id)
          .filter((id) => typeof id === 'string' && !id.startsWith('user-content-')),
      ).toEqual([]);
    },
  );
  it.each(HOSTILE_FIXTURES)('$id reaches only inert sanitized hast', async ({ id, source }) => {
    await expect(source).toMatchFileSnapshot(`../fixtures/hostile/${id}.md`);
    const tree = toPreviewTree(parseNote(source)).hast;
    for (const node of elements(tree)) {
      expect(iridiumSanitizeSchema.tagNames).toContain(node.tagName);
      for (const [property, value] of Object.entries(node.properties)) {
        expect(property).not.toMatch(/^(?:on|style$|name$|srcset$|target$)/i);
        expect(
          property !== 'id' || (typeof value === 'string' && value.startsWith('user-content-')),
        ).toBe(true);
        expect(
          !['href', 'src'].includes(property) ||
            (typeof value === 'string' &&
              !/^(?:javascript|vbscript|data|file|ftp|tel):/i.test(value)),
        ).toBe(true);
      }
    }
    expect(
      elements(tree)
        .filter((node) => node.tagName === 'input')
        .every((node) => node.properties.type === 'checkbox' && node.properties.disabled === true),
    ).toBe(true);
    expect(tree).toEqual(sanitize(tree, iridiumSanitizeSchema));
  });
  it('the final sanitizer removes hostile output even from a preceding flavor transform', () => {
    const unsafe: Root = {
      type: 'root',
      children: [
        {
          type: 'element',
          tagName: 'script',
          properties: {},
          children: [{ type: 'text', value: 'attack()' }],
        },
        {
          type: 'element',
          tagName: 'a',
          properties: {
            href: 'javascript:attack()',
            id: 'location',
            name: 'iridium',
            onClick: 'attack()',
            style: 'color:red',
          },
          children: [{ type: 'text', value: 'bad' }],
        },
        {
          type: 'element',
          tagName: 'input',
          properties: { type: 'text', disabled: false },
          children: [],
        },
      ],
    };
    const flavor = { ...gfmFlavor, rehype: [() => () => unsafe] };
    const processor = createProcessor({ flavor });
    const result = processor.runSync(processor.parse('source'), 'source');
    expect(elements(result).map((node) => node.tagName)).toEqual(['a', 'input']);
    expect(elements(result)[0]?.properties).toEqual({});
    expect(elements(result)[1]?.properties).toEqual({ type: 'checkbox', disabled: true });
  });
});
