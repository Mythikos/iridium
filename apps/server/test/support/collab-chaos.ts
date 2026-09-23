import type { FaultPoint, NoteClient } from '@iridium/testkit';
import { expect } from 'vitest';

import type { CollabHarness } from './collab-harness.ts';

/** The canonical PR/nightly budgets from the CH table, never lowered by a local override. */
export const NIGHTLY_CHAOS = Number(process.env['IRIDIUM_CHAOS_ITERATIONS'] ?? '20') >= 200;
export const CRASH_ITERATIONS = NIGHTLY_CHAOS ? 200 : 20;
export const FAULT_ITERATIONS = NIGHTLY_CHAOS ? 20 : 1;
export const ROUTINE_ITERATIONS = NIGHTLY_CHAOS ? 5 : 1;

/** Observe the product fault consumption, which precedes its delay, throw or kill. */
export async function waitFault(
  harness: CollabHarness,
  point: FaultPoint,
  after = 0,
): Promise<void> {
  await expect
    .poll(
      () =>
        harness.logs
          .slice(after)
          .some(
            (line) => line.includes('"event":"fault.fired"') && line.includes(`"point":"${point}"`),
          ),
      // The wait is for the product to reach the armed point and log its consumption, which means
      // a real request reaching a real commit. On a two-core runner sharing its I/O with the rest
      // of the lane that took longer than ten seconds, and the poll failed before any durability
      // assertion ran. The chaos project budgets a whole iteration at 180 s, so this still fails
      // fast; it just stops reporting a slow runner as a broken hard property.
      { timeout: 60_000 },
    )
    .toBe(true);
}

/** A save event must cover the complete local state, including remote client clocks. */
export function persistedCount(client: NoteClient): number {
  return client.stateless.filter((message) => message.t === 'persisted').length;
}
