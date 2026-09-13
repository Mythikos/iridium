/**
 * `limits.single-source.guard` (10-testing-and-quality.md, "Guard tests"; invariant 6 and "The
 * single limits policy" of 02-system-architecture.md; ARCH-16; 01-vision-scope-and-principles.md
 * §5.8).
 *
 * Invariant 6 is one sentence — *no numeric limit exists outside `@iridium/contracts/limits.ts`* —
 * and it is the sentence that makes "one limits policy" true rather than aspirational. A cap
 * invented in a module is a cap the client cannot pre-validate against, the tests cannot drive to
 * its boundary, and `GET /meta.limits` does not publish; the failure mode is a client that refuses
 * an upload the server would have accepted, or accepts one it will not.
 *
 * The guard scans the four trees the policy names — `apps/server/src`, `packages/collab-client`,
 * `packages/editor` and `packages/ui` — and runs two checks.
 *
 * **1. No module *declares* a number under a limit word.** The policy says "a numeric literal
 * adjacent to `limit`/`max`/`cap`", and adjacency here is *binding*: the literal is what the
 * limit-worded name is bound to. Three shapes bind one:
 *
 * ```ts
 * const UPLOAD_MAX_BYTES = 52_428_800;   // a declaration
 * { maxRssBytes: 0 }                     // a property
 * { PAT_MAX_LIFETIME_DAYS: intField(366) } // a schema default
 * ```
 *
 * Reading adjacency as binding rather than as "within n characters of" is what separates a
 * declaration from a use. `intField(LIMITS.LOADED_DOCS_MAX, { min: 1 })` reads the policy and is
 * silent here; `Math.max(1, cpus - 1)` is arithmetic and is silent here; `{ min: 0, max: PORT_MAX }`
 * binds a name, not a number, and is silent here. None of those needs an exemption, which is what
 * keeps the register below short enough to read.
 *
 * **2. The literals the policy owns never appear in the two modules that enforce them.** The values
 * are read out of `LIMITS` rather than written here, so a change to the policy moves this check with
 * it and cannot leave the guard asserting last month's numbers.
 *
 * **The register.** `limits.single-source.allowlist.json` beside this file records the numbers that
 * legitimately live outside the policy — a protocol ceiling, a header value, a per-deployment
 * environment default — with a reason each, exactly as the plan's guard row requires. It is data, so
 * admitting one is a reviewed one-line change and never a code change, and the guard fails on an
 * entry that no longer matches anything, so the register cannot rot into a list of numbers that used
 * to exist. Its eventual home is a policy package, beside `@iridium/sql-policy`'s denylist; until
 * one exists it sits with the only guard that reads it.
 *
 * Paired with `limits.policy.unit`: this guard stops a number being invented, that test stops a
 * constant being unenforced. Co-located `*.spec.ts` files are not scanned — a test that drives a
 * limit to its boundary writes numbers by definition, and a number in a test enforces nothing.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LIMITS, type LimitId } from '@iridium/contracts';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const ALLOWLIST_FILE = join(import.meta.dirname, 'limits.single-source.allowlist.json');

/** The four trees the policy names (02-system-architecture.md, "Rules that keep this the single policy"). */
const SCANNED_DIRS: readonly string[] = [
  'apps/server/src',
  'packages/collab-client/src',
  'packages/editor/src',
  'packages/ui/src',
];

/** The words the policy names. A number bound to a name carrying one of these declares a limit. */
const LIMIT_WORDS: ReadonlySet<string> = new Set(['limit', 'limits', 'max', 'cap', 'caps']);

/**
 * The two enforcement modules whose literals the policy owns, and the constants each must read.
 *
 * The *values* come from `LIMITS`, never from a list written here, so the guard tracks the policy.
 * `limits.policy.unit` owns the other direction: every constant has an enforcement site.
 */
const POLICY_ENFORCERS: ReadonlyArray<{
  readonly file: string;
  readonly limits: readonly LimitId[];
}> = [
  {
    file: 'apps/server/src/tree/names.ts',
    limits: ['TREE_MAX_DEPTH', 'NODE_NAME_MAX_BYTES', 'VAULT_NAME_MAX_CHARS'],
  },
  {
    file: 'apps/server/src/auth/throttle.ts',
    limits: [
      'LOGIN_FAILURES_PER_ACCOUNT_SOURCE',
      'LOGIN_BLOCK_BASE_SECONDS',
      'LOGIN_BLOCK_MAX_SECONDS',
      'LOGIN_FAILURES_PER_IP_PER_DAY',
    ],
  },
];

/**
 * The literals 01-vision-scope-and-principles.md §5.8 names for those two modules. Restated here
 * only so that a policy value changed without the plan changing with it is a red guard.
 */
const DOCUMENTED_POLICY_LITERALS: readonly number[] = [5, 64, 100, 120, 255, 900, 86_400];

/** One numeric literal bound to a limit-worded name. */
interface Declaration {
  readonly file: string;
  readonly line: number;
  readonly name: string;
  readonly literal: string;
  readonly text: string;
}

/** One reviewed exemption. */
interface Exemption {
  readonly file: string;
  readonly name: string;
  readonly reason: string;
}

const NUMBER = String.raw`(?:0[xX][0-9a-fA-F][0-9a-fA-F_]*|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)`;
/** `NAME = 5` and `NAME: number = 5` — a declaration with an initialiser. */
const BOUND_BY_ASSIGNMENT = new RegExp(
  String.raw`^\s*(?::\s*[A-Za-z_$][\w$<>.\[\], ]*?)?=(?![=>])\s*-?\s*(` + NUMBER + ')',
);
/** `name: 5` — a property or a schema field. */
const BOUND_BY_PROPERTY = new RegExp(String.raw`^\s*:\s*-?\s*(` + NUMBER + ')');
/** `NAME: intField(5, …)` — a schema default handed to a field builder. */
const BOUND_THROUGH_BUILDER = new RegExp(
  String.raw`^\s*:\s*[A-Za-z_$][\w$.]*\(\s*-?\s*(` + NUMBER + ')',
);

/** Split an identifier into lower-cased words across `_`, `-` and camel-case boundaries. */
function words(identifier: string): string[] {
  return identifier
    .split(/[^A-Za-z0-9]+/)
    .flatMap((part) => part.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/))
    .filter((part) => part !== '')
    .map((part) => part.toLowerCase());
}

function carriesLimitWord(identifier: string): boolean {
  return words(identifier).some((word) => LIMIT_WORDS.has(word));
}

/**
 * Replace comment and string/template/regex bodies with spaces, preserving every offset so a match
 * still reports the real line. A number inside a comment documents a limit; it does not declare one.
 *
 * A `/` opens a regular expression when the previous significant character cannot end an expression.
 */
function maskSource(source: string): string {
  // `split('')` rather than a spread: this must be UTF-16 code units, because every offset the
  // matchers report is an index into the original string.
  const out = source.split('');
  const erase = (from: number, to: number): void => {
    for (let index = from; index < to && index < out.length; index += 1) {
      if (out[index] !== '\n') out[index] = ' ';
    }
  };
  let previousSignificant = '';
  let index = 0;
  while (index < source.length) {
    const character = source[index] ?? '';
    const next = source[index + 1] ?? '';
    if (character === '/' && next === '/') {
      let end = index;
      while (end < source.length && source[end] !== '\n') end += 1;
      erase(index, end);
      index = end;
      continue;
    }
    if (character === '/' && next === '*') {
      const close = source.indexOf('*/', index + 2);
      const end = close === -1 ? source.length : close + 2;
      erase(index, end);
      index = end;
      continue;
    }
    if (character === '/' && !/[A-Za-z0-9_$)\]]/.test(previousSignificant)) {
      let end = index + 1;
      let inCharacterClass = false;
      while (end < source.length) {
        const inner = source[end];
        if (inner === '\\') {
          end += 2;
          continue;
        }
        if (inner === '[') inCharacterClass = true;
        else if (inner === ']') inCharacterClass = false;
        else if (inner === '\n') break;
        else if (inner === '/' && !inCharacterClass) break;
        end += 1;
      }
      erase(index + 1, end);
      previousSignificant = '/';
      index = Math.min(end + 1, source.length);
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      let end = index + 1;
      while (end < source.length) {
        const inner = source[end];
        if (inner === '\\') {
          end += 2;
          continue;
        }
        if (inner === character) break;
        if (character !== '`' && inner === '\n') break;
        end += 1;
      }
      erase(index + 1, end);
      previousSignificant = character;
      index = Math.min(end + 1, source.length);
      continue;
    }
    if (!/\s/.test(character)) previousSignificant = character;
    index += 1;
  }
  return out.join('');
}

/** Every numeric literal bound to a limit-worded name in one module. */
export function declarationsIn(file: string, source: string): Declaration[] {
  const code = maskSource(source);
  const raw = source.split('\n');
  const found: Declaration[] = [];
  for (const match of code.matchAll(/[A-Za-z_$][\w$]*/g)) {
    const name = match[0];
    if (!carriesLimitWord(name)) continue;
    const tail = code.slice(match.index + name.length, match.index + name.length + 120);
    const bound =
      BOUND_BY_ASSIGNMENT.exec(tail) ??
      BOUND_BY_PROPERTY.exec(tail) ??
      BOUND_THROUGH_BUILDER.exec(tail);
    if (bound === null) continue;
    const line = code.slice(0, match.index).split('\n').length;
    found.push({
      file,
      line,
      name,
      literal: bound[1] ?? '',
      text: (raw[line - 1] ?? '').trim(),
    });
  }
  return found;
}

function walk(dir: string, files: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return files; // a tree this milestone has not created yet contributes no files
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'dist' || entry === 'generated') continue;
    if (entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, files);
    else if (/\.tsx?$/.test(entry) && !/\.spec\.tsx?$/.test(entry)) files.push(full);
  }
  return files;
}

const SCANNED_FILES: readonly string[] = SCANNED_DIRS.flatMap((dir) =>
  walk(join(REPO_ROOT, dir)).map((file) => relative(REPO_ROOT, file).replaceAll('\\', '/')),
);

const DECLARATIONS: readonly Declaration[] = SCANNED_FILES.flatMap((file) =>
  declarationsIn(file, readFileSync(join(REPO_ROOT, file), 'utf8')),
);

function isExemption(value: unknown): value is Exemption {
  return (
    typeof value === 'object' &&
    value !== null &&
    'file' in value &&
    typeof value.file === 'string' &&
    'name' in value &&
    typeof value.name === 'string' &&
    'reason' in value &&
    typeof value.reason === 'string'
  );
}

/** Read and validate the committed register. A malformed entry fails the guard here, loudly. */
function readAllowlist(): Exemption[] {
  const parsed: unknown = JSON.parse(readFileSync(ALLOWLIST_FILE, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || !('allowed' in parsed)) {
    throw new Error('limits.single-source.allowlist.json has no `allowed` member');
  }
  const { allowed } = parsed;
  if (!Array.isArray(allowed)) {
    throw new Error('limits.single-source.allowlist.json: `allowed` is not an array');
  }
  const valid = allowed.filter((entry: unknown) => isExemption(entry));
  if (valid.length !== allowed.length) {
    throw new Error(
      'limits.single-source.allowlist.json: every entry must be {file, name, reason} with string values',
    );
  }
  return valid;
}

const ALLOWED: readonly Exemption[] = readAllowlist();

function isAllowed(declaration: Declaration): boolean {
  return ALLOWED.some(
    (entry) => entry.file === declaration.file && entry.name === declaration.name,
  );
}

/** The spellings one policy value can take in TypeScript source: `86400` and `86_400`. */
function forbiddenSpellings(value: number): string[] {
  const plain = String(value);
  const grouped = plain.replace(/\B(?=(\d{3})+$)/g, '_');
  return [...new Set([plain, grouped])];
}

/**
 * Every policy-owned literal written out in one enforcement module, as `file:line: …`.
 *
 * A module the milestone has not created yet contributes nothing; the register of *which* modules
 * these are is `POLICY_ENFORCERS`, so an absent one is visible in the test name rather than silent.
 */
function policyLiteralHits(enforcer: (typeof POLICY_ENFORCERS)[number]): string[] {
  let source: string;
  try {
    source = readFileSync(join(REPO_ROOT, enforcer.file), 'utf8');
  } catch {
    return [];
  }
  const code = maskSource(source).split('\n');
  const raw = source.split('\n');
  const hits: string[] = [];
  for (const id of enforcer.limits) {
    const value = LIMITS[id];
    if (typeof value !== 'number') continue;
    for (const spelling of forbiddenSpellings(value)) {
      const pattern = new RegExp(String.raw`(?<![\w$.])` + spelling + String.raw`(?![\w$])`);
      for (const [index, line] of code.entries()) {
        if (!pattern.test(line)) continue;
        hits.push(
          `  ${enforcer.file}:${String(index + 1)}: the literal ${spelling} is LIMITS.${id}\n` +
            `      ${(raw[index] ?? '').trim()}`,
        );
      }
    }
  }
  return hits;
}

const REMEDY =
  'Remedy: add the value to `LIMITS` in packages/contracts/src/limits.ts with a `LimitId` member ' +
  'and an enforcement site, and read it from there; or, when the number is genuinely not a product ' +
  'limit, record it in apps/server/test/guards/limits.single-source.allowlist.json with a reason.';

describe('limits.single-source.guard [area:contracts]', () => {
  describe('the scan covers what the policy names', () => {
    it('walks all four trees and finds files in each that exists', () => {
      expect(SCANNED_FILES.length).toBeGreaterThan(0);
      const covered = SCANNED_DIRS.filter((dir) =>
        SCANNED_FILES.some((file) => file.startsWith(`${dir}/`)),
      );
      expect(covered, 'apps/server/src must be covered, or the scan is vacuous').toContain(
        'apps/server/src',
      );
      expect(SCANNED_FILES.some((file) => file.endsWith('.spec.ts'))).toBe(false);
    });

    it('reads a register of {file, name, reason} entries, each carrying a real reason', () => {
      for (const entry of ALLOWED) {
        expect(entry.file.length).toBeGreaterThan(0);
        expect(entry.name.length).toBeGreaterThan(0);
        // The register exists to be read by the next person; a one-word reason is not a reason.
        expect(
          entry.reason.length,
          `${entry.file}: ${entry.name} carries no usable reason`,
        ).toBeGreaterThan(40);
      }
      const keys = ALLOWED.map((entry) => `${entry.file}#${entry.name}`);
      expect(new Set(keys).size, 'the register lists a declaration twice').toBe(keys.length);
    });
  });

  describe('no module declares a numeric limit of its own', () => {
    it('finds no unregistered numeric literal bound to a limit-worded name', () => {
      const failures = DECLARATIONS.filter((declaration) => !isAllowed(declaration)).map(
        (declaration) =>
          `  ${declaration.file}:${String(declaration.line)}: ${declaration.name} = ${declaration.literal}\n` +
          `      ${declaration.text}`,
      );
      expect(
        failures.join('\n'),
        `A module declares a numeric limit outside @iridium/contracts/limits.ts (invariant 6).\n${REMEDY}`,
      ).toBe('');
    });

    it('keeps the register honest: every entry still matches a declaration', () => {
      const stale = ALLOWED.filter(
        (entry) =>
          !DECLARATIONS.some(
            (declaration) => declaration.file === entry.file && declaration.name === entry.name,
          ),
      ).map((entry) => `  ${entry.file}: ${entry.name}`);
      expect(
        stale.join('\n'),
        'These register entries match nothing. Delete them: an exemption for a number that no longer exists is an exemption nobody will notice being reused.',
      ).toBe('');
    });
  });

  describe('the declaration matcher', () => {
    it('reads the three shapes that bind a number to a limit-worded name', () => {
      const found = declarationsIn(
        'fixture.ts',
        'const UPLOAD_MAX_BYTES = 52_428_800;\n' +
          'const cap: number = 7;\n' +
          'const options = { maxRssBytes: 0 };\n' +
          'const schema = { PAT_MAX_LIFETIME_DAYS: intField(366, { min: 1 }) };\n',
      );
      expect(found.map((declaration) => `${declaration.name}=${declaration.literal}`)).toEqual([
        'UPLOAD_MAX_BYTES=52_428_800',
        'cap=7',
        'maxRssBytes=0',
        'PAT_MAX_LIFETIME_DAYS=366',
      ]);
      expect(found[0]?.line).toBe(1);
      expect(found[3]?.line).toBe(4);
    });

    it('reads a use of the policy, a bound and a comparison as what they are', () => {
      const found = declarationsIn(
        'fixture.ts',
        'const a = intField(LIMITS.LOADED_DOCS_MAX, { min: 1 });\n' +
          'const b = { PORT: intField(DEFAULT_PORT, { min: 0, max: PORT_MAX }) };\n' +
          'const c = Math.max(1, cpus - 1);\n' +
          'const d = value.slice(0, CLIENT_VERSION_MAX_LENGTH);\n' +
          'if (parsed.PRESSURE_MAX_HEAP_BYTES !== 0) throw new Error("x");\n' +
          'const e = { maxAge: HSTS_MAX_AGE_SECONDS };\n',
      );
      expect(found).toEqual([]);
    });

    it('does not read a number out of a comment or a string', () => {
      expect(
        declarationsIn(
          'fixture.ts',
          '// UPLOAD_MAX_BYTES = 52_428_800 in prose\nconst message = "cap: 5";\n',
        ),
      ).toEqual([]);
    });

    it('treats `capacity` and `maximum` as ordinary words, as the policy spells the rule', () => {
      expect(declarationsIn('fixture.ts', 'const capacity = 5;\nconst maximum = 6;\n')).toEqual([]);
      expect(declarationsIn('fixture.ts', 'const CAP_BYTES = 5;\n')).toHaveLength(1);
    });
  });

  describe('the literals the policy owns stay in the policy', () => {
    it('derives them from LIMITS, and they are the set the plan names', () => {
      // Annotated `unknown` because `LIMITS` is `as const`: without widening, every value's type is
      // its own literal and the numeric predicate below could not be written.
      const derived = POLICY_ENFORCERS.flatMap((enforcer) =>
        enforcer.limits.map((id): unknown => LIMITS[id]),
      );
      const numeric = derived.filter((value): value is number => typeof value === 'number');
      expect(numeric, 'every constant these two modules enforce is a number').toHaveLength(
        derived.length,
      );
      expect([...new Set(numeric)].toSorted((a, b) => a - b)).toEqual(DOCUMENTED_POLICY_LITERALS);
    });

    for (const enforcer of POLICY_ENFORCERS) {
      const present = existsSync(join(REPO_ROOT, enforcer.file));
      // The milestone that enforces the limit brings the module with it. Until then the scan has
      // nothing to read, and the test name says so rather than reporting a pass it did not earn;
      // the matcher itself is proven by the in-memory case below.
      const absent = present ? '' : ' (absent at this milestone)';
      it(`finds no policy-owned literal in ${enforcer.file}${absent}`, () => {
        const failures = policyLiteralHits(enforcer);
        expect(
          failures.join('\n'),
          `${enforcer.file} enforces a limit the policy owns; it must read the value from @iridium/contracts/limits.ts rather than repeat it.\n${REMEDY}`,
        ).toBe('');
      });
    }

    it('matches a policy literal as a whole token, and never inside another number or name', () => {
      const value = LIMITS.NODE_NAME_MAX_BYTES;
      const pattern = new RegExp(String.raw`(?<![\w$.])` + String(value) + String.raw`(?![\w$])`);
      expect(pattern.test(`const n = ${String(value)};`)).toBe(true);
      expect(pattern.test(`const n = ${String(value)}0;`)).toBe(false);
      expect(pattern.test(`const n = COLUMN_${String(value)};`)).toBe(false);
    });
  });
});
