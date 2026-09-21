/** Walk erased runtime imports rather than source text, so type-only collaboration seams are safe. */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runtimeSpecifiers } from '../../test/support/runtime-imports.ts';

describe('content.no-ydoc.unit [area:content]', () => {
  it('erases type-only references but retains static, re-exported and dynamic runtime edges', () => {
    expect(
      runtimeSpecifiers("import type { Y } from 'yjs'; export type { T } from 'yjs';"),
    ).toEqual([]);
    // With verbatim module semantics a named type-only binding leaves an empty runtime import.
    expect(runtimeSpecifiers("import { type D } from '@iridium/crdt';")).toEqual(['@iridium/crdt']);
    expect(
      runtimeSpecifiers(
        "import { D } from '@iridium/crdt'; export { D } from 'yjs'; const x=import('lib0');",
      ),
    ).toEqual(['@iridium/crdt', 'yjs', 'lib0']);
  });
  it('has no transitive runtime path from committed reads to a document or collaboration runtime', () => {
    const pending = [resolve(import.meta.dirname, 'read/index.ts')];
    const visited = new Set<string>();
    const forbidden: string[] = [];
    while (pending.length > 0) {
      const file = pending.pop();
      if (file === undefined || visited.has(file)) continue;
      visited.add(file);
      for (const specifier of runtimeSpecifiers(readFileSync(file, 'utf8'))) {
        if (/^(?:yjs|y-protocols|lib0|@iridium\/crdt|@hocuspocus\/server)(?:\/|$)/.test(specifier))
          forbidden.push(`${file}: ${specifier}`);
        if (specifier.startsWith('.')) pending.push(resolve(dirname(file), specifier));
      }
    }
    expect(visited.size).toBeGreaterThan(10);
    expect(forbidden).toEqual([]);
  });
});
