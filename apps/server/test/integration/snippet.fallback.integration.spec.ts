/** The second snippet stage uses the actual bounded parser worker and exact source addresses. */
import { LIMITS, type ParsedSearchQuery } from '@iridium/contracts';
import { describe, expect, it } from 'vitest';

import { systemClock } from '../../src/ops/clock.ts';
import { ProjectionPool } from '../../src/projection/pool.ts';
import { SnippetBuilder } from '../../src/search/snippets.ts';
import { ManualClock } from '../support/manual-clock.ts';

const QUERY: ParsedSearchQuery = {
  raw: 'term',
  terms: ['term'],
  phrases: [],
  negations: [],
  operators: {},
};

describe('snippet.fallback.integration [area:search]', () => {
  it('maps a formatted match across emphasis to its original line and highlight ranges', async () => {
    const pool = new ProjectionPool({
      workers: 1,
      timeoutMs: LIMITS.PROJECTION_TIMEOUT_SERVER_MS,
      clock: systemClock,
    });
    const builder = new SnippetBuilder({ pool, clock: systemClock });
    try {
      expect(
        await builder.buildForRevision({
          noteId: 'note',
          revision: 1,
          markdown: 'Preamble\n\n**ter**m',
          contentHash: 'hash',
          query: QUERY,
        }),
      ).toEqual([
        {
          line: 3,
          text: '**ter**m',
          ranges: [
            { start: 2, end: 5 },
            { start: 7, end: 8 },
          ],
        },
      ]);
    } finally {
      await pool.close();
    }
  });
  it('keeps a metadata-only match empty instead of manufacturing an unrelated body excerpt', async () => {
    const pool = new ProjectionPool({
      workers: 1,
      timeoutMs: LIMITS.PROJECTION_TIMEOUT_SERVER_MS,
      clock: systemClock,
    });
    const builder = new SnippetBuilder({ pool, clock: systemClock });
    try {
      expect(
        await builder.buildForRevision({
          noteId: 'note',
          revision: 1,
          markdown: '---\nterm: metadata\n---\nUnrelated body',
          frontmatterRaw: 'term: metadata\n',
          contentHash: 'hash',
          query: QUERY,
        }),
      ).toEqual([]);
    } finally {
      await pool.close();
    }
  });
  it('returns the documented empty fallback after the host terminates a real worker request', async () => {
    const clock = new ManualClock();
    const pool = new ProjectionPool({
      workers: 1,
      timeoutMs: LIMITS.PROJECTION_TIMEOUT_SERVER_MS,
      clock,
    });
    const builder = new SnippetBuilder({ pool, clock });
    try {
      const pending = builder.buildForRevision({
        noteId: 'note',
        revision: 1,
        markdown: '**ter**m',
        contentHash: 'hash',
        query: QUERY,
      });
      expect(pool.pending).toBe(1);
      await clock.advance(LIMITS.PROJECTION_TIMEOUT_SERVER_MS);
      await expect(pending).resolves.toEqual([]);
      expect(pool.pending).toBe(0);
    } finally {
      await pool.close();
    }
  });
});
