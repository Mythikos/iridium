/** Tagged-tree release selection and operator migration notes; no release artifacts are written. */
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

import { EnvironmentError, runAsMain, type Check, type CheckResult } from './lib/check.ts';
import { parseJson, stringMember } from './lib/json.ts';
import { REPO_ROOT } from './lib/paths.ts';
import {
  MIGRATION_ROOTS,
  productVersion,
  releaseNoteIssues,
  releaseImageTags,
  ReleasePolicyError,
  selectRelease,
  type ReleasePlan,
} from './lib/release-policy.ts';

interface ReleaseInspection {
  readonly commit: string;
  readonly plan: ReleasePlan;
  readonly previousTag: string | null;
  readonly migrations: readonly string[];
  readonly issues: readonly string[];
}

function git(repository: string, args: readonly string[]): string {
  try {
    return execFileSync('git', [...args], {
      cwd: repository,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    throw new EnvironmentError(
      `Cannot read tagged release inputs with git ${args.join(' ')}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function previousProductTag(repository: string, commit: string): string | null {
  const tags = git(repository, ['tag', '--merged', commit, '--list', 'v*'])
    .split(/\r?\n/)
    .filter((tag) => productVersion(tag) !== null)
    .filter(
      (tag) =>
        git(repository, ['rev-parse', '--verify', `refs/tags/${tag}^{commit}`]).trim() !== commit,
    );
  if (tags.length === 0) return null;
  return git(repository, [
    'describe',
    '--tags',
    '--abbrev=0',
    ...tags.map((tag) => `--match=${tag}`),
    commit,
  ]).trim();
}

/** Inspect the exact tagged inputs; working-tree edits cannot substitute for release artifacts. */
export function inspectRelease(repository: string, tag: string): ReleaseInspection {
  if (productVersion(tag) === null)
    throw new ReleasePolicyError(`Invalid product release tag: ${tag}`);
  const commit = git(repository, ['rev-parse', '--verify', `refs/tags/${tag}^{commit}`]).trim();
  if (git(repository, ['rev-parse', '--verify', 'HEAD']).trim() !== commit) {
    throw new ReleasePolicyError(`Checkout HEAD does not equal the tagged tree ${tag}`);
  }
  const manifest = parseJson(git(repository, ['show', `${commit}:apps/server/package.json`]));
  const version = stringMember(manifest, 'version');
  if (stringMember(manifest, 'name') !== '@iridium/server' || version === undefined) {
    throw new ReleasePolicyError(
      'The tagged apps/server/package.json is not the versioned server package',
    );
  }
  const current = git(repository, ['show', `${commit}:docs/milestones/CURRENT`]).trim();
  const plan = selectRelease(tag, version, current);
  if (!plan.jobs.verify) return { commit, plan, previousTag: null, migrations: [], issues: [] };
  const previousTag = previousProductTag(repository, commit);
  const paths =
    previousTag === null
      ? git(repository, ['ls-tree', '-r', '--name-only', '-z', commit, '--', ...MIGRATION_ROOTS])
      : git(repository, [
          'diff',
          '--name-only',
          '-z',
          '--no-renames',
          '--no-ext-diff',
          `refs/tags/${previousTag}^{commit}`,
          commit,
          '--',
          ...MIGRATION_ROOTS,
        ]);
  const migrations = paths
    .split('\0')
    .filter((path) => path.length > 0)
    .toSorted();
  const changelog = git(repository, ['show', `${commit}:apps/server/CHANGELOG.md`]);
  return {
    commit,
    plan,
    previousTag,
    migrations,
    issues: releaseNoteIssues(changelog, version, migrations),
  };
}

const check: Check = {
  name: 'check-release',
  workflow: 'release.yml > release-plan and verify',
  owns: '12-milestones.md D12-1/D12-2; 11-operations-and-deployment.md OPS-29',
  run(argv): CheckResult {
    const mode = argv[0];
    if (argv.length !== 1 || (mode !== 'plan' && mode !== 'notes')) {
      throw new EnvironmentError('Usage: node scripts/check-release.ts plan|notes');
    }
    const tag = process.env['GITHUB_REF_NAME'];
    if (tag === undefined)
      throw new EnvironmentError('GITHUB_REF_NAME must identify the product tag');
    try {
      const inspected = inspectRelease(REPO_ROOT, tag);
      if (inspected.issues.length > 0) {
        return {
          summary: `Operator notes refused for ${tag}`,
          findings: inspected.issues.map((problem) => ({
            file: 'apps/server/CHANGELOG.md',
            problem,
            remedy:
              "Include the operator flag in this version's server changeset and regenerate its changelog before tagging.",
          })),
        };
      }
      if (mode === 'plan') {
        const output = process.env['GITHUB_OUTPUT'];
        if (output === undefined)
          throw new EnvironmentError('GITHUB_OUTPUT is required in plan mode');
        const repository = process.env['IMAGE_NAME'];
        if (repository === undefined)
          throw new EnvironmentError('IMAGE_NAME is required in plan mode');
        const values = {
          version: inspected.plan.version,
          milestone: inspected.plan.milestone,
          image_tags: releaseImageTags(inspected.plan.version, repository).join(','),
          ...inspected.plan.jobs,
        };
        appendFileSync(
          output,
          Object.entries(values)
            .map(([key, value]) => `${key}=${String(value)}\n`)
            .join(''),
        );
      }
      return {
        summary: `${tag} at ${inspected.commit}: ${inspected.plan.milestone} release policy verified`,
        details: inspected.plan.jobs.verify
          ? [
              `Previous product tag: ${inspected.previousTag ?? '(none; all migrations in the initial release are checked)'}`,
              `Changed migration files: ${String(inspected.migrations.length)}`,
              `Jobs: ${JSON.stringify(inspected.plan.jobs)}`,
            ]
          : ['M0 publishes no artifacts; release-note validation is not due.'],
      };
    } catch (error) {
      if (!(error instanceof ReleasePolicyError)) throw error;
      return {
        summary: `Release selection refused for ${tag}`,
        findings: [
          {
            file: '.github/workflows/release.yml',
            problem: error.message,
            remedy:
              'Tag the exited milestone tree after Changesets has set the matching server version.',
          },
        ],
      };
    }
  },
};

if (import.meta.main) await runAsMain(check);
