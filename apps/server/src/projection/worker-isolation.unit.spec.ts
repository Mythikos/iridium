/** The worker graph has CPU-only imports; the host alone owns storage and network capabilities. */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runtimeSpecifiers } from '../../test/support/runtime-imports.ts';

const root = resolve(import.meta.dirname, '../../../..');
const forbidden =
  /^(?:node:)?(?:fs|net|http|https|http2|dns|dgram|tls|child_process|cluster)(?:\/|$)|^(?:mysql2|kysely|fastify|undici|@aws-sdk\/)/;

describe('projection.worker-isolation.unit [hp:HP-4]', () => {
  it('recognizes static, re-exported and dynamic I/O edges while allowing hashing', () => {
    const edges = runtimeSpecifiers(
      "import 'node:fs/promises'; export {x} from 'mysql2'; const x=import('node:https'); import {createHash} from 'node:crypto';",
    );
    expect(edges.filter((edge) => forbidden.test(edge))).toEqual([
      'node:fs/promises',
      'mysql2',
      'node:https',
    ]);
  });
  it('walks the entire first-party pipeline with no storage, network or host service import', () => {
    const pending = [resolve(import.meta.dirname, 'worker.ts')];
    const visited = new Set<string>();
    const denied: string[] = [];
    while (pending.length > 0) {
      const file = pending.pop();
      if (file === undefined || visited.has(file)) continue;
      visited.add(file);
      for (const edge of runtimeSpecifiers(readFileSync(file, 'utf8'))) {
        if (forbidden.test(edge)) denied.push(`${file}: ${edge}`);
        if (edge.startsWith('.')) pending.push(resolve(dirname(file), edge));
        else if (edge === '@iridium/markdown')
          pending.push(resolve(root, 'packages/markdown/src/index.ts'));
        else if (edge.startsWith('@iridium/contracts/'))
          pending.push(
            resolve(
              root,
              'packages/contracts/src',
              edge.slice('@iridium/contracts/'.length) + '.ts',
            ),
          );
        else if (edge.startsWith('@iridium/'))
          denied.push(`${file}: unexpected workspace capability ${edge}`);
      }
      if (
        file.replaceAll('\\', '/').includes('/apps/server/') &&
        !file.startsWith(import.meta.dirname)
      )
        denied.push(file);
    }
    expect([...visited].some((file) => file.endsWith('prescan.ts'))).toBe(true);
    expect(
      [...visited].some((file) => file.replaceAll('\\', '/').endsWith('sanitize/schema.ts')),
    ).toBe(true);
    expect(denied).toEqual([]);
  });
});
