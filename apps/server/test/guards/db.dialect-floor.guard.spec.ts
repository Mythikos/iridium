/**
 * `db.dialect-floor.guard` (10-testing-and-quality.md guard table, D10-42; 03-data-model.md
 * section 1.1, D03-23; 11-operations-and-deployment.md "The MySQL dialect rule").
 *
 * Every SQL statement Iridium executes must have identical semantics on MySQL 8.4.11 and MySQL
 * 9.7.2. The floor is 8.4.11: a construct that requires 9.x is forbidden, and a construct that 8.4
 * merely deprecates is forbidden too, because a deprecation is a removal with a date on it.
 *
 * Prose does not enforce that. This guard scans the paths the rule names for every token in the
 * committed denylist `@iridium/sql-policy/forbidden-constructs.json` (`tooling/sql` on disk), and the
 * failure message prints the entry's `token`, `since` and `reason` so the guard is a remedy rather
 * than a rejection. The list is data, so adding a construct is a one-line change to a JSON file and
 * never a code change -- which is also why this file asserts the shape of the list and not its
 * contents.
 *
 * The denylist arrives through the package's `exports` map rather than through a path that climbs out
 * of `apps/server`. It is read rather than imported, because the guard validates the list's shape
 * before trusting it, so the export is resolved to a file path with `import.meta.resolve` and the
 * specifier is what a malformed list is reported against.
 *
 * Matching is a case-sensitive literal substring search. That is what separates the SQL keyword
 * `VECTOR` from the English word in a comment about a Yjs state vector, and every lowercase token in
 * the list is a literal variable, plugin or flag name. The one token that is a spelling rather than
 * an identifier -- the deprecated function call inside `ON DUPLICATE KEY UPDATE` -- is listed
 * without its space, so an ordinary value list written with one passes and the function call does
 * not.
 *
 * This file is scanned by the guard like every other, so it must never contain a denylisted token
 * literally: every token it needs comes from the JSON at run time.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const DENYLIST_SPECIFIER = '@iridium/sql-policy/forbidden-constructs.json';
const DENYLIST_PATH = fileURLToPath(import.meta.resolve(DENYLIST_SPECIFIER));

/** The paths the dialect rule names. A path that does not exist yet contributes no files. */
const SCANNED: ReadonlyArray<{ readonly dir: string; readonly extensions: readonly string[] }> = [
  { dir: 'apps/server/src', extensions: ['.ts'] },
  { dir: 'apps/server/migrations', extensions: ['.ts'] },
  { dir: 'infra/docker/mysql', extensions: ['.cnf', '.sh', '.sql'] },
  { dir: 'docs/ops', extensions: ['.sql'] },
];

interface ForbiddenConstruct {
  readonly token: string;
  readonly since: string;
  readonly reason: string;
}

function isForbiddenConstruct(value: unknown): value is ForbiddenConstruct {
  return (
    typeof value === 'object' &&
    value !== null &&
    'token' in value &&
    typeof value.token === 'string' &&
    'since' in value &&
    typeof value.since === 'string' &&
    'reason' in value &&
    typeof value.reason === 'string'
  );
}

/** Reads and validates the committed denylist. A malformed entry fails the guard here, loudly. */
function readDenylist(): ForbiddenConstruct[] {
  const parsed: unknown = JSON.parse(readFileSync(DENYLIST_PATH, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || !('constructs' in parsed)) {
    throw new Error(`${DENYLIST_SPECIFIER} has no \`constructs\` member`);
  }
  const { constructs } = parsed;
  if (!Array.isArray(constructs)) {
    throw new Error(`${DENYLIST_SPECIFIER}: \`constructs\` is not an array`);
  }
  const valid = constructs.filter((entry: unknown) => isForbiddenConstruct(entry));
  if (valid.length !== constructs.length) {
    throw new Error(
      `${DENYLIST_SPECIFIER}: every entry must be {token, since, reason} with string values`,
    );
  }
  return valid;
}

function walk(dir: string, extensions: readonly string[]): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return []; // a path the rule names that this milestone has not created yet
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...walk(full, extensions));
    } else if (extensions.some((extension) => entry.endsWith(extension))) {
      files.push(full);
    }
  }
  return files;
}

function scannedFiles(): string[] {
  return SCANNED.flatMap(({ dir, extensions }) => walk(join(REPO_ROOT, dir), extensions));
}

/** The matcher: a case-sensitive literal substring search, reported as `line: text`. */
export function hitsIn(contents: string, token: string): string[] {
  if (!contents.includes(token)) return [];
  const hits: string[] = [];
  for (const [index, line] of contents.split('\n').entries()) {
    if (line.includes(token)) hits.push(`${String(index + 1)}: ${line.trim()}`);
  }
  return hits;
}

function occurrences(token: string): string[] {
  return scannedFiles().flatMap((file) =>
    hitsIn(readFileSync(file, 'utf8'), token).map(
      (hit) => `${relative(REPO_ROOT, file).replaceAll('\\', '/')}:${hit}`,
    ),
  );
}

const DENYLIST = readDenylist();

describe('db.dialect-floor.guard [area:ops]', () => {
  it('reads a committed denylist of {token, since, reason} entries', () => {
    expect(DENYLIST.length).toBeGreaterThan(0);
    for (const construct of DENYLIST) {
      expect(construct.token.length).toBeGreaterThan(0);
      expect(construct.since.length).toBeGreaterThan(0);
      // The message is the remedy, so a one-word reason is not a reason.
      expect(construct.reason.length).toBeGreaterThan(30);
    }
    const tokens = DENYLIST.map((construct) => construct.token);
    expect(new Set(tokens).size).toBe(tokens.length);
  });

  it('scans the paths the MySQL dialect rule names, and finds files in each that exists', () => {
    const paths = scannedFiles().map((file) => relative(REPO_ROOT, file).replaceAll('\\', '/'));
    expect(paths.length).toBeGreaterThan(0);
    // The two paths this milestone creates must actually be covered, or the guard passes vacuously.
    expect(paths.some((path) => path.startsWith('apps/server/migrations/'))).toBe(true);
    expect(paths.some((path) => path.startsWith('infra/docker/mysql/'))).toBe(true);
  });

  it('finds no construct outside the MySQL 8.4.11 floor, and none that 8.4 deprecates', () => {
    const failures = DENYLIST.flatMap((construct) => {
      const hits = occurrences(construct.token);
      return hits.length === 0
        ? []
        : [
            [
              `${construct.token} (${construct.since})`,
              `  ${construct.reason}`,
              ...hits.map((hit) => `  ${hit}`),
            ].join('\n'),
          ];
    });
    expect(failures.join('\n\n')).toBe('');
  });

  it('matches a denylisted token case-sensitively, and never its lower-cased spelling', () => {
    // Built at run time from the list rather than written here, so this file stays clean of the
    // tokens it guards against.
    const uppercase = DENYLIST.map((construct) => construct.token).find(
      (token) => token !== token.toLowerCase(),
    );
    expect(uppercase).toBeDefined();
    const token = uppercase ?? '';
    expect(hitsIn(`SELECT ${token} FROM t`, token)).toHaveLength(1);
    expect(hitsIn(`-- a note about a ${token.toLowerCase()} in prose`, token)).toHaveLength(0);
    expect(hitsIn('SELECT 1', token)).toHaveLength(0);
  });
});
