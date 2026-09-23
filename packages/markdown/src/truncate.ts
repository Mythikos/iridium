/**
 * Bounding a projected string without inventing a character that was never in the source.
 *
 * Every `*_MAX_CHARS` / `*_MAX_CODEPOINTS` bound in `markdown-limits.ts` counts characters, not
 * the UTF-16 units `String.prototype.slice` cuts on. Slicing by unit splits an astral character
 * into a lone surrogate, and a lone surrogate is not text: MySQL refuses it in a JSON column with
 * `ER_INVALID_JSON_TEXT` ("The surrogate pair in string is invalid"), which reaches the client as
 * a `500` on an ordinary note create. Cutting between combining sequences goes one step further
 * and keeps a base character together with its marks, which is what the heading bound has always
 * promised ("truncated at a complete grapheme", `markdown-limits.ts`).
 */

/** A base character with its combining marks, or a run of marks with no base to attach to. */
const SEQUENCES = /\P{M}\p{M}*|\p{M}+/gu;

/**
 * Truncates `value` to at most `maxCodePoints` code points, never mid-character.
 *
 * @param value the projected string to bound
 * @param maxCodePoints the limit from `LIMITS`, counted in code points
 * @returns `value` when it already fits, otherwise its longest whole-sequence prefix
 */
export function truncateChars(value: string, maxCodePoints: number): string {
  let size = 0;
  let truncated = '';
  for (const sequence of value.match(SEQUENCES) ?? []) {
    size += Array.from(sequence).length;
    if (size > maxCodePoints) return truncated;
    truncated += sequence;
  }
  return value;
}
