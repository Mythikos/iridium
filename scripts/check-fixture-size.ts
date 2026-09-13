/**
 * `scripts/check-fixture-size.ts` — the second of the four scripts ``ci.yml › static ›
 * `Exclusion hygiene` `` runs.
 *
 * The rule is 10-testing-and-quality.md, "Test data and fixtures policy", rule 5 (decision D10-17):
 * *"Total committed fixture weight is capped at 5 MB and checked by `scripts/check-fixture-size.ts`;
 * no git LFS."*
 *
 * Both halves of that sentence are enforced here, because they are one rule: the cap keeps the
 * repository small and reviewable, and LFS is the escape hatch that would make the cap meaningless
 * while leaving the clone just as expensive. A pointer file weighs 130 bytes and a 400 MB corpus
 * still arrives on every checkout.
 *
 * ## What is weighed
 *
 * The two committed fixture trees: `packages/testkit/src/fixtures` and `apps/server/test/fixtures`.
 * Those are the two directories the repository excludes from `oxfmt` and `oxlint` as "pipeline test
 * data, never code" (`.oxfmtrc.jsonc`, `oxlint.config.ts`), so they are the two the policy is about.
 * `apps/server/test/fixtures` does not exist yet; an absent tree weighs nothing and is reported as
 * such rather than treated as an error, because the policy caps what is committed and nothing is.
 *
 * Generated corpora are **not** weighed and must never appear here: rule 4 puts the 10 000-node
 * tree, the 5 000-note corpus, the 500 MB export fixture and the 1 MB note behind a seeded generator
 * precisely so they are not committed. A file large enough to matter to this cap is nearly always
 * one of those, checked in by mistake, which is why the failure lists the heaviest files by name.
 *
 * `KB` and `MB` are 1024-based here, as they are in `scripts/check-bundle-budget.ts`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  finding,
  repoPath,
  runAsMain,
  type Check,
  type CheckResult,
  type Finding,
} from './lib/check.ts';
import { isDirectory, isFile, walkFiles, type FoundFile } from './lib/files.ts';
import { FIXTURE_ROOTS, REPO_ROOT } from './lib/paths.ts';

/** Rule 5's cap: 5 MB across every committed fixture tree, not per tree. */
const CAP_BYTES = 5 * 1024 * 1024;

/** How many of the heaviest files a failure names, so the fix is obvious without a second run. */
const HEAVIEST_LISTED = 10;

/** The first bytes of a git-lfs pointer file. */
const LFS_POINTER = 'version https://git-lfs.github.com/spec/v1';

function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function kilobytes(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/** Whether a file's opening bytes are an LFS pointer rather than its content. */
function isLfsPointer(file: FoundFile): boolean {
  // A pointer is a small text file; reading the head of a large binary would be pointless and slow.
  if (file.bytes > 1024) return false;
  try {
    return readFileSync(file.path, 'utf8').startsWith(LFS_POINTER);
  } catch {
    return false;
  }
}

/** Every `.gitattributes` whose rules could put a fixture behind LFS. */
function lfsAttributeFiles(): { path: string; line: number; text: string }[] {
  const candidates = [join(REPO_ROOT, '.gitattributes')];
  for (const root of FIXTURE_ROOTS) {
    for (const file of walkFiles(root)) {
      if (file.path.endsWith('.gitattributes')) candidates.push(file.path);
    }
  }
  const found: { path: string; line: number; text: string }[] = [];
  for (const path of candidates) {
    if (!isFile(path)) continue;
    const lines = readFileSync(path, 'utf8').replaceAll('\r\n', '\n').split('\n');
    for (const [index, line] of lines.entries()) {
      if (line.trimStart().startsWith('#')) continue;
      if (line.includes('filter=lfs')) found.push({ path, line: index + 1, text: line.trim() });
    }
  }
  return found;
}

export const check: Check = {
  name: 'check-fixture-size',
  workflow: 'ci.yml › static › `Exclusion hygiene`',
  owns: '10-testing-and-quality.md, "Test data and fixtures policy" rule 5 (D10-17)',
  run(): CheckResult {
    const findings: Finding[] = [];
    const details: string[] = [];
    const weighed: FoundFile[] = [];

    for (const root of FIXTURE_ROOTS) {
      if (!isDirectory(root)) {
        details.push(`${repoPath(root)}: absent, nothing committed.`);
        continue;
      }
      const files = walkFiles(root);
      const bytes = files.reduce((sum, file) => sum + file.bytes, 0);
      weighed.push(...files);
      details.push(
        `${repoPath(root)}: ${megabytes(bytes)} across ${String(files.length)} file(s).`,
      );
    }

    const total = weighed.reduce((sum, file) => sum + file.bytes, 0);
    details.push(`Total committed fixture weight: ${megabytes(total)} of ${megabytes(CAP_BYTES)}.`);

    if (total > CAP_BYTES) {
      const heaviest = weighed
        .toSorted((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path))
        .slice(0, HEAVIEST_LISTED);
      findings.push(
        finding(
          FIXTURE_ROOTS[0] ?? REPO_ROOT,
          `committed fixtures weigh ${megabytes(total)}, over the ${megabytes(CAP_BYTES)} cap by ` +
            `${megabytes(total - CAP_BYTES)}. The heaviest are: ` +
            heaviest.map((file) => `${repoPath(file.path)} (${kilobytes(file.bytes)})`).join(', ') +
            '.',
          'move the corpus behind the seeded generator in `packages/testkit/src/fixtures/generate.ts` ' +
            '(rule 4) instead of committing it; the cap is not raised to admit a large fixture.',
        ),
      );
    }

    for (const file of weighed) {
      if (!isLfsPointer(file)) continue;
      findings.push(
        finding(
          file.path,
          'this fixture is a git-lfs pointer, not its content.',
          'commit the file itself if it fits under the cap, or generate it from a seed (rule 4); ' +
            'rule 5 is "no git LFS", because a pointer keeps the clone expensive while hiding the weight.',
        ),
      );
    }

    for (const attribute of lfsAttributeFiles()) {
      findings.push(
        finding(
          attribute.path,
          `git-lfs is configured here: \`${attribute.text}\`.`,
          'remove the filter; rule 5 forbids LFS outright, so a fixture either fits under the cap or ' +
            'is generated from a printed seed.',
          attribute.line,
        ),
      );
    }

    return {
      summary:
        findings.length === 0
          ? `${String(weighed.length)} committed fixture file(s) weigh ${megabytes(total)}, inside the ` +
            `${megabytes(CAP_BYTES)} cap.`
          : `${String(weighed.length)} committed fixture file(s) weigh ${megabytes(total)}; the fixture ` +
            'policy is broken.',
      details,
      findings,
    };
  },
};

if (import.meta.main) await runAsMain(check);
