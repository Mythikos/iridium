/**
 * `@iridium/crdt` — the only first-party package that imports `yjs`, `y-protocols` or `lib0`.
 *
 * Server persistence (`apps/server/src/collab/persistence/**`), `@iridium/collab-client` and
 * `@iridium/editor` consume this API instead; a lint rule fails the build on any other `yjs` import
 * and the Yjs v14 migration is therefore a one-package change plus the `note_docs.yjs_major` marker
 * (13-decision-log.md A14). The package is isomorphic and side-effect free: no DOM, no `node:*`, no
 * counters and no logging — the metrics that belong to a degradation belong to its call sites.
 */
export {
  applyV1,
  decodeStateVector,
  encodeState,
  loadState,
  mergeV1,
  recordedSv,
  stateVector,
  storedSv,
  SV_STORED_MAX_BYTES,
  type SnapshotFormat,
  type StateVector,
  type V1Update,
  type V2State,
} from './codec.ts';
export {
  CONTENT_KEY,
  createNoteDoc,
  getContent,
  INIT_ORIGIN,
  LOAD_ORIGIN,
  projectMarkdown,
  type CreateNoteDocOptions,
} from './doc.ts';
export { dominates } from './dominates.ts';
export { CrdtError, type CrdtErrorCode } from './errors.ts';
export { assertLfOnly, assertNoAttributes, assertWithinCaps, type CapSubject } from './guards.ts';
export { initialNoteState, type InitialNoteState } from './initial-state.ts';
export { insertChunked } from './insert-chunked.ts';
export { prefixSuffixDiff, type TextDiff } from './prefix-suffix-diff.ts';
export { scanHostileContent, type HostileContentScan } from './scan.ts';
