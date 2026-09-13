/**
 * Narrowing helpers for the values this pipeline reads from outside TypeScript's knowledge: parsed
 * JSON, dynamically imported modules, and the route objects Fastify hands back.
 *
 * They exist so the scripts contain no type assertions. `oxlint`'s `typescript/no-unsafe-type-assertion`
 * is on for good reason — an assertion on a parsed document is a promise the parser never made — and a
 * generator that asserts its way through a malformed input produces a malformed artefact instead of an
 * error naming the input.
 */

/** A plain object, the only JSON shape any of these generators indexes into. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read a string member, or `undefined` when it is absent or not a string. */
export function stringMember(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const member = value[key];
  return typeof member === 'string' ? member : undefined;
}

/** Read a record member, or `undefined` when it is absent or not an object. */
export function recordMember(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const member = value[key];
  return isRecord(member) ? member : undefined;
}

/** Read an array member, or `undefined` when it is absent or not an array. */
export function arrayMember(value: unknown, key: string): unknown[] | undefined {
  if (!isRecord(value)) return undefined;
  const member = value[key];
  return Array.isArray(member) ? member : undefined;
}

/** `JSON.parse` that yields `unknown` rather than `any`, so the caller has to narrow. */
export function parseJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}
