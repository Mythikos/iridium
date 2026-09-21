import { describe, expect, it } from 'vitest';

import { NOTE, INDEX } from '../test/linked-vault.ts';
import { resolveLink, parseNote, project } from './index.ts';

describe('markdown.links.anchor-rows.unit [area:markdown]', () => {
  it('marks same-note anchors accurately and leaves cross-note fragments unvalidated', () => {
    expect(resolveLink('#Hello%20World', NOTE, INDEX)).toEqual({
      kind: 'anchor',
      fragment: 'hello-world',
      valid: true,
    });
    expect(resolveLink('#hello-world', NOTE, INDEX)).toEqual({
      kind: 'anchor',
      fragment: 'hello-world',
      valid: true,
    });
    expect(resolveLink('#missing', NOTE, INDEX)).toEqual({
      kind: 'anchor',
      fragment: 'missing',
      valid: false,
    });
    const source =
      '# Hello World\n\n[good](#Hello%20World) [bad](#missing) [cross](Plan.md#absent)';
    const result = project(parseNote(source), source, {
      contentHash: 'hash',
      note: NOTE,
      index: INDEX,
    });
    expect(result.links.map((link) => link.resolved)).toEqual([
      { kind: 'anchor', fragment: 'hello-world', valid: true },
      { kind: 'anchor', fragment: 'missing', valid: false },
      { kind: 'vault', nodeId: 'plan', fragment: 'absent', via: 'path' },
    ]);
  });
  it('indexes occurrences and unused definitions in source order without double-counting literal wikilinks', () => {
    const source = '[same][x] [same again][x] [[x]]\n\n[x]: Plan.md\n[unused]: /missing\n';
    const result = project(parseNote(source), source, {
      contentHash: 'hash',
      note: NOTE,
      index: INDEX,
    });
    expect(result.links.map((link) => link.kind)).toEqual([
      'markdown',
      'markdown',
      'wikilink',
      'definition',
    ]);
    expect(result.links.map((link) => link.ordinal)).toEqual([0, 1, 2, 3]);
    expect(result.links.map((link) => link.line)).toEqual([1, 1, 1, 4]);
    expect(result.links[2]?.rawTarget).toBe('x');
  });
});
