// oxlint-disable typescript/no-unsafe-type-assertion -- an update a document emits is V1 by
// construction; the listener is the same seam the server's writer brands the bytes at.

/**
 * Driving a note document from a generated edit script, and capturing what it emits.
 *
 * The helpers are deliberately thin: the property files assert over the real package API, and the
 * only thing this module adds is the clamping that turns an arbitrary position into a legal one and
 * the `update` listener the durability path uses to observe what would be persisted.
 */
import type * as Y from 'yjs';

import type { V1Update } from '../src/codec.ts';
import { getContent } from '../src/doc.ts';
import type { Edit } from './arbitraries.ts';

/** Collect every V1 update a document emits from now on, in order. */
export function captureUpdates(doc: Y.Doc): V1Update[] {
  const updates: V1Update[] = [];
  doc.on('update', (update: Uint8Array) => {
    updates.push(update as V1Update);
  });
  return updates;
}

/** Apply an edit script to a document, one transaction per edit, with positions clamped. */
export function runEdits(doc: Y.Doc, script: readonly Edit[], origin: unknown): void {
  const text = getContent(doc);
  for (const edit of script) {
    doc.transact(() => {
      const length = text.length;
      const at = edit.at % (length + 1);
      if (edit.kind === 'insert') {
        text.insert(at, edit.text);
      } else {
        text.delete(at, Math.min(edit.length, length - at));
      }
    }, origin);
  }
}
