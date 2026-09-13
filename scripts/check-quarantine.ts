/**
 * `scripts/check-quarantine.ts` — the first of the four scripts ``ci.yml › static ›
 * `Exclusion hygiene` `` runs.
 *
 * The rule is 10-testing-and-quality.md, "Flake policy" (decision D10-15): `apps/e2e/QUARANTINE.md`
 * carries one row per quarantined test naming **the test, the acceptance row or hard property it
 * covered, the issue and the owner**; there are **at most five rows**; and **none may cover an
 * acceptance row or a hard property** — "a flaky `collab.durable-ack.chaos` blocks the pipeline
 * until it is fixed, because the alternative is shipping an untested durability claim".
 *
 * `docs/acceptance-map.json` is the authority on what a test covers (D10-21). Coverage is read from
 * it in both directions, because a row can hide the fact either way round: an entry whose `Covers`
 * cell names a `rowId` or an `HP-n` is rejected on its own wording, and an entry whose *test* appears
 * under any `rowId` or `hpId` entry of the map is rejected whatever the cell says. A register that
 * could be satisfied by writing "—" in one column would not be a gate.
 *
 * ## The file exists even when it is empty
 *
 * `apps/e2e/QUARANTINE.md` is committed with the rules and an empty table from M0, rather than
 * appearing the first time somebody quarantines something. Three reasons, and the decision is
 * recorded here because the plan states the rule and not the file's lifecycle:
 *
 *  - The merge-blocking list of that section says "a CI step parses each file and fails on an entry
 *    missing either field". A check whose input may or may not exist has to decide what absence
 *    means, and "absent means zero entries" is indistinguishable from "somebody deleted the
 *    register".
 *  - The rules are what a contributor needs at the moment they are about to add a row, and the
 *    register is where they will be looking.
 *  - An empty table is a claim — *nothing is quarantined* — and the repository should be able to
 *    make it.
 *
 * So a missing file is exit `2` with the remedy, not a silent pass.
 */
import { readFileSync } from 'node:fs';

import {
  EnvironmentError,
  finding,
  repoPath,
  runAsMain,
  type Check,
  type CheckResult,
  type Finding,
} from './lib/check.ts';
import { isFile } from './lib/files.ts';
import { arrayMember, isRecord, parseJson, stringMember } from './lib/json.ts';
import { plainText, readTables } from './lib/markdown.ts';
import { ARTEFACTS, CHECK_INPUTS } from './lib/paths.ts';

/** The hard ceiling of D10-15. Absolute: a sixth flaky test means fixing the fifth. */
const CEILING = 5;

/** The columns the register's table declares, in the order the plan names them. */
const COLUMNS: readonly string[] = ['Test', 'Covers', 'Issue', 'Owner'];

/** Cell values that mean "this test covered nothing gated". */
const NOTHING: ReadonlySet<string> = new Set(['', '—', '-', '–', 'none', 'n/a', 'na']);

/** What the acceptance map says a test covers. */
interface Coverage {
  /** Test name → the `rowId`s and `hpId`s whose entries name it. */
  readonly gatedBy: ReadonlyMap<string, readonly string[]>;
  /** Every `rowId` and `hpId` in the map, for checking what a `Covers` cell claims. */
  readonly gatedIds: ReadonlySet<string>;
  /** Every key of `tests`, so a row that names nothing real is caught. */
  readonly known: ReadonlySet<string>;
}

function readCoverage(): Coverage {
  if (!isFile(ARTEFACTS.acceptanceMap)) {
    throw new EnvironmentError(
      `${repoPath(ARTEFACTS.acceptanceMap)} does not exist, so what a quarantined test covers cannot ` +
        'be decided.\nRemedy: run `pnpm gen` to regenerate it.',
    );
  }
  const parsed = parseJson(readFileSync(ARTEFACTS.acceptanceMap, 'utf8'));
  const entries = arrayMember(parsed, 'entries');
  const tests = isRecord(parsed) ? parsed['tests'] : undefined;
  if (entries === undefined || !isRecord(tests)) {
    throw new EnvironmentError(
      `${repoPath(ARTEFACTS.acceptanceMap)} carries no \`entries\` array or no \`tests\` object.\n` +
        'Remedy: run `pnpm gen` to regenerate it.',
    );
  }

  const gatedBy = new Map<string, string[]>();
  const gatedIds = new Set<string>();
  for (const entry of entries) {
    const id = stringMember(entry, 'rowId') ?? stringMember(entry, 'hpId');
    if (id === undefined) continue;
    gatedIds.add(id);
    for (const test of arrayMember(entry, 'tests') ?? []) {
      if (typeof test !== 'string') continue;
      const existing = gatedBy.get(test) ?? [];
      if (!existing.includes(id)) existing.push(id);
      gatedBy.set(test, existing);
    }
  }
  for (const [test, ids] of gatedBy)
    gatedBy.set(
      test,
      ids.toSorted((a, b) => a.localeCompare(b)),
    );
  return { gatedBy, gatedIds, known: new Set(Object.keys(tests)) };
}

/** One parsed row of the register. */
interface Entry {
  readonly line: number;
  readonly test: string;
  readonly covers: string;
  readonly issue: string;
  readonly owner: string;
}

function readRegister(): Entry[] {
  if (!isFile(CHECK_INPUTS.quarantine)) {
    throw new EnvironmentError(
      `${repoPath(CHECK_INPUTS.quarantine)} does not exist.\n` +
        'The register is committed from M0 with an empty table, because "no rows" and "no register" ' +
        'are different claims (10-testing-and-quality.md, "Flake policy").\n' +
        `Remedy: restore the file with the rules and the header row | ${COLUMNS.join(' | ')} |.`,
    );
  }
  const lines = readFileSync(CHECK_INPUTS.quarantine, 'utf8').replaceAll('\r\n', '\n').split('\n');
  const tables = readTables(lines).filter(
    (table) =>
      table.headers.length === COLUMNS.length &&
      table.headers.every(
        (header, index) => header.toLowerCase() === COLUMNS[index]?.toLowerCase(),
      ),
  );
  if (tables.length !== 1) {
    throw new EnvironmentError(
      `${repoPath(CHECK_INPUTS.quarantine)} has ${String(tables.length)} table(s) with the columns ` +
        `| ${COLUMNS.join(' | ')} |, and the register is exactly one.\n` +
        'Remedy: keep a single table with those four columns; the prose above it is free.',
    );
  }
  const table = tables[0];
  if (table === undefined) return [];
  return table.rows.map((row, index) => ({
    // The header row and the delimiter row sit above the first data row.
    line: table.line + 2 + index,
    test: plainText(row[0] ?? ''),
    covers: plainText(row[1] ?? ''),
    issue: plainText(row[2] ?? ''),
    owner: plainText(row[3] ?? ''),
  }));
}

function isIssueUrl(text: string): boolean {
  return /^https?:\/\/\S+$/.test(text);
}

export const check: Check = {
  name: 'check-quarantine',
  workflow: 'ci.yml › static › `Exclusion hygiene`',
  owns: '10-testing-and-quality.md, "Flake policy" (D10-15)',
  run(): CheckResult {
    const coverage = readCoverage();
    const entries = readRegister();
    const findings: Finding[] = [];
    const file = CHECK_INPUTS.quarantine;

    if (entries.length > CEILING) {
      findings.push(
        finding(
          file,
          `${String(entries.length)} quarantined test(s), over the hard ceiling of ${String(CEILING)}.`,
          'fix one of the quarantined tests and remove its row; the ceiling is absolute and is never ' +
            'raised to admit another.',
        ),
      );
    }

    const seen = new Set<string>();
    for (const entry of entries) {
      if (entry.test === '') {
        findings.push(
          finding(
            file,
            'a row names no test.',
            'name the quarantined test, or delete the row.',
            entry.line,
          ),
        );
        continue;
      }
      if (seen.has(entry.test)) {
        findings.push(
          finding(
            file,
            `${entry.test} is quarantined twice.`,
            'keep one row per test; two rows hide the ceiling.',
            entry.line,
          ),
        );
      }
      seen.add(entry.test);

      if (!coverage.known.has(entry.test)) {
        findings.push(
          finding(
            file,
            `${entry.test} is not a key of ${repoPath(ARTEFACTS.acceptanceMap)}, so the row names no ` +
              'test that exists.',
            'use the canonical name from the "Inventory completeness" tables of ' +
              '10-testing-and-quality.md, which is what `pnpm gen` writes into the map.',
            entry.line,
          ),
        );
      }

      if (entry.owner === '') {
        findings.push(
          finding(
            file,
            `${entry.test} has no owner.`,
            'name the person who will fix it; an unowned quarantine is a test nobody is bringing back.',
            entry.line,
          ),
        );
      }
      if (!isIssueUrl(entry.issue)) {
        findings.push(
          finding(
            file,
            `${entry.test} has no linked issue (found "${entry.issue}").`,
            'link the tracking issue as a full http(s) URL; the merge-blocking rule is "no new entry ' +
              'without a linked issue and an owner".',
            entry.line,
          ),
        );
      }

      const gatedByMap = coverage.gatedBy.get(entry.test) ?? [];
      if (gatedByMap.length > 0) {
        findings.push(
          finding(
            file,
            `${entry.test} covers ${gatedByMap.join(', ')} in ${repoPath(ARTEFACTS.acceptanceMap)}, and an ` +
              'acceptance row or hard property may never be quarantined.',
            'fix the test. Quarantining it would ship the claim it proves untested, which is the one ' +
              'thing the ceiling rule forbids outright.',
            entry.line,
          ),
        );
      }
      const claimed = entry.covers.trim();
      if (!NOTHING.has(claimed.toLowerCase()) && coverage.gatedIds.has(claimed)) {
        findings.push(
          finding(
            file,
            `${entry.test} declares that it covers ${claimed}, which is an acceptance row or hard ` +
              'property.',
            'fix the test rather than quarantining it; a row that covers a gated id is not admissible ' +
              'however it is worded.',
            entry.line,
          ),
        );
      }
    }

    return {
      summary:
        findings.length === 0
          ? entries.length === 0
            ? `${repoPath(file)} is empty: nothing is quarantined.`
            : `${String(entries.length)} of ${String(CEILING)} quarantine slot(s) used, all owned and none gating.`
          : `${String(entries.length)} quarantine row(s); the register is not admissible.`,
      findings,
    };
  },
};

if (import.meta.main) await runAsMain(check);
