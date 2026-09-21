import { it } from '@fast-check/vitest';
import { describe } from 'vitest';

import { DOCUMENT } from '../test/generated-documents.ts';
import { PROP } from '../test/prop-budget.ts';
import { parseNote, project, toPreviewTree } from './index.ts';

describe('markdown.no-rewrite.prop [area:markdown] [spec:portability-and-safety]', () => {
  it.prop([DOCUMENT], PROP)(
    'all derived operations preserve source and the parsed tree',
    (source) => {
      const parsed = parseNote(source);
      const before = JSON.stringify(parsed.mdast);
      const projection = project(parsed, source, { contentHash: 'hash' });
      toPreviewTree(parsed, { softBreaks: true });
      return (
        parsed.source === source &&
        JSON.stringify(parsed.mdast) === before &&
        projection.sizeChars === source.length
      );
    },
  );
});
