/**
 * `guards.mutation-lane.guard` (10-testing-and-quality.md, the guard table and "Mutation";
 * 13-decision-log.md A2 as amended 2026-09-13; `docs/adr/0002-mutation-lane.md`).
 *
 * A2 keeps two consumers of the TypeScript **JavaScript** compiler API alive inside a repository
 * that builds with TypeScript 7.0.2, which ships no such API until 7.1. Each lives in its own leaf
 * package that aliases `typescript` to `@typescript/typescript6`: `tooling/mutation` for Stryker's
 * `typescript-checker`, and `tooling/api-codegen` for `openapi-typescript`, whose type printer calls
 * `ts.factory` (the M0 finding that amended A2).
 *
 * The alias is safe only because it is contained. A third manifest carrying it — or the alias
 * reaching the workspace `catalog`/`catalogs` or `overrides`, which apply to the whole closure —
 * would put TypeScript 6 under packages that are supposed to compile with 7, and the symptom would
 * not be a build failure but a *checker* that quietly agrees with the wrong compiler. So this guard
 * enumerates every workspace manifest from `pnpm-workspace.yaml`'s own `packages` globs, `spikes/*`
 * included, rather than from a list written here: a new workspace is covered the day it is added.
 *
 * **The second assertion is about a copy that cannot be removed.** `ci.yml`'s `mutation-scoped` job
 * decides whether to run the lane by matching changed paths against a shell regex, because a GitHub
 * Actions step cannot import a Stryker config. Its own comment says this guard "should assert the
 * two agree so this copy cannot drift". It does: both sides are normalised to the same canonical
 * glob set — the regex by expanding its alternations and rewriting `/.*\.ts` as `/**\/*.ts`, the
 * config by expanding its braces — and any construct either normaliser does not understand fails the
 * guard rather than being skipped, so the comparison can never pass by not looking.
 *
 * The configuration is *imported* rather than pattern-matched, so the assertion is against the value
 * Stryker will actually use. Its module body sets `IRIDIUM_PROP_SEED` when unset (the fixed seed the
 * lane needs), which is restored below: a guard must leave no environment behind for the next file
 * in the worker.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const WORKSPACE_FILE = join(REPO_ROOT, 'pnpm-workspace.yaml');
const STRYKER_CONFIG = join(REPO_ROOT, 'tooling', 'mutation', 'stryker.config.mjs');
const CI_WORKFLOW = join(REPO_ROOT, '.github', 'workflows', 'ci.yml');

/** The npm package the two leaf manifests alias `typescript` to (A2). */
const ALIAS_PACKAGE = '@typescript/typescript6';

/** The only two manifests that may carry the alias (A2 as amended; ADR 0002). */
const ALIAS_MANIFESTS: readonly string[] = [
  'tooling/api-codegen/package.json',
  'tooling/mutation/package.json',
];

const REMEDY_ALIAS =
  `Remedy: keep ${ALIAS_PACKAGE} inside ${ALIAS_MANIFESTS.join(' and ')}. A package that needs ` +
  'the TypeScript JavaScript compiler API gets its own leaf manifest (A2); it never widens the ' +
  'alias, and never reaches the workspace catalog or overrides, which apply to the whole closure.';

function repoRelative(absolute: string): string {
  return relative(REPO_ROOT, absolute).replaceAll('\\', '/');
}

// ---------------------------------------------------------------------------------------------
// pnpm-workspace.yaml
// ---------------------------------------------------------------------------------------------

/**
 * Strip YAML comments, leaving every offset alone.
 *
 * `pnpm-workspace.yaml` *documents* the alias in a comment above `peerDependencyRules`, which is
 * exactly the difference between recording a decision and making one. A `#` inside a quoted scalar
 * is not a comment.
 */
function stripYamlComments(yaml: string): string {
  return yaml
    .split('\n')
    .map((line) => {
      let quote: string | null = null;
      for (let index = 0; index < line.length; index += 1) {
        const character = line[index];
        if (quote !== null) {
          if (character === quote) quote = null;
          continue;
        }
        if (character === "'" || character === '"') {
          quote = character;
          continue;
        }
        if (character === '#') return line.slice(0, index);
      }
      return line;
    })
    .join('\n');
}

/**
 * The `packages:` globs, read out of the file rather than restated here, so a workspace root added
 * to the YAML is scanned without a change to this guard.
 */
function workspaceGlobs(yaml: string): string[] {
  const lines = stripYamlComments(yaml).split('\n');
  const start = lines.findIndex((line) => /^packages:\s*$/.test(line));
  if (start === -1) throw new Error('pnpm-workspace.yaml declares no top-level `packages:` key');
  const globs: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '') continue;
    if (/^\S/.test(line)) break; // the next top-level key ends the block
    const entry = /^\s+-\s*'?([^'\s]+)'?\s*$/.exec(line);
    if (entry === null) throw new Error(`unparsable \`packages\` entry: ${line}`);
    globs.push(entry[1] ?? '');
  }
  return globs;
}

/**
 * Expand one workspace glob to the manifests it matches.
 *
 * Only the `<dir>/*` form the file uses and a literal directory are understood. Anything else throws
 * rather than matching nothing, because a glob this function silently ignores is a set of packages
 * the alias scan stops covering.
 */
function manifestsForGlob(glob: string): string[] {
  if (!glob.includes('*')) {
    const manifest = join(REPO_ROOT, glob, 'package.json');
    return existsSync(manifest) ? [manifest] : [];
  }
  const segments = glob.split('/');
  if (segments.filter((segment) => segment.includes('*')).length !== 1 || segments.at(-1) !== '*') {
    throw new Error(
      `the guard understands \`<dir>/*\` and literal paths; \`${glob}\` is neither, so it would be ` +
        'scanned as nothing. Teach the expander the new form rather than dropping the glob.',
    );
  }
  const parent = join(REPO_ROOT, ...segments.slice(0, -1));
  let entries: string[];
  try {
    entries = readdirSync(parent);
  } catch {
    return [];
  }
  return entries
    .map((entry) => join(parent, entry, 'package.json'))
    .filter((manifest) => existsSync(manifest));
}

/** Every workspace manifest, plus the root manifest, which no glob matches but which is one. */
function workspaceManifests(yaml: string): string[] {
  const manifests = workspaceGlobs(yaml).flatMap((glob) => manifestsForGlob(glob));
  return [join(REPO_ROOT, 'package.json'), ...manifests]
    .map((manifest) => repoRelative(manifest))
    .toSorted((a, b) => a.localeCompare(b));
}

/** Every block of a manifest in which a dependency can be declared. */
const DEPENDENCY_BLOCKS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The `typescript` specifier a manifest declares, in whichever block declares it. */
function typescriptSpecifier(manifest: string): string | null {
  const parsed: unknown = JSON.parse(readFileSync(join(REPO_ROOT, manifest), 'utf8'));
  if (!isRecord(parsed)) return null;
  for (const block of DEPENDENCY_BLOCKS) {
    const section = parsed[block];
    if (!isRecord(section)) continue;
    const specifier = section['typescript'];
    if (typeof specifier === 'string') return specifier;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// The mutate scope, on both sides
// ---------------------------------------------------------------------------------------------

/** Expand `{a,b}` alternations into one string each, recursively. */
function expandBraces(pattern: string): string[] {
  const open = pattern.indexOf('{');
  if (open === -1) return [pattern];
  const close = pattern.indexOf('}', open);
  if (close === -1) throw new Error(`unbalanced brace in glob \`${pattern}\``);
  const head = pattern.slice(0, open);
  const tail = pattern.slice(close + 1);
  return pattern
    .slice(open + 1, close)
    .split(',')
    .flatMap((choice) => expandBraces(`${head}${choice}${tail}`));
}

/** Split on `|` at paren depth zero. */
function splitAlternatives(pattern: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '\\') {
      current += character + (pattern[index + 1] ?? '');
      index += 1;
      continue;
    }
    if (character === '(') depth += 1;
    if (character === ')') depth -= 1;
    if (character === '|' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  parts.push(current);
  return parts;
}

/** Expand `(a|b)` groups into one alternative each, recursively. */
function expandGroups(pattern: string): string[] {
  const open = pattern.indexOf('(');
  if (open === -1) return [pattern];
  let depth = 0;
  let close = -1;
  for (let index = open; index < pattern.length; index += 1) {
    if (pattern[index] === '(') depth += 1;
    else if (pattern[index] === ')') {
      depth -= 1;
      if (depth === 0) {
        close = index;
        break;
      }
    }
  }
  if (close === -1) throw new Error(`unbalanced group in regex \`${pattern}\``);
  const head = pattern.slice(0, open);
  const tail = pattern.slice(close + 1);
  return splitAlternatives(pattern.slice(open + 1, close)).flatMap((choice) =>
    expandGroups(`${head}${choice}${tail}`),
  );
}

/**
 * Rewrite one group-free regular expression as the glob it means.
 *
 * `\X` is the literal `X`, `.*` is `**` followed by a path segment, and every other character is
 * itself. A metacharacter this function has no rule for throws, so an expression it cannot read is
 * a red guard rather than a silent mismatch.
 */
function regexToGlob(pattern: string): string {
  let glob = '';
  let index = 0;
  while (index < pattern.length) {
    const character = pattern[index] ?? '';
    if (character === '\\') {
      glob += pattern[index + 1] ?? '';
      index += 2;
      continue;
    }
    if (character === '.' && pattern[index + 1] === '*') {
      glob += '**/*';
      index += 2;
      continue;
    }
    if ('.*+?[]{}()^$|'.includes(character)) {
      throw new Error(
        `the guard cannot read \`${character}\` in the ci.yml mutate regex \`${pattern}\`; ` +
          'teach the normaliser the construct rather than letting the comparison skip it.',
      );
    }
    glob += character;
    index += 1;
  }
  return glob;
}

/** The `mutate=` shell fragments of `ci.yml`'s `mutation-scoped` job, concatenated in order. */
function ciMutateRegex(workflow: string): string {
  const fragments = workflow
    .split('\n')
    .filter((line) => /^\s*mutate=/.test(line))
    .map((line) => {
      const quoted = /'([^']*)'\s*$/.exec(line);
      if (quoted === null) throw new Error(`unparsable mutate fragment in ci.yml: ${line.trim()}`);
      return quoted[1] ?? '';
    });
  if (fragments.length === 0) throw new Error('ci.yml declares no `mutate=` fragments');
  return fragments.join('');
}

/** The canonical glob set the `ci.yml` regex describes. */
function ciMutateGlobs(workflow: string): string[] {
  const regex = ciMutateRegex(workflow);
  const anchored = /^\^\((.*)\)\$$/s.exec(regex);
  if (anchored === null) {
    throw new Error(`the ci.yml mutate regex is not an anchored alternation: ${regex}`);
  }
  return expandGroups(anchored[1] ?? '')
    .flatMap((alternative) => splitAlternatives(alternative))
    .map((alternative) => regexToGlob(alternative))
    .toSorted((a, b) => a.localeCompare(b));
}

/** Stryker's `mutate` array, split into the positive patterns and the negated ones. */
function strykerMutate(mutate: readonly string[]): {
  readonly globs: string[];
  readonly negated: string[];
} {
  const positive = mutate.filter((pattern) => !pattern.startsWith('!'));
  return {
    globs: positive
      .flatMap((pattern) => expandBraces(pattern))
      .toSorted((a, b) => a.localeCompare(b)),
    negated: mutate.filter((pattern) => pattern.startsWith('!')),
  };
}

// ---------------------------------------------------------------------------------------------

const WORKSPACE_YAML = readFileSync(WORKSPACE_FILE, 'utf8');
const CI_YAML = readFileSync(CI_WORKFLOW, 'utf8');
const MANIFESTS = workspaceManifests(WORKSPACE_YAML);

/** The `mutate` array Stryker will use, read from the config module rather than from its text. */
let strykerMutatePatterns: readonly string[] = [];

beforeAll(async () => {
  const where = repoRelative(STRYKER_CONFIG);
  // The config's module body sets IRIDIUM_PROP_SEED when unset; leave the environment as found.
  const seed = process.env['IRIDIUM_PROP_SEED'];
  const loaded: unknown = await import(pathToFileURL(STRYKER_CONFIG).href);
  if (seed === undefined) delete process.env['IRIDIUM_PROP_SEED'];
  else process.env['IRIDIUM_PROP_SEED'] = seed;
  if (typeof loaded !== 'object' || loaded === null || !('default' in loaded)) {
    throw new Error(`${where} has no default export`);
  }
  const options: unknown = loaded.default;
  if (typeof options !== 'object' || options === null || !('mutate' in options)) {
    throw new Error(`${where} exports no \`mutate\` array`);
  }
  const mutate: unknown = options.mutate;
  if (!Array.isArray(mutate) || mutate.some((pattern: unknown) => typeof pattern !== 'string')) {
    throw new Error(`${where}: \`mutate\` is not an array of glob strings`);
  }
  strykerMutatePatterns = mutate;
});

describe('guards.mutation-lane.guard [area:ops]', () => {
  describe('the TypeScript 6 alias stays in its two leaf packages', () => {
    it('enumerates every workspace manifest from the workspace file, spikes included', () => {
      const globs = workspaceGlobs(WORKSPACE_YAML);
      expect(globs, 'pnpm-workspace.yaml no longer lists the spike harnesses').toContain(
        'spikes/*',
      );
      expect(MANIFESTS, 'the root manifest is a manifest too').toContain('package.json');
      for (const manifest of ALIAS_MANIFESTS) {
        expect(MANIFESTS, `${manifest} is not reachable from the workspace globs`).toContain(
          manifest,
        );
      }
      // A workspace of this size cannot legitimately shrink to a handful; a collapsed glob
      // expansion would make every assertion below pass by scanning almost nothing.
      expect(MANIFESTS.length).toBeGreaterThan(15);
    });

    it(`finds ${ALIAS_PACKAGE} in exactly the two manifests A2 names`, () => {
      const carriers = MANIFESTS.filter((manifest) =>
        readFileSync(join(REPO_ROOT, manifest), 'utf8').includes(ALIAS_PACKAGE),
      );
      expect(
        carriers.join('\n'),
        `${ALIAS_PACKAGE} must appear in exactly ${ALIAS_MANIFESTS.join(' and ')}.\n${REMEDY_ALIAS}`,
      ).toBe(ALIAS_MANIFESTS.join('\n'));
    });

    it('declares the alias on `typescript`, at one exact version shared by both leaves', () => {
      const specifiers = ALIAS_MANIFESTS.map((manifest) => typescriptSpecifier(manifest));
      for (const manifest of ALIAS_MANIFESTS) {
        const specifier = typescriptSpecifier(manifest);
        expect(
          specifier,
          `${manifest} declares no \`typescript\` dependency.\n${REMEDY_ALIAS}`,
        ).not.toBeNull();
        expect(
          specifier ?? '',
          `${manifest} must alias typescript to an exact ${ALIAS_PACKAGE} version (\`saveExact: true\`; the plan pins exact versions only).`,
        ).toMatch(/^npm:@typescript\/typescript6@\d+\.\d+\.\d+$/);
      }
      expect(
        new Set(specifiers).size,
        `the two leaf packages must alias the same ${ALIAS_PACKAGE} version, or the mutation lane and \`pnpm gen\` step 3 run against two different compilers: ${specifiers.join(' vs ')}`,
      ).toBe(1);
    });

    it('keeps the alias out of the workspace catalogs and overrides', () => {
      const declarations = stripYamlComments(WORKSPACE_YAML);
      const lines = declarations
        .split('\n')
        .map((line, index) => ({ line, number: index + 1 }))
        .filter((entry) => entry.line.includes(ALIAS_PACKAGE))
        .map((entry) => `  pnpm-workspace.yaml:${String(entry.number)}: ${entry.line.trim()}`);
      expect(
        lines.join('\n'),
        `${ALIAS_PACKAGE} in \`catalog\`, \`catalogs\` or \`overrides\` applies to the whole closure, which is the opposite of what A2 decided.\n${REMEDY_ALIAS}`,
      ).toBe('');
    });
  });

  describe("ci.yml's mutate regex and stryker.config.mjs's mutate array agree", () => {
    it('loads the configuration Stryker will use', () => {
      expect(
        strykerMutatePatterns,
        'stryker.config.mjs exported an empty `mutate` array, so the lane mutates nothing',
      ).not.toHaveLength(0);
    });

    it('describes the same canonical glob set on both sides', () => {
      const fromConfig = strykerMutate(strykerMutatePatterns);
      const fromWorkflow = ciMutateGlobs(CI_YAML);
      const onlyInWorkflow = fromWorkflow.filter((glob) => !fromConfig.globs.includes(glob));
      const onlyInConfig = fromConfig.globs.filter((glob) => !fromWorkflow.includes(glob));
      const report = [
        ...onlyInWorkflow.map((glob) => `  only in .github/workflows/ci.yml: ${glob}`),
        ...onlyInConfig.map((glob) => `  only in tooling/mutation/stryker.config.mjs: ${glob}`),
      ].join('\n');
      expect(
        report,
        "ci.yml's `mutation-scoped` job decides whether to run the lane from a copy of Stryker's `mutate` array, and the two have drifted. The config is the source of truth: edit the regex in .github/workflows/ci.yml to match it.",
      ).toBe('');
    });

    it('excludes spec files on both sides, and only spec files', () => {
      expect(strykerMutate(strykerMutatePatterns).negated).toEqual(['!**/*.spec.ts']);
      expect(
        CI_YAML,
        'ci.yml must drop spec files from the changed-path match, as the `mutate` array does',
      ).toContain(String.raw`grep -v '\.spec\.ts$'`);
    });

    it('refuses a pattern either normaliser cannot read, rather than skipping it', () => {
      expect(() => regexToGlob(String.raw`apps/server/src/[ab]/x\.ts`)).toThrow(/cannot read/);
      expect(() => expandBraces('apps/{a,b')).toThrow(/unbalanced brace/);
      expect(() => expandGroups('apps/(a|b')).toThrow(/unbalanced group/);
      expect(() => manifestsForGlob('apps/**/deep')).toThrow(/neither/);
    });

    it('tracks the regex it reads, so a narrowed scope is a difference', () => {
      const drifted = CI_YAML.replace(
        '|packages/crdt/src/.*\\.ts',
        '|packages/crdt/src/only-one\\.ts',
      );
      expect(drifted, 'the ci.yml fragment this case edits has been renamed').not.toBe(CI_YAML);
      const globs = ciMutateGlobs(drifted);
      expect(globs).toContain('packages/crdt/src/only-one.ts');
      expect(globs).not.toContain('packages/crdt/src/**/*.ts');
    });

    it('normalises a group, a brace and a wildcard to the same glob', () => {
      expect(expandGroups(String.raw`a/(x|y)/.*\.ts`).map((p) => regexToGlob(p))).toEqual([
        'a/x/**/*.ts',
        'a/y/**/*.ts',
      ]);
      expect(expandBraces('a/{x,y}.ts')).toEqual(['a/x.ts', 'a/y.ts']);
    });
  });
});
