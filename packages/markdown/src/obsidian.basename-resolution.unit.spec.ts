import { LIMITS } from '@iridium/contracts/limits';
import { describe, expect, it } from 'vitest';

import { NOTE, INDEX } from '../test/linked-vault.ts';
import { resolveLink, normalizeLinkTarget } from './index.ts';

describe('obsidian.basename-resolution.unit [area:markdown] [spec:portability-and-safety]', () => {
  it('resolves exact paths before basenames and aliases; standard Markdown has no global fallback', () => {
    expect(resolveLink('plan.md', NOTE, INDEX)).toEqual({
      kind: 'vault',
      nodeId: 'plan',
      fragment: null,
      via: 'path',
    });
    expect(resolveLink('elsewhere', NOTE, INDEX)).toEqual({ kind: 'broken', reason: 'not_found' });
    expect(resolveLink('elsewhere', NOTE, INDEX, { wikilink: true })).toMatchObject({
      kind: 'vault',
      nodeId: 'elsewhere',
      via: 'basename',
    });
    expect(resolveLink('nickname', NOTE, INDEX, { wikilink: true })).toMatchObject({
      kind: 'vault',
      nodeId: 'plan',
      via: 'alias',
    });
    expect(resolveLink('shared', NOTE, INDEX, { wikilink: true })).toEqual({
      kind: 'ambiguous',
      candidates: ['a', 'b', 'c', 'd', 'e'],
    });
    expect(resolveLink('not/shared', NOTE, INDEX, { wikilink: true })).toEqual({
      kind: 'broken',
      reason: 'not_found',
    });
  });
  it('folds NFC and case, handles percent escapes, and preserves literal query/hash filename data', () => {
    expect(resolveLink('RE%CC%81SUME%CC%81.md', NOTE, INDEX)).toMatchObject({
      kind: 'vault',
      nodeId: 'resume',
    });
    expect(resolveLink('/literal?query', NOTE, INDEX)).toMatchObject({
      kind: 'vault',
      nodeId: 'question',
    });
    expect(resolveLink('/a%23b#Heading', NOTE, INDEX)).toMatchObject({
      kind: 'vault',
      nodeId: 'hash',
      fragment: 'Heading',
    });
    expect(normalizeLinkTarget('bad%ZZ', NOTE)).toMatchObject({
      kind: 'path',
      folded: 'folder/bad%zz',
    });
    expect(resolveLink('./attachments/picture.png#page=2', NOTE, INDEX)).toEqual({
      kind: 'attachment',
      attachmentId: 'picture',
      fragment: 'page=2',
    });
  });
  it('refuses root escape, raw or encoded controls, unsupported schemes and unbounded fragments', () => {
    expect(resolveLink('../../outside', NOTE, INDEX)).toEqual({
      kind: 'broken',
      reason: 'escapes_vault',
    });
    expect(resolveLink('%2E%2E/%2E%2E/outside', NOTE, INDEX)).toEqual({
      kind: 'broken',
      reason: 'escapes_vault',
    });
    expect(resolveLink('bad%00target', NOTE, INDEX)).toEqual({
      kind: 'broken',
      reason: 'bad_target',
    });
    expect(resolveLink('bad\u0000target', NOTE, INDEX)).toEqual({
      kind: 'broken',
      reason: 'bad_target',
    });
    expect(resolveLink('file:///outside', NOTE, INDEX)).toEqual({
      kind: 'blocked',
      scheme: 'file',
    });
    expect(resolveLink('tel:123', NOTE, INDEX)).toEqual({ kind: 'blocked', scheme: 'tel' });
    expect(resolveLink(' '.repeat(3), NOTE, INDEX)).toEqual({ kind: 'broken', reason: 'empty' });
    expect(resolveLink('a'.repeat(LIMITS.LINK_TARGET_MAX_CHARS + 1), NOTE, INDEX)).toEqual({
      kind: 'broken',
      reason: 'bad_target',
    });
    expect(resolveLink('#' + 'a'.repeat(LIMITS.LINK_FRAGMENT_MAX_CHARS + 1), NOTE, INDEX)).toEqual({
      kind: 'broken',
      reason: 'bad_target',
    });
  });
});
