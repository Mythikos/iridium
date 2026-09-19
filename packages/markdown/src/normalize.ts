/**
 * `normalizeSource` — the one normalisation of note text (08-markdown-pipeline-import-export.md §4).
 *
 * The text of record is LF-only, has its encoding BOM removed, holds no U+0000 or lone surrogate,
 * and is never rewritten by anything else (invariant I1). That state is reached exactly
 * once, at the four entry points §4.1 names — create, import, restore, repair — and what it records
 * (`hadBom`, `originalEol`, `encoding`) is what `restoreSource` (the transfer milestone) needs to
 * give the bytes back.
 *
 * What it changes, and only that (§4.2, steps 1 to 7): bytes are decoded, with UTF-16 recognised by
 * its BOM and invalid UTF-8 rejected unless the caller chose replacement; a leading BOM is removed
 * and recorded; every line ending becomes LF and the original kind is recorded; U+0000 becomes
 * U+FFFD (CommonMark §2.3); a lone surrogate becomes U+FFFD (`utf8mb4` refuses it). Nothing else is
 * touched — no Unicode normalisation, no tab expansion, no whitespace trimming, no final-newline
 * change, no control-character stripping — because every one of those would be a silent rewrite of
 * the user's bytes.
 */

/** The line-ending kind recorded in `notes.original_eol`. */
export type Eol = 'lf' | 'crlf' | 'cr' | 'mixed';

/** The encoding the bytes were decoded from; string input is `utf-8` by definition. */
export type SourceEncoding = 'utf-8' | 'utf-16le' | 'utf-16be';

/** The warning codes of §4.2, one per step that changed something. */
export type NormalizeWarningCode =
  | 'bom_stripped'
  | 'crlf_normalized'
  | 'cr_normalized'
  | 'mixed_eol'
  | 'nul_replaced'
  | 'lone_surrogate_replaced'
  | 'invalid_utf8_replaced'
  | 'utf16_decoded';

/** One warning, with how often it applied and, for line-based ones, where first. */
export interface NormalizeWarning {
  readonly code: NormalizeWarningCode;
  readonly count: number;
  readonly firstLine?: number;
}

/** LF-only text with its encoding BOM removed, preserving subsequent U+FEFF content for restoration. */
export interface NormalizedSource {
  readonly text: string;
  readonly hadBom: boolean;
  readonly originalEol: Eol;
  readonly encoding: SourceEncoding;
  readonly warnings: readonly NormalizeWarning[];
}

/** What `normalizeSource` accepts beside the input. */
export interface NormalizeOptions {
  /**
   * What to do with bytes that are not valid UTF-8: `reject` (the default) throws
   * `InvalidUtf8Error`, `replace` substitutes U+FFFD and warns `invalid_utf8_replaced` (D08-06).
   */
  readonly invalidUtf8?: 'reject' | 'replace';
}

/** Thrown for invalid UTF-8 under the default `reject`; the import scanner reports `invalid_utf8`. */
export class InvalidUtf8Error extends Error {
  readonly code = 'invalid_utf8';

  constructor() {
    super(
      'the bytes are not valid UTF-8. Convert the file to UTF-8, or import with ' +
        "`invalidUtf8: 'replace'` to substitute U+FFFD for every invalid sequence.",
    );
    this.name = 'InvalidUtf8Error';
  }
}

const BOM = '﻿';
const REPLACEMENT = '�';
const CR = '\r';
const LF = '\n';
const LF_UNIT = LF.charCodeAt(0);

const UTF16LE_BOM: readonly [number, number] = [0xff, 0xfe];
const UTF16BE_BOM: readonly [number, number] = [0xfe, 0xff];

const HIGH_SURROGATE_START = 0xd800;
const HIGH_SURROGATE_END = 0xdbff;
const LOW_SURROGATE_START = 0xdc00;
const LOW_SURROGATE_END = 0xdfff;

function isHighSurrogate(unit: number): boolean {
  return unit >= HIGH_SURROGATE_START && unit <= HIGH_SURROGATE_END;
}

function isLowSurrogate(unit: number): boolean {
  return unit >= LOW_SURROGATE_START && unit <= LOW_SURROGATE_END;
}

// ---- step 1: encoding ----------------------------------------------------------------------------

interface Decoded {
  readonly text: string;
  readonly encoding: SourceEncoding;
  readonly replaced: number;
}

function hasPrefix(bytes: Uint8Array, prefix: readonly [number, number]): boolean {
  return bytes[0] === prefix[0] && bytes[1] === prefix[1];
}

/**
 * Decodes bytes. A UTF-16 BOM selects the UTF-16 decoder (`ignoreBOM: false`, so the BOM itself is
 * consumed, then re-added as U+FEFF so step 2 records it like any other); UTF-8 keeps its BOM for
 * step 2 (`ignoreBOM: true` means "leave it in the text"), and is strict unless told to replace.
 */
function decode(bytes: Uint8Array, options: NormalizeOptions): Decoded {
  if (hasPrefix(bytes, UTF16LE_BOM) || hasPrefix(bytes, UTF16BE_BOM)) {
    const encoding: SourceEncoding = hasPrefix(bytes, UTF16LE_BOM) ? 'utf-16le' : 'utf-16be';
    const text = new TextDecoder(encoding, { ignoreBOM: false }).decode(bytes);
    return { text: BOM + text, encoding, replaced: 0 };
  }
  if (options.invalidUtf8 === 'replace') {
    const text = new TextDecoder('utf-8', { ignoreBOM: true, fatal: false }).decode(bytes);
    return { text, encoding: 'utf-8', replaced: countReplacementsAdded(bytes, text) };
  }
  try {
    const text = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true }).decode(bytes);
    return { text, encoding: 'utf-8', replaced: 0 };
  } catch {
    throw new InvalidUtf8Error();
  }
}

/**
 * How many U+FFFD the lenient decoder added: the replacement characters in the output that are not
 * accounted for by a genuine `EF BF BD` sequence in the input.
 */
function countReplacementsAdded(bytes: Uint8Array, text: string): number {
  let genuine = 0;
  for (let index = 0; index + 2 < bytes.length; index += 1) {
    if (bytes[index] === 0xef && bytes[index + 1] === 0xbf && bytes[index + 2] === 0xbd) {
      genuine += 1;
      index += 2;
    }
  }
  let total = 0;
  for (const character of text) if (character === REPLACEMENT) total += 1;
  return Math.max(0, total - genuine);
}

// ---- step 3: EOL detection -----------------------------------------------------------------------

interface EolCounts {
  readonly crlf: number;
  readonly cr: number;
  readonly lf: number;
  readonly firstCrlfLine: number | undefined;
  readonly firstCrLine: number | undefined;
}

/** Counts CRLF, lone CR and lone LF, remembering the line of the first of each converted kind. */
function countEols(text: string): EolCounts {
  let crlf = 0;
  let cr = 0;
  let lf = 0;
  let firstCrlfLine: number | undefined;
  let firstCrLine: number | undefined;
  let line = 1;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === CR) {
      if (text[index + 1] === LF) {
        crlf += 1;
        firstCrlfLine ??= line;
        index += 1;
      } else {
        cr += 1;
        firstCrLine ??= line;
      }
      line += 1;
    } else if (character === LF) {
      lf += 1;
      line += 1;
    }
  }
  return { crlf, cr, lf, firstCrlfLine, firstCrLine };
}

function eolKind(counts: EolCounts): Eol {
  const kinds = [counts.crlf > 0, counts.cr > 0, counts.lf > 0].filter(Boolean).length;
  if (kinds > 1) return 'mixed';
  if (counts.crlf > 0) return 'crlf';
  if (counts.cr > 0) return 'cr';
  return 'lf';
}

/**
 * The line-ending kind of a text as §4.2 step 3 classifies it: `lf` for LF-only text and for text
 * with no line break at all, `mixed` when more than one kind is present.
 */
export function detectEol(text: string): Eol {
  return eolKind(countEols(text));
}

// ---- steps 5 and 6: illegal units ----------------------------------------------------------------

interface Replaced {
  readonly text: string;
  readonly nul: number;
  readonly nulLine: number | undefined;
  readonly lone: number;
  readonly loneLine: number | undefined;
}

/** U+0000 and lone surrogates become U+FFFD in one pass; valid pairs are untouched. */
function replaceIllegalUnits(text: string): Replaced {
  let nul = 0;
  let lone = 0;
  let nulLine: number | undefined;
  let loneLine: number | undefined;
  let line = 1;
  let changed = false;
  const out: string[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit === 0) {
      nul += 1;
      nulLine ??= line;
      out.push(REPLACEMENT);
      changed = true;
      continue;
    }
    if (isHighSurrogate(unit)) {
      if (isLowSurrogate(text.charCodeAt(index + 1))) {
        out.push(text[index] ?? '', text[index + 1] ?? '');
        index += 1;
        continue;
      }
      lone += 1;
      loneLine ??= line;
      out.push(REPLACEMENT);
      changed = true;
      continue;
    }
    if (isLowSurrogate(unit)) {
      lone += 1;
      loneLine ??= line;
      out.push(REPLACEMENT);
      changed = true;
      continue;
    }
    if (unit === LF_UNIT) line += 1;
    out.push(text[index] ?? '');
  }
  return { text: changed ? out.join('') : text, nul, nulLine, lone, loneLine };
}

function withFirstLine(
  code: NormalizeWarningCode,
  count: number,
  firstLine: number | undefined,
): NormalizeWarning {
  return firstLine === undefined ? { code, count } : { code, count, firstLine };
}

/**
 * Normalises one note's source (08 §4.2, steps 1 to 7).
 *
 * Removes only the encoding marker: a subsequent U+FEFF remains content, even at the start of the
 * result. Restore the recorded BOM before normalizing again to keep that content intact (08 §4.3);
 * a bare second call cannot distinguish it from a new input's encoding marker.
 *
 * @throws InvalidUtf8Error for invalid UTF-8 bytes under the default `invalidUtf8: 'reject'`.
 */
export function normalizeSource(
  input: Uint8Array | string,
  options: NormalizeOptions = {},
): NormalizedSource {
  const warnings: NormalizeWarning[] = [];

  // Step 1: only bytes are decoded; a string is already text.
  const decoded: Decoded =
    typeof input === 'string'
      ? { text: input, encoding: 'utf-8', replaced: 0 }
      : decode(input, options);
  if (decoded.encoding !== 'utf-8') warnings.push({ code: 'utf16_decoded', count: 1 });
  if (decoded.replaced > 0)
    warnings.push({ code: 'invalid_utf8_replaced', count: decoded.replaced });

  // Step 2: only a *leading* U+FEFF is a byte order mark; anywhere else it is a legal character.
  const hadBom = decoded.text.startsWith(BOM);
  let text = hadBom ? decoded.text.slice(BOM.length) : decoded.text;
  if (hadBom) warnings.push({ code: 'bom_stripped', count: 1 });

  // Step 3: detect before converting, so the recorded kind describes what entered the system.
  const counts = countEols(text);
  const originalEol = eolKind(counts);
  if (originalEol === 'mixed') warnings.push({ code: 'mixed_eol', count: counts.crlf + counts.cr });
  if (counts.crlf > 0) {
    warnings.push(withFirstLine('crlf_normalized', counts.crlf, counts.firstCrlfLine));
  }
  if (counts.cr > 0) warnings.push(withFirstLine('cr_normalized', counts.cr, counts.firstCrLine));

  // Step 4.
  if (counts.crlf > 0 || counts.cr > 0) text = text.replaceAll(/\r\n?/g, LF);

  // Steps 5 and 6.
  const replaced = replaceIllegalUnits(text);
  text = replaced.text;
  if (replaced.nul > 0)
    warnings.push(withFirstLine('nul_replaced', replaced.nul, replaced.nulLine));
  if (replaced.lone > 0) {
    warnings.push(withFirstLine('lone_surrogate_replaced', replaced.lone, replaced.loneLine));
  }

  // Step 7: everything else is untouched.
  return { text, hadBom, originalEol, encoding: decoded.encoding, warnings };
}
