/**
 * The one timestamp encoding every surface uses (09-api-reference.md section 1.1: RFC 3339 UTC with
 * up to six fractional digits and a trailing `Z`, never a local offset).
 *
 * Iridium emits six fractional digits because every stored timestamp is a MySQL `DATETIME(6)`, and
 * accepts one to six on input because a client must tolerate any precision. The audit chain needs
 * the stricter, fixed-width form: its pre-image is hashed, so two spellings of one instant would be
 * two different hashes (03-data-model.md section 12.2).
 *
 * This module owns the format and nothing else. It has no clock: a caller passes the instant it
 * already holds, because a module that reads the wall clock cannot be tested without one.
 */

import { z } from 'zod';

/** Fractional digits Iridium emits, matching `DATETIME(6)`. */
export const TIMESTAMP_FRACTIONAL_DIGITS = 6;

/** What `Timestamp` accepts: one to six fractional digits, or none, always UTC. */
export const TIMESTAMP_PATTERN: RegExp =
  /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?Z$/;

/** What the audit chain hashes: exactly six fractional digits, so one instant has one spelling. */
export const AUDIT_TIMESTAMP_PATTERN: RegExp =
  /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{6}Z$/;

/** An RFC 3339 UTC timestamp as every body, tool result and audit row spells it. */
export const Timestamp: z.ZodString = z
  .string()
  .regex(TIMESTAMP_PATTERN, 'expected an RFC 3339 UTC timestamp with up to six fractional digits')
  .meta({ id: 'Timestamp' });

const MILLISECOND_DIGITS = 3;
/** The index one past the seconds in `YYYY-MM-DDTHH:MM:SS`, which is what a round trip compares. */
const SECONDS_END = 19;

/**
 * The wire spelling of an instant: `2026-09-11T14:03:22.418771Z`. A `Date` carries milliseconds, so
 * the remaining three digits are zeros rather than invented precision; a caller that holds real
 * microseconds (a value read back from MySQL) passes them as `microseconds` and they replace the
 * whole fraction.
 */
export function toTimestamp(instant: Date, microseconds?: number): string {
  const iso = instant.toISOString();
  const seconds = iso.slice(0, iso.indexOf('.'));
  if (microseconds === undefined) {
    const fraction = iso.slice(iso.indexOf('.') + 1, iso.indexOf('.') + 1 + MILLISECOND_DIGITS);
    return `${seconds}.${fraction.padEnd(TIMESTAMP_FRACTIONAL_DIGITS, '0')}Z`;
  }
  return `${seconds}.${String(microseconds).padStart(TIMESTAMP_FRACTIONAL_DIGITS, '0')}Z`;
}

/**
 * The instant a wire timestamp names, or `null` when the string is not one. Millisecond precision:
 * a JavaScript `Date` cannot hold the last three digits, which is why the string and not the `Date`
 * is what the audit chain hashes.
 *
 * A date the calendar does not have is refused rather than rolled over: `new Date()` turns
 * `2026-02-30` into 2 March, and a validator that silently moves a timestamp two days is worse than
 * one that rejects it.
 */
export function parseTimestamp(value: string): Date | null {
  if (!TIMESTAMP_PATTERN.test(value)) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, SECONDS_END) === value.slice(0, SECONDS_END) ? parsed : null;
}
