import { describe, expect, it } from 'vitest';

import {
  iridiumSanitizeSchema,
  mergeSanitizeSchema,
  UnsafeSanitizeExtensionError,
} from './index.ts';

describe('markdown.sanitize-schema.unit [area:markdown] [hp:HP-4]', () => {
  it('pins every permitted tag, property, value pattern and scheme', async () => {
    const snapshot = JSON.stringify(
      iridiumSanitizeSchema,
      (_key, value: unknown) => (value instanceof RegExp ? value.source : value),
      2,
    );
    await expect(`${snapshot}\n`).toMatchFileSnapshot('../fixtures/sanitize-schema.json');
  });
  it('refuses changes to security fields and safe-looking URL/event/clobber extensions', () => {
    expect(() => mergeSanitizeSchema({ protocols: { href: ['javascript'] } })).toThrow(
      UnsafeSanitizeExtensionError,
    );
    expect(() => mergeSanitizeSchema({ clobberPrefix: '' })).toThrow(UnsafeSanitizeExtensionError);
    expect(() => mergeSanitizeSchema({ tagNames: ['script'] })).toThrow(
      UnsafeSanitizeExtensionError,
    );
    for (const name of [
      'style',
      'name',
      'onclick',
      'onError',
      'id',
      'href',
      'src',
      'data*',
      'ariaDescribedBy',
    ]) {
      expect(() => mergeSanitizeSchema({ attributes: { '*': [name] } })).toThrow(
        UnsafeSanitizeExtensionError,
      );
    }
    expect(
      mergeSanitizeSchema({
        tagNames: ['mark', 'mark'],
        attributes: { mark: ['title'] },
      }).tagNames?.filter((tag) => tag === 'mark'),
    ).toHaveLength(1);
    expect(
      mergeSanitizeSchema({ attributes: { span: [['className', 'safe']] } }).protocols,
    ).toEqual(iridiumSanitizeSchema.protocols);
  });
});
