/**
 * `scripts/check-test-name-references.ts` — a `static`-job check, not a `pnpm gen` step
 * (10-testing-and-quality.md, "Inventory completeness").
 *
 * It greps every Markdown file under `docs/plan/` and `docs/` for `<area>.<subject>.<layer>` and fails
 * on any match that is not a key of `docs/acceptance-map.json`, printing the canonical spelling when
 * the match is a superseded variant. A rename therefore breaks the build in the commit that renames,
 * and cross-section drift is a build failure rather than a discovery at implementation time.
 *
 * ## Two recorded divergences from the grep the plan prints
 *
 * **The pattern is one quantifier wider.** The section prints
 * `[a-z][a-z0-9-]*(\.[a-z0-9-]+)+\.(unit|…|drill)`, whose `+` requires three dot-separated segments.
 * Most of the web E2E inventory is two — `three-editors.e2e`, `saved-indicator.e2e`,
 * `vault-isolation.e2e`, `admin.e2e` — so the grep as printed would never look at them. Since those
 * are real names the acceptance map is keyed on, this checker uses `*` and the divergence is recorded
 * rather than silently adopted. Correcting the printed grep is an edit due in that section.
 *
 * **`docs.spikes.spec` is a literal exception**, exactly as the section states: `spec` is not one of
 * the ten legal layer segments, so the pattern cannot see the name, and widening the alternation with
 * `spec` was rejected because every `*.spec.ts` filename quoted in the plan would then look like a
 * test name. It is matched by name and resolved through the map like any pattern match.
 *
 * ## What a failure means
 *
 * A name in the plan that the map does not carry is an **undefined reference**: nothing says where the
 * file lives, which project runs it, or what it asserts, and `guards.acceptance-map.guard` cannot be
 * satisfied by it. The fix is either to add the test to an inventory of
 * 10-testing-and-quality.md — which regenerates the map — or to correct the citing section to the
 * canonical spelling this check prints.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { isRecord, parseJson } from './lib/json.ts';
import { ARTEFACTS, DOCS_ROOT, REPO_ROOT } from './lib/paths.ts';
import { LAYER_SEGMENTS, LITERAL_TEST_NAMES, NOT_TEST_NAMES } from './lib/test-names.ts';

/** See the header: one quantifier wider than the grep the plan prints. */
const REFERENCE_PATTERN = new RegExp(
  `\\b[a-z][a-z0-9-]*(?:\\.[a-z0-9-]+)*\\.(?:${LAYER_SEGMENTS.join('|')})\\b`,
  'g',
);

interface Reference {
  readonly name: string;
  readonly file: string;
  readonly line: number;
}

function markdownFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      found.push(...markdownFiles(path));
      continue;
    }
    if (entry.endsWith('.md')) found.push(path);
  }
  return found;
}

/**
 * Whether a match is part of a file path rather than a test name.
 *
 * The pattern the section prints matches inside a quoted path too: `packages/contracts/src/
 * paths.prop.spec.ts` contains `paths.prop`, and `apps/e2e/web/three-editors.e2e.spec.ts` contains
 * `three-editors.e2e`. Those are the Location convention's *files*, cited in the same tables as the
 * names, and reporting them would bury the real findings under dozens of spellings nobody wrote as a
 * test name. Two markers identify a path: the match is followed by `.spec`, or it is preceded by a
 * path separator.
 */
function isFilePath(line: string, match: RegExpExecArray): boolean {
  const start = match.index;
  const end = start + match[0].length;
  if (line.slice(end, end + 5) === '.spec') return true;
  // A call, not a name: `it.prop(...)` is `@fast-check/vitest`'s runner, quoted in the spike notes.
  if (line[end] === '(') return true;
  return line[start - 1] === '/';
}

/**
 * Lines that belong to a table recording superseded spellings.
 *
 * That table's whole job is to write down the names that are *not* map keys, beside their canonical
 * replacements, so applying the check to its own rows would make the table unwritable. Rows of a table
 * whose first column is `Superseded` are therefore skipped — and only those: a superseded name cited
 * anywhere else is exactly what this check exists to find, and the section says so ("the fix is a
 * rename in the citing section rather than a duplicate test").
 */
function supersededTableLines(lines: readonly string[]): Set<number> {
  const skipped = new Set<number>();
  for (const [index, line] of lines.entries()) {
    if (!/^\|\s*Superseded\s*\|/i.test(line.trim())) continue;
    for (let cursor = index; cursor < lines.length; cursor += 1) {
      if (!(lines[cursor] ?? '').trimStart().startsWith('|')) break;
      skipped.add(cursor);
    }
  }
  return skipped;
}

/** Every `<area>.<subject>.<layer>` reference in the documentation, with where it was written. */
export function collectReferences(): Reference[] {
  const references: Reference[] = [];
  for (const file of markdownFiles(DOCS_ROOT)) {
    const lines = readFileSync(file, 'utf8').replaceAll('\r\n', '\n').split('\n');
    const skip = supersededTableLines(lines);
    for (const [index, line] of lines.entries()) {
      if (skip.has(index)) continue;
      const names = new Set<string>([
        ...[...line.matchAll(REFERENCE_PATTERN)]
          .filter((match) => !isFilePath(line, match))
          .map((match) => match[0])
          // The property runner's API (`it.prop`, `test.prop`) fits the grammar and is quoted as code.
          .filter((name) => !NOT_TEST_NAMES.includes(name)),
        ...LITERAL_TEST_NAMES.filter((name) => line.includes(name)),
      ]);
      for (const name of names) {
        references.push({
          name,
          file: relative(REPO_ROOT, file).replaceAll('\\', '/'),
          line: index + 1,
        });
      }
    }
  }
  return references;
}

interface Map_ {
  readonly tests: Record<string, unknown>;
  readonly superseded: readonly { superseded: readonly string[]; canonical: readonly string[] }[];
}

function readMap(): Map_ {
  const parsed = parseJson(readFileSync(ARTEFACTS.acceptanceMap, 'utf8'));
  const tests = isRecord(parsed) ? parsed['tests'] : undefined;
  const superseded = isRecord(parsed) ? parsed['superseded'] : undefined;
  if (!isRecord(tests)) {
    throw new Error(
      'docs/acceptance-map.json carries no `tests` object. Run `pnpm gen` to regenerate it.',
    );
  }
  const rows: { superseded: string[]; canonical: string[] }[] = [];
  if (Array.isArray(superseded)) {
    for (const row of superseded) {
      if (!isRecord(row)) continue;
      const names = row['superseded'];
      const canonical = row['canonical'];
      if (!Array.isArray(names) || !Array.isArray(canonical)) continue;
      rows.push({
        superseded: names.filter((name) => typeof name === 'string'),
        canonical: canonical.filter((name) => typeof name === 'string'),
      });
    }
  }
  return { tests, superseded: rows };
}

function main(): void {
  const map = readMap();
  // A row with N superseded spellings against N canonical ones pairs positionally; anything else
  // offers the whole canonical list, because the table states no other correspondence.
  const canonicalFor = new Map<string, string[]>();
  for (const row of map.superseded) {
    const paired = row.superseded.length === row.canonical.length;
    for (const [index, name] of row.superseded.entries()) {
      const canonical = paired ? [row.canonical[index] ?? ''] : [...row.canonical];
      canonicalFor.set(name, canonical);
    }
  }

  const unresolved = new Map<string, Reference[]>();
  for (const reference of collectReferences()) {
    if (Object.hasOwn(map.tests, reference.name)) continue;
    const existing = unresolved.get(reference.name) ?? [];
    existing.push(reference);
    unresolved.set(reference.name, existing);
  }

  const total = Object.keys(map.tests).length;
  if (unresolved.size === 0) {
    console.info(
      `check-test-name-references: every test name in docs/ resolves to one of the ` +
        `${String(total)} keys of docs/acceptance-map.json.`,
    );
    return;
  }

  console.error(
    `check-test-name-references: ${String(unresolved.size)} name(s) in docs/ are not keys of ` +
      'docs/acceptance-map.json.',
  );
  for (const [name, references] of [...unresolved.entries()].toSorted(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const canonical = canonicalFor.get(name);
    const remedy =
      canonical === undefined
        ? 'not in any inventory of 10-testing-and-quality.md'
        : `superseded — the canonical spelling is ${canonical.join(' / ')}`;
    console.error(`  ${name}: ${remedy}`);
    for (const reference of references.slice(0, 3)) {
      console.error(`      ${reference.file}:${String(reference.line)}`);
    }
    if (references.length > 3) {
      console.error(`      … and ${String(references.length - 3)} more citation(s)`);
    }
  }
  process.exitCode = 1;
}

main();
