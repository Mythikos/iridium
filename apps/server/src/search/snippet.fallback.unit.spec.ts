/** The mapped-worker fallback: source-scanned snippets when projection output is unavailable. */
import { LIMITS, type ParsedSearchQuery } from '@iridium/contracts';
import { describe, expect, it, vi } from 'vitest';

import { ManualClock } from '../../test/support/manual-clock.ts';
import { ProjectionPool, ProjectionQueueFull, ProjectionTimedOut } from '../projection/pool.ts';
import mappedSnippetTask from './mapped-snippet.worker.ts';
import { sourceSnippets } from './snippet-text.ts';
import { SnippetBuilder, type SnippetRequest } from './snippets.ts';

function query(terms: string[], phrases: string[] = []): ParsedSearchQuery {
  return {
    raw: [...terms, ...phrases.map((phrase) => `"${phrase}"`)].join(' '),
    terms,
    phrases,
    negations: [],
    operators: {},
  };
}

describe('snippet.fallback.unit [area:search]', () => {
  it.each([
    { markdown: '**ter**m', parsed: query(['term']), lines: [1], highlights: ['ter', 'm'] },
    {
      markdown: 'a wrapped\nphrase here',
      parsed: query([], ['wrapped phrase']),
      lines: [1, 2],
      highlights: ['wrapped', 'phrase'],
    },
    {
      markdown: '| **al**pha | other |\n| --- | --- |\n| value | cell |',
      parsed: query(['alpha']),
      lines: [1],
      highlights: ['al', 'pha'],
    },
    {
      markdown: '![image &amp; alt](picture.png)',
      parsed: query([], ['image & alt']),
      lines: [1],
      highlights: ['image &', ' alt'],
    },
  ])('maps $markdown back to source highlights', ({ markdown, parsed, lines, highlights }) => {
    expect(sourceSnippets(markdown, parsed)).toEqual([]);
    const snippets = mappedSnippetTask({
      markdown,
      query: parsed,
      snippetChars: LIMITS.SNIPPET_MAX_CHARS,
    });
    expect(snippets.map((snippet) => snippet.line)).toEqual(lines);
    expect(
      snippets.flatMap(
        (snippet) =>
          snippet.ranges?.map((range) => snippet.text.slice(range.start, range.end)) ?? [],
      ),
    ).toEqual(highlights);
  });
  it('returns no fabricated excerpt when only metadata matches or the parser refuses admission', () => {
    expect(
      mappedSnippetTask({
        markdown: '---\nterm: metadata\n---\nbody',
        query: query(['term']),
        snippetChars: LIMITS.SNIPPET_MAX_CHARS,
      }),
    ).toEqual([]);
    expect(
      mappedSnippetTask({
        markdown: '>'.repeat(100) + ' term',
        query: query(['term']),
        snippetChars: LIMITS.SNIPPET_MAX_CHARS,
      }),
    ).toEqual([]);
  });
  it('caches by revision/query/size and expires without sleeping', async () => {
    const clock = new ManualClock();
    const pool = new ProjectionPool({ workers: 1, timeoutMs: 1_000, clock });
    const run = vi
      .spyOn(pool, 'run')
      .mockResolvedValue([{ line: 1, text: '**ter**m', ranges: [] }]);
    const builder = new SnippetBuilder({ pool, clock });
    const request: SnippetRequest = {
      noteId: 'note',
      revision: 1,
      markdown: '**ter**m',
      contentHash: 'hash',
      query: query(['term']),
    };
    await builder.buildForRevision(request);
    await builder.buildForRevision(request);
    expect(run).toHaveBeenCalledTimes(1);
    await builder.buildForRevision({ ...request, revision: 2 });
    expect(run).toHaveBeenCalledTimes(2);
    await clock.advance(LIMITS.SNIPPET_CACHE_TTL_MS);
    await builder.buildForRevision(request);
    expect(run).toHaveBeenCalledTimes(3);
    await pool.close();
  });
  it('bounds the LRU and does not turn worker saturation into a failed search', async () => {
    const clock = new ManualClock();
    const pool = new ProjectionPool({ workers: 1, timeoutMs: 1_000, clock });
    const run = vi.spyOn(pool, 'run').mockResolvedValue([]);
    const builder = new SnippetBuilder({ pool, clock });
    const request: SnippetRequest = {
      noteId: 'note',
      revision: 1,
      markdown: '**ter**m',
      contentHash: 'hash',
      query: query(['term']),
    };
    for (let revision = 1; revision <= LIMITS.SNIPPET_CACHE_MAX + 1; revision += 1) {
      // eslint-disable-next-line no-await-in-loop -- insertion order is the LRU behavior under test.
      await builder.buildForRevision({ ...request, revision });
    }
    await builder.buildForRevision(request);
    expect(run).toHaveBeenCalledTimes(LIMITS.SNIPPET_CACHE_MAX + 2);
    run.mockRejectedValueOnce(new ProjectionQueueFull());
    await expect(builder.buildForRevision({ ...request, revision: 2_000 })).resolves.toEqual([]);
    run.mockRejectedValueOnce(new ProjectionTimedOut(1_000));
    await expect(builder.buildForRevision({ ...request, revision: 2_001 })).resolves.toEqual([]);
    await pool.close();
  });
});
