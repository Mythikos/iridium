/**
 * `scripts/check-licenses.ts` — run by ``ci.yml › static › `License scan` `` on every pull request
 * and by ``release.yml › verify › `License scan against the tagged tree` `` before anything is
 * built or published.
 *
 * The rule is 10-testing-and-quality.md, "License and supply-chain scan" (decision D10-12, skeleton
 * A52): the production dependency closure of `apps/server`, `apps/web`, `apps/desktop` and
 * `packages/mcp-bridge` carries nothing outside the allowlist **MIT, Apache-2.0, BSD-2-Clause,
 * BSD-3-Clause, ISC, MPL-2.0, 0BSD, Unlicense, BlueOak-1.0.0**, and nothing matching the denylist **GPL-\*,
 * AGPL-\*, LGPL-\*, BUSL-\*, SSPL-\*, UNLICENSED, or a missing or unparseable licence**.
 * Dual-licensed packages pass if any branch is allowlisted. Exceptions live in
 * `scripts/license-exceptions.json` and the scan fails on an exception whose version range no
 * longer matches, so an exception cannot silently widen.
 *
 * ## One recorded divergence from the mechanism the section prints
 *
 * The section writes the closure as `pnpm licenses list --json --prod --filter …`. This script
 * walks the closure itself, from the four workspace manifests through pnpm's `node_modules` layout,
 * and reads each package's own `license` field. Three reasons, and the divergence is recorded here
 * rather than silently adopted:
 *
 *  - **No shell.** `pnpm` is the package manager, not a workspace dependency, so it cannot be
 *    resolved to a JavaScript entry point the way `scripts/lib/process.ts` resolves every pinned
 *    tool; spawning it means `pnpm.cmd` and `shell: true` on Windows, which is precisely the
 *    quoting asymmetry that module exists to keep out of this pipeline.
 *  - **Attribution.** `pnpm licenses list` reports a flat set of packages per licence. Walking the
 *    closure keeps the edge that reached each package, so a failure names *which* of the four
 *    workspaces depends on the offending package and by what path — which is the first thing the
 *    person fixing it needs.
 *  - **Nothing leaves the machine.** The walk reads committed manifests and the installed store.
 *    There is no registry call, so the scan behaves the same on a runner with no network egress.
 *
 * Correcting the printed mechanism is an edit due in that section.
 *
 * ## What the report is for
 *
 * The section says `release.yml` "attaches the resulting report next to the SBOM (syft) and
 * vulnerability scan (grype)". The report is written to `reports/licenses/licenses.json` — under
 * `reports/`, which is where every lane writes its evidence and which both workflows upload. It is
 * written on a pass and on a failure, because the pass is the artefact the release needs.
 */
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  EnvironmentError,
  finding,
  repoPath,
  runAsMain,
  type Check,
  type CheckResult,
  type Finding,
} from './lib/check.ts';
import { isDirectory, isFile } from './lib/files.ts';
import { arrayMember, isRecord, parseJson, stringMember } from './lib/json.ts';
import { CHECK_INPUTS, PRODUCTION_WORKSPACES, REPO_ROOT, REPORTS_ROOT } from './lib/paths.ts';
import { serializeJson } from './lib/write.ts';

// ---------------------------------------------------------------------------------------------
// The policy, exactly as 10-testing-and-quality.md states it
// ---------------------------------------------------------------------------------------------

/** Licences that pass. Compared case-insensitively; `+` and a `WITH` exception are stripped first. */
const ALLOWLIST: ReadonlySet<string> = new Set(
  [
    'MIT',
    'Apache-2.0',
    'BSD-2-Clause',
    'BSD-3-Clause',
    'ISC',
    'MPL-2.0',
    '0BSD',
    'Unlicense',
    // Added at M0 (2026-09-13): the Blue Oak Model License, a permissive notice licence carried by
    // glob 13 and its dependencies, which @fastify/static reaches (10-testing-and-quality.md).
    'BlueOak-1.0.0',
  ].map((id) => id.toLowerCase()),
);

/** Licence families that fail even if something else in the expression would have passed. */
const DENIED_PREFIXES: readonly string[] = ['gpl-', 'agpl-', 'lgpl-', 'busl-', 'sspl-'];

/** Exact spellings that fail. `UNLICENSED` is npm's "this package has no licence grant". */
const DENIED_EXACT: ReadonlySet<string> = new Set(['unlicensed', 'unlicense-not-granted']);

/** Whether one SPDX identifier is on the denylist. */
function isDenied(identifier: string): boolean {
  const id = identifier.toLowerCase();
  return DENIED_EXACT.has(id) || DENIED_PREFIXES.some((prefix) => id.startsWith(prefix));
}

/** Whether one SPDX identifier is on the allowlist. */
function isAllowed(identifier: string): boolean {
  return ALLOWLIST.has(identifier.toLowerCase());
}

// ---------------------------------------------------------------------------------------------
// SPDX expressions
// ---------------------------------------------------------------------------------------------

/**
 * The verdict on one SPDX expression, with the identifiers that produced it.
 *
 * `AND` requires every branch to pass, `OR` requires one — that is what "dual-licensed packages pass
 * if any branch is allowlisted" means when the expression nests. A denied identifier fails the whole
 * expression wherever it appears, including inside an `OR`: `MIT OR GPL-3.0-only` is a package a
 * site may use under MIT, but the denylist in this section is about what may enter the closure at
 * all, not about which grant we would rely on, so the conservative reading is the one implemented
 * and it is stated here rather than left to be discovered.
 */
interface Verdict {
  readonly ok: boolean;
  readonly reason: string;
}

type Token =
  | { readonly kind: 'id' | 'and' | 'or' | '('; readonly text: string }
  | {
      readonly kind: ')';
      readonly text: string;
    };

function tokenize(expression: string): Token[] | null {
  const tokens: Token[] = [];
  // SPDX identifiers are `[A-Za-z0-9.+-]`; `WITH <exception>` is collapsed onto the base identifier
  // below, so the exception name never reaches the allowlist comparison.
  const pattern = /\s*(\(|\)|[A-Za-z0-9.+-]+)/gy;
  let cursor = 0;
  while (cursor < expression.length) {
    pattern.lastIndex = cursor;
    const match = pattern.exec(expression);
    if (match === null) return null;
    cursor = pattern.lastIndex;
    const text = match[1] ?? '';
    if (text === '(') tokens.push({ kind: '(', text });
    else if (text === ')') tokens.push({ kind: ')', text });
    else if (/^and$/i.test(text)) tokens.push({ kind: 'and', text });
    else if (/^or$/i.test(text)) tokens.push({ kind: 'or', text });
    else if (/^with$/i.test(text)) {
      // `Apache-2.0 WITH LLVM-exception` — the grant is the base licence; the exception widens it.
      const previous = tokens.at(-1);
      if (previous === undefined || previous.kind !== 'id') return null;
      const exception = pattern.exec(expression);
      if (exception === null) return null;
      cursor = pattern.lastIndex;
    } else tokens.push({ kind: 'id', text });
  }
  return tokens.length === 0 ? null : tokens;
}

/** Recursive-descent over `expr := term (OR term)*`, `term := factor (AND factor)*`. */
function evaluate(tokens: readonly Token[]): Verdict | null {
  let index = 0;
  const identifiers: string[] = [];

  const factor = (): boolean | null => {
    const token = tokens[index];
    if (token === undefined) return null;
    if (token.kind === '(') {
      index += 1;
      const inner = expression();
      if (inner === null) return null;
      if (tokens[index]?.kind !== ')') return null;
      index += 1;
      return inner;
    }
    if (token.kind !== 'id') return null;
    index += 1;
    const identifier = token.text.replace(/\+$/, '');
    identifiers.push(identifier);
    if (isDenied(identifier)) return false;
    return isAllowed(identifier);
  };

  const term = (): boolean | null => {
    let value = factor();
    if (value === null) return null;
    while (tokens[index]?.kind === 'and') {
      index += 1;
      const right = factor();
      if (right === null) return null;
      value = value && right;
    }
    return value;
  };

  const expression = (): boolean | null => {
    let value = term();
    if (value === null) return null;
    while (tokens[index]?.kind === 'or') {
      index += 1;
      const right = term();
      if (right === null) return null;
      value = value || right;
    }
    return value;
  };

  const result = expression();
  if (result === null || index !== tokens.length) return null;
  const denied = identifiers.filter((id) => isDenied(id));
  if (denied.length > 0) {
    return { ok: false, reason: `${denied.join(', ')} is on the denylist` };
  }
  if (result) return { ok: true, reason: 'allowlisted' };
  const outside = identifiers.filter((id) => !isAllowed(id));
  return { ok: false, reason: `${outside.join(', ')} is outside the allowlist` };
}

/** Evaluate a package's declared licence. A missing or unparseable expression is a denial. */
export function judgeLicense(declared: string | null): Verdict {
  if (declared === null || declared.trim() === '') {
    return { ok: false, reason: 'the manifest declares no licence' };
  }
  const tokens = tokenize(declared);
  const verdict = tokens === null ? null : evaluate(tokens);
  if (verdict === null) {
    return { ok: false, reason: `"${declared}" is not a parseable SPDX expression` };
  }
  return verdict;
}

// ---------------------------------------------------------------------------------------------
// Semantic version ranges, for the exception file
// ---------------------------------------------------------------------------------------------

/**
 * The range grammar `scripts/license-exceptions.json` accepts.
 *
 * A deliberately small subset of npm's, because the whole purpose of the field is that a reviewer
 * can see at a glance which versions an exception covers, and because "the scan fails on an
 * exception whose version range no longer matches" only means something if the range is legible:
 *
 * ```
 * range      := alternative ("||" alternative)*
 * alternative:= comparator (" " comparator)*     — every comparator must hold
 * comparator := "*" | version | ("=" | ">" | ">=" | "<" | "<=") version
 * ```
 *
 * `^`, `~`, `x` wildcards and hyphen ranges are rejected with a message naming the grammar, rather
 * than approximated — an exception that covers more versions than its author believed is the exact
 * failure this field exists to prevent.
 */
interface Comparator {
  readonly operator: '=' | '>' | '>=' | '<' | '<=' | '*';
  readonly version: readonly number[];
  readonly prerelease: string;
}

function parseVersion(text: string): { core: number[]; prerelease: string } | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(text);
  if (match === null) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ?? '',
  };
}

function compareVersions(a: Comparator, b: Comparator): number {
  for (const [index, part] of a.version.entries()) {
    const other = b.version[index] ?? 0;
    if (part !== other) return part - other;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === '') return 1;
  if (b.prerelease === '') return -1;
  return a.prerelease.localeCompare(b.prerelease);
}

function parseComparator(text: string): Comparator | null {
  if (text === '*') return { operator: '*', version: [], prerelease: '' };
  const match = /^(>=|<=|>|<|=)?\s*(.+)$/.exec(text);
  if (match === null) return null;
  const parsed = parseVersion((match[2] ?? '').trim());
  if (parsed === null) return null;
  const operator = match[1];
  return {
    operator:
      operator === undefined || operator === '='
        ? '='
        : operator === '>'
          ? '>'
          : operator === '>='
            ? '>='
            : operator === '<'
              ? '<'
              : '<=',
    version: parsed.core,
    prerelease: parsed.prerelease,
  };
}

/** Whether `version` satisfies `range`, or `null` when the range is outside the grammar above. */
export function rangeMatches(range: string, version: string): boolean | null {
  const parsed = parseVersion(version);
  if (parsed === null) return null;
  const subject: Comparator = {
    operator: '=',
    version: parsed.core,
    prerelease: parsed.prerelease,
  };
  for (const alternative of range.split('||')) {
    const comparators = alternative
      .trim()
      .split(/\s+/)
      .filter((part) => part !== '');
    if (comparators.length === 0) return null;
    let holds = true;
    for (const text of comparators) {
      const comparator = parseComparator(text);
      if (comparator === null) return null;
      if (comparator.operator === '*') continue;
      const order = compareVersions(subject, comparator);
      const satisfied =
        comparator.operator === '='
          ? order === 0
          : comparator.operator === '>'
            ? order > 0
            : comparator.operator === '>='
              ? order >= 0
              : comparator.operator === '<'
                ? order < 0
                : order <= 0;
      if (!satisfied) holds = false;
    }
    if (holds) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// The closure walk
// ---------------------------------------------------------------------------------------------

/** One third-party package in the closure. */
interface ClosurePackage {
  readonly name: string;
  readonly version: string;
  readonly license: string | null;
  /** Repository-relative directory, so the report names a place on disk. */
  readonly directory: string;
  /** Every `<workspace> → … → <name>` path that reached it, sorted, deduplicated. */
  readonly reachedBy: readonly string[];
}

/** A dependency named by a manifest that no `node_modules` directory resolves. */
interface Unresolved {
  readonly name: string;
  readonly from: string;
  readonly optional: boolean;
}

function readManifest(directory: string): Record<string, unknown> | null {
  const path = join(directory, 'package.json');
  if (!isFile(path)) return null;
  const parsed = parseJson(readFileSync(path, 'utf8'));
  return isRecord(parsed) ? parsed : null;
}

function dependencyNames(manifest: Record<string, unknown>, key: string): string[] {
  const record = manifest[key];
  return isRecord(record) ? Object.keys(record).toSorted((a, b) => a.localeCompare(b)) : [];
}

/**
 * Node's own resolution, restricted to the repository: `<dir>/node_modules/<name>`, then every
 * parent's, up to the workspace root.
 *
 * pnpm's isolated layout gives every package in the virtual store its own `node_modules` holding a
 * link per declared dependency, so the first candidate resolves for almost every edge; the walk up
 * covers the hoisted entries at the repository root.
 */
function resolveDependency(from: string, name: string): string | null {
  let directory = from;
  for (;;) {
    const candidate = join(directory, 'node_modules', name);
    if (isFile(join(candidate, 'package.json'))) return realpathSync(candidate);
    const parent = dirname(directory);
    if (parent === directory || !directory.startsWith(REPO_ROOT)) return null;
    if (directory === REPO_ROOT) return null;
    directory = parent;
  }
}

/** Whether a resolved directory is a workspace package rather than an installed dependency. */
function isWorkspacePackage(directory: string): boolean {
  return !directory.split(/[/\\]/).includes('node_modules');
}

/** The legacy `licenses: [{type}]` array some very old packages still carry. */
function declaredLicense(manifest: Record<string, unknown>): string | null {
  const single = stringMember(manifest, 'license');
  if (single !== undefined) return single;
  const legacy = arrayMember(manifest, 'licenses');
  if (legacy !== undefined) {
    const types = legacy
      .map((entry) => stringMember(entry, 'type'))
      .filter((type) => type !== undefined);
    if (types.length > 0) return types.join(' OR ');
  }
  const nested = manifest['license'];
  // `license: { type, url }` is the other deprecated spelling.
  const type = stringMember(nested, 'type');
  return type ?? null;
}

interface Closure {
  readonly packages: readonly ClosurePackage[];
  readonly unresolved: readonly Unresolved[];
}

function walkClosure(): Closure {
  const found = new Map<string, { entry: ClosurePackage; reached: Set<string> }>();
  const unresolved: Unresolved[] = [];
  const seenEdges = new Map<string, Set<string>>();

  const visit = (directory: string, trail: readonly string[]): void => {
    const manifest = readManifest(directory);
    if (manifest === null) return;
    const name = stringMember(manifest, 'name') ?? repoPath(directory);
    const version = stringMember(manifest, 'version') ?? '0.0.0';
    const nextTrail = [...trail, name];

    if (!isWorkspacePackage(directory)) {
      const key = `${name}@${version}`;
      const existing = found.get(key);
      const reached = existing?.reached ?? new Set<string>();
      reached.add(trail.length === 0 ? name : nextTrail.join(' → '));
      if (existing === undefined) {
        found.set(key, {
          entry: {
            name,
            version,
            license: declaredLicense(manifest),
            directory: repoPath(directory),
            reachedBy: [],
          },
          reached,
        });
      }
    }

    for (const key of ['dependencies', 'optionalDependencies']) {
      for (const dependency of dependencyNames(manifest, key)) {
        const visited = seenEdges.get(directory) ?? new Set<string>();
        if (visited.has(dependency)) continue;
        visited.add(dependency);
        seenEdges.set(directory, visited);
        const resolved = resolveDependency(directory, dependency);
        if (resolved === null) {
          unresolved.push({
            name: dependency,
            from: repoPath(directory),
            optional: key === 'optionalDependencies',
          });
          continue;
        }
        visit(resolved, nextTrail);
      }
    }
  };

  for (const workspace of PRODUCTION_WORKSPACES) visit(realpathSync(workspace), []);

  const packages = [...found.values()]
    .map(({ entry, reached }) => ({
      name: entry.name,
      version: entry.version,
      license: entry.license,
      directory: entry.directory,
      reachedBy: [...reached].toSorted((a, b) => a.localeCompare(b)),
    }))
    .toSorted((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  return {
    packages,
    unresolved: unresolved.toSorted(
      (a, b) => a.from.localeCompare(b.from) || a.name.localeCompare(b.name),
    ),
  };
}

// ---------------------------------------------------------------------------------------------
// Exceptions
// ---------------------------------------------------------------------------------------------

/** One reviewed exception, with the five fields D10-12 requires. */
interface Exception {
  readonly index: number;
  readonly package: string | undefined;
  readonly versions: string | undefined;
  readonly license: string | undefined;
  readonly reason: string | undefined;
  readonly approver: string | undefined;
}

function readExceptions(): Exception[] {
  if (!isFile(CHECK_INPUTS.licenseExceptions)) {
    throw new EnvironmentError(
      `${repoPath(CHECK_INPUTS.licenseExceptions)} does not exist.\n` +
        'The scan reads it even when it is empty, because an absent exception file and an empty ' +
        'one are different claims.\n' +
        'Remedy: create it with `{ "exceptions": [] }`.',
    );
  }
  const parsed = parseJson(readFileSync(CHECK_INPUTS.licenseExceptions, 'utf8'));
  const entries = arrayMember(parsed, 'exceptions');
  if (entries === undefined) {
    throw new EnvironmentError(
      `${repoPath(CHECK_INPUTS.licenseExceptions)} carries no \`exceptions\` array.\n` +
        'Remedy: the file is `{ "exceptions": [ … ] }`; an empty list is the normal state.',
    );
  }
  return entries.map((entry, index) => ({
    index,
    package: stringMember(entry, 'package'),
    versions: stringMember(entry, 'versions'),
    license: stringMember(entry, 'license'),
    reason: stringMember(entry, 'reason'),
    approver: stringMember(entry, 'approver'),
  }));
}

// ---------------------------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------------------------

interface Judged {
  readonly entry: ClosurePackage;
  readonly verdict: Verdict;
  readonly exception: number | null;
}

function writeReport(judged: readonly Judged[], unresolved: readonly Unresolved[]): string {
  const directory = join(REPORTS_ROOT, 'licenses');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'licenses.json');
  writeFileSync(
    path,
    serializeJson({
      generatedBy: 'scripts/check-licenses.ts',
      rule: '10-testing-and-quality.md, "License and supply-chain scan" (D10-12, skeleton A52)',
      allowlist: [...ALLOWLIST].toSorted((a, b) => a.localeCompare(b)),
      deniedPrefixes: DENIED_PREFIXES,
      workspaces: PRODUCTION_WORKSPACES.map((workspace) => repoPath(workspace)),
      packages: judged.map(({ entry, verdict, exception }) => ({
        name: entry.name,
        version: entry.version,
        license: entry.license,
        verdict: verdict.ok ? 'allowed' : exception === null ? 'denied' : 'excepted',
        reason: verdict.reason,
        directory: entry.directory,
        reachedBy: entry.reachedBy,
      })),
      unresolved,
    }),
    'utf8',
  );
  return repoPath(path);
}

export const check: Check = {
  name: 'check-licenses',
  workflow: 'ci.yml › static › `License scan`, and release.yml › verify',
  owns: '10-testing-and-quality.md, "License and supply-chain scan" (D10-12)',
  run(): CheckResult {
    for (const workspace of PRODUCTION_WORKSPACES) {
      if (!isDirectory(join(workspace, 'node_modules'))) {
        throw new EnvironmentError(
          `${repoPath(workspace)}/node_modules does not exist, so there is no closure to walk.\n` +
            'Remedy: run `pnpm install --frozen-lockfile` before the scan, as every CI lane does.',
        );
      }
    }

    const exceptions = readExceptions();
    const { packages, unresolved } = walkClosure();
    const findings: Finding[] = [];

    // An exception whose range no longer matches is a failure in its own right, so the file cannot
    // keep an approval alive across a version it was never reviewed against.
    const used = new Set<number>();
    const judged: Judged[] = packages.map((entry) => {
      const verdict = judgeLicense(entry.license);
      if (verdict.ok) return { entry, verdict, exception: null };
      const applicable = exceptions.find(
        (exception) =>
          exception.package === entry.name &&
          exception.versions !== undefined &&
          rangeMatches(exception.versions, entry.version) === true,
      );
      if (applicable === undefined) {
        findings.push(
          finding(
            join(REPO_ROOT, entry.directory),
            `${entry.name}@${entry.version} declares ${entry.license ?? 'no licence'}: ${verdict.reason}. ` +
              `Reached by ${entry.reachedBy[0] ?? 'an unknown path'}.`,
            `remove the dependency, replace it with an allowlisted equivalent, or add a reviewed entry ` +
              `to ${repoPath(CHECK_INPUTS.licenseExceptions)} with a package, versions, license, reason and approver.`,
          ),
        );
        return { entry, verdict, exception: null };
      }
      used.add(applicable.index);
      return { entry, verdict, exception: applicable.index };
    });

    const installed = new Map<string, string[]>();
    for (const entry of packages) {
      installed.set(entry.name, [...(installed.get(entry.name) ?? []), entry.version]);
    }

    for (const exception of exceptions) {
      const where = CHECK_INPUTS.licenseExceptions;
      const label = `exceptions[${String(exception.index)}]`;
      const missing = (['package', 'versions', 'license', 'reason', 'approver'] as const).filter(
        (field) => exception[field] === undefined || exception[field].trim() === '',
      );
      if (missing.length > 0) {
        findings.push(
          finding(
            where,
            `${label} is missing ${missing.join(', ')}.`,
            'every exception carries a package, a versions range, the license it grants, a reason and ' +
              'an approver (D10-12); delete the entry if it is no longer needed.',
          ),
        );
        continue;
      }
      const versions = exception.versions ?? '';
      const name = exception.package ?? '';
      const present = installed.get(name);
      if (present === undefined) {
        findings.push(
          finding(
            where,
            `${label} excepts ${name}, which is not in the production closure any more.`,
            'delete the entry: an exception for a package nobody depends on can only hide a future ' +
              'reintroduction.',
          ),
        );
        continue;
      }
      const matched = present.filter((version) => rangeMatches(versions, version) === true);
      if (present.some((version) => rangeMatches(versions, version) === null)) {
        findings.push(
          finding(
            where,
            `${label} has the range "${versions}", which is outside the accepted grammar.`,
            'use exact versions or `>=`/`<`/`<=`/`>` comparators joined by spaces, with `||` between ' +
              'alternatives; `^`, `~` and `x` wildcards are rejected so a reviewer can see the covered set.',
          ),
        );
        continue;
      }
      if (matched.length === 0) {
        findings.push(
          finding(
            where,
            `${label} has the range "${versions}", which matches none of the installed ` +
              `${name} versions (${present.join(', ')}).`,
            're-review the exception against the installed version and widen the range deliberately, or ' +
              'delete it — a stale range is how an exception silently widens.',
          ),
        );
        continue;
      }
      if (!used.has(exception.index)) {
        findings.push(
          finding(
            where,
            `${label} excepts ${name}@${matched.join(', ')}, whose licence now passes on its own.`,
            'delete the entry: the exception is no longer doing anything and hides the next regression.',
          ),
        );
      }
    }

    for (const missing of unresolved) {
      if (missing.optional) continue;
      findings.push(
        finding(
          join(REPO_ROOT, missing.from, 'package.json'),
          `\`${missing.name}\` is declared as a production dependency but no node_modules resolves it.`,
          'run `pnpm install --frozen-lockfile`; if the dependency is genuinely gone, remove it from the ' +
            'manifest so the closure and the lockfile agree.',
        ),
      );
    }

    const reportPath = writeReport(judged, unresolved);
    const excepted = judged.filter((item) => item.exception !== null).length;
    const details = [
      `Closure walked from ${PRODUCTION_WORKSPACES.map((workspace) => repoPath(workspace)).join(', ')}.`,
      `Report written to ${reportPath}.`,
    ];
    if (excepted > 0) {
      details.push(
        `${String(excepted)} package(s) pass only through ${repoPath(CHECK_INPUTS.licenseExceptions)}.`,
      );
    }
    const skippedOptional = unresolved.filter((entry) => entry.optional);
    if (skippedOptional.length > 0) {
      details.push(
        `${String(skippedOptional.length)} optional dependency(ies) are not installed and were not weighed: ` +
          `${skippedOptional.map((entry) => entry.name).join(', ')}.`,
      );
    }

    return {
      summary:
        findings.length === 0
          ? `${String(packages.length)} third-party package(s) in the production closure; every licence is allowed.`
          : `${String(packages.length)} third-party package(s) in the production closure; the licence policy is broken.`,
      details,
      findings,
    };
  },
};

if (import.meta.main) await runAsMain(check);
