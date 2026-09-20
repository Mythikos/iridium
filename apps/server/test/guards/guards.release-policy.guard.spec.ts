/** D12-1/D12-2 artifact floors and OPS-29 current-release migration notes. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const WORKFLOW = readFileSync(join(REPO_ROOT, '.github/workflows/release.yml'), 'utf8');

/** Execute the actual Node script module without adding a cross-workspace TypeScript dependency. */
function evaluate(script: string, input: unknown): unknown {
  const stdout = execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: REPO_ROOT,
    input: JSON.stringify(input),
    encoding: 'utf8',
    windowsHide: true,
  });
  const result: unknown = JSON.parse(stdout);
  return result;
}

const SELECT_SCRIPT = `
import { selectRelease } from './scripts/lib/release-policy.ts';
let text = ''; for await (const part of process.stdin) text += part;
const result = JSON.parse(text).map(([tag, version, milestone]) => {
  try {
    const plan = selectRelease(tag, version, milestone);
    return { jobs: Object.entries(plan.jobs).filter(([, due]) => due).map(([job]) => job) };
  } catch (error) { return { error: error.message }; }
});
console.log(JSON.stringify(result));
`;
const NOTES_SCRIPT = `
import { releaseNoteIssues } from './scripts/lib/release-policy.ts';
let text = ''; for await (const part of process.stdin) text += part;
const input = JSON.parse(text);
console.log(JSON.stringify(releaseNoteIssues(input.changelog, '0.1.0', input.paths).length === 0));
`;
const IMAGE_TAG_SCRIPT = `
import { releaseImageTags } from './scripts/lib/release-policy.ts';
let text = ''; for await (const part of process.stdin) text += part;
console.log(JSON.stringify(JSON.parse(text).map((version) => {
  try { return releaseImageTags(version, 'ghcr.io/example/iridium-server'); }
  catch (error) { return { error: error.message }; }
})));
`;
const INSPECT_SCRIPT = `
import { inspectRelease } from './scripts/check-release.ts';
let text = ''; for await (const part of process.stdin) text += part;
try { console.log(JSON.stringify(inspectRelease(JSON.parse(text), 'v0.1.0'))); }
catch (error) { console.log(JSON.stringify({ error: error.message })); }
`;
const IMAGE_REPOSITORY_SCRIPT = `
import { releaseImageRepository, releaseImageTags } from './scripts/lib/release-policy.ts';
let text = ''; for await (const part of process.stdin) text += part;
console.log(JSON.stringify(JSON.parse(text).map((repository) => {
  try { return { repository: releaseImageRepository(repository), tags: releaseImageTags('0.1.0', repository) }; }
  catch (error) { return { error: error.message }; }
})));
`;

function jobBlocks(source: string): Map<string, string> {
  const lines = source.replaceAll('\r\n', '\n').split('\n');
  const start = lines.indexOf('jobs:');
  if (start === -1) throw new Error('No top-level jobs mapping');
  const result = new Map<string, string>();
  let current: string | null = null;
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line) && !line.startsWith('#')) break;
    const job = /^  ([a-z][a-z0-9-]*):\s*$/.exec(line)?.[1];
    if (job !== undefined) {
      if (result.has(job)) throw new Error(`Duplicate release job ${job}`);
      current = job;
      result.set(job, '');
    } else if (/^  \S/.test(line) && !line.trimStart().startsWith('#')) {
      throw new Error(`Unsupported release job declaration: ${line}`);
    } else if (current !== null && !line.trimStart().startsWith('#')) {
      result.set(current, `${result.get(current) ?? ''}${line}\n`);
    }
  }
  return result;
}

function jobScalar(block: string, key: string): string | null {
  const matches = [...block.matchAll(new RegExp(`^    ${key}: (.*)$`, 'gm'))];
  if (matches.length > 1) throw new Error(`Duplicate or unsupported ${key} job key`);
  return matches[0]?.[1] ?? null;
}

function workflowIssues(source: string): string[] {
  const jobs = jobBlocks(source);
  const issues: string[] = [];
  const required: Readonly<Record<string, { output: string; needs: string }>> = {
    verify: { output: 'verify', needs: '[release-plan]' },
    'server-image': { output: 'server_image', needs: '[release-plan, verify]' },
    bridge: { output: 'bridge', needs: '[release-plan, server-image]' },
    desktop: { output: 'desktop', needs: '[release-plan, verify]' },
    'release-feed': { output: 'release_feed', needs: '[release-plan, desktop, server-image]' },
    drill: { output: 'drill', needs: '[release-plan, server-image]' },
  };
  const expectedJobs = ['release-plan', ...Object.keys(required)].toSorted();
  if (JSON.stringify([...jobs.keys()].toSorted()) !== JSON.stringify(expectedJobs)) {
    issues.push('The release jobs differ from the reviewed artifact inventory');
  }
  const plan = jobs.get('release-plan') ?? '';
  if (jobScalar(plan, 'if') !== "startsWith(github.ref, 'refs/tags/v')")
    issues.push('No product-tag selector');
  if (!/^        run: node scripts\/check-release\.ts plan$/m.test(plan))
    issues.push('Selector bypassed');
  if (!/^          fetch-depth: 0$/m.test(plan)) issues.push('Selector needs complete tag history');
  for (const key of [
    'version',
    'milestone',
    'image_tags',
    'image_repository',
    ...Object.values(required).map((job) => job.output),
  ]) {
    if (!plan.includes(`      ${key}: \${{ steps.select.outputs.${key} }}`)) {
      issues.push(`Wrong selector output ${key}`);
    }
  }
  for (const [job, expected] of Object.entries(required)) {
    const block = jobs.get(job) ?? '';
    if (jobScalar(block, 'if') !== `needs.release-plan.outputs.${expected.output} == 'true'`) {
      issues.push(`Wrong milestone selection for ${job}`);
    }
    if (jobScalar(block, 'needs') !== expected.needs)
      issues.push(`Wrong successful prerequisites for ${job}`);
    if (/^\s+continue-on-error:/m.test(block)) issues.push(`Advisory release gate ${job}`);
  }
  const verify = jobs.get('verify') ?? '';
  if (
    !/uses: \.\/\.github\/actions\/setup-workspace\n        with:\n          playwright-browsers: 'chromium'/.test(
      verify,
    )
  )
    issues.push('Browser Mode component verification needs Chromium setup');
  for (const command of [
    'pnpm turbo run build',
    'pnpm exec vitest --run --passWithNoTests --config vitest.config.ts --project guard',
    'pnpm exec tsc -b --builders 8',
    'pnpm exec oxlint -c oxlint.config.ts --type-aware .',
    'pnpm exec oxfmt --check .',
    'pnpm exec knip --production',
    'pnpm exec turbo boundaries',
    'pnpm gen:check',
    'node scripts/check-licenses.ts',
    '--project unit --project component',
    '--project integration --project contract --project mcp',
    'docker build -f infra/docker/server.Dockerfile -t iridium-server:ci .',
    'node scripts/check-release.ts notes',
  ]) {
    const expectedLine = command.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!new RegExp(`^ {8,10}(?:run: )?${expectedLine}$`, 'm').test(verify)) {
      issues.push(`Missing M1 verification command ${command}`);
    }
  }
  if (/^        if:/m.test(verify)) issues.push('A verification step has become conditional');
  if (!verify.includes("mysql: ['mysql:8.4.11', 'mysql:9.7.2-oraclelinux9']"))
    issues.push('Both required engines must verify');
  const server = jobs.get('server-image') ?? '';
  if (!server.includes('tags: ${{ needs.release-plan.outputs.image_tags }}'))
    issues.push('Image tags must come from the tested selector');
  if (!server.includes('IMAGE_NAME: ${{ needs.release-plan.outputs.image_repository }}'))
    issues.push('Image scans must use the same canonical repository as the published tags');
  for (const setting of [
    'platforms: linux/amd64,linux/arm64',
    'push: true',
    'sbom: true',
    'provenance: mode=max',
    'format: cyclonedx-json',
    'severity-cutoff: high',
    'only-fixed: true',
    'fail-build: true',
  ]) {
    if (!server.includes(setting)) issues.push(`Missing M1 publication requirement ${setting}`);
  }
  return issues;
}

const migration = 'apps/server/migrations/0055_min_client_version.ts';
const noteCases = [
  {
    name: 'a continued reference title is not an operator notice',
    body: '## 0.1.0\n[ref]: https://example.invalid\n  "[migration]"',
    valid: false,
  },
  {
    name: 'a multiline quoted reference title remains hidden',
    body: '## 0.1.0\n[ref]: /url\n  "first\n[migration]\nlast"',
    valid: false,
  },
  {
    name: 'continued destinations and parenthesized titles remain hidden',
    body: '## 0.1.0\n[ref]:\n <https://example.invalid>\n (first\n[migration]\nlast)',
    valid: false,
  },
  {
    name: 'a multiline reference label is supported',
    body: '## 0.1.0\n[\nref\n]: /url\n "[migration]"',
    valid: false,
  },
  {
    name: 'visible prose after a definition still supplies the flag',
    body: '## 0.1.0\n[ref]: /url\n "hidden [migration]"\n[migration] Apply the new schema.',
    valid: true,
  },
  {
    name: 'invalid trailing content makes the same-line definition visible',
    body: '## 0.1.0\n[ref]: /url "[migration]" trailing',
    valid: true,
  },
  {
    name: 'invalid following-line title remains visible prose',
    body: '## 0.1.0\n[ref]: /url\n "[migration]" trailing',
    valid: true,
  },
  {
    name: 'a reference cannot interrupt visible paragraph prose',
    body: '## 0.1.0\nNormal prose\n[migration]: /url',
    valid: true,
  },
  {
    name: 'balanced destination parentheses do not expose a title',
    body: '## 0.1.0\n[ref]: /path(a(b))\n "[migration]"',
    valid: false,
  },
  {
    name: 'blank lines invalidate continued titles',
    body: '## 0.1.0\n[ref]: /url\n "first\n\n[migration]"',
    valid: true,
  },
  {
    name: 'a malformed angle destination remains visible',
    body: '## 0.1.0\n[migration]: <unfinished',
    valid: true,
  },
  {
    name: 'a link-reference definition is not a visible operator flag',
    body: '## 0.1.0\n[migration]: https://example.invalid',
    valid: false,
  },
  {
    name: 'current release flag in the actual Changesets list format',
    body: '## 0.1.0\n\n### Minor Changes\n\n- abcdef0: New kernel\n  \n  [migration] Apply the new schema.\n\n## 0.0.0\nOld notes',
    valid: true,
  },
  {
    name: 'current release without migration changes',
    body: '## 0.1.0\nOnly prose.',
    paths: ['docs/ops/README.md'],
    valid: true,
  },
  {
    name: 'historical flag cannot cover the new release',
    body: '## 0.1.0\nNew schema.\n\n## 0.0.0\n[migration] An old schema.',
    valid: false,
  },
  { name: 'missing current version', body: '## 0.0.0\n[migration] An old schema.', valid: false },
  {
    name: 'duplicate current versions',
    body: '## 0.1.0\n[migration]\n## 0.1.0\nOther notes.',
    valid: false,
  },
  {
    name: 'current version must be newest',
    body: '## 0.2.0\nNext.\n## 0.1.0\n[migration]',
    valid: false,
  },
  {
    name: 'a prerelease heading is not the final version',
    body: '## 0.1.0-rc.1\n[migration]',
    valid: false,
  },
  {
    name: 'an HTML comment is not an operator flag',
    body: '## 0.1.0\n<!--\n[migration]\n-->',
    valid: false,
  },
  {
    name: 'fenced examples cannot grant migration approval',
    body: '## 0.1.0\n```md\n[migration]\n```',
    valid: false,
  },
  {
    name: 'a shorter nested fence does not expose its body',
    body: '## 0.1.0\n````md\n```\n[migration]\n````',
    valid: false,
  },
  {
    name: 'a different closing fence does not expose its body',
    body: '## 0.1.0\n~~~md\n```\n[migration]\n~~~',
    valid: false,
  },
  {
    name: 'indented code is not an operator flag',
    body: '## 0.1.0\n    [migration]',
    valid: false,
  },
  { name: 'an escaped token is not the flag', body: '## 0.1.0\n\\[migration]', valid: false },
  {
    name: 'visible inline code can print the operator flag',
    body: '## 0.1.0\n`[migration]` Apply it.',
    valid: true,
  },
  {
    name: 'flags after another root heading do not belong to the release',
    body: '## 0.1.0\nNotes\n# History\n[migration]',
    valid: false,
  },
  {
    name: 'CRLF and Changesets subsection headings remain supported',
    body: '# @iridium/server\r\n\r\n## 0.1.0\r\n### Minor Changes\r\n[migration]\r\n',
    valid: true,
  },
  {
    name: 'a quoted fake heading does not duplicate the release',
    body: '## 0.1.0\n~~~md\n## 0.1.0\n~~~\n[migration]',
    valid: true,
  },
  {
    name: 'migration registry changes need the flag too',
    body: '## 0.1.0\nRegistry changed.',
    paths: ['apps/server/src/migrations/index.ts'],
    valid: false,
  },
  {
    name: 'similar test paths do not pretend to be migrations',
    body: '## 0.1.0\nTests only.',
    paths: ['apps/server/test/migrations/example.ts', 'apps/server/migrations-old/example.ts'],
    valid: true,
  },
] as const;

function withHistory(
  options: {
    previousTag: boolean;
    change: 'add' | 'delete' | 'none';
    flag: boolean;
    secondParentTag?: boolean;
  },
  assertion: (repository: string) => void,
): void {
  const repository = mkdtempSync(join(tmpdir(), 'iridium-release-'));
  const git = (args: readonly string[]): void => {
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Release guard',
        '-c',
        'user.email=release-guard@example.invalid',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'tag.gpgsign=false',
        '-c',
        'core.autocrlf=false',
        '-c',
        `core.hooksPath=${join(repository, 'empty-hooks')}`,
        ...args,
      ],
      { cwd: repository, windowsHide: true, stdio: 'pipe' },
    );
  };
  const write = (path: string, value: string): void => {
    const file = join(repository, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, value);
  };
  const version = (value: string, current: string): void => {
    write('apps/server/package.json', JSON.stringify({ name: '@iridium/server', version: value }));
    write('docs/milestones/CURRENT', `${current}\n`);
  };
  try {
    git(['init', '--quiet', '--initial-branch=main']);
    version('0.0.0', 'M0');
    write('apps/server/migrations/0001_initial.ts', 'export const initial = true;\n');
    write(
      'apps/server/CHANGELOG.md',
      '# @iridium/server\n\n## 0.0.0\n[migration] Initial schema.\n',
    );
    git(['add', '--all']);
    git(['commit', '--quiet', '-m', 'Initial fixture']);
    git(['tag', '@iridium/server@0.0.0']);
    if (options.secondParentTag) git(['branch', 'side']);
    if (options.previousTag) git(['tag', 'v0.0.0']);
    version('0.1.0', 'M1');
    if (options.change === 'add')
      write('apps/server/migrations/0002_new.ts', 'export const next = true;\n');
    if (options.change === 'delete')
      rmSync(join(repository, 'apps/server/migrations/0001_initial.ts'));
    write(
      'apps/server/CHANGELOG.md',
      `# @iridium/server\n\n## 0.1.0\n${options.flag ? '[migration] ' : ''}New release.\n\n## 0.0.0\n[migration] Initial schema.\n`,
    );
    git(['add', '--all']);
    git(['commit', '--quiet', '-m', 'Current fixture']);
    if (options.secondParentTag) {
      git(['checkout', '--quiet', 'side']);
      write('side-note.md', 'Independent branch release.\n');
      git(['add', '--all']);
      git(['commit', '--quiet', '-m', 'Second-parent release']);
      git(['tag', 'v0.0.0']);
      git(['checkout', '--quiet', 'main']);
      git(['merge', '--no-ff', '--no-edit', '-m', 'Merge released branch', 'side']);
      git(['tag', 'v0.1.1']); // A current-commit alias must not become the previous release.
    }
    git(['tag', 'v0.1.0']);
    assertion(repository);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
}

describe('guards.release-policy.guard [area:release]', () => {
  it('selects every artifact at its owning milestone, including prerelease and 1.x tags', () => {
    const cases = [
      ['v0.0.0', '0.0.0', 'M0'],
      ['v0.1.0', '0.1.0', 'M1'],
      ['v0.2.0', '0.2.0', 'M2'],
      ['v0.3.0', '0.3.0', 'M3'],
      ['v0.4.0', '0.4.0', 'M4'],
      ['v0.5.0', '0.5.0', 'M5'],
      ['v0.6.0', '0.6.0', 'M6'],
      ['v0.7.0', '0.7.0', 'M7'],
      ['v0.8.0', '0.8.0', 'M8'],
      ['v0.8.0-rc.1', '0.8.0-rc.1', 'M8'],
      ['v1.0.0', '1.0.0', 'M8'],
      ['v1.3.2-beta.x', '1.3.2-beta.x', 'M8'],
    ];
    const server = ['verify', 'server_image'];
    const bridge = ['verify', 'server_image', 'bridge'];
    const desktop = ['verify', 'server_image', 'bridge', 'desktop', 'release_feed'];
    const all = ['verify', 'server_image', 'bridge', 'desktop', 'release_feed', 'drill'];
    expect(evaluate(SELECT_SCRIPT, cases)).toEqual(
      [[], server, server, bridge, bridge, desktop, desktop, desktop, all, all, all, all].map(
        (jobs) => ({ jobs }),
      ),
    );
  });

  it('refuses malformed tags and version or exited-milestone mismatches', () => {
    const cases = [
      ['@iridium/server@0.1.0', '0.1.0', 'M1'],
      ['v01.1.0', '01.1.0', 'M1'],
      ['v0.1.0-rc.01', '0.1.0-rc.01', 'M1'],
      ['v0.1.0+build', '0.1.0+build', 'M1'],
      ['v0.1.0', '0.2.0', 'M1'],
      ['v0.1.0', '0.1.0', 'M0'],
      ['v0.1.0', '0.1.0', 'M2'],
      ['v0.9.0', '0.9.0', 'M8'],
      ['v1.0.0', '1.0.0', 'M7'],
      ['v0.1.0', '0.1.0', 'M9'],
    ];
    expect(evaluate(SELECT_SCRIPT, cases)).toEqual(
      cases.map(() => ({ error: expect.any(String) })),
    );
  });

  it('publishes only immutable prerelease tags and adds stable major/minor aliases', () => {
    expect(evaluate(IMAGE_TAG_SCRIPT, ['0.1.0', '0.1.0-rc.1', '1.2.3', '1.2.3-beta.2'])).toEqual([
      [
        'ghcr.io/example/iridium-server:0.1.0',
        'ghcr.io/example/iridium-server:0.1',
        'ghcr.io/example/iridium-server:0',
      ],
      ['ghcr.io/example/iridium-server:0.1.0-rc.1'],
      [
        'ghcr.io/example/iridium-server:1.2.3',
        'ghcr.io/example/iridium-server:1.2',
        'ghcr.io/example/iridium-server:1',
      ],
      ['ghcr.io/example/iridium-server:1.2.3-beta.2'],
    ]);
  });

  it('refuses malformed image versions before producing a publishable tag set', () => {
    expect(evaluate(IMAGE_TAG_SCRIPT, ['01.2.3', '1.2.3+build', '1.2.3-rc.01'])).toEqual([
      { error: expect.any(String) },
      { error: expect.any(String) },
      { error: expect.any(String) },
    ]);
  });

  it('uses one lowercase image repository for tags and digest-based scans', () => {
    expect(
      evaluate(IMAGE_REPOSITORY_SCRIPT, [
        'ghcr.io/Mythikos/iridium-server',
        '',
        'one,two',
        'one two',
      ]),
    ).toEqual([
      {
        repository: 'ghcr.io/mythikos/iridium-server',
        tags: [
          'ghcr.io/mythikos/iridium-server:0.1.0',
          'ghcr.io/mythikos/iridium-server:0.1',
          'ghcr.io/mythikos/iridium-server:0',
        ],
      },
      { error: expect.any(String) },
      { error: expect.any(String) },
      { error: expect.any(String) },
    ]);
  });

  it.each(noteCases)('$name', (fixture) => {
    const paths = 'paths' in fixture ? fixture.paths : [migration];
    expect(evaluate(NOTES_SCRIPT, { changelog: fixture.body, paths })).toBe(fixture.valid);
  });

  it('wires the due-job selector while keeping successful M1 verification and image prerequisites', () => {
    expect(workflowIssues(WORKFLOW)).toEqual([]);
  });

  it.each([
    ['missing Chromium', "playwright-browsers: 'chromium'", "playwright-browsers: ''"],
    [
      'shell-only image tags',
      'tags: ${{ needs.release-plan.outputs.image_tags }}',
      'tags: iridium-server:latest',
    ],
    [
      'premature desktop',
      "if: needs.release-plan.outputs.desktop == 'true'",
      "if: needs.release-plan.outputs.server_image == 'true'",
    ],
    ['bypassed verification', 'needs: [release-plan, verify]', 'needs: [release-plan]'],
    ['disabled verification', "if: needs.release-plan.outputs.verify == 'true'", 'if: false'],
    [
      'wrong selector output',
      'desktop: ${{ steps.select.outputs.desktop }}',
      'desktop: ${{ steps.select.outputs.server_image }}',
    ],
    [
      'old whole-history grep',
      'run: node scripts/check-release.ts notes',
      "run: grep -q '[migration]' CHANGELOG.md",
    ],
    [
      'missing required engine',
      "mysql: ['mysql:8.4.11', 'mysql:9.7.2-oraclelinux9']",
      "mysql: ['mysql:8.4.11']",
    ],
    ['missing SBOM', 'sbom: true', 'sbom: false'],
  ])('detects workflow regression: %s', (_name, before, after) => {
    expect(WORKFLOW).toContain(before);
    expect(workflowIssues(WORKFLOW.replace(before, after))).not.toEqual([]);
  });

  it('rejects unrecognized job declarations instead of dropping them from the inventory', () => {
    expect(() =>
      workflowIssues(`${WORKFLOW}\n  "future-publish":\n    runs-on: ubuntu-latest\n`),
    ).toThrow('Unsupported release job declaration');
  });

  it('checks every initial migration when only per-package tags precede the first product release', () => {
    withHistory({ previousTag: false, change: 'add', flag: true }, (repository) => {
      expect(evaluate(INSPECT_SCRIPT, repository)).toMatchObject({
        previousTag: null,
        migrations: [
          'apps/server/migrations/0001_initial.ts',
          'apps/server/migrations/0002_new.ts',
        ],
        issues: [],
      });
    });
  });

  it('refuses both an old flag and an uncommitted replacement of the tagged changelog', () => {
    withHistory({ previousTag: true, change: 'add', flag: false }, (repository) => {
      writeFileSync(
        join(repository, 'apps/server/CHANGELOG.md'),
        '## 0.1.0\n[migration] Uncommitted.\n',
      );
      expect(evaluate(INSPECT_SCRIPT, repository)).toMatchObject({
        previousTag: 'v0.0.0',
        migrations: ['apps/server/migrations/0002_new.ts'],
        issues: [expect.stringContaining('## 0.1.0 needs a visible [migration]')],
      });
    });
  });

  it('does not demand a new migration flag for unchanged historical migrations', () => {
    withHistory({ previousTag: true, change: 'none', flag: false }, (repository) => {
      expect(evaluate(INSPECT_SCRIPT, repository)).toMatchObject({
        previousTag: 'v0.0.0',
        migrations: [],
        issues: [],
      });
    });
  });

  it('refuses a checkout that does not equal the named release tag', () => {
    withHistory({ previousTag: true, change: 'add', flag: true }, (repository) => {
      execFileSync(
        'git',
        ['-c', `core.hooksPath=${join(repository, 'empty-hooks')}`, 'checkout', '--quiet', 'HEAD^'],
        { cwd: repository, windowsHide: true, stdio: 'pipe' },
      );
      expect(evaluate(INSPECT_SCRIPT, repository)).toEqual({
        error: 'Checkout HEAD does not equal the tagged tree v0.1.0',
      });
    });
  });

  it('finds a release through the second merge parent and excludes current-commit aliases', () => {
    withHistory(
      { previousTag: false, secondParentTag: true, change: 'add', flag: false },
      (repository) => {
        expect(evaluate(INSPECT_SCRIPT, repository)).toMatchObject({
          previousTag: 'v0.0.0',
          migrations: ['apps/server/migrations/0002_new.ts'],
          issues: [expect.stringContaining('needs a visible [migration]')],
        });
      },
    );
  });

  it('includes a deleted migration in the release comparison', () => {
    withHistory({ previousTag: true, change: 'delete', flag: false }, (repository) => {
      expect(evaluate(INSPECT_SCRIPT, repository)).toMatchObject({
        previousTag: 'v0.0.0',
        migrations: ['apps/server/migrations/0001_initial.ts'],
        issues: [expect.stringContaining('needs a visible [migration]')],
      });
    });
  });
});
