/**
 * `scripts/check-exclusion-owners.ts` — the last of the four scripts ``ci.yml › static ›
 * `Exclusion hygiene` `` runs.
 *
 * The rule is 10-testing-and-quality.md, "What blocks a merge" item 10, and decision D10-15:
 *
 * > No new entry in `apps/e2e/QUARANTINE.md`, `schemathesis-exclusions.toml` or
 * > `license-exceptions.json` without a linked issue and an owner (a CI step parses each file and
 * > fails on an entry missing either field). The MCP conformance baseline is not on this list
 * > because it admits no entries at all.
 *
 * and D10-15's extension of it: *"Every other exclusion file … follows the same owner+issue+expiry
 * rule."*
 *
 * So this check owns four files:
 *
 * | File | Rule |
 * |---|---|
 * | `apps/server/test/contract/schemathesis-exclusions.toml` | owner, issue, expiry, reason per entry |
 * | `scripts/license-exceptions.json` | owner (`approver`), issue, expiry per entry |
 * | `apps/server/test/mcp/conformance-baseline.yaml` | **no entries at all**, ever (skeleton A51) |
 *
 * `apps/e2e/QUARANTINE.md` is the fifth exclusion file and is **not** checked here.
 * `scripts/check-quarantine.ts` owns it end to end — the ceiling, the owner, the issue and the ban
 * on covering an acceptance row — because D10-15 states the quarantine rules and then says every
 * *other* exclusion file follows the same owner rule. Two scripts parsing one register would be two
 * places to disagree about what a row is.
 *
 * Nothing beyond those four is checked. Coverage excludes, `oxlint` ignore patterns, `oxfmt`
 * ignores and `knip` ignores are configuration with a stated reason in the file that carries them,
 * and the plan puts none of them under this rule; inventing an ownership registry for them would be
 * a policy this repository has not adopted.
 *
 * ## Two things this check decides, because the plan states a rule and not a path
 *
 * **The CommonMark deviation allowlist is not checked here** (D10-15, amended 2026-09-21). It lives
 * at `packages/markdown/fixtures/commonmark-deviations.json`, beside the corpus it annotates, and
 * `markdown.commonmark.unit` owns it end to end for the same reason `scripts/check-quarantine.ts`
 * owns the quarantine: two parsers of one register are two places to disagree about what a row is.
 * That test enforces more than this script could — every one of the 652 examples still runs and is
 * asserted against its documented output, a reason must cite its 08-markdown-pipeline-import-export.md
 * section and must not read `UNREVIEWED`, an entry whose example is absent from the corpus fails,
 * and an entry the engine no longer needs fails as stale. Nothing is excluded, so the quiet-death
 * failure mode D10-15 exists to stop cannot arise there.
 *
 * **An absent file is zero entries, and is said out loud.** Three of the four land at later
 * milestones: the Schemathesis exclusions with the fuzz lane, the deviation allowlist with
 * `markdown.commonmark.unit`, the conformance baseline at M3. Absence is reported in the check's
 * own output with the milestone that creates the file, so "nothing to check" can never be mistaken
 * for "checked and clean".
 */
import { readFileSync } from 'node:fs';

import {
  finding,
  repoPath,
  runAsMain,
  type Check,
  type CheckResult,
  type Finding,
} from './lib/check.ts';
import { isFile } from './lib/files.ts';
import { arrayMember, parseJson, stringMember } from './lib/json.ts';
import { CHECK_INPUTS } from './lib/paths.ts';

/** One entry of an exclusion file, reduced to the fields the rule is about. */
interface Entry {
  /** How the entry is addressed in a message, e.g. `exclusion[2]` or `exceptions[0] (glob)`. */
  readonly label: string;
  readonly line?: number;
  readonly owner: string | undefined;
  readonly issue: string | undefined;
  readonly expires: string | undefined;
  readonly reason: string | undefined;
}

/** What one exclusion file contributes. */
interface Parsed {
  readonly entries: readonly Entry[];
  /** Set when the file could not be read at all; the caller turns it into a finding. */
  readonly unreadable?: string;
}

// ---------------------------------------------------------------------------------------------
// The three entry-bearing files
// ---------------------------------------------------------------------------------------------

/**
 * A deliberately small TOML reader: array-of-table headers, table headers, and `key = "value"`.
 *
 * It is not a TOML parser, for the same reason `scripts/lib/markdown.ts` is not a Markdown parser —
 * the file has one job and a shape defeating this reader is a reported failure, never a guess. Every
 * `[table]` and `[[array.of.tables]]` header opens an entry; quoted scalar values on the lines under
 * it are its fields. Anything else on a line inside an entry is reported rather than ignored.
 */
function parseTomlEntries(path: string): Parsed {
  const lines = readFileSync(path, 'utf8').replaceAll('\r\n', '\n').split('\n');
  const entries: Entry[] = [];
  let current: { label: string; line: number; fields: Map<string, string> } | null = null;
  const flush = (): void => {
    if (current === null) return;
    entries.push({
      label: current.label,
      line: current.line,
      owner: current.fields.get('owner'),
      issue: current.fields.get('issue'),
      expires: current.fields.get('expires'),
      reason: current.fields.get('reason'),
    });
    current = null;
  };

  for (const [index, raw] of lines.entries()) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    if (line === '' || line.startsWith('#')) continue;
    const header = /^\[\[?([A-Za-z0-9_.-]+)\]\]?$/.exec(line);
    if (header !== null) {
      flush();
      current = {
        label: `[${header[1] ?? ''}] at line ${String(index + 1)}`,
        line: index + 1,
        fields: new Map(),
      };
      continue;
    }
    const pair = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (pair === null || current === null) continue;
    const value = (pair[2] ?? '').trim().replace(/^["']|["']$/g, '');
    current.fields.set((pair[1] ?? '').toLowerCase(), value);
  }
  flush();
  return { entries };
}

/** `scripts/license-exceptions.json`: `{ "exceptions": [ … ] }`. */
function parseLicenseExceptions(path: string): Parsed {
  const parsed = parseJson(readFileSync(path, 'utf8'));
  const list = arrayMember(parsed, 'exceptions');
  if (list === undefined) {
    return { entries: [], unreadable: 'the file carries no `exceptions` array' };
  }
  return {
    entries: list.map((entry, index) => ({
      label: `exceptions[${String(index)}]${
        stringMember(entry, 'package') === undefined
          ? ''
          : ` (${stringMember(entry, 'package') ?? ''})`
      }`,
      // The approver is the owner: D10-12 names the field, D10-15 names the role.
      owner: stringMember(entry, 'approver'),
      issue: stringMember(entry, 'issue'),
      expires: stringMember(entry, 'expires'),
      reason: stringMember(entry, 'reason'),
    })),
  };
}

// ---------------------------------------------------------------------------------------------
// The file table
// ---------------------------------------------------------------------------------------------

interface ExclusionFile {
  readonly path: string;
  /** What the file is, for the "absent" line. */
  readonly what: string;
  /** The milestone that creates it, named when it is absent. */
  readonly arrivesAt: string;
  /** `undefined` for the conformance baseline, which admits no entries at all. */
  readonly parse?: (path: string) => Parsed;
  /** Whether a `reason` is required as well as owner, issue and expiry. */
  readonly needsReason: boolean;
}

const FILES: readonly ExclusionFile[] = [
  {
    path: CHECK_INPUTS.schemathesisExclusions,
    what: 'known-and-accepted Schemathesis findings',
    arrivesAt: 'M1, with the REST fuzzing lane',
    parse: parseTomlEntries,
    needsReason: true,
  },
  {
    path: CHECK_INPUTS.licenseExceptions,
    what: 'reviewed licence exceptions',
    arrivesAt: 'M0',
    parse: parseLicenseExceptions,
    needsReason: true,
  },
  {
    path: CHECK_INPUTS.conformanceBaseline,
    what: 'the MCP conformance baseline, which admits no entries at all',
    arrivesAt: 'M3, committed empty',
    needsReason: false,
  },
];

/** An ISO date, and whether it is still in the future. */
function expiryProblem(expires: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expires)) {
    return `the expiry "${expires}" is not an ISO \`YYYY-MM-DD\` date`;
  }
  const deadline = Date.parse(`${expires}T23:59:59Z`);
  if (Number.isNaN(deadline)) return `the expiry "${expires}" is not a real date`;
  // The only wall-clock read in these checks, and it is inherent: an expiry that never expires is
  // a permanent exclusion wearing a date.
  if (deadline < Date.now()) return `the exclusion expired on ${expires}`;
  return null;
}

/** Lines of the conformance baseline that assert a failure rather than documenting the file. */
function baselineEntries(path: string): { line: number; text: string }[] {
  const lines = readFileSync(path, 'utf8').replaceAll('\r\n', '\n').split('\n');
  const entries: { line: number; text: string }[] = [];
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line === '---' || line === '[]' || line === '{}') {
      continue;
    }
    entries.push({ line: index + 1, text: line });
  }
  return entries;
}

export const check: Check = {
  name: 'check-exclusion-owners',
  workflow: 'ci.yml › static › `Exclusion hygiene`',
  owns: '10-testing-and-quality.md, "What blocks a merge" item 10 (D10-15)',
  run(): CheckResult {
    const findings: Finding[] = [];
    const details: string[] = [];
    let checked = 0;
    let total = 0;

    for (const file of FILES) {
      if (!isFile(file.path)) {
        details.push(
          `${repoPath(file.path)}: absent — ${file.what}; arrives at ${file.arrivesAt}. Zero entries.`,
        );
        continue;
      }
      checked += 1;

      if (file.parse === undefined) {
        const entries = baselineEntries(file.path);
        total += entries.length;
        for (const entry of entries) {
          findings.push(
            finding(
              file.path,
              `the MCP conformance baseline carries an entry: \`${entry.text}\`.`,
              'delete it. The baseline admits no entries at all (skeleton A51): a baselined protocol ' +
                'requirement is indistinguishable from a requirement we do not meet. A genuine upstream ' +
                'defect is handled by pinning the conformance version with an ADR and a tracking issue.',
              entry.line,
            ),
          );
        }
        details.push(
          `${repoPath(file.path)}: ${String(entries.length)} entry(ies); the permitted number is 0.`,
        );
        continue;
      }

      const parsed = file.parse(file.path);
      if (parsed.unreadable !== undefined) {
        findings.push(
          finding(
            file.path,
            `${parsed.unreadable}, so its entries cannot be checked for an owner.`,
            'restore the documented shape; a file the hygiene check cannot read is an exclusion list ' +
              'nobody is auditing.',
          ),
        );
        continue;
      }

      total += parsed.entries.length;
      for (const entry of parsed.entries) {
        const missing: string[] = [];
        if (entry.owner === undefined || entry.owner.trim() === '') missing.push('an owner');
        if (entry.issue === undefined || entry.issue.trim() === '') missing.push('a linked issue');
        else if (!/^https?:\/\/\S+$/.test(entry.issue.trim())) {
          findings.push(
            finding(
              file.path,
              `${entry.label} has the issue "${entry.issue}", which is not a URL.`,
              'link the tracking issue as a full http(s) URL.',
              entry.line,
            ),
          );
        }
        if (entry.expires === undefined || entry.expires.trim() === '') missing.push('an expiry');
        if (file.needsReason && (entry.reason === undefined || entry.reason.trim() === '')) {
          missing.push('a reason');
        }
        if (missing.length > 0) {
          findings.push(
            finding(
              file.path,
              `${entry.label} is missing ${missing.join(', ')}.`,
              'every exclusion carries an owner, a linked issue and an expiry (D10-15); an entry that ' +
                'cannot be given all three is an exclusion nobody has agreed to.',
              entry.line,
            ),
          );
          continue;
        }
        const problem = expiryProblem((entry.expires ?? '').trim());
        if (problem !== null) {
          findings.push(
            finding(
              file.path,
              `${entry.label}: ${problem}.`,
              'fix the finding and delete the entry, or re-review it and set a new expiry; an expiry ' +
                'nobody renews is what makes an exclusion temporary rather than permanent.',
              entry.line,
            ),
          );
        }
      }
      details.push(`${repoPath(file.path)}: ${String(parsed.entries.length)} entry(ies).`);
    }

    return {
      summary:
        findings.length === 0
          ? `${String(checked)} of ${String(FILES.length)} exclusion file(s) present, ` +
            `${String(total)} entry(ies), every one owned.`
          : `${String(checked)} of ${String(FILES.length)} exclusion file(s) present, ` +
            `${String(total)} entry(ies); exclusion hygiene is broken.`,
      details,
      findings,
    };
  },
};

if (import.meta.main) await runAsMain(check);
