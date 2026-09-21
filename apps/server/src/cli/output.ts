/**
 * What the CLI writes, and where.
 *
 * Two rules the whole command set follows, both of them an operator's rather than a preference:
 *
 *  - **stdout carries the answer, stderr carries everything else.** `--json` exists so `jq` can read
 *    a command's output (11-operations-and-deployment.md, "Command inventory"), which is only true if
 *    nothing else is on that stream — so refusals, warnings and the booted application's own pino
 *    lines go to stderr (`cli/app.ts` redirects the logger there for exactly this reason).
 *  - **Every write goes through an injected `CliIo`.** A unit test then reads what a command printed
 *    without touching the process streams, which is what lets the output shape be asserted rather
 *    than eyeballed.
 *
 * The renderers are here rather than in each command for the same reason the exit codes are: three
 * commands print a key/value block and two print a findings table, and two spellings of one layout is
 * how a runbook's example stops matching the tool.
 */

/** The two streams a command writes to. Each call appends the newline. */
export interface CliIo {
  /** The command's answer: the link, the JSON document, the table. */
  out(text: string): void;
  /** Streaming exports await the real stdout write callback to keep pipe backpressure bounded. */
  writeLine?(text: string): Promise<void>;
  /** Refusals, warnings and diagnostics — never part of the answer. */
  err(text: string): void;
}

/** The real streams. The one place this binary writes outside pino, and deliberately so. */
export const PROCESS_IO: CliIo = Object.freeze({
  out(text: string): void {
    process.stdout.write(`${text}\n`);
  },
  writeLine(text: string): Promise<void> {
    return new Promise((resolve, reject) => {
      process.stdout.write(`${text}\n`, (error) => (error == null ? resolve() : reject(error)));
    });
  },
  err(text: string): void {
    process.stderr.write(`${text}\n`);
  },
});

/** Collects what a command wrote, for the unit tests. @internal */
export class BufferedIo implements CliIo {
  readonly #out: string[] = [];
  readonly #err: string[] = [];

  out(text: string): void {
    this.#out.push(text);
  }

  err(text: string): void {
    this.#err.push(text);
  }

  /** Everything written to stdout, newline-joined, as the terminal would show it. */
  get stdout(): string {
    return this.#out.join('\n');
  }

  /** Everything written to stderr, newline-joined. */
  get stderr(): string {
    return this.#err.join('\n');
  }
}

/**
 * The `--json` rendering: two-space indentation, which is what M0's `config check --json` and
 * `version --json` already print and what a human reading a terminal can still follow.
 */
export function renderJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** One `key  value` block, the key column padded to the widest key. */
export function renderPairs(pairs: readonly (readonly [string, string])[]): string {
  const width = pairs.reduce((widest, [key]) => Math.max(widest, key.length), 0);
  return pairs.map(([key, value]) => `  ${key.padEnd(width)}  ${value}`).join('\n');
}

/**
 * A left-aligned table with a header row, used by the `doctor` findings table and by
 * `audit verify-chain`'s per-chain summary. Columns are padded to their widest cell; the last column
 * is not padded, so a long detail does not trail into whitespace.
 */
export function renderTable(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  const widths = headers.map((header, column) =>
    rows.reduce((widest, row) => Math.max(widest, row[column]?.length ?? 0), header.length),
  );
  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, column) =>
        column === cells.length - 1 ? cell : cell.padEnd(widths[column] ?? 0),
      )
      .join('  ')
      .trimEnd();
  return [line(headers), ...rows.map((row) => line(row))].join('\n');
}
