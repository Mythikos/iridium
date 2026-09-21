/** Focused diagnostics for independent parser compatibility; never used by the product. */
import { readFile } from 'node:fs/promises';

import { parseMarkdownIt } from '../src/markdown-it/parser.ts';
import { parseRemarkBaseline } from './remark-baseline.ts';

const corpus = JSON.parse(
  await readFile(new URL('../fixtures/commonmark-0.31.2.json', import.meta.url), 'utf8'),
);
function differences(before, after, path = '') {
  if (Object.is(before, after)) return [];
  if (before === null || after === null || typeof before !== 'object' || typeof after !== 'object')
    return [{ path, before, after }];
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap((key) =>
    differences(before[key], after[key], `${path}/${key}`),
  );
}
for (const entry of corpus) {
  const changes = differences(parseRemarkBaseline(entry.markdown), parseMarkdownIt(entry.markdown));
  if (changes.length > 0)
    process.stdout.write(
      `${JSON.stringify({ example: entry.example, source: entry.markdown, changes: changes.slice(0, 6), total: changes.length })}\n`,
    );
}
