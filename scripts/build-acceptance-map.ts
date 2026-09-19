/**
 * Step 9 — the last step — of `pnpm gen`: `docs/acceptance-map.json`
 * (12-milestones.md §4.3; 10-testing-and-quality.md, "Named test inventory" and "Inventory
 * completeness").
 *
 * It runs last because it references the operation and tool names the earlier steps emit.
 *
 * ## What it parses, and why each source is the authority for what it contributes
 *
 * From `docs/plan/10-testing-and-quality.md`, which owns test names (D10-21):
 *
 *  1. **Overview** — the nine spec acceptance rows: `rowId`, the required `L<n>@<milestone>` layers,
 *     the named tests, the `†` gating marker, and *Green at*.
 *  2. **Hard properties under test** and **Hard properties → required layers** — `hpId`, the testable
 *     statement, and the `●` layer matrix.
 *  3. **Specified rules outside the nine rows** — `ruleId`, the rule, its required tag, and its tests
 *     with their own `(L<n>@M<k>)` annotations.
 *  4. **Guard tests** — every guard, what it asserts, and how.
 *  5. The suite inventories: **Server suite by area**, **Client suite**, **The `IridiumHost` contract
 *     suite**, **E2E inventory**, and the eleven **Inventory completeness** tables, which are what
 *     resolve a name to a file, a project and a tag. **Superseded spellings** and the post-1.0 table
 *     are parsed from the same section, because `scripts/check-test-name-references.ts` resolves every
 *     name in the plan against this map and both kinds of name are cited in the plan.
 *
 * From `docs/plan/12-milestones.md`, which owns milestone scope: the test → milestone index
 * (`scripts/lib/milestone-index.ts`).
 *
 * ## Two derivations, stated here because the plan states a rule rather than a table
 *
 * **A test's layer comes from its name.** The overview names a row's tests in one cell and its
 * required layers in another; nothing in the prose pairs them. The Location convention makes the
 * pairing mechanical — the layer segment of a name *is* its layer — so `scripts/lib/test-names.ts`
 * derives it, and this builder then asserts the two columns agree in both directions. A row whose
 * named tests do not cover its required layers, or that names a test at a layer it does not require,
 * fails the pipeline.
 *
 * **A hard-property layer's `sinceMilestone` is the earliest milestone of its tests.** The `●` matrix
 * carries no milestone. Rule 3 of the guard is "a hard-property id has no test in a required layer
 * that is due", which is satisfied by *one* test, so the layer becomes due when its first test does.
 * Taking the latest instead would let a layer sit unproven for milestones after a test that proves it
 * already exists.
 *
 * ## What is reported rather than guessed
 *
 * A name the five inventories use but the "Inventory completeness" tables do not resolve to a file,
 * a project and a tag is listed in the step's output and carried in the map with `null` fields. It is
 * not invented, and it is not dropped: dropping it would make
 * `scripts/check-test-name-references.ts` fail on the section that cites it, which is the opposite of
 * what that script is for.
 */
import { readFileSync } from 'node:fs';

import {
  codeSpans,
  plainText,
  readSections,
  readTables,
  requireSection,
  requireTable,
  type Section,
  type Table,
} from './lib/markdown.ts';
import { readMilestoneIndex, type MilestoneIndex } from './lib/milestone-index.ts';
import { ARTEFACTS, CURRENT_MILESTONE_FILE, PLAN_DOCUMENTS } from './lib/paths.ts';
import { runAsMain, type Step, type StepContext, type StepResult } from './lib/step.ts';
import { earlierMilestone, inventoryMilestone, isTestName, layerOf } from './lib/test-names.ts';
import { writeJsonOrCompare } from './lib/write.ts';

// ---------------------------------------------------------------------------------------------
// The shapes the map carries
// ---------------------------------------------------------------------------------------------

/** One `{rowId | hpId | ruleId, layer, sinceMilestone, tests[]}` entry — the guard's unit of work. */
export interface MapEntry {
  readonly rowId?: string;
  readonly hpId?: string;
  readonly ruleId?: string;
  readonly layer: string;
  readonly sinceMilestone: string;
  /** Set for the layer named in 12-milestones.md §2.3's *Gates 1.0* column (rule 7). */
  readonly gating?: true;
  readonly tests: readonly string[];
}

/** What the map records about one test name. */
export interface TestRecord {
  readonly layer: string;
  readonly sinceMilestone: string | null;
  readonly project: string | null;
  readonly file: string | null;
  readonly tag: string | null;
  readonly asserts: string | null;
  /** Every inventory that named this test, so an unresolved name can be traced. */
  readonly inventories: readonly string[];
  /** `true` when the E2E inventory says the spec carries the `@smoke` Playwright tag. */
  readonly smoke?: true;
}

// ---------------------------------------------------------------------------------------------
// Overview — the nine acceptance rows
// ---------------------------------------------------------------------------------------------

interface RowRecord {
  readonly rowId: string;
  readonly title: string;
  readonly greenAt: string;
  readonly layers: readonly { layer: string; sinceMilestone: string; gating: boolean }[];
  readonly tests: readonly string[];
}

function readOverview(sections: readonly Section[]): RowRecord[] {
  const section = requireSection(sections, 'Overview', '10-testing-and-quality.md');
  const table = requireTable(
    section.body,
    ['#', 'Spec row (`row-id`)', 'Layers required (`L<n>@<milestone>`)', 'Named tests', 'Green at'],
    '10-testing-and-quality.md § Overview',
    section.line + 1,
  );
  return table.rows.map((row) => {
    const rowCell = row[1] ?? '';
    const rowId = codeSpans(rowCell)[0];
    if (rowId === undefined) {
      throw new Error(
        `10-testing-and-quality.md § Overview: row ${JSON.stringify(rowCell)} carries no ` +
          '`row-id` code span.',
      );
    }
    const layers = [...(row[2] ?? '').matchAll(/L(\d)@(M\d)(†?)/g)].map((match) => ({
      layer: `L${match[1] ?? ''}`,
      sinceMilestone: match[2] ?? '',
      gating: match[3] === '†',
    }));
    if (layers.length === 0) {
      throw new Error(
        `10-testing-and-quality.md § Overview: row \`${rowId}\` declares no \`L<n>@<milestone>\` layer.`,
      );
    }
    const tests = codeSpans(row[3] ?? '').filter((span) => isTestName(span));
    if (tests.length === 0) {
      throw new Error(
        `10-testing-and-quality.md § Overview: row \`${rowId}\` names no test. Every cell names a ` +
          'test, never a lane, a runner or a phrase.',
      );
    }
    return {
      rowId,
      title: plainText(rowCell.replace(/\s*\(`[^`]+`\)\s*$/, '')),
      greenAt: plainText(row[4] ?? ''),
      layers,
      tests,
    };
  });
}

/** Group a row's tests by the layer their names imply, and assert the two columns agree. */
function rowEntries(row: RowRecord): MapEntry[] {
  const byLayer = new Map<string, string[]>();
  for (const test of row.tests) {
    const layer = layerOf(test);
    const existing = byLayer.get(layer) ?? [];
    existing.push(test);
    byLayer.set(layer, existing);
  }
  const required = new Set(row.layers.map((entry) => entry.layer));
  const named = new Set(byLayer.keys());
  const missing = [...required].filter((layer) => !named.has(layer));
  const unrequired = [...named].filter((layer) => !required.has(layer));
  if (missing.length > 0 || unrequired.length > 0) {
    throw new Error(
      `10-testing-and-quality.md § Overview: row \`${row.rowId}\`'s two columns disagree.\n` +
        (missing.length > 0 ? `  required but named by no test: ${missing.join(', ')}\n` : '') +
        (unrequired.length > 0
          ? `  named by a test but not required: ${unrequired.join(', ')} ` +
            `(${[...named].map((layer) => `${layer}=${(byLayer.get(layer) ?? []).join('/')}`).join('; ')})\n`
          : '') +
        "  A test's layer is the layer segment of its name (the Location convention), so the " +
        '*Layers required* and *Named tests* columns must cover the same set.',
    );
  }
  return row.layers.map((entry) => ({
    rowId: row.rowId,
    layer: entry.layer,
    sinceMilestone: entry.sinceMilestone,
    ...(entry.gating ? { gating: true as const } : {}),
    tests: byLayer.get(entry.layer) ?? [],
  }));
}

// ---------------------------------------------------------------------------------------------
// Hard properties
// ---------------------------------------------------------------------------------------------

interface HardProperty {
  readonly hpId: string;
  readonly property: string;
  readonly statement: string;
}

function readHardProperties(sections: readonly Section[]): HardProperty[] {
  const section = requireSection(
    sections,
    'Hard properties under test',
    '10-testing-and-quality.md',
  );
  const table = requireTable(
    section.body,
    ['Id', 'Property', 'Testable statement', 'Primary evidence'],
    '10-testing-and-quality.md § Hard properties under test',
    section.line + 1,
  );
  return table.rows.map((row) => ({
    hpId: plainText(row[0] ?? ''),
    property: plainText(row[1] ?? ''),
    statement: plainText(row[2] ?? ''),
  }));
}

function hardPropertyEntries(
  sections: readonly Section[],
  milestoneOf: (name: string) => string | undefined,
): MapEntry[] {
  const section = requireSection(
    sections,
    'Hard properties → required layers',
    '10-testing-and-quality.md',
  );
  const table = requireTable(
    section.body,
    [
      '',
      'L1 unit',
      'L2 component',
      'L3 integration',
      'L4 property',
      'L5 chaos',
      'L6 web E2E',
      'L7 Electron E2E',
      'L8 contract',
    ],
    '10-testing-and-quality.md § Hard properties → required layers',
    section.line + 1,
  );
  const layerOfColumn = table.headers.map((header) => /^L\d/.exec(header)?.[0] ?? null);

  const entries: MapEntry[] = [];
  for (const row of table.rows) {
    const hpId = /HP-\d+/.exec(row[0] ?? '')?.[0];
    if (hpId === undefined) continue;
    for (const [index, cell] of row.entries()) {
      const layer = layerOfColumn[index];
      if (layer === null || layer === undefined) continue;
      if (!cell.includes('●')) continue;
      const tests = codeSpans(cell).filter((span) => isTestName(span));
      if (tests.length === 0) {
        throw new Error(
          `10-testing-and-quality.md § Hard properties → required layers: ${hpId} marks ${layer} ` +
            'required (●) but names no test in that cell.',
        );
      }
      const sinceMilestone = tests.reduce<string | null>((earliest, test) => {
        const claim = milestoneOf(test);
        if (claim === undefined) return earliest;
        return earliest === null ? claim : earlierMilestone(earliest, claim);
      }, null);
      if (sinceMilestone === null) {
        throw new Error(
          `10-testing-and-quality.md § Hard properties → required layers: ${hpId} ${layer} names ` +
            `${tests.join(', ')}, and no source schedules any of them — not the nine-row overview's ` +
            "`L<n>@<milestone>` column, not the rules table's `(L<n>@M<k>)` annotations, and not " +
            "12-milestones.md's exit criteria, §2.3 or §2.4. A required layer with no milestone " +
            "cannot be gated: add the test to the owning milestone's exit criteria.",
        );
      }
      entries.push({ hpId, layer, sinceMilestone, tests });
    }
  }
  if (entries.length === 0) {
    throw new Error(
      '10-testing-and-quality.md § Hard properties → required layers: no ● cell parsed. The ● is the ' +
        'marker this builder reads.',
    );
  }
  return entries;
}

// ---------------------------------------------------------------------------------------------
// Specified rules outside the nine rows
// ---------------------------------------------------------------------------------------------

interface RuleRecord {
  readonly ruleId: string;
  readonly rule: string;
  readonly tag: string;
}

function readRules(sections: readonly Section[]): { rules: RuleRecord[]; entries: MapEntry[] } {
  const section = requireSection(
    sections,
    'Specified rules outside the nine rows',
    '10-testing-and-quality.md',
  );
  const table = requireTable(
    section.body,
    ['Rule id', 'Rule, and where it is specified', 'Tag', 'Named tests (layer @ milestone)'],
    '10-testing-and-quality.md § Specified rules outside the nine rows',
    section.line + 1,
  );

  const rules: RuleRecord[] = [];
  const entries: MapEntry[] = [];
  for (const row of table.rows) {
    const ruleId = codeSpans(row[0] ?? '')[0];
    if (ruleId === undefined) continue;
    const tag = /\[(?:spec|hp|area):[^\]]+\]/.exec(row[2] ?? '')?.[0] ?? '';
    if (tag === '') {
      throw new Error(
        `10-testing-and-quality.md § Specified rules outside the nine rows: \`${ruleId}\` declares ` +
          'no `[spec:…]`, `[hp:…]` or `[area:…]` tag. Rule 6 of the guard checks the tag the table ' +
          'states.',
      );
    }
    rules.push({ ruleId, rule: plainText(row[1] ?? ''), tag });

    // `\`tree.rename-impact.unit\` (L1@M2), \`tree.rename-impact.integration\` (L3@M2), …`
    const cell = row[3] ?? '';
    const byLayer = new Map<string, { sinceMilestone: string; tests: string[] }>();
    for (const match of cell.matchAll(/`([^`]+)`\s*\((L\d)@(M\d)[^)]*\)/g)) {
      const [, name, layer, milestone] = match;
      if (name === undefined || layer === undefined || milestone === undefined) continue;
      if (!isTestName(name)) continue;
      const derived = layerOf(name);
      if (derived !== layer) {
        throw new Error(
          `10-testing-and-quality.md § Specified rules outside the nine rows: \`${ruleId}\` states ` +
            `${name} at ${layer}, but its name's layer segment makes it ${derived}.`,
        );
      }
      const existing = byLayer.get(layer) ?? { sinceMilestone: milestone, tests: [] };
      existing.sinceMilestone = earlierMilestone(existing.sinceMilestone, milestone);
      existing.tests.push(name);
      byLayer.set(layer, existing);
    }
    if (byLayer.size === 0) {
      throw new Error(
        `10-testing-and-quality.md § Specified rules outside the nine rows: \`${ruleId}\` names no ` +
          'test in the form `` `name` (L<n>@M<k>) ``. That form is what rule 6 resolves.',
      );
    }
    for (const [layer, value] of byLayer) {
      entries.push({
        ruleId,
        layer,
        sinceMilestone: value.sinceMilestone,
        tests: value.tests,
      });
    }
  }
  return { rules, entries };
}

// ---------------------------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------------------------

interface GuardRecord {
  readonly name: string;
  readonly asserts: string;
  readonly how: string;
}

function readGuards(sections: readonly Section[]): GuardRecord[] {
  const section = requireSection(sections, 'Guard tests', '10-testing-and-quality.md');
  const table = requireTable(
    section.body,
    ['Guard', 'What it asserts', 'How'],
    '10-testing-and-quality.md § Guard tests',
    section.line + 1,
  );
  const guards: GuardRecord[] = [];
  for (const row of table.rows) {
    for (const name of codeSpans(row[0] ?? '').filter((span) => isTestName(span))) {
      guards.push({ name, asserts: plainText(row[1] ?? ''), how: plainText(row[2] ?? '') });
    }
  }
  if (guards.length === 0) {
    throw new Error('10-testing-and-quality.md § Guard tests: no guard name parsed.');
  }
  return guards;
}

// ---------------------------------------------------------------------------------------------
// The suite inventories
// ---------------------------------------------------------------------------------------------

/** One table with the bold paragraph that introduces it, and the defaults that paragraph states. */
interface GroupedTable {
  readonly label: string;
  readonly defaultProject: string | null;
  readonly defaultTag: string | null;
  readonly table: Table;
}

/**
 * Pair each table in a section with the bold lead-in above it.
 *
 * "Inventory completeness" states a group's defaults in that lead-in — `project \`unit\`; tag
 * `[area:contracts]` unless stated` — so a row with an empty Project or Tag column is not missing
 * data, it is inheriting it.
 */
function readGroupedTables(section: Section): GroupedTable[] {
  const tables = readTables(section.body, section.line + 1);
  const grouped: GroupedTable[] = [];
  for (const table of tables) {
    // The nearest bold paragraph above the header row.
    let label = section.title;
    for (let index = table.line - section.line - 2; index >= 0; index -= 1) {
      const line = section.body[index] ?? '';
      if (line.trimStart().startsWith('|')) continue;
      const bold = /^\*\*(.+)$/.exec(line.trim());
      if (bold !== null) {
        label = line.trim();
        break;
      }
      if (line.trim() !== '') break;
    }
    grouped.push({
      label: plainText(label),
      // Read from the raw line: `plainText` strips the backticks the defaults are written in.
      defaultProject: /project `(\w+)`/.exec(label)?.[1] ?? null,
      defaultTag: /tag `(\[[^\]]+\])`/.exec(label)?.[1] ?? null,
      table,
    });
  }
  return grouped;
}

function cellByHeader(
  table: Table,
  row: readonly string[],
  names: readonly string[],
): string | null {
  for (const name of names) {
    const index = table.headers.findIndex((header) => header.toLowerCase() === name.toLowerCase());
    if (index === -1) continue;
    const cell = row[index];
    if (cell !== undefined && cell.trim() !== '') return cell.trim();
  }
  return null;
}

const TAG_PATTERN = /\[(?:spec|hp|area):[^\]]+\]/;

/**
 * Expand the `` `mcp.cursor.unit` + `.mcp` `` form of the *Server suite by area* table.
 *
 * A bare `.<layer>` code span is not a test name; it is shorthand for the previous name's subject at a
 * second layer. The shorthand is recorded here rather than reported as unparseable because the
 * expansion is unambiguous and the alternative — dropping it — would lose `mcp.cursor.mcp` from the
 * map and fail `scripts/check-test-name-references.ts` on the section that cites it.
 */
function expandLayerShorthand(spans: readonly string[]): string[] {
  const names: string[] = [];
  for (const span of spans) {
    if (isTestName(span)) {
      names.push(span);
      continue;
    }
    const shorthand = /^\.([a-z0-9-]+)$/.exec(span);
    const previous = names.at(-1);
    if (shorthand === null || previous === undefined) continue;
    const candidate = `${previous.slice(0, previous.lastIndexOf('.'))}.${shorthand[1] ?? ''}`;
    if (isTestName(candidate)) names.push(candidate);
  }
  return names;
}

/**
 * The directory the Location convention fixes for a layer, or null when the layer does not imply one.
 *
 * unit, prop and component are co-located under the owning package's src/, and the layer says nothing
 * about which package that is, so they return null.
 */
function conventionalDirectory(name: string, layer: string): string | null {
  switch (layer) {
    case 'L3': {
      return 'apps/server/test/integration';
    }
    case 'L5': {
      return 'apps/server/test/chaos';
    }
    case 'L6': {
      return 'apps/e2e/web';
    }
    case 'L7': {
      return 'apps/e2e/electron';
    }
    case 'L8': {
      return name.endsWith('.mcp') ? 'apps/server/test/mcp' : 'apps/server/test/contract';
    }
    default: {
      return null;
    }
  }
}

/** The Vitest or Playwright project a layer runs in, where the layer fixes it. */
function conventionalProject(name: string, layer: string): string | null {
  if (name.endsWith('.guard')) return 'guard';
  switch (layer) {
    case 'L1': {
      // A .prop file runs in `unit` at the PROP budget when it is pure and in `property` when it is
      // database-backed, which its name does not say - so only .unit is fixed here.
      return name.endsWith('.unit') ? 'unit' : null;
    }
    case 'L2': {
      return 'component';
    }
    case 'L3': {
      return 'integration';
    }
    case 'L5': {
      return 'chaos';
    }
    case 'L6': {
      return 'chromium';
    }
    case 'L7': {
      return 'electron';
    }
    case 'L8': {
      return name.endsWith('.mcp') ? 'mcp' : 'contract';
    }
    default: {
      return null;
    }
  }
}

interface Inventory {
  readonly records: Map<string, TestRecord>;
  readonly superseded: { superseded: string[]; canonical: string[]; why: string }[];
  readonly postOnePointZero: { name: string; epic: string; asserts: string }[];
  readonly hostContract: { name: string; file: string; hosts: string; how: string }[];
  readonly e2e: { web: string[]; electron: string[]; smoke: string[] };
  readonly unresolved: string[];
  /** Names no source in the plan schedules; the map carries them with a null `sinceMilestone`. */
  readonly unscheduled: string[];
  /** Names the plan resolves to no requirement tag. */
  readonly untagged: string[];
}

function readInventory(
  sections: readonly Section[],
  milestoneOf: (name: string) => string | undefined,
  claimMilestone: (name: string, milestone: string) => void,
): Inventory {
  const records = new Map<string, TestRecord>();
  const inventoriesByName = new Map<string, Set<string>>();

  const note = (name: string, inventory: string, fields: Partial<TestRecord> = {}): void => {
    const inventories = inventoriesByName.get(name) ?? new Set<string>();
    inventories.add(inventory);
    inventoriesByName.set(name, inventories);
    const existing = records.get(name);
    records.set(name, {
      layer: layerOf(name),
      sinceMilestone: milestoneOf(name) ?? null,
      project: fields.project ?? existing?.project ?? null,
      file: fields.file ?? existing?.file ?? null,
      tag: fields.tag ?? existing?.tag ?? null,
      asserts: fields.asserts ?? existing?.asserts ?? null,
      inventories: [...inventories].toSorted((a, b) => a.localeCompare(b)),
      ...(fields.smoke === true || existing?.smoke === true ? { smoke: true as const } : {}),
    });
  };

  // ---- Server suite by area
  {
    const section = requireSection(sections, 'Server suite by area', '10-testing-and-quality.md');
    const table = requireTable(
      section.body,
      ['Area', 'Tests', 'Key assertions'],
      '10-testing-and-quality.md § Server suite by area',
      section.line + 1,
    );
    for (const row of table.rows) {
      const area = plainText(row[0] ?? '');
      for (const name of expandLayerShorthand(codeSpans(row[1] ?? ''))) {
        note(name, `Server suite by area (${area})`, { asserts: plainText(row[2] ?? '') });
      }
    }
  }

  // ---- Client suite
  {
    const section = requireSection(sections, 'Client suite', '10-testing-and-quality.md');
    const table = requireTable(
      section.body,
      ['Test', 'Proves'],
      '10-testing-and-quality.md § Client suite',
      section.line + 1,
    );
    for (const row of table.rows) {
      // A row may name several specs that share one assertion sentence
      // (`tree.keyboard.component`, `tree.dnd.component`), so every name in the cell is taken.
      for (const name of codeSpans(row[0] ?? '').filter((span) => isTestName(span))) {
        note(name, 'Client suite', { project: 'component', asserts: plainText(row[1] ?? '') });
      }
    }
  }

  // ---- The IridiumHost contract suite
  const hostContract: Inventory['hostContract'] = [];
  {
    const section = requireSection(
      sections,
      'The `IridiumHost` contract suite',
      '10-testing-and-quality.md',
    );
    const table = requireTable(
      section.body,
      ['Harness', 'File', 'Host(s)', 'How it runs the cases'],
      '10-testing-and-quality.md § The `IridiumHost` contract suite',
      section.line + 1,
    );
    for (const row of table.rows) {
      const name = codeSpans(row[0] ?? '')[0];
      if (name === undefined || !isTestName(name)) continue;
      const file = codeSpans(row[1] ?? '')[0] ?? null;
      hostContract.push({
        name,
        file: file ?? '',
        hosts: plainText(row[2] ?? ''),
        how: plainText(row[3] ?? ''),
      });
      note(name, 'The IridiumHost contract suite', {
        ...(file === null ? {} : { file }),
        asserts: plainText(row[3] ?? ''),
      });
    }
  }

  // ---- E2E inventory
  const e2e: Inventory['e2e'] = { web: [], electron: [], smoke: [] };
  {
    const section = requireSection(sections, 'E2E inventory', '10-testing-and-quality.md');
    for (const line of section.body) {
      const names = codeSpans(line).filter((span) => isTestName(span));
      if (names.length === 0) continue;
      if (line.startsWith('**Web (')) {
        e2e.web.push(...names);
        for (const name of names) note(name, 'E2E inventory (web)', { project: 'chromium' });
        continue;
      }
      if (line.startsWith('**Electron (')) {
        e2e.electron.push(...names);
        for (const name of names) note(name, 'E2E inventory (electron)', { project: 'electron' });
        continue;
      }
      if (line.includes('`@smoke`')) {
        e2e.smoke.push(...names);
        for (const name of names) note(name, 'E2E inventory (@smoke)', { smoke: true });
      }
    }
    if (e2e.web.length === 0 || e2e.electron.length === 0) {
      throw new Error(
        '10-testing-and-quality.md § E2E inventory: the Web or the Electron paragraph parsed to no ' +
          'test name. Both are bold-lead paragraphs whose names are code spans.',
      );
    }
  }

  // ---- The spike-register check, whose properties live in a Property/Value table of its own.
  {
    const section = requireSection(
      sections,
      'The spike-register check',
      '10-testing-and-quality.md',
    );
    const table = requireTable(
      section.body,
      ['Property', 'Value'],
      '10-testing-and-quality.md § The spike-register check',
      section.line + 1,
    );
    const values = new Map<string, string>();
    for (const row of table.rows) values.set(plainText(row[0] ?? ''), row[1] ?? '');
    note('docs.spikes.spec', 'The spike-register check', {
      project: /project `(\w+)`/.exec(values.get('Layer') ?? '')?.[1] ?? 'guard',
      file: codeSpans(values.get('Location') ?? '')[0] ?? null,
      tag: TAG_PATTERN.exec(values.get('Tag') ?? '')?.[0] ?? null,
      asserts: plainText(values.get('What it asserts') ?? ''),
    });
  }

  // ---- Property and model suites
  //
  // Three shapes live here. The `### <name>` subsection headings and the "Markdown properties" table
  // name tests directly. The "Other pure properties" table is keyed by **file path** instead, and the
  // section's own closing paragraph has to explain in prose how each path resolves to a name — the
  // package supplies the area prefix for `ids.prop.spec.ts`, but `tokens.format.prop.spec.ts` already
  // carries its own. That is not mechanically derivable, so a file is attached only when one of two
  // unambiguous candidates is a name some other inventory already established: the basename itself, or
  // the basename prefixed by the owning package or directory. Anything else is left unattached and
  // reported, never guessed into a new name.
  {
    const propertySuites = sections.filter((candidate) => isTestName(plainText(candidate.title)));
    for (const candidate of propertySuites) {
      note(plainText(candidate.title), 'Property and model suites');
    }

    const markdownProperties = sections.find(
      (candidate) => candidate.title === 'Markdown properties',
    );
    if (markdownProperties !== undefined) {
      const table = requireTable(
        markdownProperties.body,
        ['Property', 'Statement'],
        '10-testing-and-quality.md § Markdown properties',
        markdownProperties.line + 1,
      );
      for (const row of table.rows) {
        const name = codeSpans(row[0] ?? '')[0];
        if (name === undefined || !isTestName(name)) continue;
        note(name, 'Markdown properties', {
          project: 'unit',
          asserts: plainText(row[1] ?? ''),
        });
      }
    }
  }

  // ---- Chaos and durability procedures
  //
  // The CH series names its tests in the subsection headings rather than in a table
  // (### CH-1 - Kill after ack (HP-1, HP-2; `collab.durable-ack.chaos`, case ...)), so those headings
  // are the inventory for the chaos suite. Without them collab.durable-ack.chaos - HP-1's L5 evidence
  // and row 6's - is a name no inventory resolves.
  for (const candidate of sections) {
    if (!/^CH-\d+\b/.test(candidate.title)) continue;
    const area = candidate.title.split('\u2014')[0]?.trim() ?? candidate.title;
    for (const name of codeSpans(candidate.title).filter((span) => isTestName(span))) {
      note(name, `Chaos and durability procedures (${area})`);
    }
  }

  // ---- Inventory completeness: the eleven grouped tables
  const superseded: Inventory['superseded'] = [];
  const postOnePointZero: Inventory['postOnePointZero'] = [];
  {
    const section = requireSection(sections, 'Inventory completeness', '10-testing-and-quality.md');
    for (const group of readGroupedTables(section)) {
      const first = (group.table.headers[0] ?? '').toLowerCase();
      if (first === 'superseded') {
        for (const row of group.table.rows) {
          const canonical = codeSpans(row[1] ?? '');
          superseded.push({
            // Kept as an array rather than a joined string: several rows list N superseded spellings
            // against N canonical ones, and the pairing is positional. Joining would lose it.
            superseded: codeSpans(row[0] ?? ''),
            canonical,
            why: plainText(row[2] ?? ''),
          });
          // The canonical spelling has to be a key: `scripts/check-test-name-references.ts` fails on
          // a superseded name and prints the canonical one, which it resolves through this map.
          for (const name of canonical) {
            if (isTestName(name)) note(name, 'Superseded spellings (canonical)');
          }
        }
        continue;
      }
      if (first !== 'test') continue;
      const isEpicTable = group.table.headers.some((header) => header.toLowerCase() === 'epic');
      for (const row of group.table.rows) {
        const names = codeSpans(row[0] ?? '').filter((span) => isTestName(span));
        const name = names[0];
        if (name === undefined) continue;
        const asserts = cellByHeader(group.table, row, ['Asserts', 'Proves']);
        if (isEpicTable) {
          postOnePointZero.push({
            name,
            epic: plainText(cellByHeader(group.table, row, ['Epic']) ?? ''),
            asserts: plainText(asserts ?? ''),
          });
          note(name, 'Inventory completeness (post-1.0 epic)', {
            asserts: plainText(asserts ?? ''),
          });
          continue;
        }
        // Several rows state the milestone inline, in bold: `**M1**`, `**M0**`, `**M5**`. That is the
        // only place some tests are scheduled at all - `crdt.insert-chunking.prop` carries `**M0**`
        // here and 12-milestones.md §4.3 names neither it nor `insertChunked`, which that section
        // records as a correction due there.
        const inlineMilestone = inventoryMilestone(asserts ?? '');
        if (inlineMilestone !== undefined) {
          for (const sibling of names) claimMilestone(sibling, inlineMilestone);
        }

        const projectCell = cellByHeader(group.table, row, [
          'Project',
          'Project / file',
          'Project / lane',
        ]);
        const fileCell = cellByHeader(group.table, row, ['File', 'Project / file']);
        const tagCell = cellByHeader(group.table, row, ['Tag']);
        // A row may carry more than one name; they share the row's file, project, tag and sentence.
        for (const sibling of names.slice(1)) {
          note(sibling, `Inventory completeness — ${group.label.slice(0, 60)}`, {
            project: group.defaultProject,
            tag: group.defaultTag,
            asserts: plainText(asserts ?? ''),
          });
        }
        note(name, `Inventory completeness — ${group.label.slice(0, 60)}`, {
          project:
            (projectCell === null ? null : (codeSpans(projectCell)[0] ?? plainText(projectCell))) ??
            group.defaultProject,
          file:
            fileCell === null ? null : (codeSpans(fileCell).find((s) => s.includes('/')) ?? null),
          tag:
            (tagCell === null ? null : TAG_PATTERN.exec(tagCell)?.[0]) ??
            (asserts === null ? null : TAG_PATTERN.exec(asserts)?.[0]) ??
            group.defaultTag,
          asserts: plainText(asserts ?? ''),
        });
      }
    }
    if (superseded.length === 0) {
      throw new Error(
        '10-testing-and-quality.md § Inventory completeness: the Superseded/Canonical table parsed ' +
          'to no row. `scripts/check-test-name-references.ts` prints the canonical spelling from it.',
      );
    }
  }

  // ---- Other pure properties, keyed by file path
  //
  // This is the one shape in the section a generator cannot read straight through: the key is a path,
  // and the section's own closing paragraph explains in prose how each path resolves to a name - the
  // package supplies the area prefix for ids.prop.spec.ts, while tokens.format.prop.spec.ts already
  // carries its own. A path is therefore attached only when one of three unambiguous candidates is a
  // name another inventory already established: the basename, the basename prefixed by the owning
  // package, or the basename prefixed by its directory. Anything else is left unattached and reported,
  // never turned into a new name. It runs after "Inventory completeness", which is where the canonical
  // names are established.
  {
    const otherProperties = sections.find(
      (candidate) => candidate.title === 'Other pure properties',
    );
    if (otherProperties !== undefined) {
      const table = requireTable(
        otherProperties.body,
        ['File', 'Statement'],
        '10-testing-and-quality.md § Other pure properties',
        otherProperties.line + 1,
      );
      for (const row of table.rows) {
        const file = codeSpans(row[0] ?? '')[0];
        if (file === undefined || !file.endsWith('.spec.ts')) continue;
        const segments = file.split('/');
        const basename = (segments.at(-1) ?? '').replace(/\.spec\.ts$/, '');
        const sourceIndex = segments.indexOf('src');
        const owner = sourceIndex > 0 ? (segments[sourceIndex - 1] ?? '') : '';
        const candidates = [
          basename,
          `${owner}.${basename}`,
          `${segments.at(-2) ?? ''}.${basename}`,
        ];
        const resolved = candidates.find((candidate) => records.has(candidate));
        if (resolved === undefined) continue;
        note(resolved, 'Other pure properties', { file, asserts: plainText(row[1] ?? '') });
      }
    }
  }

  // ---- The Location convention
  //
  // "File paths follow the Location convention, so a table states a path only where the layer does not
  // imply it" (10-testing-and-quality.md, "Inventory completeness"). Filling those in is reading the
  // convention, not guessing: the layer fixes the directory for every server-side and end-to-end
  // layer. unit, prop and component files are co-located under their package's src/, which the layer
  // does not identify, so those keep whatever path a table stated and nothing more.
  // A snapshot, because `note` writes back into `records` while this loop reads it.
  const beforeConvention = Array.from(records);
  for (const [name, record] of beforeConvention) {
    const directory = conventionalDirectory(name, record.layer);
    const project = conventionalProject(name, record.layer);
    if (record.file === null && directory !== null) {
      note(name, 'the Location convention', { file: `${directory}/${name}.spec.ts` });
    }
    if (records.get(name)?.project === null && project !== null) {
      note(name, 'the Location convention', { project });
    }
  }

  // The inventory itself contributed milestone claims (the inline `**M<n>**` markers), so every
  // record's `sinceMilestone` is re-resolved once the whole section has been read. Doing it here rather
  // than at each `note` call keeps the value independent of the order the tables are parsed in.
  // A snapshot for the same reason: the loop writes back into the map it is reading.
  const beforeMilestones = Array.from(records);
  for (const [name, record] of beforeMilestones) {
    const resolved = milestoneOf(name) ?? null;
    if (resolved !== record.sinceMilestone) {
      records.set(name, { ...record, sinceMilestone: resolved });
    }
  }

  // The section claims that every name used anywhere in the plan resolves *here* to a file, a project
  // and a tag. What it does not resolve is reported: a name the grouped tables never carry, and a name
  // they carry without a requirement tag - the two things rules 4 and 6 of the guard need and that no
  // convention can supply.
  const unresolved = [...records.entries()]
    .filter(
      ([, record]) =>
        !record.inventories.some((inventory) => inventory.startsWith('Inventory completeness')),
    )
    .map(([name]) => name)
    .toSorted((a, b) => a.localeCompare(b));

  const unscheduled = [...records.entries()]
    .filter(([, record]) => record.sinceMilestone === null)
    .map(([name]) => name)
    .toSorted((a, b) => a.localeCompare(b));
  const untagged = [...records.entries()]
    .filter(([, record]) => record.tag === null)
    .map(([name]) => name)
    .toSorted((a, b) => a.localeCompare(b));

  return {
    records,
    superseded,
    postOnePointZero,
    hostContract,
    e2e,
    unresolved,
    unscheduled,
    untagged,
  };
}

// ---------------------------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------------------------

export interface AcceptanceMap {
  readonly generatedBy: string;
  readonly sources: readonly string[];
  readonly description: string;
  readonly currentMilestone: string;
  readonly milestones: readonly string[];
  /** Every explicitly named milestone exit test, including tests outside acceptance rows. */
  readonly exitCriteria: Readonly<Record<string, readonly string[]>>;
  readonly entries: readonly MapEntry[];
  readonly rows: readonly { rowId: string; title: string; greenAt: string }[];
  readonly hardProperties: readonly HardProperty[];
  readonly rules: readonly RuleRecord[];
  readonly guards: readonly GuardRecord[];
  readonly hostContractHarnesses: readonly {
    name: string;
    file: string;
    hosts: string;
    how: string;
  }[];
  readonly e2e: {
    readonly web: readonly string[];
    readonly electron: readonly string[];
    readonly smoke: readonly string[];
  };
  readonly superseded: readonly {
    superseded: readonly string[];
    canonical: readonly string[];
    why: string;
  }[];
  readonly postOnePointZero: readonly { name: string; epic: string; asserts: string }[];
  readonly tests: Readonly<Record<string, TestRecord>>;
}

/** What the builder could not resolve from the plan, reported rather than invented. */
export interface MapGaps {
  /** Named by an inventory but carried by no "Inventory completeness" table. */
  readonly unresolved: readonly string[];
  /** Scheduled by no milestone source, so the map carries `sinceMilestone: null`. */
  readonly unscheduled: readonly string[];
  /** Resolved to no `[spec:…]`, `[hp:…]` or `[area:…]` tag. */
  readonly untagged: readonly string[];
}

export function buildMap(): { map: AcceptanceMap; gaps: MapGaps } {
  const testing = readFileSync(PLAN_DOCUMENTS.testing, 'utf8');
  const sections = readSections(testing);
  const milestones = readMilestoneIndex();

  const rows = readOverview(sections);
  const { rules, entries: ruleEntries } = readRules(sections);
  const rowMapEntries = rows.flatMap((row) => rowEntries(row));

  /** Explicit test schedules take precedence over the enclosing area's layer schedule. */
  const claims = new Map<string, string>();
  for (const [name, value] of milestones.byTest) claims.set(name, value.milestone);
  // Traceability fills only tests absent from 12. A row spanning several milestones must schedule
  // its individual tests in 12; an area's M1 proof does not pull its M2 search proof into M1.
  for (const [name, value] of milestones.fallbackByTest) {
    if (!claims.has(name)) claims.set(name, value.milestone);
  }
  const explicit = new Set(claims.keys());
  const claim = (name: string, milestone: string): void => {
    if (explicit.has(name)) return;
    const existing = claims.get(name);
    claims.set(name, existing === undefined ? milestone : earlierMilestone(existing, milestone));
  };
  for (const entry of [...rowMapEntries, ...ruleEntries]) {
    for (const test of entry.tests) claim(test, entry.sinceMilestone);
  }
  const milestoneOf = (name: string): string | undefined => claims.get(name);

  // Guards have their own inventory table; its assertion carries the same explicit schedule syntax.
  for (const guard of readGuards(sections)) {
    const declared = inventoryMilestone(guard.asserts);
    if (declared !== undefined) claim(guard.name, declared);
  }

  const inventory = readInventory(sections, milestoneOf, claim);

  const entries: MapEntry[] = [
    ...rowMapEntries,
    ...hardPropertyEntries(sections, milestoneOf),
    ...ruleEntries,
  ];

  // Every test named by an entry must be a key of `tests`: rule 2 resolves a claimed id through the
  // map, and `scripts/check-test-name-references.ts` resolves every name in the plan through it.
  const known = new Map(inventory.records);
  for (const entry of entries) {
    for (const test of entry.tests) {
      if (known.has(test)) continue;
      known.set(test, {
        layer: layerOf(test),
        sinceMilestone: milestoneOf(test) ?? entry.sinceMilestone,
        project: null,
        file: null,
        tag: null,
        asserts: null,
        inventories: ['named by an acceptance-map entry only'],
      });
    }
  }
  for (const guard of inventory.records.keys()) void guard;
  for (const guard of readGuards(sections)) {
    if (known.has(guard.name)) continue;
    known.set(guard.name, {
      layer: layerOf(guard.name),
      sinceMilestone: milestoneOf(guard.name) ?? null,
      project: 'guard',
      file: null,
      tag: null,
      asserts: guard.asserts,
      inventories: ['Guard tests'],
    });
  }

  const tests: Record<string, TestRecord> = {};
  for (const name of [...known.keys()].toSorted((a, b) => a.localeCompare(b))) {
    const record = known.get(name);
    if (record !== undefined) tests[name] = record;
  }

  const currentMilestone = readFileSync(CURRENT_MILESTONE_FILE, 'utf8').trim();

  const map: AcceptanceMap = {
    generatedBy: 'scripts/build-acceptance-map.ts',
    sources: ['docs/plan/10-testing-and-quality.md', 'docs/plan/12-milestones.md'],
    description:
      "The acceptance map `guards.acceptance-map.guard` reads. `entries` is the guard's unit of " +
      'work: one `{rowId | hpId | ruleId, layer, sinceMilestone, tests[]}` per required layer, with ' +
      '`gating: true` on the layer that retires a row for 1.0. `tests` resolves every test name the ' +
      'plan uses to a layer, a milestone, a project, a file and a requirement tag; ' +
      '`scripts/check-test-name-references.ts` fails on any name in `plan/` or `docs/` that is not a ' +
      'key of it.',
    currentMilestone,
    milestones: milestones.milestones,
    exitCriteria: Object.fromEntries(milestones.exitCriteria),
    entries,
    rows: rows.map((row) => ({ rowId: row.rowId, title: row.title, greenAt: row.greenAt })),
    hardProperties: readHardProperties(sections),
    rules,
    guards: readGuards(sections),
    hostContractHarnesses: inventory.hostContract,
    e2e: inventory.e2e,
    superseded: inventory.superseded,
    postOnePointZero: inventory.postOnePointZero,
    tests,
  };
  return {
    map,
    gaps: {
      unresolved: inventory.unresolved,
      unscheduled: inventory.unscheduled,
      untagged: inventory.untagged,
    },
  };
}

/**
 * The M0 self-check my brief and 12-milestones.md §4.6 both require: every test the M0 exit criteria
 * name is a key of the map, with `sinceMilestone` M0.
 */
function assertM0ExitCriteria(map: AcceptanceMap, milestones: MilestoneIndex): string[] {
  const expected = milestones.exitCriteria.get('M0') ?? [];
  const problems: string[] = [];
  for (const name of expected) {
    const record = map.tests[name];
    if (record === undefined) {
      problems.push(`${name}: named by 12-milestones.md §4.6 but absent from the map`);
      continue;
    }
    if (record.sinceMilestone !== 'M0') {
      problems.push(
        `${name}: sinceMilestone is ${String(record.sinceMilestone)}, but §4.6 names it at M0`,
      );
    }
  }
  return problems;
}

export const step: Step = {
  name: 'acceptance map',
  produces: 'docs/acceptance-map.json',
  run(context: StepContext): Promise<StepResult> {
    const { map, gaps } = buildMap();
    const milestones = readMilestoneIndex();
    const excluded = new Map(map.postOnePointZero.map((entry) => [entry.name, entry]));
    const unscheduled = Object.entries(map.tests)
      .filter(([name, record]) => {
        if (record.sinceMilestone !== null) return false;
        const exclusion = excluded.get(name);
        return (
          exclusion === undefined || exclusion.epic.trim() === '' || exclusion.asserts.trim() === ''
        );
      })
      .map(([name]) => `${name}: no milestone and no explained post-1.0 exclusion`);
    const problems = [...assertM0ExitCriteria(map, milestones), ...unscheduled];
    if (problems.length > 0) {
      throw new Error(
        'docs/acceptance-map.json has unresolved milestone requirements:\n' +
          problems.map((problem) => `  ${problem}`).join('\n'),
      );
    }
    const outcome = writeJsonOrCompare(ARTEFACTS.acceptanceMap, map, context.check);

    const details: string[] = [
      `${String(map.rows.length)} rows, ${String(map.hardProperties.length)} hard properties, ` +
        `${String(map.rules.length)} rules, ${String(map.guards.length)} guards, ` +
        `${String(Object.keys(map.tests).length)} test names`,
      `${String(map.entries.filter((entry) => entry.gating === true).length)} gating layer(s)`,
    ];
    // Gaps are reported, never filled by invention. Each name stays a key of the map with null
    // fields, because dropping it would make `scripts/check-test-name-references.ts` fail on the
    // section that cites it - the opposite of what that script is for.
    if (gaps.unresolved.length > 0) {
      details.push(
        `${String(gaps.unresolved.length)} name(s) are carried by no "Inventory completeness" table ` +
          '(they are resolved by one of the five inventories instead)',
      );
    }
    if (gaps.untagged.length > 0) {
      details.push(`${String(gaps.untagged.length)} name(s) resolve to no requirement tag`);
    }
    if (gaps.unscheduled.length > 0) {
      details.push(
        `${String(gaps.unscheduled.length)} name(s) are scheduled by no milestone source ` +
          '(sinceMilestone is null):',
        ...gaps.unscheduled.map((name) => `  ${name}`),
      );
    }
    return Promise.resolve({
      summary: `${String(map.entries.length)} entries, ${String(outcome.bytes)} bytes`,
      writes: [outcome],
      details,
    });
  },
};

if (import.meta.main) await runAsMain(step);
