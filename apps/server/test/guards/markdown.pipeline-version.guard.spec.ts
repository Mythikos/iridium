/** Pipeline output changes invalidate stored projections, including M1's existing version 1 rows. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { mask, REPO_ROOT } from './source-scan.ts';

const SOURCE = 'packages/markdown/src/';
const VERSION_FILE = `${SOURCE}version.ts`;

/** Git/history failures fail closed with a concrete local and CI recovery command. */
class PipelineHistoryUnavailable extends Error {
  constructor(detail: string) {
    super(
      `Cannot verify PIPELINE_VERSION: ${detail}. Fetch the comparison history (Actions checkout fetch-depth: 0), then rerun the guard.`,
    );
    this.name = 'PipelineHistoryUnavailable';
  }
}

function git(args: readonly string[]): string {
  try {
    return execFileSync('git', [...args], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    throw new PipelineHistoryUnavailable(error instanceof Error ? error.message : String(error));
  }
}

function paths(output: string): string[] {
  return output.split('\0').filter(Boolean);
}

function pipelinePath(path: string): boolean {
  if (
    !path.startsWith(SOURCE) ||
    !path.endsWith('.ts') ||
    path.endsWith('.d.ts') ||
    /\.(?:spec|test)\.ts$/.test(path)
  )
    return false;
  const relative = path.slice(SOURCE.length);
  return (
    !['index.ts', 'version.ts', 'text-codec.d.ts'].includes(relative) &&
    !relative.startsWith('search/')
  );
}

function newPipelineSurface(path: string): boolean {
  return (
    pipelinePath(path) &&
    /^(?:parse(?:\.ts|\/)|project(?:\.ts|\/)|processor\.ts|sanitize\/|plugins\/)/.test(
      path.slice(SOURCE.length),
    )
  );
}

function version(source: string): number | null {
  const found = /\bexport\s+const\s+PIPELINE_VERSION\s*=\s*(\d+)\s*;/g.exec(
    mask(source, { strings: true }),
  );
  const value = found?.[1] === undefined ? NaN : Number(found[1]);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

interface VersionChange {
  readonly before: number | null;
  readonly after: number | null;
  readonly baselinePaths: readonly string[];
  readonly changedPaths: readonly string[];
}

function violation(change: VersionChange): string | null {
  if (change.after === null)
    return 'Export one positive integer PIPELINE_VERSION in src/version.ts.';
  const firstPipeline = !change.baselinePaths.some(newPipelineSurface);
  // A genuinely new namespace starts at 1. M1 already persisted version 1 even
  // though this package did not yet expose parse/project, so M2 must advance it.
  if (firstPipeline && change.before === null && !change.baselinePaths.includes(VERSION_FILE))
    return change.after === 1 ? null : 'A new pipeline version namespace starts at 1.';
  if (change.before === null) return 'The comparison revision has no valid PIPELINE_VERSION.';
  if (change.after < change.before) return 'PIPELINE_VERSION must never decrease.';
  const changed = change.changedPaths.filter(pipelinePath);
  if (changed.length > 0 && change.after === change.before) {
    return `Bump packages/markdown/src/version.ts above ${change.before}; derived output may change in: ${changed.join(', ')}`;
  }
  return null;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function eventBaseline(event: unknown): string | null {
  if (!record(event)) return null;
  const pullRequest = event.pull_request;
  const base = record(pullRequest) ? pullRequest.base : undefined;
  const candidate = record(base) ? base.sha : event.before;
  if (candidate === undefined || candidate === '0'.repeat(40)) return null;
  if (typeof candidate !== 'string' || !/^[a-f\d]{40,64}$/i.test(candidate))
    throw new PipelineHistoryUnavailable('invalid comparison SHA in the GitHub event');
  return candidate;
}

function inspectCheckout(): { baseline: string; change: VersionChange } {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const event: unknown =
    eventPath === undefined ? null : JSON.parse(readFileSync(eventPath, 'utf8'));
  const eventBase = eventBaseline(event);
  const untracked = paths(git(['ls-files', '--others', '--exclude-standard', '-z', '--', SOURCE]));
  const working = paths(git(['diff', '--name-only', '--no-renames', '-z', 'HEAD', '--', SOURCE]));
  // A local dirty checkout compares against HEAD. A clean checkout still checks its last commit.
  const baseline =
    eventBase ??
    (working.some(pipelinePath) || untracked.some(pipelinePath)
      ? git(['rev-parse', 'HEAD']).trim()
      : git(['rev-parse', 'HEAD^1']).trim());
  git(['cat-file', '-e', `${baseline}^{commit}`]);
  const baselinePaths = paths(git(['ls-tree', '-r', '--name-only', '-z', baseline, '--', SOURCE]));
  const changedPaths = [
    ...new Set([
      ...paths(git(['diff', '--name-only', '--no-renames', '-z', baseline, '--', SOURCE])),
      ...untracked,
    ]),
  ];
  const before = baselinePaths.includes(VERSION_FILE)
    ? version(git(['show', `${baseline}:${VERSION_FILE}`]))
    : null;
  return {
    baseline,
    change: {
      before,
      after: version(readFileSync(join(REPO_ROOT, VERSION_FILE), 'utf8')),
      baselinePaths,
      changedPaths,
    },
  };
}

describe('markdown.pipeline-version.guard [area:markdown]', () => {
  it('checks actual tracked, staged, deleted and untracked pipeline changes against history', () => {
    const actual = inspectCheckout();
    expect(
      violation(actual.change),
      `Compared Markdown output against ${actual.baseline}`,
    ).toBeNull();
  });

  it.each([
    'parse.ts',
    'project.ts',
    'processor.ts',
    'frontmatter.ts',
    'body-text.ts',
    'hast-walk.ts',
    'markdown-it/parser.ts',
    'links/resolve.ts',
    'plugins/rehype-iridium.ts',
    'sanitize/schema.ts',
  ])('protects the real flat and nested implementation path %s', (path) => {
    expect(pipelinePath(`${SOURCE}${path}`)).toBe(true);
    expect(
      violation({
        before: 1,
        after: 1,
        baselinePaths: [`${SOURCE}parse.ts`],
        changedPaths: [`${SOURCE}${path}`],
      }),
    ).toContain('Bump');
  });

  it.each([
    'src/search/parse-query.ts',
    'src/version.ts',
    'src/text-codec.d.ts',
    'src/markdown.pipeline.unit.spec.ts',
    'fixtures/golden/note.md',
  ])('does not demand reindexing for unrelated %s', (path) => {
    expect(pipelinePath(`packages/markdown/${path}`)).toBe(false);
  });

  it('advances M1 projections when the full M2 pipeline lands and keeps later bumps monotonic', () => {
    const initial = {
      before: 1,
      after: 1,
      baselinePaths: [`${SOURCE}normalize.ts`],
      changedPaths: [`${SOURCE}parse.ts`, `${SOURCE}project.ts`],
    };
    expect(violation(initial)).toContain('Bump');
    expect(violation({ ...initial, after: 2 })).toBeNull();
    expect(violation({ ...initial, before: null, baselinePaths: [] })).toBeNull();
    expect(violation({ ...initial, before: null, baselinePaths: [], after: 2 })).toContain(
      'starts at 1',
    );
    const subsequent = { ...initial, baselinePaths: [`${SOURCE}parse.ts`] };
    expect(violation(subsequent)).toContain('Bump');
    expect(violation({ ...subsequent, after: 2 })).toBeNull();
    expect(violation({ ...subsequent, before: 2, after: 1 })).toContain('decrease');
    expect(violation({ ...subsequent, changedPaths: [] })).toBeNull();
    expect(violation({ ...subsequent, after: null })).toContain('positive integer');
    expect(violation({ ...subsequent, before: null })).toContain('comparison revision');
  });

  it('reads version code rather than comments and rejects unsafe or missing values', () => {
    expect(
      version('/* export const PIPELINE_VERSION = 99; */\nexport const PIPELINE_VERSION = 2;'),
    ).toBe(2);
    expect(version('const text = "export const PIPELINE_VERSION = 99;";')).toBeNull();
    expect(version('export const PIPELINE_VERSION = 0;')).toBeNull();
    expect(version('export const PIPELINE_VERSION = 1 + 1;')).toBeNull();
  });

  it('selects PR and multi-commit push baselines and preserves NUL-delimited rename/deletion paths', () => {
    const sha = 'a'.repeat(40);
    expect(eventBaseline({ pull_request: { base: { sha } }, before: 'b'.repeat(40) })).toBe(sha);
    expect(eventBaseline({ before: sha })).toBe(sha);
    expect(eventBaseline({ before: '0'.repeat(40) })).toBeNull();
    expect(eventBaseline({})).toBeNull();
    expect(() => eventBaseline({ before: '--output=other' })).toThrow(PipelineHistoryUnavailable);
    expect(paths(`${SOURCE}parse.ts\0${SOURCE}plugins/name with space.ts\0`)).toEqual([
      `${SOURCE}parse.ts`,
      `${SOURCE}plugins/name with space.ts`,
    ]);
  });
});
