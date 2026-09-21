/** Single byte range parsing, before opening storage (08 §9.4). */
import type { ByteRange } from './storage.ts';

/** Absent/full, one satisfiable inclusive range, or the documented 416 refusal. */
export type RangeResult =
  | { readonly kind: 'full' }
  | { readonly kind: 'range'; readonly range: ByteRange }
  | { readonly kind: 'invalid' };
/** Handles bounded, open-ended and suffix forms without integer overflow. */
export function parseAttachmentRange(value: string | undefined, size: number): RangeResult {
  if (value === undefined) return { kind: 'full' };
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (match === null || size === 0) return { kind: 'invalid' };
  const [, from, through] = match;
  if (from === '' && through === '') return { kind: 'invalid' };
  const left = Number(from);
  const right = Number(through);
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right)) return { kind: 'invalid' };
  if (from === '')
    return right > 0
      ? { kind: 'range', range: { start: Math.max(0, size - right), end: size - 1 } }
      : { kind: 'invalid' };
  const end = through === '' ? size - 1 : Math.min(right, size - 1);
  return left <= end && left < size
    ? { kind: 'range', range: { start: left, end } }
    : { kind: 'invalid' };
}

/** GET validators permit weak comparison and comma-delimited tags (RFC 9110 §13.1.2). */
export function attachmentEtagMatches(value: string | undefined, etag: string): boolean {
  return (
    value !== undefined &&
    value.split(',').some((tag) => tag.trim() === '*' || tag.trim().replace(/^W\//, '') === etag)
  );
}
