/**
 * The four collaboration counters the hooks, the socket layer and the writer move
 * (05-collaboration-and-durability.md, the observability table), as the slice of the process
 * registry they take. `ops/metrics.ts` declares every name, label and help string; nothing here
 * chooses one, and a unit suite hands a hook the same slice off a registry of its own.
 */
import type { Metrics } from '../ops/metrics.ts';

/** The counters a collaboration component moves. */
export type CollabMetrics = Pick<
  Metrics,
  | 'collabMessagesTotal'
  | 'collabHookErrorsTotal'
  | 'stateVectorOversizeTotal'
  | 'contentInvalidTotal'
>;
