import { describe, expect, it } from 'vitest';

import { iridiumSanitizeSchema, PREVIEW_DATA_ATTRIBUTES } from './index.ts';

describe('preview.data-attributes.unit [area:markdown]', () => {
  it('permits exactly the eight renderer navigation and position hints', () => {
    expect(iridiumSanitizeSchema.attributes?.['*']).toEqual([
      'dataLine',
      'dataOffset',
      'dataEndOffset',
      'dataLinkKind',
      'dataNoteId',
      'dataAttachmentId',
      'dataFragment',
      'dataCandidates',
    ]);
    expect(iridiumSanitizeSchema.attributes?.['*']).toEqual(PREVIEW_DATA_ATTRIBUTES);
  });
});
