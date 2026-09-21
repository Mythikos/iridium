import { it } from '@fast-check/vitest';
import { describe } from 'vitest';

import { DOCUMENT } from '../test/generated-documents.ts';
import { PROP } from '../test/prop-budget.ts';
import { parseNote, toBodyText, sourceOffsetOf } from './index.ts';

describe('markdown.body-text-map.prop [area:markdown] [spec:portability-and-safety]', () => {
  it.prop([DOCUMENT], PROP)(
    'every literal mapped UTF-16 unit points at the same source unit',
    (source) => {
      const body = toBodyText(parseNote(source).mdast, source);
      for (const run of body.runs) {
        for (let index = 0; index < run[2]; index += 1) {
          const bodyOffset = run[0] + index;
          if (source[sourceOffsetOf(body.runs, bodyOffset)] !== body.text[bodyOffset]) return false;
        }
      }
      return body.lineCount === source.split('\n').length;
    },
  );
});
