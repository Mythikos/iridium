/** The corpus-5k budget uses product writes and real authorized FULLTEXT reads. */
import { createHash } from 'node:crypto';

import { type SearchPage } from '@iridium/contracts';
import { generateSearchCorpus, SEARCH_CORPUS_SIZE, SEARCH_CORPUS_QUERIES } from '@iridium/testkit';
import { describe, expect, it } from 'vitest';

import { idBytes } from '../../src/auth/ids.ts';
import { startCollab } from '../support/collab-harness.ts';
import { recordPerformance } from '../support/performance.ts';
import { createStructureWriter } from '../support/seed-structure.ts';

describe('search.performance.integration [area:search]', () => {
  it('builds and executes queries over 5000 projected notes within the 200 ms p95 budget', async () => {
    const harness = await startCollab();
    try {
      const admin = await harness.server.seed.admin();
      const vault = await harness.server.seed.vault({ name: 'corpus-5k' });
      const create = createStructureWriter(harness.application());
      const corpus = generateSearchCorpus();
      const corpusHash = createHash('sha256');
      for (const [index, note] of corpus.entries()) {
        corpusHash.update(note.markdown);
        // eslint-disable-next-line no-await-in-loop -- bounded real structural transactions, never fixture SQL
        await create({
          vaultId: vault.id,
          parentId: vault.rootNodeId,
          name: note.name,
          kind: 'note',
          markdown: note.markdown,
          actor: { userId: admin.id, sessionId: admin.sessionId, displayName: admin.displayName },
        });
        if ((index + 1) % 1000 === 0)
          console.info(`[corpus-5k] ${String(index + 1)} notes committed`);
      }
      const db = harness.application().database.dbApp;
      if (db === null) throw new Error('The search budget needs a real database.');
      const count = await db
        .selectFrom('note_search')
        .select((eb) => eb.fn.countAll<number>().as('total'))
        .where('vault_id', '=', idBytes(vault.id))
        .executeTakeFirstOrThrow();
      expect(count.total).toBe(SEARCH_CORPUS_SIZE);
      const samples: number[] = [];
      const timings: Array<{ query: string; elapsedMs: number }> = [];
      for (let index = 0; index < 35; index += 1) {
        const query = SEARCH_CORPUS_QUERIES[index % SEARCH_CORPUS_QUERIES.length];
        if (query === undefined) throw new Error('Every measured run needs a known query.');
        const started = performance.now();
        // eslint-disable-next-line no-await-in-loop -- individual round trips, with one warm-up per query
        const response = await admin.client.get<SearchPage>(
          `/vaults/${vault.id}/search?q=${encodeURIComponent(query)}&limit=25`,
        );
        const elapsed = performance.now() - started;
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        expect(response.body.results).toHaveLength(25);
        expect(response.body.results.every((hit) => hit.vaultId === vault.id && !hit.stale)).toBe(
          true,
        );
        expect(response.body.nextCursor).toBeDefined();
        if (index >= SEARCH_CORPUS_QUERIES.length) {
          samples.push(elapsed);
          timings.push({ query, elapsedMs: elapsed });
        }
      }
      const p95 = recordPerformance('search.corpus-5k.p95_ms', samples, {
        fixture: 'corpus-5k',
        notes: SEARCH_CORPUS_SIZE,
        sourceSha256: corpusHash.digest('hex'),
        budgetMs: 200,
        warmupSamples: SEARCH_CORPUS_QUERIES.length,
        timings,
        interval:
          'complete public HTTP request, including authorization, grammar, FULLTEXT, snippets and JSON',
      });
      expect(p95).toBeLessThan(200);
    } finally {
      await harness.close();
    }
  }, 900_000);
});
