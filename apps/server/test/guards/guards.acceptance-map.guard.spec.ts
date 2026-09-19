/**
 * `guards.acceptance-map.guard` — the acceptance map is complete and honest
 * (10-testing-and-quality.md principle 5, "Named test inventory" rules 1-7 and the guard table row;
 * 12-milestones.md §3 "Acceptance map" and D12-16).
 *
 * The plan promises that every acceptance row, every hard property and every specified rule has
 * named tests in named layers. A promise of that shape is worth exactly what a script can check, so
 * `scripts/build-acceptance-map.ts` turns the inventory tables of 10-testing-and-quality.md into
 * `docs/acceptance-map.json` and this file holds the repository to it.
 *
 * **The milestone axis is what makes the gate runnable rather than red.** `docs/milestones/CURRENT`
 * names the *last exited* milestone (D12-16), so a layer is enforced from the exit that arms it: a
 * row that needs a browser layer at M4 is not demanded at M0, and a milestone cannot exit while its
 * own layers are empty. Every rule below therefore asks "is this due?" before it asks "does it
 * exist?".
 *
 * **A test is identified by its `describe` title, never by its file name.** The Location convention
 * lets a name live at a path the name does not spell (`crdt.dominates.prop` in
 * `packages/crdt/src/dominates.prop.spec.ts`), and the completeness tables — not the filesystem —
 * are the authority mapping a name to a path. So the single walk below reads the top-level
 * `describe` title of every `*.spec.ts[x]` in the workspace and a test exists when some title starts
 * with its exact name.
 *
 * The seven rules, in the plan's numbering:
 *
 *  1. a row id has no test in a required layer that is due;
 *  2. a test claims a `[spec:…]` or `[hp:…]` id the map does not list;
 *  3. a hard-property id has no test in a required layer that is due;
 *  4. a file under `apps/e2e/` or `apps/server/test/` carries none of the three requirement tags;
 *  5. a case in `hostContractCases()` has no recorded pass in every host-contract harness that is
 *     due — the one rule that needs evidence from three CI jobs, so it reads
 *     `IRIDIUM_TEST_HOST_CONTRACT_REPORTS` and has nothing to check until M4 arms the first harness;
 *  6. a rule id names a test that does not exist, or whose file does not carry the tag the
 *     "Specified rules outside the nine rows" table states;
 *  7. a gating layer names a test that no merge-blocking lane selects.
 *
 * **What this guard deliberately does not do.** It never asks whether the committed map still agrees
 * with the prose tables it was generated from: that is `gen.drift.guard`, which runs `pnpm gen` and
 * diffs. Two checks over one artefact would make a stale map fail twice and be fixed in neither
 * place with confidence.
 *
 * **Per-test milestones, not just per-layer ones.** An entry becomes due at the earliest milestone of
 * its tests (the derivation `scripts/build-acceptance-map.ts` documents), so demanding *every* test
 * of a due entry would demand an M1 test at M0. Each named test is therefore weighed against its own
 * inventory milestone, and the entry as a whole against rule 1/3's floor: a due layer has at least
 * one test. That is also why the remedy in every message offers two exits — write the spec, or move
 * the milestone in the inventory row that schedules it.
 *
 * Two exemptions from rule 4 are recorded rather than silent. The `guard` project is the plan's own
 * ("untagged tests are allowed only in the `guard` project"), and the throwaway spike harness under
 * `apps/server/test/spikes/` is outside the file-name convention (`*.spike.spec.ts` names no layer),
 * belongs to no project of the root `vitest.config.ts` and is deleted when M1 absorbs it (D12-5).
 * Rule 4 is therefore applied to files whose basename ends in one of the ten legal layers.
 *
 * Checks read source and runner configuration through a root-owned tool, needing no Docker, network or
 * build, and it walks the workspace exactly once — which is what keeps it in the first
 * `vitest --project guard` step of `ci.yml › static`.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, matchesGlob, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { sourceOf } from './source-scan.ts';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const MAP_FILE = join(REPO_ROOT, 'docs', 'acceptance-map.json');
const CURRENT_MILESTONE_FILE = join(REPO_ROOT, 'docs', 'milestones', 'CURRENT');

/** How each source is named in a failure message, so a remedy points at a file a human can open. */
const MAP_REFERENCE = 'docs/acceptance-map.json';
const CURRENT_REFERENCE = 'docs/milestones/CURRENT';
const INVENTORY_REFERENCE = 'docs/plan/10-testing-and-quality.md, "Inventory completeness"';
const RULES_TABLE_REFERENCE =
  'docs/plan/10-testing-and-quality.md, "Specified rules outside the nine rows"';
const REGENERATE = 'regenerate the map with `pnpm gen` and commit it';

/** The workspace roots the walk covers: every place a `*.spec.ts[x]` may live. */
const WALK_ROOTS: readonly string[] = ['apps', 'packages', 'spikes', 'tooling'];

/** The ten legal layer segments of the file-name convention. */
const LAYER_BASENAME =
  /\.(?:unit|component|integration|prop|chaos|contract|mcp|e2e|guard|drill)\.spec\.tsx?$/;

/** The trees rule 4 polices, and the one path inside them the plan exempts. */
const TAGGED_TREES: readonly string[] = ['apps/e2e/', 'apps/server/test/'];
const GUARD_PROJECT_TREE = 'apps/server/test/guards/';

/** Rule 7's merge-blocking selector: `@smoke` is what the `e2e-electron` lane runs. */
const SMOKE_TAG = '@smoke';
const GATING_LAYER = 'L7';

/** Rule 5's evidence, produced by three different CI jobs and merged in `merge-reports`. */
const HOST_CONTRACT_REPORTS_VAR = 'IRIDIUM_TEST_HOST_CONTRACT_REPORTS';

// ---------------------------------------------------------------------------------------------
// The map, validated before it is trusted
// ---------------------------------------------------------------------------------------------

/** One `{rowId | hpId | ruleId, layer, sinceMilestone, tests[]}` entry — the guard's unit of work. */
interface MapEntry {
  readonly id: string;
  readonly namespace: 'rowId' | 'hpId' | 'ruleId';
  readonly layer: string;
  readonly sinceMilestone: string;
  readonly gating: boolean;
  readonly tests: readonly string[];
}

/** What the map records about one test name. `null` is "the inventory does not resolve this". */
interface TestRecord {
  readonly sinceMilestone: string | null;
  readonly project: string | null;
  readonly file: string | null;
  readonly tag: string | null;
}

interface AcceptanceMap {
  readonly milestones: readonly string[];
  readonly exitCriteria: ReadonlyMap<string, readonly string[]>;
  readonly entries: readonly MapEntry[];
  readonly rowIds: ReadonlySet<string>;
  readonly hpIds: ReadonlySet<string>;
  /** `ruleId` → the requirement tag the rules table states for its tests (rule 6). */
  readonly ruleTags: ReadonlyMap<string, string>;
  readonly hostContractHarnesses: readonly string[];
  readonly tests: ReadonlyMap<string, TestRecord>;
  readonly postOnePointZero: ReadonlyMap<
    string,
    { readonly epic: string; readonly reason: string }
  >;
}

function mapError(what: string): never {
  throw new Error(
    `${MAP_REFERENCE} ${what}. The map is generated from ${INVENTORY_REFERENCE} by ` +
      `scripts/build-acceptance-map.ts: correct the table it is generated from, then ${REGENERATE}.`,
  );
}

function objectAt(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    mapError(`: ${where} is not an object`);
  }
  // Rebuilt rather than asserted: the guard validates its own input, so it never tells the type
  // system something it has not checked.
  return Object.fromEntries(Object.entries(value));
}

/** One field of a value that may not be an object at all — used for files the guard does not own. */
function fieldOf(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  return Object.fromEntries(Object.entries(value))[key];
}

function arrayAt(source: Record<string, unknown>, key: string, where: string): readonly unknown[] {
  const value = source[key];
  if (!Array.isArray(value)) mapError(`: ${where}.${key} is not an array`);
  return value;
}

function stringAt(source: Record<string, unknown>, key: string, where: string): string {
  const value = source[key];
  if (typeof value !== 'string' || value === '') {
    mapError(`: ${where}.${key} is not a non-empty string`);
  }
  return value;
}

function stringOrNullAt(
  source: Record<string, unknown>,
  key: string,
  where: string,
): string | null {
  const value = source[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') mapError(`: ${where}.${key} is neither a string nor null`);
  return value;
}

function readEntry(value: unknown, index: number): MapEntry {
  const where = `entries[${String(index)}]`;
  const source = objectAt(value, where);
  const namespaces = (['rowId', 'hpId', 'ruleId'] as const).filter(
    (key) => source[key] !== undefined,
  );
  const namespace = namespaces[0];
  if (namespaces.length !== 1 || namespace === undefined) {
    mapError(
      `: ${where} carries ${String(namespaces.length)} of rowId/hpId/ruleId; every entry carries ` +
        'exactly one, because the three are the map’s three id namespaces',
    );
  }
  return {
    id: stringAt(source, namespace, where),
    namespace,
    layer: stringAt(source, 'layer', where),
    sinceMilestone: stringAt(source, 'sinceMilestone', where),
    gating: source['gating'] === true,
    tests: arrayAt(source, 'tests', where).map((test, position) => {
      if (typeof test !== 'string' || test === '') {
        mapError(`: ${where}.tests[${String(position)}] is not a test name`);
      }
      return test;
    }),
  };
}

function readIdSet(
  root: Record<string, unknown>,
  key: string,
  idKey: 'rowId' | 'hpId',
): ReadonlySet<string> {
  return new Set(
    arrayAt(root, key, 'the map').map((value, index) =>
      stringAt(objectAt(value, `${key}[${String(index)}]`), idKey, `${key}[${String(index)}]`),
    ),
  );
}

function readAcceptanceMap(text: string): AcceptanceMap {
  const root = objectAt(JSON.parse(text), 'the map');
  const milestones = arrayAt(root, 'milestones', 'the map').map((value, index) => {
    if (typeof value !== 'string' || value === '') {
      mapError(`: milestones[${String(index)}] is not a milestone name`);
    }
    return value;
  });
  if (milestones.length === 0) mapError(': `milestones` is empty, so nothing can be due');

  const exitCriteriaRoot = objectAt(root['exitCriteria'], 'the map.exitCriteria');
  const exitCriteria = new Map<string, readonly string[]>();
  for (const milestone of milestones) {
    const names = arrayAt(exitCriteriaRoot, milestone, 'exitCriteria').map((name) => {
      if (typeof name !== 'string' || name === '')
        mapError(`: ${milestone} has an invalid exit test`);
      return name;
    });
    if (names.length === 0) mapError(`: ${milestone} names no exit tests`);
    exitCriteria.set(milestone, names);
  }

  const tests = new Map<string, TestRecord>();
  const testsRoot = objectAt(root['tests'], 'the map.tests');
  for (const [name, value] of Object.entries(testsRoot)) {
    const record = objectAt(value, `tests[${JSON.stringify(name)}]`);
    tests.set(name, {
      sinceMilestone: stringOrNullAt(record, 'sinceMilestone', `tests[${JSON.stringify(name)}]`),
      project: stringOrNullAt(record, 'project', `tests[${JSON.stringify(name)}]`),
      file: stringOrNullAt(record, 'file', `tests[${JSON.stringify(name)}]`),
      tag: stringOrNullAt(record, 'tag', `tests[${JSON.stringify(name)}]`),
    });
  }

  const postOnePointZero = new Map<string, { readonly epic: string; readonly reason: string }>();
  for (const value of arrayAt(root, 'postOnePointZero', 'the map')) {
    const exclusion = objectAt(value, 'postOnePointZero');
    const name = stringAt(exclusion, 'name', 'postOnePointZero');
    if (postOnePointZero.has(name)) mapError(`duplicates the post-1.0 exclusion for ${name}`);
    postOnePointZero.set(name, {
      epic: stringAt(exclusion, 'epic', 'postOnePointZero'),
      reason: stringAt(exclusion, 'asserts', 'postOnePointZero'),
    });
  }

  const ruleTags = new Map<string, string>();
  for (const [index, value] of arrayAt(root, 'rules', 'the map').entries()) {
    const where = `rules[${String(index)}]`;
    const rule = objectAt(value, where);
    ruleTags.set(stringAt(rule, 'ruleId', where), stringAt(rule, 'tag', where));
  }

  const entries = arrayAt(root, 'entries', 'the map').map((value, index) =>
    readEntry(value, index),
  );
  if (entries.length === 0) mapError(': `entries` is empty, so the guard has no unit of work');

  return {
    milestones,
    exitCriteria,
    entries,
    rowIds: readIdSet(root, 'rows', 'rowId'),
    hpIds: readIdSet(root, 'hardProperties', 'hpId'),
    ruleTags,
    hostContractHarnesses: arrayAt(root, 'hostContractHarnesses', 'the map').map((value, index) =>
      stringAt(
        objectAt(value, `hostContractHarnesses[${String(index)}]`),
        'name',
        `hostContractHarnesses[${String(index)}]`,
      ),
    ),
    tests,
    postOnePointZero,
  };
}

function readCurrentMilestone(text: string): string {
  const milestone = text.trim();
  if (!/^M\d+$/.test(milestone)) {
    throw new Error(
      `${CURRENT_REFERENCE} holds ${JSON.stringify(milestone)}, not an \`M<n>\` line. It names the ` +
        'last exited milestone (12-milestones.md D12-16) and is the single input that arms the ' +
        "map's `sinceMilestone` entries.",
    );
  }
  return milestone;
}

// ---------------------------------------------------------------------------------------------
// The single walk: every spec file, its top-level `describe` title and its requirement tags
// ---------------------------------------------------------------------------------------------

interface SpecFile {
  /** Repository-relative, forward slashes, so a message names a path a human can open. */
  readonly path: string;
  /** The top-level `describe` title, or `null` for a file that declares none. */
  readonly title: string | null;
  /** The first whitespace-delimited token of the title: the test name the file declares. */
  readonly name: string | null;
  readonly specTags: readonly string[];
  readonly hpTags: readonly string[];
  readonly areaTags: readonly string[];
  /** Playwright's `{ tag: [...] }` annotation on the same `describe`. */
  readonly playwrightTags: readonly string[];
}

/**
 * Only a column-zero suite declares the file's name. A parameterized suite evaluates a table before
 * its title call; balance that argument list using the masked source, so nested callbacks and
 * parentheses inside comments or strings cannot move the title boundary.
 */
const TOP_LEVEL_DESCRIBE = /(?:^|\n)(?:test\.)?describe(?:\.each)?\s*\(/;

function describeTitle(source: string): { title: string; titleEnd: number } | null {
  const scanned = sourceOf('suite.ts', source);
  const match = TOP_LEVEL_DESCRIBE.exec(scanned.code);
  if (match === null) return null;
  let open = match.index + match[0].lastIndexOf('(');
  if (match[0].includes('.each')) {
    let depth = 1;
    let position = open + 1;
    while (position < scanned.code.length && depth > 0) {
      if (scanned.code[position] === '(') depth += 1;
      else if (scanned.code[position] === ')') depth -= 1;
      position += 1;
    }
    if (depth !== 0) return null;
    while (/\s/.test(scanned.code[position] ?? '') && position < scanned.code.length) position += 1;
    if (scanned.code[position] !== '(') return null;
    open = position;
  }
  const argumentsSource = scanned.noComments.slice(open + 1);
  const literal = /^\s*(['"`])((?:\\[\s\S]|(?!\1)[^\\])*)\1\s*(?=,|\))/.exec(argumentsSource);
  if (literal?.[2] === undefined) return null;
  // Dynamic template titles and concatenated strings cannot statically declare a named test.
  if (literal[1] === '`' && literal[2].includes('${')) return null;
  if (literal[1] !== '`' && /[\r\n]/.test(literal[2])) return null;
  return {
    title: literal[2].replaceAll(/\\(['"`\\])/g, '$1'),
    titleEnd: open + 1 + literal[0].length,
  };
}
const SPEC_TAG = /\[spec:([a-z\d-]+)\]/g;
const HP_TAG = /\[hp:(HP-\d+)\]/g;
const AREA_TAG = /\[area:([a-z\d-]+)\]/g;
const PLAYWRIGHT_TAG_ARRAY = /tag:\s*\[([^\]]*)\]/;
const PLAYWRIGHT_TAG = /@[a-z\d-]+/g;

function tagsOf(title: string, pattern: RegExp): string[] {
  return [...title.matchAll(pattern)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
}

/**
 * Playwright annotates the `describe` call itself (`{ tag: ['@smoke'] }`), so the annotation is read
 * from the call's arguments — the source between the title and the callback arrow — rather than from
 * the whole file, where a `tag:` in a fixture would be indistinguishable from this one.
 */
function playwrightTagsOf(source: string, describeAt: number): string[] {
  const window = source.slice(describeAt, describeAt + 1000);
  const callbackAt = window.indexOf('=>');
  const argumentList = window.slice(0, callbackAt === -1 ? window.length : callbackAt);
  const array = PLAYWRIGHT_TAG_ARRAY.exec(argumentList);
  return array?.[1] === undefined ? [] : [...array[1].matchAll(PLAYWRIGHT_TAG)].map(([tag]) => tag);
}

function readSpecSource(path: string, source: string): SpecFile {
  const suite = describeTitle(source);
  if (suite === null) {
    return {
      path,
      title: null,
      name: null,
      specTags: [],
      hpTags: [],
      areaTags: [],
      playwrightTags: [],
    };
  }
  return {
    path,
    title: suite.title,
    name: suite.title.split(/\s+/)[0] ?? null,
    specTags: tagsOf(suite.title, SPEC_TAG),
    hpTags: tagsOf(suite.title, HP_TAG),
    areaTags: tagsOf(suite.title, AREA_TAG),
    playwrightTags: playwrightTagsOf(sourceOf(path, source).noComments, suite.titleEnd),
  };
}

function readSpecFile(absolute: string): SpecFile {
  return readSpecSource(
    relative(REPO_ROOT, absolute).replaceAll('\\', '/'),
    readFileSync(absolute, 'utf8'),
  );
}
function walk(dir: string, found: string[]): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return found; // a workspace root this milestone has not created yet
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, found);
    } else if (/\.spec\.tsx?$/.test(entry)) {
      found.push(full);
    }
  }
  return found;
}

function readSpecFiles(): SpecFile[] {
  return WALK_ROOTS.flatMap((root) => walk(join(REPO_ROOT, root), [])).map((file) =>
    readSpecFile(file),
  );
}

/** Name → the files that declare it. A name is declared by the title's first token (exact match). */
function declaredTests(files: readonly SpecFile[]): ReadonlyMap<string, readonly SpecFile[]> {
  const declared = new Map<string, SpecFile[]>();
  for (const file of files) {
    if (file.name === null) continue;
    const existing = declared.get(file.name);
    if (existing === undefined) declared.set(file.name, [file]);
    else existing.push(file);
  }
  return declared;
}

// ---------------------------------------------------------------------------------------------
// The milestone axis
// ---------------------------------------------------------------------------------------------

/** Every rule asks this before it asks whether a test exists. */
function isDue(map: AcceptanceMap, current: string, milestone: string | null): boolean {
  if (milestone === null) return false;
  const position = map.milestones.indexOf(milestone);
  const reached = map.milestones.indexOf(current);
  return position !== -1 && reached !== -1 && position <= reached;
}

/**
 * When a named test is due: its own inventory milestone if the map resolves one, and otherwise the
 * milestone of the entry that names it — an unresolved name is not a reason to stop demanding the
 * test the row promises.
 */
function testMilestone(map: AcceptanceMap, entry: MapEntry, test: string): string {
  return map.tests.get(test)?.sinceMilestone ?? entry.sinceMilestone;
}

/** The requirement tag a test of this entry must carry (rule 6 states it for `ruleId` entries). */
function requiredTag(map: AcceptanceMap, entry: MapEntry): string {
  if (entry.namespace === 'rowId') return `[spec:${entry.id}]`;
  if (entry.namespace === 'hpId') return `[hp:${entry.id}]`;
  return map.ruleTags.get(entry.id) ?? `the tag ${RULES_TABLE_REFERENCE} states`;
}

function describeEntry(entry: MapEntry): string {
  return `${entry.id} ${entry.layer} (due since ${entry.sinceMilestone})`;
}

function whereItBelongs(map: AcceptanceMap, test: string): string {
  const file = map.tests.get(test)?.file;
  return file === null || file === undefined
    ? `it at the path ${INVENTORY_REFERENCE} names for it`
    : `it at ${file}`;
}

// ---------------------------------------------------------------------------------------------
// Rules 1, 3 and 6 — a due layer has the tests it names
// ---------------------------------------------------------------------------------------------

/** A project's real file selector, read through the repository-owned runner-config tool. */
interface ConfiguredProject {
  readonly name: string;
  readonly selects: (path: string) => boolean;
}

function pathWithin(directory: string, path: string): string | null {
  const candidate = relative(directory, resolve(REPO_ROOT, path)).replaceAll('\\', '/');
  return isAbsolute(candidate) || candidate === '..' || candidate.startsWith('../')
    ? null
    : candidate;
}

type PlaywrightPattern = string | RegExp;

function playwrightMatches(patterns: readonly PlaywrightPattern[], absolutePath: string): boolean {
  return patterns.some((pattern) => {
    if (typeof pattern !== 'string') {
      // A fresh expression keeps global/sticky expressions independent of earlier candidates.
      return (
        new RegExp(pattern.source, pattern.flags).test(absolutePath) ||
        new RegExp(pattern.source, pattern.flags).test(absolutePath.replaceAll('\\', '/'))
      );
    }
    const glob = pattern.startsWith('**/') ? pattern : '**/' + pattern;
    return matchesGlob(absolutePath.replaceAll('\\', '/').toLowerCase(), glob.toLowerCase());
  });
}

function selectorError(reason: string): never {
  throw new Error('scripts/read-test-projects.ts returned malformed project selectors: ' + reason);
}

function selectorPatterns(value: unknown): PlaywrightPattern[] {
  if (!Array.isArray(value)) selectorError('patterns must be an array');
  return value.map((item) => {
    const kind = fieldOf(item, 'kind');
    const pattern = fieldOf(item, 'value');
    const flags = fieldOf(item, 'flags');
    if (typeof pattern !== 'string' || typeof flags !== 'string') {
      selectorError('each pattern needs a string value and flags');
    }
    if (kind === 'glob' && flags === '') return pattern;
    if (kind === 'regex') return new RegExp(pattern, flags);
    return selectorError('pattern kind must be glob (without flags) or regex');
  });
}

/** The child result is untrusted JSON; validate the protocol before it can satisfy an exit. */
function readProjectSelectors(value: unknown): ConfiguredProject[] {
  if (fieldOf(value, 'version') !== 1) selectorError('unsupported protocol version');
  const projects = fieldOf(value, 'projects');
  if (!Array.isArray(projects) || projects.length === 0) selectorError('no project array');
  return projects.map((project) => {
    const runner = fieldOf(project, 'runner');
    const name = fieldOf(project, 'name');
    const directory = fieldOf(project, 'directory');
    if (
      (runner !== 'vitest' && runner !== 'playwright') ||
      typeof name !== 'string' ||
      name === '' ||
      typeof directory !== 'string' ||
      !isAbsolute(directory)
    ) {
      selectorError('each project needs a runner, name, and absolute directory');
    }
    const include = selectorPatterns(fieldOf(project, 'include'));
    const exclude = selectorPatterns(fieldOf(project, 'exclude'));
    if (runner === 'vitest' && [...include, ...exclude].some((item) => typeof item !== 'string')) {
      selectorError('Vitest file patterns must be globs');
    }
    return {
      name,
      selects: (path) => {
        const candidate = pathWithin(directory, path);
        if (candidate === null) return false;
        if (runner === 'vitest') {
          return (
            include.some(
              (pattern) => typeof pattern === 'string' && matchesGlob(candidate, pattern),
            ) &&
            !exclude.some(
              (pattern) => typeof pattern === 'string' && matchesGlob(candidate, pattern),
            )
          );
        }
        const absolutePath = resolve(REPO_ROOT, path);
        return (
          playwrightMatches(include, absolutePath) && !playwrightMatches(exclude, absolutePath)
        );
      },
    };
  });
}

function configuredProjects(fixture?: {
  readonly runner: 'vitest' | 'playwright';
  readonly config: unknown;
}): ConfiguredProject[] {
  const result = spawnSync(
    process.execPath,
    [
      join(REPO_ROOT, 'scripts', 'read-test-projects.ts'),
      ...(fixture === undefined ? [] : [JSON.stringify(fixture)]),
    ],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    },
  );
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      'Runner selector tool failed (' +
        String(result.status) +
        '):\n' +
        result.stdout +
        '\n' +
        result.stderr,
    );
  }
  // Runner configs may print diagnostics, such as Vitest's seed. A single explicit record keeps
  // that output visible on a failure without treating arbitrary output as a successful report.
  const prefix = 'IRIDIUM_TEST_PROJECTS ';
  const records = result.stdout.split(/\r?\n/).filter((line) => line.startsWith(prefix));
  const record = records[0];
  if (records.length !== 1 || record === undefined) {
    throw new Error(
      'Runner selector tool must emit exactly one JSON record:\n' +
        result.stdout +
        '\n' +
        result.stderr,
    );
  }
  return readProjectSelectors(JSON.parse(record.slice(prefix.length)));
}

const CONFIGURED_PROJECTS: readonly ConfiguredProject[] = configuredProjects();

/** Exit tables also name standalone guards that belong to no acceptance row. */
function missingExitTests(
  map: AcceptanceMap,
  current: string,
  declared: ReadonlyMap<string, readonly SpecFile[]>,
  projects: readonly ConfiguredProject[] = CONFIGURED_PROJECTS,
): string[] {
  return [...map.exitCriteria].flatMap(([milestone, tests]) =>
    isDue(map, current, milestone)
      ? tests.flatMap((name) => {
          const declarations = declared.get(name) ?? [];
          if (declarations.length === 0) {
            return [
              `${milestone} exit requires ${name}, but no spec declares it. ` +
                'Implement the named exit test before advancing docs/milestones/CURRENT.',
            ];
          }
          const owner = map.tests.get(name)?.project ?? null;
          if (
            declarations.some((file) =>
              projects.some(
                (project) =>
                  (owner === null || project.name === owner) && project.selects(file.path),
              ),
            )
          ) {
            return [];
          }
          return [
            `${milestone} exit requires ${name}, but its declarations in ` +
              declarations.map((file) => file.path).join(', ') +
              ` are not selected by ${owner === null ? 'any configured project' : `the ${owner} project`}. ` +
              'Correct the spec location or its owning runner include/exclude configuration; ' +
              'a declaration that no due runner executes cannot satisfy an exit test.',
          ];
        })
      : [],
  );
}

/** An unassigned deadline is never an implicit deferral. Only an explained post-1.0 epic is exempt. */
function schedulingFailures(map: AcceptanceMap): string[] {
  const failures: string[] = [];
  for (const [name, record] of map.tests) {
    if (record.sinceMilestone !== null) {
      if (!map.milestones.includes(record.sinceMilestone))
        failures.push(`${name} has unknown milestone ${record.sinceMilestone}.`);
      continue;
    }
    const exclusion = map.postOnePointZero.get(name);
    if (exclusion === undefined || exclusion.epic.trim() === '' || exclusion.reason.trim() === '') {
      failures.push(`${name} has no milestone and no explained post-1.0 exclusion.`);
    }
  }
  for (const name of map.postOnePointZero.keys()) {
    const record = map.tests.get(name);
    if (record === undefined || record.sinceMilestone !== null) {
      failures.push(`${name} has a post-1.0 exclusion without an unscheduled inventory record.`);
    }
  }
  return failures;
}

/** Every inventory promise is enforced, including names outside acceptance rows and exit tables. */
function inventoryFailures(
  map: AcceptanceMap,
  current: string,
  declared: ReadonlyMap<string, readonly SpecFile[]>,
  projects: readonly ConfiguredProject[] = CONFIGURED_PROJECTS,
): string[] {
  const problems: string[] = [];
  for (const [name, record] of map.tests) {
    // Unexplained null schedules fail schedulingFailures; explained post-1.0 epics have no MVP deadline.
    if (record.sinceMilestone === null || !isDue(map, current, record.sinceMilestone)) continue;
    const declarations = declared.get(name) ?? [];
    if (declarations.length === 0) {
      problems.push(`${name} is due at ${record.sinceMilestone}, but no spec declares it.`);
      continue;
    }
    const selected = declarations.filter((file) =>
      projects.some(
        (project) =>
          (record.project === null || project.name === record.project) &&
          project.selects(file.path),
      ),
    );
    if (selected.length === 0) {
      problems.push(`${name} is not selected by ${record.project ?? 'any configured project'}.`);
      continue;
    }
    if (record.tag !== null && !selected.some((file) => carriesTag(file, record.tag ?? ''))) {
      problems.push(`${name} is due but no selected declaration carries ${record.tag}.`);
    }
  }
  return problems;
}

function carriesTag(file: SpecFile, tag: string): boolean {
  if (file.title?.includes(tag) === true) return true;
  const match = /^\[(spec|hp|area):([^\]]+)\]$/.exec(tag);
  if (match === null) return false;
  const value = match[1] === 'hp' ? match[2]?.replace(/^HP-/, '') : match[2];
  return file.playwrightTags.includes(`@${match[1]}-${value}`);
}

function missingDueTests(
  map: AcceptanceMap,
  current: string,
  declared: ReadonlyMap<string, readonly SpecFile[]>,
): string[] {
  const problems: string[] = [];
  for (const entry of map.entries) {
    if (!isDue(map, current, entry.sinceMilestone)) continue;

    if (entry.tests.length === 0) {
      problems.push(
        `${describeEntry(entry)} names no test at all, and ${CURRENT_REFERENCE} says ${current}. ` +
          `A due layer with an empty test list is the state rule 1 exists to refuse: name a test in ` +
          `the row of ${INVENTORY_REFERENCE} that owns this layer, or move the layer's milestone ` +
          `past ${current}, then ${REGENERATE}.`,
      );
      continue;
    }

    const due = entry.tests.filter((test) => isDue(map, current, testMilestone(map, entry, test)));
    for (const test of due) {
      if (declared.has(test)) continue;
      problems.push(
        `${describeEntry(entry)} names \`${test}\` (due at ` +
          `${testMilestone(map, entry, test)}), which no spec file declares. Write ` +
          `${whereItBelongs(map, test)}, with a top-level \`describe\` title starting \`${test}\` ` +
          `and carrying ${requiredTag(map, entry)}. If the test is not due yet, the row of ` +
          `${INVENTORY_REFERENCE} that schedules it is what says so: move that test's milestone ` +
          `past ${current} and ${REGENERATE}.`,
      );
    }

    // Rule 1/3's floor, which per-test milestones cannot express: a due layer that is proven by
    // nothing at all, because every test it names is scheduled for a later milestone.
    if (due.length === 0 && !entry.tests.some((test) => declared.has(test))) {
      problems.push(
        `${describeEntry(entry)} is due and none of its tests exists — ${entry.tests
          .map((test) => `\`${test}\` (${testMilestone(map, entry, test)})`)
          .join(', ')}. A layer is due when its earliest test is, so either a test of this layer ` +
          `lands now or the layer's milestone in ${INVENTORY_REFERENCE} is wrong; ${REGENERATE} ` +
          `after the correction.`,
      );
    }
  }
  return problems;
}

/** Rule 6's second half: the file proving a rule carries the tag the rules table states. */
function ruleTagMismatches(
  map: AcceptanceMap,
  current: string,
  declared: ReadonlyMap<string, readonly SpecFile[]>,
): string[] {
  const problems: string[] = [];
  for (const entry of map.entries) {
    if (entry.namespace !== 'ruleId' || !isDue(map, current, entry.sinceMilestone)) continue;
    const tag = requiredTag(map, entry);
    for (const test of entry.tests) {
      for (const file of declared.get(test) ?? []) {
        if (file.title?.includes(tag) === true) continue;
        problems.push(
          `${entry.id} names \`${test}\`, whose top-level describe title in ${file.path} is ` +
            `${JSON.stringify(file.title ?? '')} and does not carry ${tag}. ${RULES_TABLE_REFERENCE} ` +
            `states that tag for this rule: add it to the title, or correct the table and ` +
            `${REGENERATE}.`,
        );
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// Rule 2 — no test claims an id the map does not list
// ---------------------------------------------------------------------------------------------

function unknownClaims(map: AcceptanceMap, files: readonly SpecFile[]): string[] {
  const problems: string[] = [];
  for (const file of files) {
    const claimedRows = [
      ...file.specTags,
      ...file.playwrightTags.flatMap((tag) => (tag.startsWith('@spec-') ? [tag.slice(6)] : [])),
    ];
    for (const rowId of claimedRows) {
      if (map.rowIds.has(rowId)) continue;
      problems.push(
        `${file.path} claims the spec row \`${rowId}\`, which ${MAP_REFERENCE} does not list. The ` +
          `nine row ids are ${[...map.rowIds].join(', ')}: correct the tag, or add the row to ` +
          `${INVENTORY_REFERENCE} and ${REGENERATE}.`,
      );
    }
    const claimedProperties = [
      ...file.hpTags,
      ...file.playwrightTags.flatMap((tag) =>
        /^@hp-\d+$/.test(tag) ? [`HP-${tag.slice(4)}`] : [],
      ),
    ];
    for (const hpId of claimedProperties) {
      if (map.hpIds.has(hpId)) continue;
      problems.push(
        `${file.path} claims the hard property \`${hpId}\`, which ${MAP_REFERENCE} does not list. ` +
          `The properties are ${[...map.hpIds].join(', ')}: correct the tag, or add the property ` +
          `to ${INVENTORY_REFERENCE} and ${REGENERATE}.`,
      );
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// Rule 4 — every server and E2E spec file is tagged
// ---------------------------------------------------------------------------------------------

function untaggedSpecFiles(files: readonly SpecFile[]): string[] {
  return files.flatMap((file) => {
    const policed =
      TAGGED_TREES.some((tree) => file.path.startsWith(tree)) &&
      !file.path.startsWith(GUARD_PROJECT_TREE) &&
      LAYER_BASENAME.test(file.path);
    if (!policed) return [];
    const tagged =
      file.specTags.length + file.hpTags.length + file.areaTags.length > 0 ||
      file.playwrightTags.some((tag) => /^@(?:spec|hp|area)-/.test(tag));
    if (tagged) return [];
    return [
      `${file.path} carries no requirement tag. Every file under ${TAGGED_TREES.join(' or ')} ` +
        `carries \`[spec:<row-id>]\`, \`[hp:HP-n]\` or \`[area:<name>]\` in its top-level describe ` +
        `title (Playwright: \`{ tag: ['@spec-…','@hp-n','@area-…'] }\`). A file that defends no row ` +
        `and no hard property takes an \`[area:…]\` tag rather than claiming one it does not prove.`,
    ];
  });
}

// ---------------------------------------------------------------------------------------------
// Rule 7 — a gating layer's tests are selected by a merge-blocking lane
// ---------------------------------------------------------------------------------------------

function ungatedTests(
  map: AcceptanceMap,
  current: string,
  declared: ReadonlyMap<string, readonly SpecFile[]>,
): string[] {
  const problems: string[] = [];
  for (const entry of map.entries) {
    if (!entry.gating || !isDue(map, current, entry.sinceMilestone)) continue;
    for (const test of entry.tests) {
      for (const file of declared.get(test) ?? []) {
        if (file.playwrightTags.includes(SMOKE_TAG)) continue;
        problems.push(
          `${describeEntry(entry)} is the gating layer for ${entry.id}, and \`${test}\` in ` +
            `${file.path} carries no \`${SMOKE_TAG}\` tag, so the \`e2e-electron\` lane does not ` +
            `select it. A gate that only runs nightly is not a gate (01-vision-scope-and-principles.md ` +
            `§4.6): add \`${SMOKE_TAG}\` to the spec's \`{ tag: [...] }\` array.`,
        );
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// Rule 5 — every host-contract case has a recorded pass in every harness that is due
// ---------------------------------------------------------------------------------------------

/** Reads one harness report; `null` when the file is absent, unreadable or not a case list. */
type ReportReader = (harness: string) => readonly string[] | null;

function readHostContractReport(directory: string): ReportReader {
  return (harness) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(directory, `${harness}.json`), 'utf8'));
    } catch {
      return null;
    }
    // Both shapes a harness may write: the bare array of case names, or `{ cases: [...] }`.
    const cases = Array.isArray(parsed) ? parsed : fieldOf(parsed, 'cases');
    if (!Array.isArray(cases)) return null;
    return cases.filter((entry): entry is string => typeof entry === 'string');
  };
}

function hostContractGaps(
  map: AcceptanceMap,
  current: string,
  directory: string | undefined,
  read: ReportReader,
): string[] {
  const due = map.hostContractHarnesses.filter((harness) =>
    isDue(map, current, map.tests.get(harness)?.sinceMilestone ?? null),
  );
  // Nothing to check before M4 arms the first harness; and with the variable unset the rule is
  // skipped by design — `merge-reports` is the job that asserts it was set, so "skipped" can never
  // be the silent default in the lane that owns the evidence.
  if (due.length === 0 || directory === undefined) return [];

  const reports = new Map(due.map((harness) => [harness, read(harness)]));
  const problems = due.flatMap((harness) =>
    reports.get(harness) === null
      ? [
          `${harness} is due at ${map.tests.get(harness)?.sinceMilestone ?? current} and wrote no ` +
            `readable ${harness}.json under ${directory}. Each harness writes the case names it ` +
            `passed and \`merge-reports\` aggregates them; a missing report is an unproven host, ` +
            `not an absent one.`,
        ]
      : [],
  );
  const everyCase = [...new Set(due.flatMap((harness) => reports.get(harness) ?? []))].toSorted();
  for (const caseName of everyCase) {
    for (const harness of due) {
      const recorded = reports.get(harness);
      if (recorded === null || recorded === undefined || recorded.includes(caseName)) continue;
      problems.push(
        `the host-contract case ${JSON.stringify(caseName)} has a recorded pass in another due ` +
          `harness but none in ${harness}. A case in \`hostContractCases()\` is a promise every ` +
          `host keeps: implement it in that host, or remove the case from the array.`,
      );
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------------------------

const MAP = readAcceptanceMap(readFileSync(MAP_FILE, 'utf8'));

it('keeps explicit test milestones when an acceptance row starts earlier', () => {
  expect(MAP.tests.get('search.acl.integration')?.sinceMilestone).toBe('M2');
  expect(MAP.tests.get('transfer.isolation.integration')?.sinceMilestone).toBe('M6');
});
// An exit rehearsal may enforce a future milestone without falsely recording it as exited.
const CURRENT = readCurrentMilestone(
  process.env['IRIDIUM_TEST_TARGET_MILESTONE'] ?? readFileSync(CURRENT_MILESTONE_FILE, 'utf8'),
);
const SPEC_FILES = readSpecFiles();
const DECLARED = declaredTests(SPEC_FILES);
const DUE_ENTRIES = MAP.entries.filter((entry) => isDue(MAP, CURRENT, entry.sinceMilestone));

/**
 * Every remedy is carried by the **asserted value** rather than by `expect`'s message argument:
 * `vitest/valid-expect` accepts only a literal or a template there, and these remedies are longer
 * than one line. Each check produces `''` when it holds and the whole remedy when it does not, so
 * the diff Vitest prints is the repair instruction.
 */
function problemList(problems: readonly string[]): string {
  return problems.filter((problem) => problem !== '').join('\n\n');
}

/** A synthetic map, so each rule can be shown to fail on the case it exists for. */
function syntheticMap(overrides: Partial<AcceptanceMap> = {}): AcceptanceMap {
  return {
    milestones: ['M0', 'M1', 'M2'],
    exitCriteria: new Map(),
    entries: [],
    rowIds: new Set(['concurrent-editing']),
    hpIds: new Set(['HP-1']),
    ruleTags: new Map([['vault-settings', '[area:vaults]']]),
    hostContractHarnesses: [],
    tests: new Map(),
    postOnePointZero: new Map(),
    ...overrides,
  };
}

function syntheticEntry(overrides: Partial<MapEntry> = {}): MapEntry {
  return {
    id: 'concurrent-editing',
    namespace: 'rowId',
    layer: 'L3',
    sinceMilestone: 'M0',
    gating: false,
    tests: ['synthetic.absent.integration'],
    ...overrides,
  };
}

function syntheticFile(overrides: Partial<SpecFile> = {}): SpecFile {
  return {
    path: 'apps/server/test/integration/synthetic.present.integration.spec.ts',
    title: 'synthetic.present.integration [area:ops]',
    name: 'synthetic.present.integration',
    specTags: [],
    hpTags: [],
    areaTags: ['ops'],
    playwrightTags: [],
    ...overrides,
  };
}

describe('guards.acceptance-map.guard [area:docs]', () => {
  describe('every scheduled inventory name is an executable, accurately tagged test', () => {
    it('requires an explicit milestone or an explained post-1.0 epic for every inventory name', () => {
      expect(problemList(schedulingFailures(MAP))).toBe('');
    });

    it('refuses unexplained, invalid and orphaned schedules while preserving documented future work', () => {
      const name = 'synthetic.future.integration';
      const record = { sinceMilestone: null, project: 'integration', file: null, tag: null };
      const unscheduled = syntheticMap({ tests: new Map([[name, record]]) });
      expect(schedulingFailures(unscheduled)).toEqual([
        `${name} has no milestone and no explained post-1.0 exclusion.`,
      ]);
      const excluded = syntheticMap({
        ...unscheduled,
        postOnePointZero: new Map([
          [name, { epic: '14', reason: 'Requires a post-1.0 signing identity.' }],
        ]),
      });
      expect(schedulingFailures(excluded)).toEqual([]);
      expect(
        schedulingFailures(
          syntheticMap({
            ...excluded,
            postOnePointZero: new Map([[name, { epic: '14', reason: ' ' }]]),
          }),
        ),
      ).toHaveLength(1);
      expect(
        schedulingFailures(
          syntheticMap({
            ...excluded,
            postOnePointZero: new Map([
              [name, { epic: ' ', reason: 'A reason without an owner.' }],
            ]),
          }),
        ),
      ).toHaveLength(1);
      expect(schedulingFailures(syntheticMap({ ...excluded, tests: new Map() }))).toEqual([
        `${name} has a post-1.0 exclusion without an unscheduled inventory record.`,
      ]);
      const future = syntheticMap({
        tests: new Map([[name, { ...record, sinceMilestone: 'M2' }]]),
      });
      expect(schedulingFailures(future)).toEqual([]);
      expect(inventoryFailures(future, 'M1', new Map())).toEqual([]);
      expect(inventoryFailures(future, 'M2', new Map())).toHaveLength(1);
      expect(
        schedulingFailures(
          syntheticMap({ tests: new Map([[name, { ...record, sinceMilestone: 'M9' }]]) }),
        ),
      ).toEqual([`${name} has unknown milestone M9.`]);
      expect(schedulingFailures(syntheticMap({ ...excluded, tests: future.tests }))).toHaveLength(
        1,
      );
    });

    it('reads legitimate inventory milestone styles and rejects unsupported deadlines in the generator', () => {
      const result = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `
        import { inventoryMilestone } from './scripts/lib/test-names.ts';
        const inputs = JSON.parse(process.argv[1]);
        console.log(JSON.stringify(inputs.map((input) => {
          try { return inventoryMilestone(input) ?? null; }
          catch (error) { return error.message; }
        })));
      `,
          JSON.stringify([
            '**M1** — first delivery',
            'Since M1',
            'since M2',
            '**M0 exit** — bootstrap',
            'M3 — parsed guard assertion',
            'Extends a mechanism described in M1.',
            '**M9** — invalid',
            'Since M10',
          ]),
        ],
        {
          cwd: REPO_ROOT,
          encoding: 'utf8',
          windowsHide: true,
          shell: false,
          timeout: 30_000,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual([
        'M1',
        'M1',
        'M2',
        'M0',
        'M3',
        null,
        'Unsupported inventory milestone: M9',
        'Unsupported inventory milestone: M10',
      ]);
    });

    it('enforces the entire tests inventory, including names outside entries and exit criteria', () => {
      expect(problemList(inventoryFailures(MAP, CURRENT, DECLARED))).toBe('');
    });

    it('refuses missing due names while preserving explicitly scheduled future work', () => {
      const map = syntheticMap({
        tests: new Map([
          [
            'synthetic.present.integration',
            { sinceMilestone: 'M1', project: 'integration', file: null, tag: '[hp:HP-1]' },
          ],
          [
            'synthetic.future.integration',
            { sinceMilestone: 'M2', project: 'integration', file: null, tag: null },
          ],
        ]),
      });
      expect(inventoryFailures(map, 'M0', new Map())).toEqual([]);
      expect(inventoryFailures(map, 'M1', new Map())).toEqual([
        expect.stringContaining('synthetic.present.integration is due at M1'),
      ]);
      const wrongTag = declaredTests([
        syntheticFile({ title: 'synthetic.present.integration [hp:HP-2]' }),
      ]);
      expect(inventoryFailures(map, 'M1', wrongTag)).toEqual([
        expect.stringContaining('no selected declaration carries [hp:HP-1]'),
      ]);
      const valid = declaredTests([
        syntheticFile({ title: 'synthetic.present.integration [hp:HP-1]' }),
      ]);
      expect(inventoryFailures(map, 'M1', valid)).toEqual([]);
      expect(inventoryFailures(map, 'M2', valid)).toEqual([
        expect.stringContaining('synthetic.future.integration is due at M2'),
      ]);
    });

    it('refuses an unselected declaration without inventing a deadline for an unresolved name', () => {
      const name = 'synthetic.present.integration';
      const record = { sinceMilestone: 'M1', project: 'integration', file: null, tag: null };
      const map = syntheticMap({ tests: new Map([[name, record]]) });
      const unsupported = declaredTests([
        syntheticFile({ path: 'apps/server/test/support/synthetic.present.integration.spec.ts' }),
      ]);
      expect(inventoryFailures(map, 'M1', unsupported)).toEqual([
        expect.stringContaining('not selected by integration'),
      ]);
      expect(
        inventoryFailures(
          syntheticMap({ tests: new Map([[name, { ...record, sinceMilestone: null }]]) }),
          'M1',
          unsupported,
        ),
      ).toEqual([]);
    });
  });

  describe('every named milestone exit test exists when due', () => {
    it('covers standalone exit tests as well as acceptance-map rows', () => {
      expect(MAP.exitCriteria.get('M1')).toContain('collab.lf-invariant.guard');
      expect(problemList(missingExitTests(MAP, CURRENT, DECLARED))).toBe('');
    });

    it('refuses a missing standalone guard at its exit and defers future tests', () => {
      const map = syntheticMap({
        exitCriteria: new Map([
          ['M1', ['synthetic.absent.guard']],
          ['M2', ['synthetic.future.integration']],
        ]),
      });
      expect(missingExitTests(map, 'M0', new Map())).toEqual([]);
      expect(missingExitTests(map, 'M1', new Map())).toHaveLength(1);
      expect(missingExitTests(map, 'M1', new Map())[0]).toContain('synthetic.absent.guard');
      const declared = declaredTests([syntheticFile({ name: 'synthetic.absent.guard' })]);
      expect(missingExitTests(map, 'M1', declared)).toEqual([]);
      expect(missingExitTests(map, 'M2', declared)[0]).toContain('synthetic.future.integration');
    });

    it('rejects an unselected support-path declaration without pulling it into an earlier exit', () => {
      const name = 'synthetic.present.guard';
      const map = syntheticMap({
        exitCriteria: new Map([['M1', [name]]]),
        tests: new Map([[name, { sinceMilestone: 'M1', project: 'guard', file: null, tag: null }]]),
      });
      const unselected = declaredTests([
        syntheticFile({ name, path: 'apps/server/test/support/lf.proof.guard.spec.ts' }),
      ]);
      expect(missingExitTests(map, 'M0', unselected)).toEqual([]);
      expect(missingExitTests(map, 'M1', unselected)).toHaveLength(1);
      expect(missingExitTests(map, 'M1', unselected)[0]).toContain(
        'not selected by the guard project',
      );
      const selected = declaredTests([
        syntheticFile({ name, path: 'apps/server/test/guards/lf.proof.guard.spec.ts' }),
      ]);
      expect(missingExitTests(map, 'M1', selected)).toEqual([]);
    });

    it('requires the documented owner even when a different project selects the declaration', () => {
      const name = 'synthetic.present.guard';
      const map = syntheticMap({
        exitCriteria: new Map([['M1', [name]]]),
        tests: new Map([[name, { sinceMilestone: 'M1', project: 'guard', file: null, tag: null }]]),
      });
      const wrongProject = declaredTests([syntheticFile({ name })]);
      expect(missingExitTests(map, 'M1', wrongProject)[0]).toContain(
        'not selected by the guard project',
      );
    });

    it.each([
      ['unit', 'packages/crdt/src/dominates.prop.spec.ts', true],
      ['property', 'packages/crdt/src/dominates.prop.spec.ts', false],
      ['property', 'apps/server/test/property/convergence.model.prop.spec.ts', true],
      ['electron', 'apps/e2e/electron/desktop.launch.e2e.spec.ts', true],
      ['electron', 'apps/e2e/support/desktop.launch.e2e.spec.ts', false],
    ])('uses the actual %s project selector for %s', (name, path, selected) => {
      const project = CONFIGURED_PROJECTS.find((candidate) => candidate.name === name);
      expect(project).toBeDefined();
      expect(project?.selects(path)).toBe(selected);
    });

    it('rejects malformed tool output before it can satisfy an exit test', () => {
      const project = {
        runner: 'vitest',
        name: 'guard',
        directory: REPO_ROOT,
        include: [{ kind: 'glob', value: '**/*.spec.ts', flags: '' }],
        exclude: [],
      };
      for (const output of [
        { version: 2, projects: [project] },
        { version: 1, projects: [] },
        { version: 1, projects: [{ ...project, runner: 'unknown' }] },
        { version: 1, projects: [{ ...project, directory: '.' }] },
        {
          version: 1,
          projects: [{ ...project, include: [{ kind: 'glob', value: '**', flags: 'i' }] }],
        },
        {
          version: 1,
          projects: [{ ...project, include: [{ kind: 'regex', value: '.*', flags: '' }] }],
        },
      ]) {
        expect(() => readProjectSelectors(output)).toThrow('malformed project selectors');
      }
    });

    it('surfaces a failed config reader instead of accepting an empty selector report', () => {
      expect(() =>
        configuredProjects({ runner: 'vitest', config: { test: { projects: [] } } }),
      ).toThrow('vitest.config.ts must declare the inline projects');
    });

    it('merges Vitest inherited and project exclusions while retaining package property selection', () => {
      const projects = configuredProjects({
        runner: 'vitest',
        config: {
          root: REPO_ROOT,
          test: {
            include: ['packages/*/src/**/*.prop.spec.ts'],
            exclude: ['**/support/**'],
            projects: [
              {
                test: {
                  name: 'fixture',
                  include: ['apps/server/test/**/*.guard.spec.ts'],
                  exclude: ['**/ignored/**'],
                },
              },
            ],
          },
        },
      });
      const project = projects[0];
      expect(project?.selects('packages/crdt/src/dominates.prop.spec.ts')).toBe(true);
      expect(project?.selects('apps/server/test/guards/valid.guard.spec.ts')).toBe(true);
      expect(project?.selects('apps/server/test/support/invalid.guard.spec.ts')).toBe(false);
      expect(project?.selects('apps/server/test/ignored/invalid.guard.spec.ts')).toBe(false);
    });

    it('keeps Playwright globs and inherited ignores inside the configured test directory', () => {
      const projects = configuredProjects({
        runner: 'playwright',
        config: {
          testDir: 'apps/e2e',
          testMatch: '*.e2e.spec.ts',
          testIgnore: '**/ignored/**',
          projects: [{ name: 'fixture' }],
        },
      });
      const project = projects[0];
      expect(project?.selects('apps/e2e/electron/valid.e2e.spec.ts')).toBe(true);
      expect(project?.selects('apps/e2e/ignored/invalid.e2e.spec.ts')).toBe(false);
      expect(project?.selects('apps/server/test/valid.e2e.spec.ts')).toBe(false);
    });
  });

  describe('the top-level suite reader', () => {
    const path = 'apps/server/test/chaos/synthetic.chaos.spec.ts';

    it('reads a multiline plain title and its requirement tags', () => {
      const suite = readSpecSource(
        path,
        "describe(\n  'synthetic.chaos [spec:concurrent-editing] [hp:HP-5] [area:collab]',\n  () => {},\n);",
      );
      expect(suite.name).toBe('synthetic.chaos');
      expect(suite.specTags).toEqual(['concurrent-editing']);
      expect(suite.hpTags).toEqual(['HP-5']);
      expect(suite.areaTags).toEqual(['collab']);
    });

    it('balances parameter tables with nested calls, callbacks and misleading string punctuation', () => {
      const suite = readSpecSource(
        path,
        [
          '/* describe("comment.fake [hp:HP-9]", () => {}); */',
          'describe.each(',
          '  Array.from({ length: 3 }, (_, index) => ({ index, label: ")((" })),',
          ')( /* table complete */',
          '  "synthetic.chaos [hp:HP-5] iteration %i",',
          '  () => {',
          '    describe("nested.fake [hp:HP-9]", () => {});',
          '  },',
          ');',
        ].join('\n'),
      );
      expect(suite.name).toBe('synthetic.chaos');
      expect(suite.hpTags).toEqual(['HP-5']);
      expect(untaggedSpecFiles([suite])).toEqual([]);
    });

    it('reads Playwright annotations after the title and not from fixtures or the callback', () => {
      const suite = readSpecSource(
        path,
        [
          "const fixture = { tag: ['@hp-9'] };",
          'test.describe(',
          "  'synthetic.chaos',",
          "  { tag: ['@smoke', '@area-collab'] },",
          "  () => { const nested = { tag: ['@hp-8'] }; },",
          ');',
        ].join('\n'),
      );
      expect(suite.playwrightTags).toEqual(['@smoke', '@area-collab']);
    });

    it('does not invent a declaration from comments, nested suites, or nonliteral titles', () => {
      for (const fixture of [
        '/*\ndescribe("comment.fake [hp:HP-9]", () => {});\n*/',
        'function helper() {\n  describe("nested.fake [hp:HP-9]", () => {});\n}',
        'describe.each(makeTable(() => [1, 2])(',
        'describe.each([1, 2]);',
        'describe("synthetic." + kind, () => {});',
        'describe(`synthetic.${kind} [hp:HP-5]`, () => {});',
      ]) {
        const suite = readSpecSource(path, fixture);
        expect(suite.name).toBeNull();
        expect(suite.hpTags).toEqual([]);
        expect(untaggedSpecFiles([suite])).toHaveLength(1);
      }
    });
  });
  describe('the map and the milestone axis', () => {
    it(`reads ${MAP_REFERENCE} against the milestone ${CURRENT_REFERENCE} names`, () => {
      expect(MAP.entries.length).toBeGreaterThan(0);
      expect(MAP.milestones).toContain(CURRENT);
      // A guard that checks nothing passes; these are the two ways this one could become vacuous.
      expect(DUE_ENTRIES.length).toBeGreaterThan(0);
      expect(SPEC_FILES.length).toBeGreaterThan(0);
    });

    it('resolves every entry to an id namespace, a layer and a milestone the map knows', () => {
      const unknown = MAP.entries
        .filter((entry) => !MAP.milestones.includes(entry.sinceMilestone))
        .map((entry) => `${entry.id} ${entry.layer} @${entry.sinceMilestone}`);
      const unlisted = MAP.entries.filter((entry) => {
        if (entry.namespace === 'rowId') return !MAP.rowIds.has(entry.id);
        if (entry.namespace === 'hpId') return !MAP.hpIds.has(entry.id);
        return !MAP.ruleTags.has(entry.id);
      });
      expect(
        problemList([
          unknown.length === 0
            ? ''
            : `${MAP_REFERENCE}: ${unknown.join(', ')} name a milestone outside \`milestones\`, so ` +
              `the guard cannot tell whether the layer is due. Correct the inventory row and ` +
              `${REGENERATE}.`,
          unlisted.length === 0
            ? ''
            : `${MAP_REFERENCE}: ${unlisted
                .map((entry) => `${entry.namespace} ${entry.id}`)
                .join(
                  ', ',
                )} appear in \`entries\` but in none of \`rows\`, \`hardProperties\` or ` +
              `\`rules\`, so rule 2 would reject a test that claimed them. ${REGENERATE}.`,
        ]),
      ).toBe('');
    });

    it(`declares every gating layer at ${GATING_LAYER}, the one layer rule 7 has a selector for`, () => {
      const elsewhere = MAP.entries
        .filter((entry) => entry.gating && entry.layer !== GATING_LAYER)
        .map((entry) => `${entry.id} ${entry.layer}`);
      expect(
        elsewhere.length === 0
          ? ''
          : `${MAP_REFERENCE} marks ${elsewhere.join(', ')} as gating, but rule 7 knows only ` +
              `${GATING_LAYER}'s merge-blocking selector (\`${SMOKE_TAG}\`, which \`e2e-electron\` ` +
              `runs). Specify the lane selector for that layer in ` +
              `docs/plan/10-testing-and-quality.md before marking it gating, then teach this guard ` +
              `the same selector.`,
      ).toBe('');
    });

    it('finds exactly one spec file per test name the map resolves', () => {
      const duplicated = [...DECLARED.entries()]
        .filter(([name, files]) => files.length > 1 && MAP.tests.has(name))
        .map(([name, files]) => `\`${name}\`: ${files.map((file) => file.path).join(', ')}`);
      expect(
        duplicated.length === 0
          ? ''
          : `two spec files declare the same test name, so a name in ${MAP_REFERENCE} no longer ` +
              `resolves to one file:\n${duplicated.join('\n')}\nA test's name is its own; rename ` +
              `one of them, following the \`<area>.<subject>.<layer>\` convention.`,
      ).toBe('');
    });
  });

  describe('rules 1, 3 and 6 — a due layer has the tests it names', () => {
    it('finds every test named by a due row, hard property or rule', () => {
      expect(problemList(missingDueTests(MAP, CURRENT, DECLARED))).toBe('');
    });

    it(`finds the tag ${RULES_TABLE_REFERENCE} states on every due rule's tests`, () => {
      expect(problemList(ruleTagMismatches(MAP, CURRENT, DECLARED))).toBe('');
    });

    it('reports a due entry whose named test no file declares, and the two ways out', () => {
      const map = syntheticMap({ entries: [syntheticEntry()] });
      const [problem] = missingDueTests(map, 'M0', declaredTests([syntheticFile()]));
      expect(problem).toContain('concurrent-editing L3 (due since M0)');
      expect(problem).toContain('`synthetic.absent.integration`');
      expect(problem).toContain('[spec:concurrent-editing]');
      expect(problem).toContain("move that test's milestone");
    });

    it('demands nothing of a test whose own inventory milestone has not arrived', () => {
      const map = syntheticMap({
        entries: [
          syntheticEntry({ tests: ['synthetic.present.integration', 'synthetic.later.prop'] }),
        ],
        tests: new Map([
          [
            'synthetic.present.integration',
            { sinceMilestone: 'M0', project: null, file: null, tag: null },
          ],
          ['synthetic.later.prop', { sinceMilestone: 'M2', project: null, file: null, tag: null }],
        ]),
      });
      expect(missingDueTests(map, 'M0', declaredTests([syntheticFile()]))).toEqual([]);
      // …and demands it once that milestone is the one CURRENT names.
      expect(missingDueTests(map, 'M2', declaredTests([syntheticFile()]))).toHaveLength(1);
    });

    it('refuses a due layer that is proven by nothing, and one that names no test at all', () => {
      const nothingExists = syntheticMap({
        entries: [syntheticEntry({ tests: ['synthetic.later.prop'] })],
        tests: new Map([
          ['synthetic.later.prop', { sinceMilestone: 'M2', project: null, file: null, tag: null }],
        ]),
      });
      expect(missingDueTests(nothingExists, 'M0', declaredTests([]))[0]).toContain(
        'is due and none of its tests exists',
      );
      const namesNothing = syntheticMap({ entries: [syntheticEntry({ tests: [] })] });
      expect(missingDueTests(namesNothing, 'M0', declaredTests([]))[0]).toContain(
        'names no test at all',
      );
    });

    it("reports a rule whose test drops the rules table's tag", () => {
      const map = syntheticMap({
        entries: [
          syntheticEntry({
            id: 'vault-settings',
            namespace: 'ruleId',
            tests: ['synthetic.present.integration'],
          }),
        ],
      });
      const [problem] = ruleTagMismatches(map, 'M0', declaredTests([syntheticFile()]));
      expect(problem).toContain('[area:vaults]');
      expect(problem).toContain(
        'apps/server/test/integration/synthetic.present.integration.spec.ts',
      );
    });
  });

  describe('rule 2 — no test claims an id the map does not list', () => {
    it('resolves every `[spec:…]` and `[hp:…]` tag in the workspace', () => {
      expect(problemList(unknownClaims(MAP, SPEC_FILES))).toBe('');
    });

    it('reports a claimed row id and a claimed hard property the map does not carry', () => {
      const problems = unknownClaims(syntheticMap(), [
        syntheticFile({ specTags: ['not-a-row'], hpTags: ['HP-9'] }),
        syntheticFile({ playwrightTags: ['@spec-also-not-a-row', '@hp-9'] }),
      ]);
      expect(problems).toHaveLength(4);
      expect(problems.join('\n')).toContain('`not-a-row`');
      expect(problems.join('\n')).toContain('`HP-9`');
      expect(problems.join('\n')).toContain('`also-not-a-row`');
    });
  });

  describe('rule 4 — every server and E2E spec file carries a requirement tag', () => {
    it('finds a tag on every file the rule polices', () => {
      expect(problemList(untaggedSpecFiles(SPEC_FILES))).toBe('');
    });

    it('reports an untagged file, and exempts the guard project and the spike harness', () => {
      const untagged = syntheticFile({ title: 'synthetic.present.integration', areaTags: [] });
      expect(untaggedSpecFiles([untagged])[0]).toContain('carries no requirement tag');
      expect(
        untaggedSpecFiles([
          syntheticFile({
            path: 'apps/server/test/guards/synthetic.present.guard.spec.ts',
            title: 'synthetic.present.guard',
            areaTags: [],
          }),
          syntheticFile({
            path: 'apps/server/test/spikes/s01-something.spike.spec.ts',
            title: 'S1 — a throwaway harness',
            areaTags: [],
          }),
          syntheticFile({
            path: 'packages/crdt/src/dominates.prop.spec.ts',
            title: 'crdt.dominates.prop',
            areaTags: [],
          }),
        ]),
      ).toEqual([]);
    });

    it('accepts a Playwright annotation as the tag', () => {
      expect(
        untaggedSpecFiles([
          syntheticFile({
            path: 'apps/e2e/electron/synthetic.launch.e2e.spec.ts',
            title: 'synthetic.launch.e2e',
            areaTags: [],
            playwrightTags: ['@smoke', '@area-clients'],
          }),
        ]),
      ).toEqual([]);
    });
  });

  describe('rule 7 — a gating layer is selected by a merge-blocking lane', () => {
    it(`finds ${SMOKE_TAG} on every due gating test`, () => {
      expect(problemList(ungatedTests(MAP, CURRENT, DECLARED))).toBe('');
    });

    it(`reports a due gating test whose spec carries no ${SMOKE_TAG} tag`, () => {
      const map = syntheticMap({
        entries: [
          syntheticEntry({
            layer: GATING_LAYER,
            gating: true,
            tests: ['synthetic.desktop.e2e'],
          }),
        ],
      });
      const file = syntheticFile({
        path: 'apps/e2e/electron/synthetic.desktop.e2e.spec.ts',
        title: 'synthetic.desktop.e2e [spec:concurrent-editing]',
        name: 'synthetic.desktop.e2e',
        playwrightTags: ['@spec-concurrent-editing'],
      });
      expect(ungatedTests(map, 'M0', declaredTests([file]))[0]).toContain(SMOKE_TAG);
      expect(
        ungatedTests(
          map,
          'M0',
          declaredTests([{ ...file, playwrightTags: [...file.playwrightTags, SMOKE_TAG] }]),
        ),
      ).toEqual([]);
    });
  });

  describe('rule 5 — host-contract cases have a recorded pass in every due harness', () => {
    it(`checks the merged reports when ${HOST_CONTRACT_REPORTS_VAR} names them`, () => {
      const directory = process.env[HOST_CONTRACT_REPORTS_VAR];
      expect(
        problemList(
          hostContractGaps(
            MAP,
            CURRENT,
            directory,
            directory === undefined ? () => null : readHostContractReport(directory),
          ),
        ),
      ).toBe('');
    });

    it('reports a case one due harness never recorded, and a harness that wrote no report', () => {
      const map = syntheticMap({
        hostContractHarnesses: ['host.contract.component', 'desktop.host-contract.e2e'],
        tests: new Map([
          [
            'host.contract.component',
            { sinceMilestone: 'M0', project: null, file: null, tag: null },
          ],
          [
            'desktop.host-contract.e2e',
            { sinceMilestone: 'M0', project: null, file: null, tag: null },
          ],
        ]),
      });
      const reports: Record<string, readonly string[] | null> = {
        'host.contract.component': ['openExternal refuses a javascript: URL'],
        'desktop.host-contract.e2e': [],
      };
      const gaps = hostContractGaps(map, 'M0', 'reports/host-contract', (harness) =>
        harness in reports ? (reports[harness] ?? null) : null,
      );
      expect(gaps).toHaveLength(1);
      expect(gaps[0]).toContain('desktop.host-contract.e2e');
      expect(hostContractGaps(map, 'M0', 'reports/host-contract', () => null)).toHaveLength(2);
    });

    it('has nothing to check before a harness is due, or with the variable unset', () => {
      const map = syntheticMap({
        hostContractHarnesses: ['host.contract.component'],
        tests: new Map([
          [
            'host.contract.component',
            { sinceMilestone: 'M2', project: null, file: null, tag: null },
          ],
        ]),
      });
      expect(hostContractGaps(map, 'M0', 'reports/host-contract', () => null)).toEqual([]);
      expect(hostContractGaps(map, 'M2', undefined, () => null)).toEqual([]);
    });
  });
});
