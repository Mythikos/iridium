/** Real shutdown completion for fixtures that control product timers but retain real SQL and sockets. */
import type { FastifyInstance } from 'fastify';

import type { ManualClock } from './manual-clock.ts';
import { withPacedClock } from './paced-clock.ts';

/** Advance only injected product time until the actual drain settles, then propagate any failure. */
export async function drainWithClock(
  app: Pick<FastifyInstance, 'drain'>,
  clock?: ManualClock,
): Promise<void> {
  const draining = app.drain();
  if (clock === undefined) {
    await draining;
    return;
  }
  // Shutdown includes real SQL and sockets, so the drain is paced against host time: a pending
  // acquisition retains its actual deadline and overdue periodic work is delivered once.
  await withPacedClock(clock, draining, {
    description: 'the real shutdown drain with controlled timers',
  });
}
