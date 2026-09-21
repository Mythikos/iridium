// oxlint-disable vitest/no-standalone-expect -- it.prop(...)(name, fn) is the fast-check test block form.
import { it } from '@fast-check/vitest';
import * as fc from 'fast-check';
import { describe, expect } from 'vitest';

import { WORD } from '../test/generated-documents.ts';
import { PROP } from '../test/prop-budget.ts';
import { NOTE } from '../test/resolution-context.ts';
import { createVaultIndex, encodeAttachmentReference, foldLinkPath, resolveLink } from './index.ts';

describe('markdown.attachment-reference.prop [area:markdown] [spec:portability-and-safety]', () => {
  it.prop([WORD, fc.constantFrom(' #?.png', ' %.pdf', ' résumé.png')], PROP)(
    'upload hints resolve only inside their own vault and survive reserved-character encoding',
    (name, suffix) => {
      const path = `attachments/${name}${suffix}`;
      const snapshot = {
        vaultId: NOTE.vaultId,
        treeVersion: 1,
        attachmentsVersion: 1,
        notes: [],
        basenames: [],
        aliases: [],
      };
      const same = createVaultIndex({
        ...snapshot,
        attachments: [[foldLinkPath(`${NOTE.parentPath}/${path}`), 'attachment']],
      });
      const foreign = createVaultIndex({
        ...snapshot,
        vaultId: 'different-vault',
        attachments: [[foldLinkPath(`${NOTE.parentPath}/${path}`), 'attachment']],
      });
      const target = encodeAttachmentReference(path);
      expect(resolveLink(target, NOTE, same)).toEqual({
        kind: 'attachment',
        attachmentId: 'attachment',
        fragment: null,
      });
      expect(resolveLink(target, NOTE, foreign)).toEqual({ kind: 'broken', reason: 'not_found' });
      expect(decodeURIComponent(target)).toBe(path);
    },
  );
  it.prop(
    [
      fc.array(
        fc.string({
          unit: fc.constantFrom('a', ' ', '#', '?', '%', 'é', '😀', '[', ']'),
          minLength: 1,
          maxLength: 15,
        }),
        { minLength: 1, maxLength: 5 },
      ),
    ],
    PROP,
  )('encoding every path component preserves literal filename punctuation', (segments) => {
    const path = segments.join('/');
    return decodeURIComponent(encodeAttachmentReference(path)) === path;
  });
});
