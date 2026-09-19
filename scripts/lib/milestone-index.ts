/**
 * The test → milestone index, read from 12-milestones.md.
 *
 * 10-testing-and-quality.md owns test *names*; 12-milestones.md owns *when* each one is due. The
 * acceptance map needs both, because `sinceMilestone` is what makes the guard runnable on every pull
 * request instead of red from M1 to M4, and the hard-property table states no milestone of its own.
 *
 * Three sources, in decreasing authority:
 *
 *  1. **Each milestone's exit-criteria table** (`### <N>.<k> Exit criteria`, columns
 *     `Test | Lane | Proves`). A test named there is due at that milestone. The section number maps to
 *     a milestone through the `## <N>. M<k>` heading that encloses it, read from the document rather
 *     than assumed, so renumbering the document cannot silently shift every milestone by one.
 *  2. **§2.3 "Spec acceptance rows: where each proof lands"**, whose cells prefix test lists with the
 *     milestone that proves them (`M1 \`collab.convergence.integration\``).
 *  3. **§2.4 "Specified rules gated outside the nine rows"**, whose *Gated at* column carries the
 *     milestone for each `ruleId`'s tests.
 *
 * The earliest milestone any source names wins, because "due from" is the question the guard asks.
 */
import { readFileSync } from 'node:fs';

import { codeSpans, readSections, readTables, requireTable, type Section } from './markdown.ts';
import { PLAN_DOCUMENTS } from './paths.ts';
import { earlierMilestone, isTestName } from './test-names.ts';

/** Where a milestone claim came from, so a surprising value can be traced back to the prose. */
export interface MilestoneClaim {
  readonly milestone: string;
  readonly source: string;
}

export interface MilestoneIndex {
  /** Earliest milestone claimed for each test name. */
  readonly byTest: ReadonlyMap<string, MilestoneClaim>;
  /** Every milestone the document defines, in order: `M0` … `M8`. */
  readonly milestones: readonly string[];
  /** The tests each milestone's exit criteria name, in document order. */
  readonly exitCriteria: ReadonlyMap<string, readonly string[]>;
  /**
   * 15-requirements-traceability.md's `Milestone` column, consulted **only** for a test 12-milestones.md
   * schedules nowhere.
   *
   * It is a fallback rather than a peer because a traceability row lists several tests across several
   * layers against a milestone *list* (`M2 (hast), M4 (web), M5 (desktop)`) without pairing them, so
   * taking its earliest value as authoritative would pull an M5 desktop spec back to M2. Used only to
   * fill a gap, it closes exactly the cases 12 omits — today `projection.hostile.integration` and
   * `limits.policy.unit`, both named in 10's hard-property matrix and in no exit-criteria table.
   */
  readonly fallbackByTest: ReadonlyMap<string, MilestoneClaim>;
}

/** `## 4. M0 — Repository bootstrap…` → section number 4 means milestone `M0`. */
function milestoneBySectionNumber(sections: readonly Section[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const section of sections) {
    if (section.level !== 2) continue;
    const heading = /^(\d+)\.\s+(M\d+)\b/.exec(section.title);
    if (heading?.[1] === undefined || heading[2] === undefined) continue;
    map.set(heading[1], heading[2]);
  }
  if (map.size === 0) {
    throw new Error(
      '12-milestones.md: no `## <N>. M<k>` heading was found, so no section number could be mapped ' +
        'to a milestone.',
    );
  }
  return map;
}

export function readMilestoneIndex(): MilestoneIndex {
  const source = readFileSync(PLAN_DOCUMENTS.milestones, 'utf8');
  const sections = readSections(source);
  const bySectionNumber = milestoneBySectionNumber(sections);

  const claims = new Map<string, MilestoneClaim>();
  const record = (name: string, milestone: string, where: string): void => {
    const existing = claims.get(name);
    if (existing === undefined) {
      claims.set(name, { milestone, source: where });
      return;
    }
    const earlier = earlierMilestone(existing.milestone, milestone);
    if (earlier !== existing.milestone) claims.set(name, { milestone, source: where });
  };

  // 1. Exit-criteria tables.
  const exitCriteria = new Map<string, string[]>();
  for (const section of sections) {
    const heading = /^(\d+)\.(\d+)\s+Exit criteria/.exec(section.title);
    if (heading?.[1] === undefined) continue;
    const milestone = bySectionNumber.get(heading[1]);
    if (milestone === undefined) {
      throw new Error(
        `12-milestones.md §${section.title}: section ${heading[1]} has no \`## ${heading[1]}. M<k>\` ` +
          'heading, so its exit criteria cannot be attributed to a milestone.',
      );
    }
    // Most exit-criteria sections carry one `| Test | Lane | Proves |` table; §8.4 (M4) carries two
    // `| Spec | Proves |` tables instead. Both name tests in the first column, so the shape is
    // accepted by that column's header rather than by a fixed header tuple — and a section with no
    // such table at all is a parse failure below.
    const tables = readTables(section.body, section.line + 1).filter((table) => {
      const first = (table.headers[0] ?? '').toLowerCase();
      return first === 'test' || first === 'spec';
    });
    const names: string[] = [];
    for (const table of tables) {
      for (const row of table.rows) {
        for (const span of codeSpans(row[0] ?? '')) {
          if (!isTestName(span)) continue;
          names.push(span);
          record(span, milestone, `12-milestones.md §${section.title}`);
        }
      }
    }
    if (tables.length === 0) {
      throw new Error(
        `12-milestones.md §${section.title}: no table whose first column is \`Test\` or \`Spec\`. ` +
          'The milestone index reads exit criteria from that column.',
      );
    }
    exitCriteria.set(milestone, names);
  }
  if (exitCriteria.size === 0) {
    throw new Error(
      '12-milestones.md: no `### <N>.<k> Exit criteria` section produced a `| Test | Lane | Proves |` ' +
        'table. The milestone index is built from those tables, so an empty result is a parse ' +
        'failure rather than an empty index.',
    );
  }

  // 2. §2.3 — cells of the form `M1 \`test\`, \`test\``; the milestone prefixes the names after it.
  const acceptanceRows = sections.find((section) =>
    section.title.startsWith('2.3 Spec acceptance rows'),
  );
  if (acceptanceRows !== undefined) {
    for (const table of readTables(acceptanceRows.body, acceptanceRows.line + 1)) {
      for (const row of table.rows) {
        for (const cell of row) {
          let current: string | null = null;
          for (const token of cell.split(/(?=\bM\d\b)/)) {
            const milestone = /^M\d\b/.exec(token)?.[0];
            if (milestone !== undefined) current = milestone;
            if (current === null) continue;
            for (const span of codeSpans(token)) {
              if (isTestName(span)) record(span, current, '12-milestones.md §2.3');
            }
          }
        }
      }
    }
  }

  // 3. §2.4 — the `Gated at` column carries one or more milestones for the row's tests.
  const ruleRows = sections.find((section) =>
    section.title.startsWith('2.4 Specified rules gated'),
  );
  if (ruleRows !== undefined) {
    const table = requireTable(
      ruleRows.body,
      ['Rule id', 'Gated at', 'Tests'],
      '12-milestones.md §2.4',
      ruleRows.line + 1,
    );
    for (const row of table.rows) {
      const milestones = [...(row[1] ?? '').matchAll(/\bM\d\b/g)].map((match) => match[0]);
      const earliest = milestones.reduce<string | null>(
        (best, milestone) => (best === null ? milestone : earlierMilestone(best, milestone)),
        null,
      );
      if (earliest === null) continue;
      for (const span of codeSpans(row[2] ?? '')) {
        if (isTestName(span)) record(span, earliest, '12-milestones.md §2.4');
      }
    }
  }

  // 4. Section 3 - the cross-cutting gates. "These gates are evaluated at every milestone exit ...
  //    They exist from M0 onward - except where a row names a later milestone because the artefact it
  //    checks does not exist before it." So a guard named in a gate row is due at M0 unless the row
  //    itself names a milestone, in which case the earliest one it names is the answer. This is a
  //    fallback only: a row mentioning the M1 fixture and the M8 upgrade rehearsal must not
  //    override the rehearsal explicitly scheduled by the M8 exit table.
  const gates = sections.find((section) => section.title.startsWith('3. Cross-cutting gates'));
  if (gates !== undefined) {
    const table = requireTable(
      gates.body,
      ['Gate', 'Check', 'Where it runs'],
      '12-milestones.md §3',
      gates.line + 1,
    );
    for (const row of table.rows) {
      const mentioned = [...row.join(' ').matchAll(/\bM\d\b/g)].map((match) => match[0]);
      const milestone = mentioned.reduce<string>(
        (best, candidate) => earlierMilestone(best, candidate),
        mentioned[0] ?? 'M0',
      );
      for (const span of codeSpans(row[1] ?? '')) {
        if (isTestName(span) && !claims.has(span)) {
          record(span, milestone, '12-milestones.md §3 (cross-cutting gates)');
        }
      }
    }
  }

  const milestones = [...new Set(bySectionNumber.values())].toSorted(
    (a, b) => Number(a.slice(1)) - Number(b.slice(1)),
  );
  return { byTest: claims, milestones, exitCriteria, fallbackByTest: readTraceabilityMilestones() };
}

/** The `Milestone` column of 15-requirements-traceability.md's matrix, earliest value per test. */
function readTraceabilityMilestones(): Map<string, MilestoneClaim> {
  const source = readFileSync(PLAN_DOCUMENTS.traceability, 'utf8');
  const claims = new Map<string, MilestoneClaim>();
  for (const table of readTables(source.replaceAll('\r\n', '\n').split('\n'))) {
    const testColumn = table.headers.findIndex((header) => header.toLowerCase() === 'tests');
    const milestoneColumn = table.headers.findIndex(
      (header) => header.toLowerCase() === 'milestone',
    );
    if (testColumn === -1 || milestoneColumn === -1) continue;
    for (const row of table.rows) {
      const found = [...(row[milestoneColumn] ?? '').matchAll(/\bM\d\b/g)].map((match) => match[0]);
      const earliest = found.reduce<string | null>(
        (best, milestone) => (best === null ? milestone : earlierMilestone(best, milestone)),
        null,
      );
      if (earliest === null) continue;
      for (const span of codeSpans(row[testColumn] ?? '')) {
        if (!isTestName(span)) continue;
        const existing = claims.get(span);
        if (
          existing === undefined ||
          earlierMilestone(existing.milestone, earliest) !== existing.milestone
        ) {
          claims.set(span, { milestone: earliest, source: '15-requirements-traceability.md' });
        }
      }
    }
  }
  return claims;
}
