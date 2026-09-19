/**
 * Read the repository-owned runner configs for static acceptance checks in workspace packages.
 * The server guard invokes this tool instead of importing files outside its package boundary.
 * Config diagnostics remain visible; exactly one marked JSON record carries the selectors.
 */
import { resolve } from 'node:path';

import { configDefaults, mergeConfig } from 'vitest/config';

import playwrightConfig from '../playwright.config.ts';
import vitestConfig from '../vitest.config.ts';
import { isRecord, parseJson } from './lib/json.ts';

const REPO_ROOT = resolve(import.meta.dirname, '..');

interface Pattern {
  readonly kind: 'glob' | 'regex';
  readonly value: string;
  readonly flags: string;
}

interface Project {
  readonly runner: 'vitest' | 'playwright';
  readonly name: string;
  readonly directory: string;
  readonly include: readonly Pattern[];
  readonly exclude: readonly Pattern[];
}

function pattern(value: string | RegExp): Pattern {
  return typeof value === 'string'
    ? { kind: 'glob', value, flags: '' }
    : { kind: 'regex', value: value.source, flags: value.flags };
}

/** Vitest 5 merges inline projects with the root config, including include/exclude arrays. */
function vitestProjects(config: typeof vitestConfig): Project[] {
  const projects = config.test?.projects;
  if (projects === undefined || projects.length === 0) {
    throw new Error(
      'vitest.config.ts must declare the inline projects used by the acceptance guard',
    );
  }
  return projects.map((project) => {
    if (
      typeof project !== 'object' ||
      project === null ||
      'then' in project ||
      typeof project.extends === 'string'
    ) {
      throw new Error('The acceptance guard requires inline Vitest project configurations');
    }
    const name =
      typeof project.test?.name === 'string' ? project.test.name : project.test?.name?.label;
    if (name === undefined || name === '') {
      throw new Error(
        'Every inline Vitest project needs an explicit name for the acceptance guard',
      );
    }
    const merged: typeof vitestConfig = mergeConfig(
      project.extends === false ? {} : config,
      project,
    );
    const root = resolve(REPO_ROOT, merged.root ?? '.');
    return {
      runner: 'vitest',
      name,
      directory: resolve(root, merged.test?.dir ?? '.'),
      include: (merged.test?.include ?? configDefaults.include).map(pattern),
      exclude: (merged.test?.exclude ?? configDefaults.exclude).map(pattern),
    };
  });
}

function patterns(value: string | RegExp | readonly (string | RegExp)[]): Pattern[] {
  return (typeof value === 'string' || value instanceof RegExp ? [value] : value).map(pattern);
}

/** Playwright inherits project selectors and confines discovery to testDir. */
function playwrightProjects(config: typeof playwrightConfig): Project[] {
  const projects = config.projects;
  if (projects === undefined || projects.length === 0) {
    throw new Error('playwright.config.ts must declare the projects used by the acceptance guard');
  }
  return projects.map((project) => {
    const name = project.name;
    const include = project.testMatch ?? config.testMatch;
    if (name === undefined || name === '' || include === undefined) {
      throw new Error('Every Playwright project needs an explicit name and testMatch selector');
    }
    return {
      runner: 'playwright',
      name,
      directory: resolve(REPO_ROOT, project.testDir ?? config.testDir ?? '.'),
      include: patterns(include),
      exclude: patterns(project.testIgnore ?? config.testIgnore ?? []),
    };
  });
}

// The optional JSON input exercises configuration inheritance through this same root-owned seam.
// Its supported fixture fields are validated; no parsed value is asserted to be a runner config.
function fixtureObject(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('A selector fixture must be an object');
  return value;
}

function fixtureString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  if (value === undefined || typeof value === 'string') return value;
  throw new Error('Selector fixture field ' + key + ' must be a string');
}

function fixtureStrings(source: Record<string, unknown>, key: string): string[] | undefined {
  const value = source[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error('Selector fixture field ' + key + ' must be an array');
  return value.map((item) => {
    if (typeof item !== 'string') throw new Error('Selector fixture patterns must be strings');
    return item;
  });
}

function fixtureProjects(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error('Selector fixture projects must be an array');
  return value.map(fixtureObject);
}

interface VitestFixtureOptions {
  readonly name?: string;
  readonly dir?: string;
  readonly include?: string[];
  readonly exclude?: string[];
}

function vitestFixtureOptions(source: Record<string, unknown>): VitestFixtureOptions {
  const name = fixtureString(source, 'name');
  const dir = fixtureString(source, 'dir');
  const include = fixtureStrings(source, 'include');
  const exclude = fixtureStrings(source, 'exclude');
  return {
    ...(name === undefined ? {} : { name }),
    ...(dir === undefined ? {} : { dir }),
    ...(include === undefined ? {} : { include }),
    ...(exclude === undefined ? {} : { exclude }),
  };
}

function vitestFixture(source: Record<string, unknown>): typeof vitestConfig {
  const test = fixtureObject(source['test']);
  return {
    root: fixtureString(source, 'root') ?? REPO_ROOT,
    test: {
      ...vitestFixtureOptions(test),
      projects: fixtureProjects(test['projects']).map((project) => {
        const inherit = project['extends'];
        if (inherit !== undefined && typeof inherit !== 'boolean') {
          throw new Error('Selector fixture extends must be a boolean');
        }
        const root = fixtureString(project, 'root');
        const options: { root?: string; extends?: boolean; test: VitestFixtureOptions } = {
          test: vitestFixtureOptions(fixtureObject(project['test'])),
        };
        if (root !== undefined) options.root = root;
        if (inherit !== undefined) options.extends = inherit;
        return options;
      }),
    },
  };
}

interface PlaywrightFixtureOptions {
  readonly name?: string;
  readonly testDir?: string;
  readonly testMatch?: string | string[];
  readonly testIgnore?: string | string[];
}

function playwrightFixtureOptions(source: Record<string, unknown>): PlaywrightFixtureOptions {
  const name = fixtureString(source, 'name');
  const testDir = fixtureString(source, 'testDir');
  const testMatch =
    typeof source['testMatch'] === 'string'
      ? source['testMatch']
      : fixtureStrings(source, 'testMatch');
  const testIgnore =
    typeof source['testIgnore'] === 'string'
      ? source['testIgnore']
      : fixtureStrings(source, 'testIgnore');
  return {
    ...(name === undefined ? {} : { name }),
    ...(testDir === undefined ? {} : { testDir }),
    ...(testMatch === undefined ? {} : { testMatch }),
    ...(testIgnore === undefined ? {} : { testIgnore }),
  };
}

function readProjects(input: string | undefined): Project[] {
  if (input === undefined) {
    return [...vitestProjects(vitestConfig), ...playwrightProjects(playwrightConfig)];
  }
  const fixture = fixtureObject(parseJson(input));
  const config = fixtureObject(fixture['config']);
  if (fixture['runner'] === 'vitest') return vitestProjects(vitestFixture(config));
  if (fixture['runner'] === 'playwright') {
    return playwrightProjects({
      ...playwrightFixtureOptions(config),
      projects: fixtureProjects(config['projects']).map(playwrightFixtureOptions),
    });
  }
  throw new Error('Selector fixture runner must be vitest or playwright');
}

if (import.meta.main) {
  if (process.argv.length > 3)
    throw new Error('Expected at most one selector fixture JSON argument');
  const projects = readProjects(process.argv[2]);
  process.stdout.write('IRIDIUM_TEST_PROJECTS ' + JSON.stringify({ version: 1, projects }) + '\n');
}
