/**
 * The dominance test behind *Saved*.
 *
 * `dominates(persisted, local)` is `true` iff the persisted state contains every `(clientID, clock)`
 * pair the local state has. Comparing whole vectors rather than the client's own clock is what makes
 * the acknowledgement immune to Hocuspocus issue #845 (a client ID that changes mid-session) and to
 * updates relayed from a second tab: both produce local clocks under a client ID the caller never
 * authored, and both must hold *Saved* back until the server has committed them
 * (13-decision-log.md A19; 05-collaboration-and-durability.md, "The Saved protocol").
 */
import { decodeStateVector, type StateVector } from './codec.ts';

function asClocks(vector: StateVector | Map<number, number>): Map<number, number> {
  return vector instanceof Map ? vector : decodeStateVector(vector);
}

/**
 * Does `persisted` contain everything `local` does?
 *
 * Pure, total and side-effect free: a missing client ID counts as clock 0, so a persisted vector
 * that has never seen a client never dominates that client's work.
 */
export function dominates(
  persisted: StateVector | Map<number, number>,
  local: StateVector | Map<number, number>,
): boolean {
  const persistedClocks = asClocks(persisted);
  const localClocks = asClocks(local);
  for (const [clientId, clock] of localClocks) {
    if ((persistedClocks.get(clientId) ?? 0) < clock) return false;
  }
  return true;
}
