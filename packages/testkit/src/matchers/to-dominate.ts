/**
 * `expect(sv).toDominate(other)` — the HP-1 assertion
 * (10-testing-and-quality.md, "Matchers and oracles": *"`@iridium/crdt.dominates(a, b)` with a
 * readable diff of the first offending `clientID → clock` pair"*).
 *
 * Dominance is the whole of the Saved protocol: *"Saved" means a MySQL transaction containing the
 * user's edits has committed and the server has broadcast a state vector that dominates the client's*
 * (principle 1, skeleton A19). A test that compared sequence numbers or byte lengths instead would
 * pass for an acknowledgement that is missing one client's clock entirely, which is precisely the
 * false *Saved* the protocol exists to prevent — so the comparison is `@iridium/crdt`'s own, the same
 * function the client's `SaveStateMachine` calls.
 *
 * The diff matters as much as the verdict. `a does not dominate b` tells a reader nothing; *"client
 * 3420154612 is at clock 7 in the received vector and 9 in the expected one"* tells them which peer's
 * update never reached the writer.
 */

import { decodeStateVector, dominates, type StateVector } from '@iridium/crdt';
import { expect } from 'vitest';

/** What a decoded state vector looks like: one clock per `clientID`. */
type Clocks = ReadonlyMap<number, number>;

/**
 * The branding boundary of A14: the wire and `NoteClient.sv()` both carry a state vector as plain
 * bytes, and `@iridium/crdt` brands the same bytes. The brand is a compile-time marker that adds no
 * runtime check, so the only honest check is the one above it — that these are bytes at all.
 */
function asStateVector(value: unknown, label: string): StateVector {
  if (!(value instanceof Uint8Array)) {
    throw new TypeError(`@iridium/testkit: toDominate expects ${label} to be a Uint8Array`);
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the branding boundary; see above
  return value as StateVector;
}

/** The first client the candidate does not cover, and the two clocks, for the message. */
function firstGap(
  candidate: Clocks,
  required: Clocks,
): { clientId: number; candidateClock: number; requiredClock: number } | null {
  for (const [clientId, requiredClock] of required) {
    const candidateClock = candidate.get(clientId) ?? 0;
    if (candidateClock < requiredClock) return { clientId, candidateClock, requiredClock };
  }
  return null;
}

declare module 'vitest' {
  interface Matchers<R extends void | Promise<void> = void | Promise<void>, T = unknown> {
    /**
     * Assert that the received state vector dominates `other`: for every `clientID` in `other`, the
     * received vector's clock is at least as high.
     */
    toDominate(other: Uint8Array): R;
  }
}

/** Register `toDominate` on the global `expect`. Called once per worker, from a setup file. */
export function registerDominanceMatcher(): void {
  expect.extend({
    toDominate(received: unknown, other: unknown) {
      const candidate = asStateVector(received, 'the received value');
      const required = asStateVector(other, 'the expected value');
      const pass = dominates(candidate, required);
      if (pass) {
        return { pass: true, message: (): string => 'the received vector dominates the other' };
      }
      const gap = firstGap(decodeStateVector(candidate), decodeStateVector(required));
      const detail =
        gap === null
          ? 'no clock is lower, so the two vectors differ only in encoding'
          : `client ${String(gap.clientId)} is at clock ${String(gap.candidateClock)} in the received vector and ${String(gap.requiredClock)} in the expected one`;
      return {
        pass: false,
        message: (): string => `the received vector does not dominate the other: ${detail}`,
      };
    },
  });
}
