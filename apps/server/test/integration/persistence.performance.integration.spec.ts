/** The real FIFO writer's 200-commit budget (10-testing-and-quality.md, micro-budgets). */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { arch, availableParallelism, platform } from 'node:os';
import { join, resolve } from 'node:path';

import { LIMITS, NoteId } from '@iridium/contracts';
import { dominates, getContent, stateVector } from '@iridium/crdt';
import { describe, expect, it } from 'vitest';

import { selectedMysqlLane } from '../db-mysql-container.ts';
import { startCollab } from '../support/collab-harness.ts';

const COMMIT_COUNT = 200;
const NOMINAL_P95_MS = 15;
// The 3× runner tolerance is specified by plan10, not selected from observed measurements.
const RUNNER_TOLERANCE = 3;
const EFFECTIVE_P95_MS = NOMINAL_P95_MS * RUNNER_TOLERANCE;

describe('persistence.performance.integration [hp:HP-1]', () => {
  it('commits 200 separate single-row writes durably within the stated p95 budget', async () => {
    const harness = await startCollab({ collab: { debounceMs: 60_000, maxDebounceMs: 60_000 } });
    const samples: Array<{ index: number; elapsedMs: number; committedSeq: number }> = [];
    try {
      const settings = await harness.sql.rows(
        'SELECT VERSION(), @@GLOBAL.innodb_flush_log_at_trx_commit',
      );
      const version = settings[0]?.[0];
      expect(version).toMatch(selectedMysqlLane().versionPattern);
      expect(settings[0]?.[1]).toBe('1');
      const cast = await harness.server.seed.kernel();
      const noteId = NoteId.parse(cast.note.id);
      const app = harness.application();
      const edit = await app.collab.gateway.openServerEdit(noteId, {
        principal: { kind: 'system', job: 'performance:writer' },
        permission: 'note:write',
        reason: 'repair',
      });
      try {
        const writer = app.collab.persistence.writerOf(noteId);
        if (writer === undefined)
          throw new Error('Performance measurement requires the real loaded NoteWriter.');
        await writer.drain();
        const before = await harness.committed(noteId);
        const suffixes = Array.from(
          { length: COMMIT_COUNT },
          (_, index) => `\nwriter-performance:${String(index).padStart(3, '0')}`,
        );
        for (const [index, suffix] of suffixes.entries()) {
          expect(writer.queueLength).toBe(0);
          expect(writer.lastCommittedSeq).toBe(before.head + index);
          const started = performance.now();
          edit.insertChunked(getContent(edit.document).length, suffix);
          // eslint-disable-next-line no-await-in-loop -- each sample must finish one durable transaction before the next enqueue
          await writer.drainAccepted();
          samples.push({
            index,
            elapsedMs: performance.now() - started,
            committedSeq: writer.lastCommittedSeq,
          });
          expect(writer.lastCommittedSeq).toBe(before.head + index + 1);
          // eslint-disable-next-line no-await-in-loop -- end the scheduler turn outside the measured interval before the next sample
          await app.collab.persistence.scheduler.idle();
          expect(writer.state).toBe('idle');
        }
        const after = await harness.committed(noteId);
        expect(after.head).toBe(before.head + COMMIT_COUNT);
        expect(after.text).toBe(before.text + suffixes.join(''));
        expect(dominates(after.sv, stateVector(edit.document))).toBe(true);
        expect(dominates(stateVector(edit.document), after.sv)).toBe(true);
        const updates = after.updates.filter((update) => update.seq > before.head);
        expect(updates).toHaveLength(COMMIT_COUNT);
        expect(updates.map((update) => update.seq)).toEqual(
          samples.map((sample) => sample.committedSeq),
        );
        expect(
          updates.every(
            (update) =>
              update.origin === 'repair' &&
              update.bytes > 0 &&
              update.bytes <= LIMITS.YJS_UPDATE_MAX_BYTES,
          ),
        ).toBe(true);
        expect(
          harness.logs.filter((line) => /persist\.failed|persist\.cas_mismatch/.test(line)),
        ).toEqual([]);
        const ordered = samples
          .map((sample) => sample.elapsedMs)
          .toSorted((left, right) => left - right);
        const p95 = ordered[Math.ceil(COMMIT_COUNT * 0.95) - 1];
        if (p95 === undefined)
          throw new Error('All 200 committed samples are required for the p95.');
        const root = resolve(import.meta.dirname, '../../../../');
        const directory = join(root, 'reports/perf');
        mkdirSync(directory, { recursive: true });
        const report = {
          metric: 'persistence.writer.commit.p95_ms',
          value: p95,
          unit: 'milliseconds',
          gitSha: execFileSync('git', ['rev-parse', 'HEAD'], {
            cwd: root,
            encoding: 'utf8',
          }).trim(),
          writerSha256: createHash('sha256')
            .update(
              readFileSync(new URL('../../src/collab/persistence/writer.ts', import.meta.url)),
            )
            .digest('hex'),
          storeSha256: createHash('sha256')
            .update(
              readFileSync(
                new URL('../../src/collab/persistence/kysely-store.ts', import.meta.url),
              ),
            )
            .digest('hex'),
          runnerClass: `${platform()}/${arch()}/${String(availableParallelism())}-cpu-affinity`,
          date: new Date().toISOString(),
          node: process.version,
          mysqlVersion: version,
          innodbFlushLogAtTrxCommit: 1,
          nominalP95Ms: NOMINAL_P95_MS,
          runnerTolerance: RUNNER_TOLERANCE,
          effectiveP95Ms: EFFECTIVE_P95_MS,
          percentile: 'nearest rank ceil(0.95 * 200)',
          warmupCommitsExcluded: 0,
          interval:
            'synchronous update creation/enqueue through NoteWriter.drainAccepted after COMMIT acknowledgement; includes FIFO/coalescing, excludes independent verification and socket polling',
          independentReplayMatches: true,
          initialHead: before.head,
          finalHead: after.head,
          updates: updates.map((update) => ({
            seq: update.seq,
            bytes: update.bytes,
            origin: update.origin,
          })),
          samples,
        };
        appendFileSync(
          join(directory, `persistence-performance-${String(process.pid)}.jsonl`),
          JSON.stringify(report) + '\n',
        );
        console.info(
          JSON.stringify({
            metric: report.metric,
            value: p95,
            nominalP95Ms: NOMINAL_P95_MS,
            runnerTolerance: RUNNER_TOLERANCE,
            effectiveP95Ms: EFFECTIVE_P95_MS,
            mysqlVersion: version,
            commits: samples.length,
          }),
        );
        expect(samples).toHaveLength(COMMIT_COUNT);
        expect(p95).toBeLessThan(EFFECTIVE_P95_MS);
      } finally {
        await edit.disconnect();
      }
    } finally {
      await harness.close();
    }
  });
});
