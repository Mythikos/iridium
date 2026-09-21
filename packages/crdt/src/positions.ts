/** Cursor anchors retain CRDT identity across server edits and concurrent insertions (D05-21). */
import * as Y from 'yjs';

/** Encodes an anchor in an existing text; persistence never converts that identity to an offset. */
export function relativePositionAt(text: Y.Text, index: number): Uint8Array {
  return Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, index));
}

/** Resolves an encoded anchor after edits; a missing type or item has no current position. */
export function resolveRelativePosition(
  doc: Y.Doc,
  bytes: Uint8Array,
): { readonly index: number } | null {
  const position = Y.createAbsolutePositionFromRelativePosition(
    Y.decodeRelativePosition(bytes),
    doc,
  );
  return position === null ? null : { index: position.index };
}
