/**
 * Stripping parameter values out of mysql2 error text before it reaches the logger
 * (11-operations-and-deployment.md, "Standard fields on every line": *"`err.message` of a DB error may
 * contain SQL — `apps/server/src/db/redact-sql.ts` strips parameter lists from mysql2 errors before
 * they reach the logger"*).
 *
 * mysql2 raises errors whose `sql` and `sqlMessage` carry the statement **with its parameters already
 * interpolated**, which is how a note's Markdown, a display name or a password hash ends up on a log
 * line that nobody meant to be content. The redaction is therefore not cosmetic: it is the difference
 * between an operable error message and a disclosure, and it has to happen at the boundary where the
 * driver's error becomes a log field rather than at each of the dozens of places that log one.
 *
 * What survives is what an operator needs: the statement shape, the table and column names, the MySQL
 * error code and the constraint name. What is replaced is every literal — quoted strings, numbers, hex
 * and bit literals — and the whole `sql` property, which mysql2 fills with the interpolated statement.
 */

/** The subset of a mysql2 error this module reads. Everything is optional; nothing is trusted. */
export interface MysqlErrorLike {
  readonly message?: string | undefined;
  readonly code?: string | undefined;
  readonly errno?: number | undefined;
  readonly sqlState?: string | undefined;
  readonly sqlMessage?: string | undefined;
  readonly sql?: string | undefined;
}

/** What a redacted database error looks like on a log line. */
export interface RedactedSqlError {
  /** The driver's `code`, e.g. `ER_DUP_ENTRY`. */
  readonly code: string | null;
  readonly errno: number | null;
  readonly sqlState: string | null;
  /** `message` with every literal replaced by `?`. */
  readonly message: string;
}

/** The placeholder every removed literal collapses to — the same character a parameter marker uses. */
const PLACEHOLDER = '?';

/**
 * Quoted string literals, hex and bit literals, and bare numbers.
 *
 * The source is assembled from `String.raw` fragments rather than written as one regular-expression
 * literal because the escape-handling alternatives carry backslashes, and a pattern whose backslashes
 * are easy to miscount is a redaction that silently stops covering the case it was written for.
 *
 * Order matters: the quoted forms come first, so a number *inside* a string never reaches the numeric
 * alternative and a string containing an escaped quote is consumed whole. Backtick identifiers are
 * deliberately left alone — a table or column name is exactly the part of the statement an operator
 * needs to read.
 */
const LITERAL_PATTERNS: readonly string[] = Object.freeze([
  // 'text', with MySQL's two escape forms: a backslash escape and a doubled quote.
  String.raw`'(?:[^'\\]|\\.|'')*'`,
  // "text", the same two forms under double quoting.
  String.raw`"(?:[^"\\]|\\.|"")*"`,
  String.raw`\b0x[0-9a-fA-F]+\b`,
  String.raw`\bb'[01]*'`,
  String.raw`\b\d+\.?\d*\b`,
]);

const LITERAL = new RegExp(LITERAL_PATTERNS.join('|'), 'g');

/** Replaces every literal in a SQL fragment with `?`, leaving identifiers and keywords intact. */
export function redactSqlText(sql: string): string {
  return sql.replaceAll(LITERAL, PLACEHOLDER);
}

/** The error's own enumerable properties, without trusting its shape or asserting one. */
function propertiesOf(error: unknown): Record<string, unknown> {
  if (typeof error !== 'object' || error === null) return {};
  const properties: Record<string, unknown> = { ...error };
  // `message` lives on `Error.prototype`, so a spread does not carry it.
  if (error instanceof Error) properties['message'] = error.message;
  return properties;
}

function readString(properties: Record<string, unknown>, key: string): string | undefined {
  const value = properties[key];
  return typeof value === 'string' ? value : undefined;
}

function readNumber(properties: Record<string, unknown>, key: string): number | undefined {
  const value = properties[key];
  return typeof value === 'number' ? value : undefined;
}

/** A mysql2 error's own fields, read defensively. */
export function asMysqlErrorLike(error: unknown): MysqlErrorLike {
  const properties = propertiesOf(error);
  return {
    message: readString(properties, 'message'),
    code: readString(properties, 'code'),
    errno: readNumber(properties, 'errno'),
    sqlState: readString(properties, 'sqlState'),
    sqlMessage: readString(properties, 'sqlMessage'),
    sql: readString(properties, 'sql'),
  };
}

/**
 * The log-safe rendering of a database error.
 *
 * The `sql` property is dropped rather than redacted: mysql2 fills it with the fully interpolated
 * statement, so a redacted copy would add nothing the redacted `message` does not already carry while
 * inviting the belief that the raw statement is available somewhere.
 */
export function redactDatabaseError(error: unknown): RedactedSqlError {
  const raw = asMysqlErrorLike(error);
  const text = raw.message ?? raw.sqlMessage ?? 'database error';
  return {
    code: raw.code ?? null,
    errno: raw.errno ?? null,
    sqlState: raw.sqlState ?? null,
    message: redactSqlText(text),
  };
}
