/** Measure the actual process-owned worker pool, including dispatch and returned projection. */
import { createHash } from 'node:crypto';

import { PIPELINE_VERSION, type NoteProjection } from '@iridium/markdown';
import { generateSearchCorpus } from '@iridium/testkit';
import { describe, expect, it } from 'vitest';

import { startCollab } from '../support/collab-harness.ts';
import { recordPerformance } from '../support/performance.ts';

describe('projection.performance.integration [area:content]', () => {
  it('projects a 100 KiB note through Piscina within the 250 ms p95 budget', async () => {
    const harness = await startCollab();
    try {
      const markdown = generateSearchCorpus()
        .slice(0, 200)
        .map((note) => note.markdown)
        .join('\n')
        .slice(0, 100 * 1024);
      expect(Buffer.byteLength(markdown)).toBe(100 * 1024);
      const contentHash = createHash('sha256').update(markdown).digest('hex');
      const pool = harness.application().projectionPool;
      const samples: number[] = [];
      for (let index = 0; index < 33; index += 1) {
        const started = performance.now();
        // eslint-disable-next-line no-await-in-loop -- one dispatch must finish before measuring the next
        const projected = await pool.run<NoteProjection>({
          markdown,
          pipelineVersion: PIPELINE_VERSION,
        });
        const elapsed = performance.now() - started;
        expect(projected.status).toBe('ok');
        expect(projected.contentHash).toBe(contentHash);
        expect(projected.bodyText).toContain('quasar');
        expect(projected.headings.length).toBeGreaterThan(30);
        if (index >= 3) samples.push(elapsed);
      }
      const p95 = recordPerformance('projection.worker.p95_ms', samples, {
        sourceBytes: Buffer.byteLength(markdown),
        sourceSha256: contentHash,
        budgetMs: 250,
        warmupSamples: 3,
        pipelineVersion: PIPELINE_VERSION,
        interval: 'pool.run dispatch through returned projection; includes structured cloning',
      });
      expect(p95).toBeLessThan(250);
      expect(pool.pending).toBe(0);
    } finally {
      await harness.close();
    }
  });
});
