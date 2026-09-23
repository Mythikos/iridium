import type { FaultPoint, NoteClient } from '@iridium/testkit';
import { expect } from 'vitest';

import type { CollabHarness } from './collab-harness.ts';

/** The canonical PR/nightly budgets from the CH table, never lowered by a local override. */
export const NIGHTLY_CHAOS = Number(process.env['IRIDIUM_CHAOS_ITERATIONS'] ?? '20') >= 200;
export const CRASH_ITERATIONS = NIGHTLY_CHAOS ? 200 : 20;
export const FAULT_ITERATIONS = NIGHTLY_CHAOS ? 20 : 1;
export const ROUTINE_ITERATIONS = NIGHTLY_CHAOS ? 5 : 1;

/**
 * A reconnect in this project follows a kill or a toxic, so the wait covers the server coming back
 * as well as the socket. The client default of 35 s is sized for an ordinary reconnect and expired
 * on a shared runner while the restart was still in progress; the project budgets a whole iteration
 * at 180 s, so this still leaves half of it and fails long before the test does.
 */
export const CHAOS_RECONNECT = { timeoutMs: 90_000 } as const;

/** How many of the harness's own log lines a fault that never fired reports for diagnosis. */
const FAULT_DIAGNOSTIC_LINES = 15;

/** The budget for either shape of evidence. */
const FAULT_EVIDENCE_TIMEOUT_MS = 60_000;

/** Awaits one shape of evidence that the product reached an armed point, or explains what it saw. */
async function waitFaultEvidence(
  harness: CollabHarness,
  point: FaultPoint,
  after: number,
  evidence: () => boolean,
  expected: string,
): Promise<void> {
  try {
    // The wait is for the product to reach the armed point, which means a real request reaching a
    // real commit; on a two-core runner sharing its I/O with the rest of the lane that took longer
    // than the ten seconds this once allowed. The chaos project budgets a whole iteration at 180 s,
    // so a minute still fails fast; it just stops reporting a slow runner as a broken hard property.
    await expect.poll(evidence, { timeout: FAULT_EVIDENCE_TIMEOUT_MS }).toBe(true);
  } catch (error) {
    // "expected false to be true" says nothing about why, and each occurrence otherwise costs a
    // full lane to guess at. The level is `warn`, so an empty window is itself a finding: a request
    // that merely succeeded says nothing, and one refused or still waiting says a great deal.
    const window = harness.logs.slice(after);
    const shown = (window.length > 0 ? window : harness.logs).slice(-FAULT_DIAGNOSTIC_LINES);
    const account = [
      `the armed fault ${point} produced no ${expected}`,
      `${String(window.length)} line(s) logged after it was armed, ${String(harness.logs.length)} in all`,
      `the server's exit is ${JSON.stringify(harness.server.lastExit)}`,
      `its last ${String(shown.length)} line(s):`,
    ].join('; ');
    throw new Error(`${account}\n${shown.join('\n')}`, { cause: error });
  }
}

/** Whether the server logged that it consumed `point` after `after`. */
function faultLogged(harness: CollabHarness, point: FaultPoint, after: number): boolean {
  return harness.logs
    .slice(after)
    .some((line) => line.includes('"event":"fault.fired"') && line.includes(`"point":"${point}"`));
}

/** Observe the product fault consumption, which precedes its delay, throw or hold. */
export async function waitFault(
  harness: CollabHarness,
  point: FaultPoint,
  after = 0,
): Promise<void> {
  await waitFaultEvidence(
    harness,
    point,
    after,
    () => faultLogged(harness, point, after),
    'log line',
  );
}

/**
 * Observe a **crash** point, whose consumption the log cannot be relied on to carry.
 *
 * `FaultRegistry.crash()` logs and then `SIGKILL`s this process on the same tick — "no `finally`,
 * no drain, no flush — that is the point (HP-2)" — so the two lines it writes race the kill, and
 * about one iteration in twenty loses them. The exit is the stronger evidence in any case: nothing
 * else ends this server, and only a fired point reaches the kill inside `crash()`.
 */
export async function waitCrashFault(
  harness: CollabHarness,
  point: FaultPoint,
  after = 0,
): Promise<void> {
  await waitFaultEvidence(
    harness,
    point,
    after,
    () => {
      const exit = harness.server.lastExit;
      return faultLogged(harness, point, after) || (exit !== null && exit.code !== 0);
    },
    'log line and no crash',
  );
}

/** A save event must cover the complete local state, including remote client clocks. */
export function persistedCount(client: NoteClient): number {
  return client.stateless.filter((message) => message.t === 'persisted').length;
}
