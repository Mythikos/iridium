/**
 * `guards.one-boot-path.guard` (10-testing-and-quality.md line 349 and its guard table; invariant 1
 * of 02-system-architecture.md; ARCH-01).
 *
 * One boot path means two things that no other test would catch until production:
 *
 *  1. **one construction site per server.** `buildApp({ mode })` is the only place `Fastify(` is
 *     called and, from M1, the only place `new Hocuspocus(` is called. A second construction site is
 *     a second plugin tree — a route registered on one and not the other, a hook that runs under
 *     `child` and not under `in-process` — and the divergence stays invisible until the mode nobody
 *     covered runs in production. `app.boot-modes.integration` owns the behavioural half (the three
 *     modes produce identical route tables and registration orders); this file owns the static half.
 *  2. **no test-only branch in the product boot path.** `NODE_ENV === 'test'` may be read in exactly
 *     two modules — `src/ops/faults.ts`, where the fault registry is inert outside the harness, and
 *     `src/config/env.ts`, where the environment is validated — because those two are where the plan
 *     puts the decision. Anywhere else it is behaviour the harness sees and production does not,
 *     which is the one class of defect a test suite cannot report on.
 *
 * **What the milestone axis does to the counts.** The collaboration server is constructed at M1, so
 * `new Hocuspocus(` has *zero* construction sites today and that must pass; `Fastify(` has exactly
 * one, because the server boots at M0. The rule is therefore "at least what this milestone has
 * reached, and never more than one", and both halves are named in the failure message so a count of
 * zero never reads as a count of one. `src/ops/faults.ts` is absent at M0 for the same reason: an
 * exempt module that does not exist yet exempts nothing, which is exactly right.
 *
 * **Why the scan masks comments and strings.** `apps/server/src/app.ts` opens by stating in prose
 * that there is exactly one `Fastify(` construction site, and `src/authz/route-policy.ts` documents
 * the `/__test__` namespace as existing only under `NODE_ENV=test`. A line matcher over raw text
 * counts both, so the guard would fail on the very comments that record the invariant. Every scan
 * below therefore runs over source whose comments — and, where a string cannot carry the construct,
 * whose string contents — are replaced by spaces of the same length, so a reported offset is still
 * the real `file:line`.
 *
 * Co-located `*.spec.ts` files under `src/` are scanned like every other module. The plan names the
 * directory, and a test that reaches for `Fastify(` rather than `buildApp()` is a test written
 * against a boot path the product does not have.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SCANNED_DIR = 'apps/server/src';

/**
 * The two modules that may branch on `NODE_ENV` being `test` (10-testing-and-quality.md line 349).
 * Repository-relative and named rather than globbed, so a rename is a hard error rather than a
 * silently widened exemption.
 */
const TEST_BRANCH_EXEMPT: readonly string[] = [
  'apps/server/src/ops/faults.ts', // the fault registry, inert unless NODE_ENV=test
  'apps/server/src/config/env.ts', // the environment schema, which refuses IRIDIUM_FAULT in production
];

/** One server whose construction must happen in one place, and what this milestone has reached. */
interface ServerConstructor {
  /** How the plan writes the construction site. */
  readonly site: string;
  /** The module specifier whose export is constructed. */
  readonly module: string;
  /** The exported binding, as the plan spells it. */
  readonly exported: string;
  /** `true` for `new Binding(`, `false` for `Binding(` — the default export called as a function. */
  readonly isNew: boolean;
  /** Construction sites this milestone requires. Hocuspocus arrives at M1, so zero until then. */
  readonly atLeast: number;
  /** Printed whenever the count leaves the allowed range. */
  readonly note: string;
}

const CONSTRUCTORS: readonly ServerConstructor[] = [
  {
    site: 'Fastify(',
    module: 'fastify',
    exported: 'Fastify',
    isNew: false,
    atLeast: 1,
    note:
      '`buildApp({ mode })` in apps/server/src/app.ts is the one boot path (ARCH-01): the three ' +
      'modes share one plugin tree and differ only in listening, signal handling and the scheduler.',
  },
  {
    site: 'new Hocuspocus(',
    module: '@hocuspocus/server',
    exported: 'Hocuspocus',
    isNew: true,
    atLeast: 0,
    note:
      'The collaboration server is constructed at M1, inside the `collab` plugin of `buildApp`. ' +
      'Zero construction sites is the correct count until then, and this guard passes on zero; ' +
      'two would mean two instances owning the same documents in one process.',
  },
];

/** A scanned module: its repository-relative path and the three views the matchers read. */
interface Source {
  readonly path: string;
  /** Comments and string/template/regex contents replaced by spaces, offsets preserved. */
  readonly code: string;
  /** Comments replaced by spaces, string contents intact, offsets preserved. */
  readonly noComments: string;
  /** The raw text, for rendering the reported line. */
  readonly raw: string;
}

function walk(dir: string, files: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return files; // a path this milestone has not created yet contributes no files
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'dist' || entry === 'generated') continue;
    if (entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, files);
    else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) files.push(full);
  }
  return files;
}

/**
 * Replace comments — and, when asked, string, template and regular-expression literal contents —
 * with spaces, preserving every offset and newline so a match still reports the real line.
 *
 * A `/` opens a regular expression when the previous significant character cannot end an expression;
 * after an identifier, a number, `)` or `]` it is division. That is the standard heuristic, and the
 * one ambiguity it leaves (a `}` that closes a block, followed by `/`) does not occur in this tree.
 */
function mask(source: string, options: { readonly strings: boolean }): string {
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
      if (options.strings) erase(index + 1, end);
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
      if (options.strings) erase(index + 1, end);
      previousSignificant = character;
      index = Math.min(end + 1, source.length);
      continue;
    }
    if (!/\s/.test(character)) previousSignificant = character;
    index += 1;
  }
  return out.join('');
}

function sourceOf(path: string, raw: string): Source {
  return {
    path,
    code: mask(raw, { strings: true }),
    noComments: mask(raw, { strings: false }),
    raw,
  };
}

const SOURCES: readonly Source[] = walk(join(REPO_ROOT, SCANNED_DIR)).map((file) =>
  sourceOf(relative(REPO_ROOT, file).replaceAll('\\', '/'), readFileSync(file, 'utf8')),
);

/** `file:line: <the source line>` for an offset into any of one source's three aligned views. */
function locate(source: Source, offset: number): string {
  const line = source.code.slice(0, offset).split('\n').length;
  const text = (source.raw.split('\n')[line - 1] ?? '').trim();
  return `${source.path}:${String(line)}: ${text}`;
}

function escapeForRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\/]/g, (character) => `\\${character}`);
}

/**
 * The local names a module's export is bound to in one file, so a construction site cannot hide
 * behind `import theServer from 'fastify'`. Pass `null` for the default export.
 *
 * Read from the comment-masked, string-bearing view: the module specifier is itself a string.
 */
function importedBindings(noComments: string, module: string, exported: string | null): string[] {
  const specifier = escapeForRegExp(module);
  const clauses = new RegExp('import\\s+([^;]*?)\\s+from\\s*[\'"`]' + specifier + '[\'"`]', 'g');
  const bindings: string[] = [];
  for (const match of noComments.matchAll(clauses)) {
    const clause = match[1] ?? '';
    if (exported === null) {
      const defaultBinding = /^\s*([A-Za-z_$][\w$]*)/.exec(clause);
      if (defaultBinding !== null) bindings.push(defaultBinding[1] ?? '');
      continue;
    }
    const named = new RegExp(
      '\\{[^}]*\\b' + escapeForRegExp(exported) + '\\b(?:\\s+as\\s+([A-Za-z_$][\\w$]*))?[^}]*\\}',
      's',
    ).exec(clause);
    if (named !== null) bindings.push(named[1] ?? exported);
  }
  return bindings.filter((binding) => binding !== '');
}

/** Every construction site of one server, as `file:line: text`, sorted for a stable message. */
function constructionSites(constructor: ServerConstructor): string[] {
  const hits: string[] = [];
  for (const source of SOURCES) {
    const names = new Set<string>([constructor.exported]);
    for (const binding of importedBindings(
      source.noComments,
      constructor.module,
      constructor.isNew ? constructor.exported : null,
    )) {
      names.add(binding);
    }
    for (const name of names) {
      const prefix = constructor.isNew ? 'new\\s+' : '(?<![.\\w$])';
      const pattern = new RegExp(prefix + escapeForRegExp(name) + '\\s*\\(', 'g');
      for (const match of source.code.matchAll(pattern)) hits.push(locate(source, match.index));
    }
  }
  return [...new Set(hits)].toSorted((a, b) => a.localeCompare(b));
}

/**
 * Where a `NODE_ENV` occurrence ends when it is really a read of the variable, or `null` when the
 * occurrence is prose.
 *
 * Two spellings read it: the identifier `process.env.NODE_ENV`, which survives the code mask, and
 * the computed access `process.env['NODE_ENV']`, whose key is a string literal and is therefore
 * masked out of the code view. The second is accepted only in the bracketed form, which is what
 * separates a read from the same eight characters sitting inside an error message.
 */
function envReadEnd(source: Source, start: number): number | null {
  const end = start + 'NODE_ENV'.length;
  if (source.code.slice(start, end) === 'NODE_ENV') return end;
  const opening = source.noComments.slice(Math.max(0, start - 2), start);
  const closing = source.noComments.slice(end, end + 2);
  if (/\[['"`]$/.test(opening) && /^['"`]\]/.test(closing)) return end + 2;
  return null;
}

/**
 * Every place a module decides something on `NODE_ENV` being — or not being — `test`.
 *
 * The comparison is read out of the string-bearing view, because the `'test'` half of the branch
 * *is* a string literal; the `NODE_ENV` half is accepted only where `envReadEnd` says it is a read
 * rather than prose. A `switch` on `NODE_ENV` is a branch too, whatever its cases say.
 */
function testBranches(source: Source): string[] {
  const hits: string[] = [];
  for (const match of source.noComments.matchAll(/\bNODE_ENV\b/g)) {
    const start = match.index;
    const end = envReadEnd(source, start);
    if (end === null) continue;
    const after = source.noComments.slice(end, end + 60);
    const before = source.noComments.slice(Math.max(0, start - 60), start);
    // `'test' === process.env.NODE_ENV` puts the access between the operator and the match, so the
    // access is trimmed off the tail before the reversed comparison is read.
    const beforeOperator = before.replace(/(?:[A-Za-z_$][\w$]*|[.[\s'"`])*$/, '');
    const comparedAfter = /^\s*(?:===|!==|==|!=)\s*(['"`])test\1/.test(after);
    const comparedBefore = /(['"`])test\1\s*(?:===|!==|==|!=)$/.test(beforeOperator);
    const switchedOn = /switch\s*\([^()]*$/.test(before);
    if (comparedAfter || comparedBefore || switchedOn) hits.push(locate(source, start));
  }
  return hits;
}

const REMEDY_BOOT =
  'Remedy: call `buildApp({ mode })` (apps/server/src/app.ts) instead of constructing a second ' +
  'server — one plugin tree, three modes.';
const REMEDY_BRANCH =
  'Remedy: move the decision into `src/config/env.ts` as a validated setting, or behind a fault ' +
  'point in `src/ops/faults.ts`. A product module behaves the same under the harness and in ' +
  'production, or the harness is proving nothing.';

describe('guards.one-boot-path.guard [area:ops]', () => {
  it('scans every module under the directory the rule names', () => {
    expect(
      SOURCES.length,
      `${SCANNED_DIR} resolved no files, so every scan below would pass vacuously`,
    ).toBeGreaterThan(0);
    expect(SOURCES.map((source) => source.path)).toContain('apps/server/src/app.ts');
  });

  describe('one construction site per server', () => {
    for (const constructor of CONSTRUCTORS) {
      it(`counts \`${constructor.site}\` in ${SCANNED_DIR}: at least ${String(constructor.atLeast)}, never more than one`, () => {
        const sites = constructionSites(constructor);
        const found = `\`${constructor.site}\` has ${String(sites.length)} construction site(s)`;
        const listed =
          sites.length === 0 ? '  (none)' : sites.map((site) => `  ${site}`).join('\n');
        expect(
          sites.length,
          `${found}, and the invariant allows one.\n${constructor.note}\n${REMEDY_BOOT}\n${listed}`,
        ).toBeLessThanOrEqual(1);
        expect(
          sites.length,
          `${found}, and this milestone requires at least ${String(constructor.atLeast)}.\n${constructor.note}`,
        ).toBeGreaterThanOrEqual(constructor.atLeast);
      });
    }

    it('reads the construction site through the local binding, not through a fixed spelling', () => {
      expect(importedBindings("import theServer from 'fastify';", 'fastify', null)).toEqual([
        'theServer',
      ]);
      expect(
        importedBindings(
          "import { Hocuspocus as Hp } from '@hocuspocus/server';",
          '@hocuspocus/server',
          'Hocuspocus',
        ),
      ).toEqual(['Hp']);
      expect(
        importedBindings(
          "import { Server } from '@hocuspocus/server';",
          '@hocuspocus/server',
          'Hocuspocus',
        ),
      ).toEqual([]);
    });
  });

  describe('no test-only branch outside the two modules that own the decision', () => {
    it('names exactly the two exempt modules, and at least one of them exists', () => {
      expect(TEST_BRANCH_EXEMPT).toEqual([
        'apps/server/src/ops/faults.ts',
        'apps/server/src/config/env.ts',
      ]);
      const present = TEST_BRANCH_EXEMPT.filter((path) =>
        SOURCES.some((source) => source.path === path),
      );
      expect(
        present,
        'every exempt module is absent, so the exemption covers nothing and the scan is vacuous',
      ).not.toHaveLength(0);
    });

    it('finds no branch on NODE_ENV being test in any other module', () => {
      const failures = SOURCES.filter(
        (source) => !TEST_BRANCH_EXEMPT.includes(source.path),
      ).flatMap((source) => testBranches(source).map((hit) => `  ${hit}`));
      expect(
        failures.join('\n'),
        `A product module branches on NODE_ENV being \`test\`.\n${REMEDY_BRANCH}`,
      ).toBe('');
    });

    it('reads a branch out of code and never out of prose or a message', () => {
      const fixture = sourceOf(
        'fixture.ts',
        "if (process.env.NODE_ENV === 'test') enable();\n" +
          "// NODE_ENV === 'test' written in a comment is prose\n" +
          'throw new Error("refused unless NODE_ENV === \'test\'");\n' +
          "switch (process.env.NODE_ENV) { case 'test': break; }\n",
      );
      const hits = testBranches(fixture);
      expect(hits).toHaveLength(2);
      expect(hits[0]).toContain('fixture.ts:1:');
      expect(hits[1]).toContain('fixture.ts:4:');
    });

    it('reads the bracketed access and the reversed comparison too', () => {
      const fixture = sourceOf(
        'fixture.ts',
        "const a = process.env['NODE_ENV'] !== 'test';\n" +
          "const b = 'test' === process.env.NODE_ENV;\n" +
          "const c = 'test' === process.env['NODE_ENV'];\n",
      );
      expect(testBranches(fixture)).toHaveLength(3);
    });

    it('leaves a comparison against another environment alone', () => {
      const fixture = sourceOf(
        'fixture.ts',
        "const production = process.env.NODE_ENV === 'production';\n" +
          'const label = `NODE_ENV=${String(process.env.NODE_ENV)}`;\n',
      );
      expect(testBranches(fixture)).toHaveLength(0);
    });
  });

  describe('the masker both scans share', () => {
    it('erases a comment and keeps every offset', () => {
      const raw = 'const a = 1; // Fastify(\nconst b = 2;\n';
      const masked = mask(raw, { strings: true });
      expect(masked).not.toContain('Fastify(');
      expect(masked).toHaveLength(raw.length);
      expect(masked.split('\n')).toHaveLength(3);
    });

    it('erases a string body without erasing its quotes, and only when asked', () => {
      expect(mask("const a = 'Fastify(';", { strings: true })).toBe("const a = '        ';");
      expect(mask("const a = 'Fastify(';", { strings: false })).toBe("const a = 'Fastify(';");
    });

    it('does not mistake a division for a regular expression', () => {
      expect(mask('const ratio = total / count; const q = "x";', { strings: true })).toBe(
        'const ratio = total / count; const q = " ";',
      );
    });
  });
});
