/**
 * The only way first-party code inserts a large string into a `Y.Text`.
 *
 * A 900 000-character CJK paste passes the UTF-16 note cap and is about 2.7 MB of UTF-8; as one
 * update it would be closed `too-large` and re-sent on every reconnect — an unbounded close/
 * reconnect loop with permanently unsavable text. Bounding the *producer* at
 * `INSERT_CHUNK_MAX_BYTES` makes the 1 MiB update cap unreachable rather than merely enforced
 * (05-collaboration-and-durability.md D05-16). Call sites: the editor's paste and drop handling, the
 * tree-item-drop link insert, import fix-ups, and the server's `DirectConnection` restore and repair
 * paths.
 */
import { LIMITS } from '@iridium/contracts';
import type * as Y from 'yjs';

import { CrdtError } from './errors.ts';
import { splitAtUtf8Bytes } from './unicode.ts';

/**
 * Insert `text` at `index`, one transaction per chunk, splitting only at code-point boundaries.
 *
 * Each chunk is at most `LIMITS.INSERT_CHUNK_MAX_BYTES` of UTF-8, so every update the pipeline
 * emits stays below `LIMITS.YJS_UPDATE_MAX_BYTES`. An empty `text` is a no-op and opens no
 * transaction. A `Y.Text` that is not integrated into a `Y.Doc` is refused rather than silently
 * losing `origin`: the origin is the routing key of the whole persistence pipeline, and an update
 * with no declared provenance is never persisted (05-collaboration-and-durability.md D05-08).
 */
export function insertChunked(ytext: Y.Text, index: number, text: string, origin: unknown): void {
  if (text.length === 0) return;
  const doc = ytext.doc;
  if (doc === null) {
    throw new CrdtError(
      'detached-text',
      'insertChunked needs a Y.Text integrated into a Y.Doc, so each chunk carries its origin',
    );
  }
  let at = index;
  for (const chunk of splitAtUtf8Bytes(text, LIMITS.INSERT_CHUNK_MAX_BYTES)) {
    doc.transact(() => {
      ytext.insert(at, chunk);
    }, origin);
    at += chunk.length;
  }
}
