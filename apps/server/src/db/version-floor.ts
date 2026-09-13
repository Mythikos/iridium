/**
 * `db.version-floor.boot` (11-operations-and-deployment.md OPS-62, 03-data-model.md section 1.1).
 *
 * Iridium has two required deployment targets and neither is preferred: MySQL 8.4 LTS (>= 8.4.11,
 * the compatibility floor every unset image selector resolves to) and MySQL 9.7 LTS (>= 9.7.2). The
 * `db` plugin reads `SELECT VERSION()` at boot and refuses to start against anything else, exiting
 * `2` with `config.mysql_unsupported` and printing the end-of-life date of a refused 8.0 or the
 * support model of a refused innovation release. `IRIDIUM_ALLOW_UNTESTED_MYSQL=true` downgrades the
 * refusal to a logged warning plus a permanent `/readyz` `mysql_version: warn`, and is documented as
 * unsupported: it exists for one case, a future LTS the product has not yet certified.
 *
 * Two required targets are a promise about which engines are tested, and a promise nobody checks is
 * a preference -- so this check is the first second of the process rather than a migration or a drill.
 */
import { sql, type Kysely } from 'kysely';

/** One supported MySQL line and the patch level Iridium is written to. */
export interface MysqlLine {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** The image tag `infra/.env` pins for this line. */
  readonly image: string;
}

/** The two required deployment targets. 8.4.11 is the compatibility floor. */
export const SUPPORTED_MYSQL_LINES: readonly MysqlLine[] = Object.freeze([
  Object.freeze({ major: 8, minor: 4, patch: 11, image: 'mysql:8.4.11' }),
  Object.freeze({ major: 9, minor: 7, patch: 2, image: 'mysql:9.7.2-oraclelinux9' }),
]);

/** MySQL 8.0 reached end of life on this date; its last release was 8.0.46. */
export const MYSQL_80_END_OF_LIFE = '2026-04-30';

/** The problem class a refused version falls into, so the message can name a remedy. */
export type MysqlVersionVerdict =
  | 'supported'
  | 'end_of_life'
  | 'below_line_floor'
  | 'innovation_release'
  | 'unknown_line'
  | 'unparsable';

export interface MysqlServerVersion {
  /** Exactly what `SELECT VERSION()` returned, suffix and all. */
  readonly raw: string;
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly verdict: MysqlVersionVerdict;
  /** The supported line this server belongs to, or `null` when it belongs to none. */
  readonly line: MysqlLine | null;
}

/** Thrown by `assertMysqlVersionFloor`; `main.ts` maps `exitCode` straight to `process.exit`. */
export class MysqlUnsupportedError extends Error {
  readonly code = 'config.mysql_unsupported';
  readonly exitCode = 2;
  readonly version: MysqlServerVersion;

  constructor(version: MysqlServerVersion, message: string) {
    super(message);
    this.name = 'MysqlUnsupportedError';
    this.version = version;
  }
}

/** Minimal structural logger; pino's `Logger` satisfies it. */
export interface DbLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)/;

function describeSupportedSet(): string {
  return SUPPORTED_MYSQL_LINES.map(
    (line) =>
      `${String(line.major)}.${String(line.minor)}.x (>= ${formatLineFloor(line)}, ${line.image})`,
  ).join(' or ');
}

function formatLineFloor(line: MysqlLine): string {
  return `${String(line.major)}.${String(line.minor)}.${String(line.patch)}`;
}

/** Classifies a `SELECT VERSION()` string against the two required lines. */
export function parseMysqlVersion(raw: string): MysqlServerVersion {
  const match = VERSION_PATTERN.exec(raw.trim());
  if (match === null) {
    return { raw, major: 0, minor: 0, patch: 0, verdict: 'unparsable', line: null };
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  const line = SUPPORTED_MYSQL_LINES.find((l) => l.major === major && l.minor === minor) ?? null;
  if (line !== null) {
    return {
      raw,
      major,
      minor,
      patch,
      verdict: patch >= line.patch ? 'supported' : 'below_line_floor',
      line,
    };
  }
  if (major < 8 || (major === 8 && minor === 0)) {
    return { raw, major, minor, patch, verdict: 'end_of_life', line: null };
  }
  if (major === 9 || major >= 10) {
    return { raw, major, minor, patch, verdict: 'innovation_release', line: null };
  }
  return { raw, major, minor, patch, verdict: 'unknown_line', line: null };
}

/**
 * The refusal message. It always names the supported set, and it always names the reason this
 * particular server is outside it -- an end-of-life date for 8.0, the support model for an
 * innovation release -- because "unsupported" without a date is a message an operator argues with.
 */
export function describeMysqlVersion(version: MysqlServerVersion): string {
  const supported = `Iridium supports ${describeSupportedSet()}.`;
  switch (version.verdict) {
    case 'supported': {
      return `MySQL ${version.raw} is a supported deployment target.`;
    }
    case 'end_of_life': {
      return (
        `MySQL ${version.raw} is not a supported deployment target: MySQL 8.0 reached end of life ` +
        `on ${MYSQL_80_END_OF_LIFE} (last release 8.0.46) and receives no further security ` +
        `patches. ${supported}`
      );
    }
    case 'below_line_floor': {
      const floor = version.line === null ? '' : formatLineFloor(version.line);
      return `MySQL ${version.raw} is below the ${floor} patch floor its line is written to. ${supported}`;
    }
    case 'innovation_release': {
      return (
        `MySQL ${version.raw} is an innovation release, not an LTS: an innovation release is ` +
        `supported only until the next one appears, roughly three months, so it is never a ` +
        `deployment target and upgrades hop LTS to LTS. ${supported}`
      );
    }
    default: {
      return `MySQL reported the version string ${JSON.stringify(version.raw)}, which Iridium cannot classify. ${supported}`;
    }
  }
}

/**
 * Reads `SELECT VERSION()` and refuses an unsupported server.
 *
 * With `allowUntested` the refusal becomes one `WARN` line and the returned version keeps its real
 * verdict, which is what the `/readyz` `mysql_version` check reports as a permanent `warn` -- never
 * a silent success, because an operator who took the override must still see it a year later.
 */
export async function assertMysqlVersionFloor<DB>(
  db: Kysely<DB>,
  options: { readonly allowUntested?: boolean; readonly logger?: DbLogger } = {},
): Promise<MysqlServerVersion> {
  const result = await sql<{ version: string }>`SELECT VERSION() AS version`.execute(db);
  const raw = result.rows[0]?.version;
  if (raw === undefined) {
    throw new Error('SELECT VERSION() returned no row');
  }
  const version = parseMysqlVersion(raw);
  if (version.verdict === 'supported') {
    options.logger?.info({ mysqlVersion: version.raw }, 'db.version-floor.boot: supported');
    return version;
  }
  const message = describeMysqlVersion(version);
  if (options.allowUntested === true) {
    options.logger?.warn(
      {
        mysqlVersion: version.raw,
        code: 'config.mysql_unsupported',
        override: 'IRIDIUM_ALLOW_UNTESTED_MYSQL',
      },
      `db.version-floor.boot: ${message} Continuing because IRIDIUM_ALLOW_UNTESTED_MYSQL=true; this deployment is unsupported.`,
    );
    return version;
  }
  throw new MysqlUnsupportedError(version, message);
}
