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
  sameDocumentState,
  stateVector,
  stateVectorFromV1,
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
export { deleteSetFingerprint, EMPTY_DELETE_SET_FINGERPRINT } from './durability.ts';
export { CrdtError, type CrdtErrorCode } from './errors.ts';
export {
  decodeAwarenessEntries,
  decodeSyncUpdate,
  FRAME_TYPE,
  peekFrame,
  peekStatelessPayload,
  peekSyncType,
  SYNC_TYPE,
  type AwarenessFrameEntry,
  type FrameHeader,
} from './frame.ts';
export { assertLfOnly, assertNoAttributes, assertWithinCaps, type CapSubject } from './guards.ts';
export { initialNoteState, type InitialNoteState } from './initial-state.ts';
export { insertChunked } from './insert-chunked.ts';
export { prefixSuffixDiff, type TextDiff } from './prefix-suffix-diff.ts';
export { relativePositionAt, resolveRelativePosition } from './positions.ts';
export { scanHostileContent, type HostileContentScan } from './scan.ts';
export { encodeSyncStep1, receiveSyncMessage, type SyncMessageResult } from './sync.ts';
export { createUndoManager, type CreateUndoManagerOptions } from './undo.ts';
// The yjs instance types the consumers name (07-client-applications.md §5.2 and its dependency
// table): they reach them through this package, never through a `yjs` import of their own (A14).
export type { Doc as NoteDoc, Text as NoteText, UndoManager as NoteUndoManager } from 'yjs';
