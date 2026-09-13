/**
 * Hostile-content detection: the content of record must be a plain `Y.Text`.
 *
 * `Y.Text` is a rich-text type — it can carry formatting attributes (`ContentFormat`) and embedded
 * objects (`ContentEmbed`) — and `toString()` drops both silently, so a client that speaks the Yjs
 * protocol correctly but the Iridium contract incorrectly can hold content that no projection,
 * search index, export or agent read will ever show. A `\r` is the second failure: CodeMirror treats
 * `\r\n` as one position while `Y.Text` counts two UTF-16 units, so every relative position after it
 * drifts permanently. Neither is catchable by the sync protocol, because both are valid CRDT
 * operations; the check therefore runs at compaction, at load and around a repair, never per
 * keystroke (05-collaboration-and-durability.md, "Hostile CRDT content").
 */
import type * as Y from 'yjs';

import { getContent, projectMarkdown } from './doc.ts';

interface DeltaOp {
  readonly insert?: unknown;
  readonly attributes?: unknown;
}

/** The verdict of `scanHostileContent`. */
export type HostileContentScan = { ok: true } | { ok: false; reason: 'cr' | 'attributes' };

/**
 * Does the body hold anything other than plain string inserts?
 *
 * An embed (`insert` is not a string) and a formatting run (`attributes` present) are one defect
 * with one reason, because the consequence is identical: content the projection cannot see.
 */
export function hasNonPlainContent(doc: Y.Doc): boolean {
  const delta: DeltaOp[] = getContent(doc).toDelta();
  for (const op of delta) {
    if (typeof op.insert !== 'string') return true;
    if (op.attributes !== undefined) return true;
  }
  return false;
}

/**
 * Scan a note document for content the Markdown projection could not represent.
 *
 * On a plain document `toDelta()` is a single `{insert: string}` entry, so the normal case is O(1)
 * allocations plus one string scan for `\r` — the same string the compactor is about to hash and
 * store anyway.
 */
export function scanHostileContent(doc: Y.Doc): HostileContentScan {
  if (hasNonPlainContent(doc)) return { ok: false, reason: 'attributes' };
  if (projectMarkdown(doc).includes('\r')) return { ok: false, reason: 'cr' };
  return { ok: true };
}
