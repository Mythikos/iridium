// oxlint-disable vitest/no-standalone-expect -- it.prop(...)(name, fn) is the fast-check test block form.
import { it } from '@fast-check/vitest';
import * as fc from 'fast-check';
import { describe, expect } from 'vitest';

import { WORD } from '../test/generated-documents.ts';
import { PROP } from '../test/prop-budget.ts';
import { NOTE, INDEX } from '../test/resolution-context.ts';
import { createVaultIndex, resolveLink, parseNote, collectLinks } from './index.ts';

describe('markdown.links.prop [area:markdown]', () => {
  it.prop(
    [
      fc.array(fc.tuple(WORD, fc.constantFrom('markdown', 'image', 'wikilink', 'embed')), {
        minLength: 1,
        maxLength: 10,
      }),
    ],
    PROP,
  )(
    'every collected occurrence slices back to the exact independently constructed link',
    (entries) => {
      const fragments = entries.map(([word, kind]) =>
        kind === 'markdown'
          ? `[${word}](${word}.md)`
          : kind === 'image'
            ? `![${word}](${word}.png)`
            : kind === 'wikilink'
              ? `[[${word}]]`
              : `![[${word}.png]]`,
      );
      const source = `prefix 😀\n\n${fragments.join('\n\n')}`;
      const links = collectLinks(parseNote(source).mdast, source, NOTE, INDEX);
      expect(links.map((link) => source.slice(link.startOffset, link.endOffset))).toEqual(
        fragments,
      );
      expect(links.map((link) => link.kind)).toEqual(entries.map(([, kind]) => kind));
      expect(links.map((link) => link.ordinal)).toEqual(entries.map((_, index) => index));
    },
  );
  it.prop([fc.string({ maxLength: 100 })], PROP)(
    'resolution is total and cannot escape the vault',
    (target) => {
      const result = resolveLink(target, NOTE, INDEX);
      return (
        ['vault', 'attachment', 'anchor', 'external', 'broken', 'ambiguous', 'blocked'].includes(
          result.kind,
        ) && resolveLink(`../../${target}`, NOTE, INDEX).kind === 'broken'
      );
    },
  );
  it.prop([WORD], PROP)('path resolution is stable under case and NFC folding', (name) => {
    const path = name.normalize('NFC').toLowerCase();
    const index = createVaultIndex({
      vaultId: 'vault',
      treeVersion: 0,
      attachmentsVersion: 0,
      notes: [[`folder/${path}`, 'target']],
      attachments: [],
      aliases: [],
      basenames: [],
    });
    return (
      JSON.stringify(resolveLink(name, NOTE, index)) ===
      JSON.stringify(resolveLink(name.toUpperCase().normalize('NFD'), NOTE, index))
    );
  });
});
