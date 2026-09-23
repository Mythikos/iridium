/**
 * Awaiting real server work from a fixture that owns the server's `Clock`.
 *
 * A fixture that injects a `ManualClock` owns every deadline armed on it: the writer's backoff
 * retry, its unload retry, the compaction await of `COMPACTION_AWAIT_TIMEOUT_MS`, the closing
 * grace and the pool-acquisition deadline are all `clock.after(...)`. A request that waits for a
 * writer to reach disposal — trash and purge both do (02-system-architecture.md §"Trash and
 * purge") — therefore makes progress only while the test moves that clock, and a test that only
 * `jump()`s leaves every one of those timers armed and unfired. The await then has no bound at
 * all and expires as an anonymous test timeout rather than as the documented refusal.
 *
 * Pacing injected time with elapsed host time restores the production behaviour without replaying
 * a `jump()`'s worth of intervals: `stall()` delivers each overdue callback once.
 */
import { performance } from 'node:perf_hooks';

import { waitFor } from '@iridium/testkit';

import type { ManualClock } from './manual-clock.ts';

/** The ceiling a paced await carries when its caller states none. */
const PACED_TIMEOUT_MS_DEFAULT = 25_000;

/** Options for {@link withPacedClock}. */
export interface PacedClockOptions {
  /** What the await is for, used verbatim in the timeout message. */
  readonly description: string;
  /** The ceiling on the whole paced await. */
  readonly timeoutMs?: number;
}

/**
 * Awaits `operation` while injected product time keeps pace with the host clock.
 *
 * @param clock the fixture's clock, the one `buildApp({ clock })` received
 * @param operation real server work already in flight
 * @param options the description and ceiling the timeout message carries
 * @returns the operation's own result, or its own failure
 */
export async function withPacedClock<T>(
  clock: ManualClock,
  operation: Promise<T>,
  options: PacedClockOptions,
): Promise<T> {
  let settled = false;
  void operation.then(
    () => {
      return (settled = true);
    },
    () => {
      return (settled = true);
    },
  );
  let previousTick = performance.now();
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
      timeoutMs: options.timeoutMs ?? PACED_TIMEOUT_MS_DEFAULT,
      intervalMs: 10,
      description: options.description,
    },
  );
  return await operation;
}
