/**
 * `config/bytes.ts` — the `bytes` environment type of 02-system-architecture.md, "Configuration
 * keys": a decimal integer, or a suffixed value (`50MiB`, `2GiB`, `1GB`).
 *
 * Binary suffixes (`KiB`, `MiB`, `GiB`, `TiB`) are powers of 1024 and decimal suffixes (`KB`, `MB`,
 * `GB`, `TB`) are powers of 1000, which is what lets `COLLAB_MAX_STATE_BYTES_TOTAL=1GiB` and
 * `COLLAB_MAX_STATE_BYTES_TOTAL=1073741824` be the same deployment. A bare `K`/`M`/`G` is refused
 * rather than guessed, because the two readings differ by 7 % and the value is a capacity budget.
 */

const BINARY = 1024;
const DECIMAL = 1000;

const SUFFIXES: ReadonlyMap<string, number> = new Map([
  ['b', 1],
  ['kib', BINARY],
  ['mib', BINARY ** 2],
  ['gib', BINARY ** 3],
  ['tib', BINARY ** 4],
  ['kb', DECIMAL],
  ['mb', DECIMAL ** 2],
  ['gb', DECIMAL ** 3],
  ['tb', DECIMAL ** 4],
]);

/** The accepted spellings, for the message a rejected value gets. */
export const BYTE_SUFFIXES: readonly string[] = [
  'B',
  'KiB',
  'MiB',
  'GiB',
  'TiB',
  'KB',
  'MB',
  'GB',
  'TB',
];

const PATTERN = /^(\d+)\s*([A-Za-z]*)$/;

/** Thrown by `parseBytes`; `EnvSchema` turns it into a zod issue on the offending key. */
export class InvalidByteSizeError extends Error {
  constructor(raw: string) {
    super(
      `${JSON.stringify(raw)} is not a byte size: expected a decimal integer, optionally suffixed ` +
        `with one of ${BYTE_SUFFIXES.join(', ')} (binary suffixes are powers of 1024, decimal ` +
        `suffixes powers of 1000)`,
    );
    this.name = 'InvalidByteSizeError';
  }
}

/**
 * Parses a `bytes` value to a non-negative integer count of bytes.
 *
 * The result is checked against `Number.MAX_SAFE_INTEGER` because every consumer of a byte budget
 * compares it with a sum of row sizes, and a value that has already lost precision compares wrong
 * rather than loudly.
 */
export function parseBytes(raw: string): number {
  const match = PATTERN.exec(raw.trim());
  if (match === null) {
    throw new InvalidByteSizeError(raw);
  }
  const digits = match[1] ?? '';
  const suffix = (match[2] ?? '').toLowerCase();
  const multiplier = suffix === '' ? 1 : SUFFIXES.get(suffix);
  if (multiplier === undefined) {
    throw new InvalidByteSizeError(raw);
  }
  const value = Number(digits) * multiplier;
  if (!Number.isSafeInteger(value)) {
    throw new InvalidByteSizeError(raw);
  }
  return value;
}

/** Renders a byte count with the largest exact binary suffix, for the redacted summary. */
export function formatBytes(value: number): string {
  const units: readonly [string, number][] = [
    ['TiB', BINARY ** 4],
    ['GiB', BINARY ** 3],
    ['MiB', BINARY ** 2],
    ['KiB', BINARY],
  ];
  for (const [unit, size] of units) {
    if (value >= size && value % size === 0) {
      return `${String(value / size)}${unit}`;
    }
  }
  return `${String(value)}B`;
}
