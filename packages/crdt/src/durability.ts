/**
 * The deletion half of the Saved witness. A state vector records inserted clocks, so deleting
 * content can leave it unchanged. A canonical delete-set fingerprint records the other half of
 * a Yjs snapshot without retaining deleted content or adding synthetic metadata to the document.
 */
import { digest } from 'lib0/hash/sha256';
import * as Y from 'yjs';

function fingerprint(snapshot: Y.Snapshot): string {
  const canonical = Y.encodeSnapshot(Y.createSnapshot(snapshot.ds, new Map()));
  return Array.from(digest(canonical), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The canonical SHA-256 witness of a document with no deletions. */
export const EMPTY_DELETE_SET_FINGERPRINT: string = fingerprint(
  Y.createSnapshot(Y.createDeleteSet(), new Map()),
);

/**
 * SHA-256 of the canonical Yjs delete-set encoding, as exactly 64 lowercase hex characters.
 * Yjs merges adjacent deleted ranges and sorts client IDs during snapshot encoding, so replay
 * order and garbage collection do not change the witness. The state vector is excluded: the
 * Saved predicate separately requires committed-vector dominance and this fingerprint's equality.
 * No serialized history is retained and no asynchronous work can outlive the captured update.
 */
export function deleteSetFingerprint(doc: Y.Doc): string {
  const snapshot = Y.snapshot(doc);
  return snapshot.ds.clients.size === 0 ? EMPTY_DELETE_SET_FINGERPRINT : fingerprint(snapshot);
}
