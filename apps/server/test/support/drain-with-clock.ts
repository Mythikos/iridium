/** Real shutdown completion for fixtures that control product timers but retain real SQL and sockets. */
import { performance } from 'node:perf_hooks';

import { waitFor } from '@iridium/testkit';
import type { FastifyInstance } from 'fastify';

import type { ManualClock } from './manual-clock.ts';

/** Advance only injected product time until the actual drain settles, then propagate any failure. */
export async function drainWithClock(
  app: Pick<FastifyInstance, 'drain'>,
  clock?: ManualClock,
): Promise<void> {
  const draining = app.drain();
  if (clock !== undefined) {
    let settled = false;
    void draining.then(
      () => {
        return (settled = true);
      },
      () => {
        return (settled = true);
      },
    );
    let previousTick = performance.now();
    // Shutdown includes real SQL and sockets. Pace the injected clock with elapsed host time so a
    // pending acquisition retains its actual deadline, and deliver overdue periodic work once:
    // replaying every interval after a test's jump() can otherwise run timers ahead of that I/O.
    // afterAll has no active Vitest test, so the harness poll works in both hooks and test bodies.
    await waitFor(
      async () => {
        const now = performance.now();
        const elapsed = now - previousTick;
        previousTick = now;
        await clock.stall(elapsed);
        return settled;
      },
      {
        timeoutMs: 25_000,
        intervalMs: 10,
        description: 'the real shutdown drain with controlled timers',
      },
    );
  }
  await draining;
}
