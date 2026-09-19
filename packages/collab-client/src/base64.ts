/**
 * Base64 decoding for the one field that carries bytes on the collaboration wire:
 * `persisted.sv`, the V1 state vector the dominance check compares (09-api-reference.md section 3.4).
 *
 * It is written out rather than delegated because this package is `iso` and declares no host
 * library: `atob` is the DOM's, `Buffer` is Node's, and `Uint8Array.fromBase64` is not in the
 * `es2024` lib the shared TypeScript base fixes. A decoder for a strict, already-validated alphabet
 * is small enough that one correct copy beats a host capability check on every frame.
 *
 * The input reaching `base64ToBytes` has passed `Base64Sv`, so the alphabet is `[A-Za-z0-9+/]` with
 * at most two `=`; the function is nonetheless total over any string, because a decoder that
 * happened to be reached with something else must refuse rather than invent bytes.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** `character → 6-bit value`, built once from the alphabet so the table cannot disagree with it. */
const VALUES: ReadonlyMap<string, number> = new Map(
  Array.from(ALPHABET, (character, index): [string, number] => [character, index]),
);

const BITS_PER_CHARACTER = 6;
const BITS_PER_BYTE = 8;

/**
 * Decode standard base64 (no URL alphabet, no line breaks) into bytes.
 *
 * Returns `null` for anything malformed — a wrong length, a character outside the alphabet, padding
 * in the wrong place — because an unparseable frame is an expected condition on a public socket and
 * the caller decides between ignoring it and closing (docs/repository-guide.md, *Error handling*).
 */
export function base64ToBytes(value: string): Uint8Array | null {
  if (value.length % 4 !== 0) return null;

  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const body = padding === 0 ? value : value.slice(0, -padding);
  if (body.includes('=')) return null;

  const bytes = new Uint8Array((value.length / 4) * 3 - padding);
  let accumulator = 0;
  let bitsHeld = 0;
  let written = 0;
  for (const character of body) {
    const sextet = VALUES.get(character);
    if (sextet === undefined) return null;
    accumulator = (accumulator << BITS_PER_CHARACTER) | sextet;
    bitsHeld += BITS_PER_CHARACTER;
    if (bitsHeld < BITS_PER_BYTE) continue;
    bitsHeld -= BITS_PER_BYTE;
    bytes[written] = (accumulator >> bitsHeld) & 0xff;
    written += 1;
  }
  // The bits a padded group leaves over must be zero; a value that sets them is not the canonical
  // encoding of these bytes and is refused rather than silently rounded.
  return (accumulator & ((1 << bitsHeld) - 1)) === 0 ? bytes : null;
}
