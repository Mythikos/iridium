import type { StateVector } from '@iridium/crdt';

/** Brands fixture/recorded vector bytes for test oracles; production reconstructs committed state. */
export function asStateVector(bytes: Uint8Array): StateVector {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- fixture bytes deliberately cover valid and degraded Yjs vectors.
  return bytes as StateVector;
}
