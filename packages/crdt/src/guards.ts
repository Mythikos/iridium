import { LIMITS } from '@iridium/contracts';
/**
 * The package's content guards: defence in depth behind `normalizeSource()` and the chunker.
 *
 * Each one accepts valid state and throws a typed `CrdtError` on the defect it owns, so a call site
 * fails at the point the invariant breaks rather than at the compaction that would have detected it
 * (05-collaboration-and-durability.md, "Defences at the entry points").
 */
import type * as Y from 'yjs';

import { CrdtError } from './errors.ts';
import { hasNonPlainContent } from './scan.ts';
import { utf8ByteLength } from './unicode.ts';

const BOM = 0xfeff;

/**
 * The text is LF-only and BOM-free.
 *
 * `normalizeSource()` has already converted the line endings and stripped the BOM at every one of
 * the four text-entry points; this is the assertion that the conversion actually happened, and it is
 * what `initialNoteState` runs before a single byte reaches a `Y.Doc`.
 */
export function assertLfOnly(text: string): void {
  if (text.includes('\r')) {
    throw new CrdtError('cr', 'note text is LF-only; a carriage return desynchronises positions');
  }
  if (text.charCodeAt(0) === BOM) {
    throw new CrdtError('bom', 'note text is BOM-free; normalizeSource strips the byte order mark');
  }
}

/**
 * The body is plain text: no formatting attributes, no embeds.
 *
 * `Y.Text.toString()` drops both silently, so accepting them would mean the CRDT and every
 * projection of it disagree about what the note says.
 */
export function assertNoAttributes(doc: Y.Doc): void {
  if (hasNonPlainContent(doc)) {
    throw new CrdtError(
      'attributes',
      'note content carries a formatting attribute or an embed, which the Markdown projection drops',
    );
  }
}

/** What `assertWithinCaps` can be handed. Each member is checked against its own cap. */
export interface CapSubject {
  /** An encoded update, against `LIMITS.YJS_UPDATE_MAX_BYTES`. */
  readonly update?: Uint8Array;
  /** A string about to be inserted, against `LIMITS.INSERT_CHUNK_MAX_BYTES` of UTF-8. */
  readonly insert?: string;
}

/**
 * The subject is within every cap that applies to it.
 *
 * The numbers come from `@iridium/contracts` and are never restated here: one limits policy, one
 * spelling per limit (02-system-architecture.md ARCH-16).
 */
export function assertWithinCaps(subject: CapSubject): void {
  const { update, insert } = subject;
  if (update !== undefined && update.byteLength > LIMITS.YJS_UPDATE_MAX_BYTES) {
    throw new CrdtError(
      'update-too-large',
      `update of ${update.byteLength} bytes is above the ${LIMITS.YJS_UPDATE_MAX_BYTES}-byte cap`,
    );
  }
  if (insert !== undefined) {
    const bytes = utf8ByteLength(insert);
    if (bytes > LIMITS.INSERT_CHUNK_MAX_BYTES) {
      throw new CrdtError(
        'insert-too-large',
        `insertion of ${bytes} UTF-8 bytes is above the ${LIMITS.INSERT_CHUNK_MAX_BYTES}-byte cap`,
      );
    }
  }
}
