/**
 * Node names and vault-relative paths (03-data-model.md section 6.5; skeleton A12).
 *
 * These rules are shared by the UI, the REST schemas and the import scanner, and they run before
 * any SQL does. They are deliberately stricter than MySQL: a name that is legal in a column but
 * dangerous in a ZIP entry, a Windows path or a URL is refused here, once, rather than at each of
 * the places that would have to remember.
 *
 * The rejected set is closed under the transformations an attacker controls — percent-encoding,
 * Unicode normalisation, case, trailing dots and spaces, and alternate separators — which is what
 * `contracts.paths.prop` asserts over generated input. Sibling *uniqueness* is decided by the
 * database collation (`utf8mb4_0900_as_ci`); `nameKey` reproduces that comparison closely enough
 * for the client and the import scanner to warn before the insert, never instead of it.
 */

import { LIMITS } from './limits.ts';

// ---------------------------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------------------------

/** Why a node name was refused. A closed vocabulary, so a caller can map it to a message. */
export const NAME_REJECTIONS = [
  'empty',
  'too_long',
  'control_character',
  'lone_surrogate',
  'separator',
  'dot_segment',
  'leading_space_or_dot',
  'trailing_space_or_dot',
  'not_nfc',
  'reserved_device_name',
  'percent_encoded',
] as const;

/** Why a node name was refused. */
export type NameRejection = (typeof NAME_REJECTIONS)[number];

/** Why a vault-relative path was refused. */
export const PATH_REJECTIONS = [
  'empty_path',
  'absolute_path',
  'empty_segment',
  'too_deep',
] as const;

/** Why a vault-relative path was refused. */
export type PathRejection = NameRejection | (typeof PATH_REJECTIONS)[number];

/** The result of checking one node name. */
export type NameCheck =
  | { readonly ok: true; readonly name: string }
  | { readonly ok: false; readonly reason: NameRejection };

/** The result of checking a vault-relative path. */
export type PathCheck =
  | { readonly ok: true; readonly segments: readonly string[] }
  | { readonly ok: false; readonly reason: PathRejection; readonly index: number | null };

/**
 * The Windows device names, refused with or without an extension and in any case. They are not
 * MySQL's problem; they are the export, the ZIP and the desktop shell's problem, and a vault that
 * contains one cannot be written to disk on a supported client.
 */
export const RESERVED_DEVICE_NAMES: readonly string[] = [
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
];

/** The path separator Iridium emits. `\` is never a separator and is never a legal name character. */
export const PATH_SEPARATOR = '/';

/** The extension a note carries on export. `nodes.name` stores the filename without it. */
export const NOTE_EXTENSION = '.md';

// ---------------------------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------------------------

/**
 * The UTF-8 byte length, which is what `nodes.name VARCHAR(255)` bounds — not the UTF-16 length
 * `String.prototype.length` reports. An unpaired surrogate is counted as its replacement, but
 * `checkNodeName` refuses one outright, so the count is never used on such a string.
 */
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint < 0x80) bytes += 1;
    else if (codePoint < 0x800) bytes += 2;
    else if (codePoint < 0x1_00_00) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

/** `true` when the string contains a surrogate code unit with no partner, which utf8mb4 rejects. */
export function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd8_00 && unit <= 0xdb_ff) {
      const next = index + 1 < value.length ? value.charCodeAt(index + 1) : 0;
      if (next < 0xdc_00 || next > 0xdf_ff) return true;
      index += 1;
    } else if (unit >= 0xdc_00 && unit <= 0xdf_ff) {
      return true;
    }
  }
  return false;
}

/**
 * C0 controls, DEL and the C1 controls, checked by code unit rather than by a regex: a regex over
 * control characters is unreadable, is flagged by lint, and is slower than the comparison it
 * hides. C1 is refused alongside C0 because in a filename it is always mojibake and survives no
 * round trip through a ZIP entry or a Windows path.
 */
export function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit <= 0x1f || (unit >= 0x7f && unit <= 0x9f)) return true;
  }
  return false;
}
const PERCENT_ESCAPE = /%[0-9A-Fa-f]{2}/;

/**
 * One round of percent-decoding, tolerant of sequences `decodeURIComponent` refuses: a name is
 * user input, and the point is to see what it would become, not to honour it.
 */
function percentDecodeOnce(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value.replaceAll(/%[0-9A-Fa-f]{2}/g, (escape) =>
      String.fromCharCode(Number.parseInt(escape.slice(1), 16)),
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------------------------

function checkNodeNameShallow(name: string): NameCheck {
  if (name.length === 0) return { ok: false, reason: 'empty' };
  if (hasLoneSurrogate(name)) return { ok: false, reason: 'lone_surrogate' };
  if (name.includes('/') || name.includes('\\')) return { ok: false, reason: 'separator' };
  if (hasControlCharacter(name)) return { ok: false, reason: 'control_character' };
  if (name === '.' || name === '..') return { ok: false, reason: 'dot_segment' };

  const first = name.charAt(0);
  if (first === '.' || /\s/.test(first)) return { ok: false, reason: 'leading_space_or_dot' };
  const last = name.charAt(name.length - 1);
  if (last === '.' || /\s/.test(last)) return { ok: false, reason: 'trailing_space_or_dot' };

  if (name.normalize('NFC') !== name) return { ok: false, reason: 'not_nfc' };

  const stem = name.split('.')[0]!.toUpperCase();
  if (RESERVED_DEVICE_NAMES.includes(stem)) return { ok: false, reason: 'reserved_device_name' };

  if (utf8ByteLength(name) > LIMITS.NODE_NAME_MAX_BYTES) return { ok: false, reason: 'too_long' };

  return { ok: true, name };
}

/**
 * Checks one node name against every rule of 03-data-model.md section 6.5. The empty string is
 * reserved for the root row and is refused here, so no caller can create a second one.
 *
 * Percent-escapes are decoded to a fixed point before the structural rules are re-applied: a name
 * that *would* contain a separator, a control character or a dot segment once decoded is refused
 * as `percent_encoded`, which is what keeps the rejected set closed under encoding rather than
 * merely un-decoded.
 */
export function checkNodeName(name: string): NameCheck {
  const shallow = checkNodeNameShallow(name);
  if (!shallow.ok) return shallow;

  if (PERCENT_ESCAPE.test(name)) {
    let decoded = name;
    for (let round = 0; round < 8; round += 1) {
      const next = percentDecodeOnce(decoded);
      if (next === decoded) break;
      decoded = next;
      if (!checkNodeNameShallow(decoded).ok) return { ok: false, reason: 'percent_encoded' };
    }
  }

  return shallow;
}

/** Whether a node name can be stored and exported. */
export function isSafeNodeName(name: string): boolean {
  return checkNodeName(name).ok;
}

/**
 * The comparison key `utf8mb4_0900_as_ci` implies: case-insensitive and accent-**sensitive**, so
 * `Note` and `note` collide while `Note` and `Noté` do not. The database remains the authority on
 * sibling uniqueness (03-data-model.md section 6.5); this is what lets a client and the import
 * scanner report `filename_collision` before the insert is attempted.
 */
export function nameKey(name: string): string {
  return name.normalize('NFC').toLowerCase();
}

/** Whether two sibling names collide under the database collation. */
export function namesCollide(left: string, right: string): boolean {
  return nameKey(left) === nameKey(right);
}

// ---------------------------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------------------------

/**
 * Checks a vault-relative path: `/`-joined node names, no leading slash, no empty segment, and at
 * most `TREE_MAX_DEPTH` levels. Every segment is checked with `checkNodeName`, so a path is safe
 * exactly when each of its names is.
 */
export function safePath(path: string): PathCheck {
  if (path.length === 0) return { ok: false, reason: 'empty_path', index: null };
  if (path.startsWith('/') || path.startsWith('\\')) {
    return { ok: false, reason: 'absolute_path', index: null };
  }

  const segments = path.split(PATH_SEPARATOR);
  if (segments.length > LIMITS.TREE_MAX_DEPTH) {
    return { ok: false, reason: 'too_deep', index: null };
  }

  for (const [index, segment] of segments.entries()) {
    if (segment.length === 0) return { ok: false, reason: 'empty_segment', index };
    const check = checkNodeName(segment);
    if (!check.ok) return { ok: false, reason: check.reason, index };
  }

  return { ok: true, segments };
}

/** Whether a vault-relative path can be stored and exported. */
export function isSafePath(path: string): boolean {
  return safePath(path).ok;
}

/** The number of levels below the root a path addresses. */
export function pathDepth(path: string): number {
  return path.length === 0 ? 0 : path.split(PATH_SEPARATOR).length;
}

/** Joins segments into a vault-relative path. The segments are not re-checked. */
export function joinPath(segments: readonly string[]): string {
  return segments.join(PATH_SEPARATOR);
}

/** The note's export filename: the stored name plus `.md`. */
export function noteFileName(name: string): string {
  return `${name}${NOTE_EXTENSION}`;
}

/** The stored name for an imported file: the filename without a trailing `.md`. */
export function nodeNameFromFileName(fileName: string): string {
  return fileName.toLowerCase().endsWith(NOTE_EXTENSION)
    ? fileName.slice(0, fileName.length - NOTE_EXTENSION.length)
    : fileName;
}
