/**
 * `scripts/check-stryker-disables.ts` — the third of the four scripts ``ci.yml › static ›
 * `Exclusion hygiene` `` runs.
 *
 * The rule is 10-testing-and-quality.md, "Mutation":
 *
 * > A surviving mutant in `auth`, `authz`, `sanitize` or `persistence` is treated as a missing test,
 * > not as an acceptable survivor. `// Stryker disable` comments are allowed only with a reason on
 * > the same line and are counted by `scripts/check-stryker-disables.ts`, which fails if the count
 * > grows.
 *
 * Three checks, one per clause.
 *
 *  1. **Every disable carries a reason on the same line.** Stryker's own syntax is
 *     `// Stryker disable [next-line] <mutators> : <reason>`, so the reason is the text after the
 *     colon. A disable without one is rejected with the form to use.
 *  2. **No disable in the four paths where a survivor means a missing test.** Those are
 *     `apps/server/src/auth/**`, `apps/server/src/authz/**`, `apps/server/src/collab/persistence/**`
 *     and `packages/markdown/src/sanitize/**` — the section's `auth`, `authz`, `persistence` and
 *     `sanitize` resolved against Stryker's `mutate` globs. Silencing a mutant there is exactly the
 *     move the sentence forbids: the mutant is the missing test, and a comment is not a test.
 *  3. **The count does not grow.** The recorded number lives in
 *     `scripts/stryker-disable-budget.json` and is `0`. Raising it is a deliberate, reviewable edit
 *     in the same commit as the disable it admits, which is the whole mechanism: a disable that
 *     nobody had to argue for is a coverage hole nobody knows about.
 *
 * ## One thing the plan states as a rule and not as a file
 *
 * "Fails if the count grows" needs a committed number to grow *from*, and the section names none.
 * `scripts/stryker-disable-budget.json` is that number, placed in `scripts/` beside
 * `scripts/license-exceptions.json`, which is the one exclusion data file the same document does
 * give a path to. Recording the count as data rather than as a constant in this file is deliberate:
 * the number is a reviewed fact about the repository, and it should show up in a diff as one.
 *
 * ## Where it looks
 *
 * Every `.ts`/`.tsx` file under a package's or application's `src/` directory. That is a superset of
 * Stryker's `mutate` globs, on purpose: a `// Stryker disable` outside the mutated scope does
 * nothing, and a comment that does nothing is either a mistake or a file about to be added to the
 * scope — both worth seeing. Generated trees are excluded, since nobody writes a reason into a file
 * `pnpm gen` overwrites.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  EnvironmentError,
  finding,
  repoPath,
  runAsMain,
  type Check,
  type CheckResult,
  type Finding,
} from './lib/check.ts';
import { isDirectory, isFile, walkFiles } from './lib/files.ts';
import { isRecord, parseJson } from './lib/json.ts';
import { CHECK_INPUTS, REPO_ROOT } from './lib/paths.ts';

/**
 * The four scopes of "a surviving mutant is a missing test", as repository-relative prefixes.
 *
 * They are prefixes rather than globs because each names a directory in Stryker's `mutate` list and
 * the rule is about the directory, not about a file-name shape.
 */
const NO_DISABLE_PREFIXES: readonly string[] = [
  'apps/server/src/auth/',
  'apps/server/src/authz/',
  'apps/server/src/collab/persistence/',
  'packages/markdown/src/sanitize/',
];

/** `// Stryker disable …` and `/* Stryker disable … *\/`, with whatever follows on the line. */
const DISABLE_PATTERN = /\/\/\s*Stryker\s+disable\b(.*)$|\/\*\s*Stryker\s+disable\b([^*]*)\*\//i;

/**
 * Every `<app|package>/src` directory that exists.
 *
 * Enumerated from the workspace layout rather than listed, so a package added at a later milestone
 * is scanned because its `src/` exists and for no other reason — a check whose scope has to be
 * edited alongside every new package is a check that quietly stops covering things.
 */
function sourceRoots(): string[] {
  const roots: string[] = [];
  for (const group of ['apps', 'packages']) {
    const groupRoot = join(REPO_ROOT, group);
    if (!isDirectory(groupRoot)) continue;
    for (const member of readdirSync(groupRoot)) {
      const source = join(groupRoot, member, 'src');
      if (isDirectory(source)) roots.push(source);
    }
  }
  return roots.toSorted((a, b) => a.localeCompare(b));
}

/** The recorded number of disables the repository is allowed to carry. */
function readCeiling(): number {
  if (!isFile(CHECK_INPUTS.strykerDisableBudget)) {
    throw new EnvironmentError(
      `${repoPath(CHECK_INPUTS.strykerDisableBudget)} does not exist, so there is no recorded count ` +
        'for the disables to be compared against.\n' +
        'Remedy: create it with `{ "ceiling": 0 }`.',
    );
  }
  const parsed = parseJson(readFileSync(CHECK_INPUTS.strykerDisableBudget, 'utf8'));
  const ceiling = isRecord(parsed) ? parsed['ceiling'] : undefined;
  if (typeof ceiling !== 'number' || !Number.isInteger(ceiling) || ceiling < 0) {
    throw new EnvironmentError(
      `${repoPath(CHECK_INPUTS.strykerDisableBudget)} carries no integer \`ceiling\`.\n` +
        'Remedy: the file is `{ "ceiling": <the recorded number of disables> }`.',
    );
  }
  return ceiling;
}

/** One `// Stryker disable` comment. */
interface Disable {
  readonly path: string;
  readonly line: number;
  readonly text: string;
  readonly reason: string;
}

function collect(): Disable[] {
  const found: Disable[] = [];
  for (const root of sourceRoots()) {
    for (const file of walkFiles(root)) {
      if (!/\.tsx?$/.test(file.path)) continue;
      if (repoPath(file.path).includes('/generated/')) continue;
      const lines = readFileSync(file.path, 'utf8').replaceAll('\r\n', '\n').split('\n');
      for (const [index, line] of lines.entries()) {
        const match = DISABLE_PATTERN.exec(line);
        if (match === null) continue;
        const tail = (match[1] ?? match[2] ?? '').trim();
        const colon = tail.indexOf(':');
        found.push({
          path: file.path,
          line: index + 1,
          text: line.trim(),
          reason: colon === -1 ? '' : tail.slice(colon + 1).trim(),
        });
      }
    }
  }
  return found;
}

export const check: Check = {
  name: 'check-stryker-disables',
  workflow: 'ci.yml › static › `Exclusion hygiene`',
  owns: '10-testing-and-quality.md, "Mutation"',
  run(): CheckResult {
    const ceiling = readCeiling();
    const disables = collect();
    const findings: Finding[] = [];

    for (const disable of disables) {
      const relative = repoPath(disable.path);
      if (disable.reason === '') {
        findings.push(
          finding(
            disable.path,
            `\`${disable.text}\` carries no reason.`,
            "write the reason on the same line in Stryker's own form — " +
              '`// Stryker disable next-line <mutators> : <why this mutant cannot be killed>`.',
            disable.line,
          ),
        );
      }
      const banned = NO_DISABLE_PREFIXES.find((prefix) => relative.startsWith(prefix));
      if (banned !== undefined) {
        findings.push(
          finding(
            disable.path,
            `a Stryker disable inside \`${banned}\`, where a surviving mutant is treated as a missing ` +
              'test rather than an acceptable survivor.',
            'write the test that kills the mutant. Nothing in auth, authz, persistence or sanitize is ' +
              'silenced with a comment, whatever the reason says.',
            disable.line,
          ),
        );
      }
    }

    if (disables.length > ceiling) {
      findings.push(
        finding(
          CHECK_INPUTS.strykerDisableBudget,
          `${String(disables.length)} Stryker disable(s) in the tree, over the recorded count of ` +
            `${String(ceiling)}.`,
          'kill the mutant instead of disabling it; if the disable is genuinely right, raise `ceiling` ' +
            'in this file in the same commit, so the count grows where a reviewer can see it.',
        ),
      );
    }

    const details = [
      `Scanned ${String(sourceRoots().length)} \`src/\` tree(s); recorded count is ${String(ceiling)}.`,
    ];
    if (disables.length < ceiling) {
      details.push(
        `Only ${String(disables.length)} disable(s) remain — lower \`ceiling\` to ` +
          `${String(disables.length)} so the budget cannot drift back up unnoticed.`,
      );
    }

    return {
      summary:
        findings.length === 0
          ? `${String(disables.length)} Stryker disable(s), each with a reason and none in a ` +
            'missing-test path.'
          : `${String(disables.length)} Stryker disable(s); the mutation exclusion rule is broken.`,
      details,
      findings,
    };
  },
};

if (import.meta.main) await runAsMain(check);
