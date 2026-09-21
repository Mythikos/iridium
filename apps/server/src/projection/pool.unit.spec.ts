/** Real worker admission, termination and replacement, with an injected clock and no timer sleeps. */
import { LIMITS } from '@iridium/contracts';
import { describe, expect, it } from 'vitest';

import { ManualClock } from '../../test/support/manual-clock.ts';
import { createLogger } from '../ops/logging.ts';
import { contentHash } from './hash.ts';
import {
  ProjectionPool,
  ProjectionPoolClosed,
  ProjectionQueueFull,
  ProjectionTimedOut,
} from './pool.ts';
import { createProjectionPreparer } from './prepare.ts';

const filename = new URL('../../test/support/projection-worker.fixture.mjs', import.meta.url).href;

describe('projection.pool.unit [area:projection]', () => {
  it('terminates uncooperative work at its deadline and serves the next task on a replacement worker', async () => {
    const clock = new ManualClock();
    const pool = new ProjectionPool({ workers: 1, timeoutMs: 100, clock, filename });
    try {
      const started = new SharedArrayBuffer(4);
      const timed = pool.run({ kind: 'spin', started });
      const outcome = timed.then(
        () => null,
        (error: unknown) => error,
      );
      await expect.poll(() => Atomics.load(new Int32Array(started), 0)).toBe(1);
      await clock.advance(100);
      expect(await outcome).toBeInstanceOf(ProjectionTimedOut);
      expect(pool.pending).toBe(0);
      expect(await pool.run({ value: 'replacement' })).toEqual({ value: 'replacement' });
      expect(clock.pendingTimers).toBe(0);
    } finally {
      await pool.close();
    }
  });

  it('bounds running plus queued work and converts overload into a source-preserving pending result', async () => {
    const clock = new ManualClock();
    const pool = new ProjectionPool({ workers: 1, timeoutMs: 10_000, clock, filename });
    const jobs = Array.from({ length: LIMITS.PROJECTION_QUEUE_MAX + 1 }, () =>
      pool.run({ kind: 'spin' }),
    );
    const settled = Promise.allSettled(jobs);
    try {
      expect(pool.pending).toBe(LIMITS.PROJECTION_QUEUE_MAX + 1);
      await expect(pool.run({ value: 'overflow' })).rejects.toBeInstanceOf(ProjectionQueueFull);
      const logger = createLogger({
        level: 'silent',
        format: 'json',
        instanceId: 'projection-pool-proof',
      });
      const prepare = createProjectionPreparer(pool, logger, clock, () => undefined);
      const result = await prepare('# Still readable\nraw source');
      expect(result).toMatchObject({
        status: 'pending',
        contentHash: contentHash('# Still readable\nraw source').toString('hex'),
        sizeChars: 27,
        lineCount: 2,
      });
      expect(result.headings).toEqual([]);
      expect(pool.pending).toBe(LIMITS.PROJECTION_QUEUE_MAX + 1);
    } finally {
      await pool.close();
      await settled;
    }
    expect(pool.pending).toBe(0);
    expect(clock.pendingTimers).toBe(0);
    await expect(pool.run({ value: 'after-close' })).rejects.toBeInstanceOf(ProjectionPoolClosed);
    await pool.close();
  });

  it('does not recreate an unused pool after shutdown', async () => {
    const pool = new ProjectionPool({
      workers: 1,
      timeoutMs: 100,
      clock: new ManualClock(),
      filename,
    });
    await pool.close();
    expect(pool.closed).toBe(true);
    await expect(pool.run({ value: 'forbidden' })).rejects.toBeInstanceOf(ProjectionPoolClosed);
  });
});
