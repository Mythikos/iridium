/**
 * UTF-16 and UTF-8 primitives shared by the diff and the chunker.
 *
 * The package is isomorphic and compiles with `lib: ["es2024"]` only, so there is no `TextEncoder`
 * and no `Buffer` here: UTF-8 sizes are counted from code points, which is also the granularity the
 * chunker has to split on. A lone surrogate counts as three bytes, which is what an encoder that
 * substitutes U+FFFD would emit for it, so the count is never below the real encoding.
 */

/** The first code unit of a surrogate pair. */
export function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

/** The second code unit of a surrogate pair. */
export function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff;
}

/** UTF-8 length of the code point starting at `index`, and how many UTF-16 units it occupies. */
function codePointAt(
  text: string,
  index: number,
): { readonly bytes: number; readonly units: number } {
  const unit = text.charCodeAt(index);
  if (
    isHighSurrogate(unit) &&
    index + 1 < text.length &&
    isLowSurrogate(text.charCodeAt(index + 1))
  ) {
    return { bytes: 4, units: 2 };
  }
  if (unit < 0x80) return { bytes: 1, units: 1 };
  if (unit < 0x800) return { bytes: 2, units: 1 };
  return { bytes: 3, units: 1 };
}

/** How many bytes `text` occupies when encoded as UTF-8 (a lone surrogate counts as three). */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length;) {
    const point = codePointAt(text, index);
    bytes += point.bytes;
    index += point.units;
  }
  return bytes;
}

/**
 * Split `text` into pieces of at most `maxBytes` UTF-8 bytes, cutting only at code-point boundaries.
 *
 * A seam inside a surrogate pair would manufacture two lone surrogates, which `scanHostileContent`
 * and `normalizeSource` would then report on content that was well-formed when it was pasted
 * (05-collaboration-and-durability.md D05-16), so the loop advances a whole code point at a time and
 * a piece is only closed before a code point that would push it over the cap.
 */
export function splitAtUtf8Bytes(text: string, maxBytes: number): string[] {
  const pieces: string[] = [];
  let start = 0;
  let bytes = 0;
  for (let index = 0; index < text.length;) {
    const point = codePointAt(text, index);
    if (bytes > 0 && bytes + point.bytes > maxBytes) {
      pieces.push(text.slice(start, index));
      start = index;
      bytes = 0;
    }
    bytes += point.bytes;
    index += point.units;
  }
  if (start < text.length) pieces.push(text.slice(start));
  return pieces;
}
