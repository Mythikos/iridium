import { it } from '@fast-check/vitest';
import * as fc from 'fast-check';
import { describe } from 'vitest';

import { WORD, DOCUMENT } from '../test/generated-documents.ts';
import { PROP } from '../test/prop-budget.ts';
import { normalizeSource, restoreSource } from './index.ts';

describe('markdown.roundtrip.prop [area:markdown] [spec:portability-and-safety]', () => {
  it.prop(
    [fc.array(WORD, { maxLength: 15 }), fc.constantFrom('\n', '\r\n', '\r'), fc.boolean()],
    PROP,
  )('uniform-EOL valid UTF-8 bytes including a BOM restore exactly', (lines, eol, hadBom) => {
    const bytes = new TextEncoder().encode((hadBom ? '\uFEFF' : '') + lines.join(eol));
    const normalized = normalizeSource(bytes);
    const restored = restoreSource(normalized.text, normalized);
    return (
      bytes.length === restored.length && bytes.every((byte, offset) => byte === restored[offset])
    );
  });
  it.prop([DOCUMENT], PROP)(
    'the documented mixed-EOL substitution is stable on subsequent exports',
    (body) => {
      const normalized = normalizeSource(`\uFEFF${body}\r\nline\ranother\n`);
      const restored = restoreSource(normalized.text, normalized);
      const again = normalizeSource(restored);
      const second = restoreSource(again.text, again);
      return (
        normalized.originalEol === 'mixed' &&
        again.originalEol === 'lf' &&
        restored.every((byte, offset) => byte === second[offset]) &&
        restored.length === second.length
      );
    },
  );
});
