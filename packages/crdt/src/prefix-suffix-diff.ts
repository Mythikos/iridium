/**
 * The minimal single edit that turns one text into another.
 *
 * Every server-side rewrite of a note — a version restore, `iridium doctor --repair-content` — is an
 * *edit inside the existing document*, never a rebuild: a rebuilt `Y.Doc` has a disjoint identity
 * set, so merging it concatenates instead of converging (05-collaboration-and-durability.md, "Why a
 * note's Y.Doc is built from Markdown exactly once"). Applying `delete(start, deleteLength)` and
 * then `insert(start, insert)` to a `Y.Text` whose `toString()` is `current` yields exactly `target`
 * while every untouched relative position — remote cursors, carets — survives.
 */
import { isHighSurrogate, isLowSurrogate } from './unicode.ts';

/** The single middle edit that turns `current` into `target`. Offsets are UTF-16 units. */
export interface TextDiff {
  /** Where the edit starts, in UTF-16 units from the beginning of `current`. */
  readonly start: number;
  /** How many UTF-16 units of `current` the edit deletes. */
  readonly deleteLength: number;
  /** The text inserted at `start` after the deletion. */
  readonly insert: string;
}

/**
 * Longest common prefix and suffix, never splitting a surrogate pair.
 *
 * The boundaries are pulled back by one code unit when they would fall between a high and a low
 * surrogate, so neither the deleted range nor the inserted string can end up holding half a pair —
 * which would be a lone surrogate in the document for `scanHostileContent` and `normalizeSource` to
 * trip on, manufactured by the diff rather than present in either input.
 */
export function prefixSuffixDiff(current: string, target: string): TextDiff {
  const shortest = Math.min(current.length, target.length);

  let prefix = 0;
  while (prefix < shortest && current.charCodeAt(prefix) === target.charCodeAt(prefix)) prefix++;
  if (prefix > 0 && isHighSurrogate(current.charCodeAt(prefix - 1))) prefix--;

  let suffix = 0;
  const suffixMax = shortest - prefix;
  while (
    suffix < suffixMax &&
    current.charCodeAt(current.length - 1 - suffix) ===
      target.charCodeAt(target.length - 1 - suffix)
  ) {
    suffix++;
  }
  if (suffix > 0 && isLowSurrogate(current.charCodeAt(current.length - suffix))) suffix--;

  const deleteLength = current.length - prefix - suffix;
  const insert = target.slice(prefix, target.length - suffix);
  // An edit that deletes nothing and inserts nothing is reported at offset 0 whatever the texts
  // are, so "no change" is one value a caller can compare against rather than a family of them.
  if (deleteLength === 0 && insert.length === 0) return { start: 0, deleteLength: 0, insert: '' };
  return { start: prefix, deleteLength, insert };
}
