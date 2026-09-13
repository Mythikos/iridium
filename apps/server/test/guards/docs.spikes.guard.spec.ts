/**
 * `docs.spikes.spec` — the "Spikes closed" milestone gate (12-milestones.md §3 and §4.4;
 * 10-testing-and-quality.md, "The spike-register check"; 14-risks-and-open-questions.md D14-11).
 *
 * **The test's name is `docs.spikes.spec`; this file's basename is `docs.spikes.guard.spec.ts`.** The
 * divergence is deliberate and recorded in 12-milestones.md §13.5: D14-11 fixed the name before the
 * layer convention existed and 10-testing-and-quality.md adopts that spelling unchanged rather than
 * overruling it. The `guard` project selects this file by path, never by title, and
 * `docs/acceptance-map.json` is keyed on `docs.spikes.spec` — so the `describe` title below carries
 * the name and the filename carries the project's include glob. Do not "fix" either one.
 *
 * A spike note is a gating artefact rather than a diary. A milestone closes only when every spike it
 * has reached carries a verdict, and a `fail` verdict is closed by the recorded fallback having been
 * executed inside the same milestone — "we will look at it later" is precisely the outcome the gate
 * exists to refuse. Prose cannot enforce that, so this file reads the register, the template and the
 * notes from the filesystem and asserts them against each other.
 *
 * Three inputs, none of them restated here:
 *
 *  1. **the register** — the table of 12-milestones.md §4.4, the single spike register for the whole
 *     plan (D12-15). Ids, `Runs at` milestones and note filenames are parsed out of the Markdown, so
 *     a spike added to the register is demanded by this guard without a code change;
 *  2. **the template** — the eight headings of `docs/spikes/README.md`, which carries D14-11's
 *     template. Reading them rather than restating them is what stops the guard and the template
 *     drifting apart: a heading renamed in the template is renamed in every note, or this fails;
 *  3. **the milestone axis** — `docs/milestones/CURRENT`, the same file `guards.acceptance-map.guard`
 *     reads, so a spike that runs at M2 is not demanded at M1.
 *
 * The verdict is asserted **as a form, not as a word**: the `Result` section must open with a bold
 * `**pass**` or `**fail**` token, which is how every note in the directory writes it. A note that
 * merely uses the word "pass" somewhere in its prose does not satisfy this guard, and a note whose
 * verdict is `open` is refused by name.
 *
 * A `fail` note must name the change that executed its recorded fallback in a form that resolves to
 * one: a `#<number>` pull request reference (the spelling the plan itself uses), a `…/pull/<number>`
 * URL, or `commit <sha>`. Prose promising that a number will be written in later is the failure mode
 * D14-11 forbids, so it is not accepted — the remedy is to write the reference, not to soften this.
 *
 * Every check is a file read and a string match, so the guard needs no Docker, no network and no
 * build; that is what keeps it in the first `vitest --project guard` step of `ci.yml › static`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SPIKES_DIR = join(REPO_ROOT, 'docs', 'spikes');
const TEMPLATE_FILE = join(SPIKES_DIR, 'README.md');
const REGISTER_FILE = join(REPO_ROOT, 'docs', 'plan', '12-milestones.md');
const RISK_REGISTER_FILE = join(REPO_ROOT, 'docs', 'plan', '14-risks-and-open-questions.md');
const CURRENT_MILESTONE_FILE = join(REPO_ROOT, 'docs', 'milestones', 'CURRENT');

/** How each source is named in a failure message, so a remedy points at a file a human can open. */
const REGISTER_REFERENCE = 'docs/plan/12-milestones.md §4.4';
const RISK_REGISTER_REFERENCE = 'docs/plan/14-risks-and-open-questions.md, "Spikes"';
const TEMPLATE_REFERENCE = 'docs/spikes/README.md';

/** `docs/spikes/S<nn>-<slug>.md`, the filename pattern D14-11 fixes. */
const NOTE_FILE_PATTERN = /^S(\d{2})-[a-z\d]+(?:-[a-z\d]+)*\.md$/;

/** The register's own `S<nn>` id spelling, which is written unpadded (`S1`, `S13`). */
const REGISTER_ID_PATTERN = /^S(\d+)$/;

/**
 * The verdict token: a bold `**pass**` at the head of the `Result` section, optionally written with
 * the word in a code span or with the sentence's full stop inside the emphasis. Those three
 * spellings are what the notes in the directory use; anything looser would let a note that mentions
 * the word in passing count as a verdict, which is the whole point of asserting a form.
 */
const VERDICT_PATTERN = /^\*\*`?([A-Za-z][\w-]*)`?\.?\*\*/;

/** A pull request named the way the plan names one (`PR #834` in 05-collaboration-and-durability.md). */
const PULL_REQUEST_REFERENCE = /(?:^|[\s([<])#\d+\b|\/pull\/\d+\b|[\w.-]+\/[\w.-]+#\d+\b/;

/** A commit named by its hash. The word is required: a bare hex run is also an ordinary word. */
const COMMIT_REFERENCE = /\bcommit\s+`?[\da-f]{7,40}`?\b/i;

interface Table {
  readonly headers: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

/** One row of the spike register. `milestone` is `null` for a row no milestone runs (post-MVP). */
interface RegisterRow {
  readonly id: string;
  readonly number: number | null;
  readonly runsAt: string;
  readonly milestone: number | null;
  /** The `Document` cell verbatim; the 14 register has no such column, so it may be empty. */
  readonly documentPath: string;
  /** The basename of `documentPath`, or `''` when the register names no document. */
  readonly noteFile: string;
}

interface NoteSection {
  readonly heading: string;
  readonly body: string;
}

interface Note {
  readonly file: string;
  readonly display: string;
  readonly sections: readonly NoteSection[];
}

/**
 * Every line of `markdown`, with the contents of fenced code blocks blanked.
 *
 * Spike notes quote shell sessions whose comments start with `#`, and the plan documents carry
 * mermaid diagrams full of pipes. Either would be read as a heading or a table row by a line matcher
 * that did not skip fences. A fence is closed by a run of three or more of its own character, so a
 * ``` block containing ~~~ stays open, which is the CommonMark rule.
 */
function linesOutsideFences(markdown: string): string[] {
  const lines: string[] = [];
  let fence: string | null = null;
  for (const line of markdown.split('\n')) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence === null) {
      if (marker === undefined) {
        lines.push(line);
      } else {
        fence = marker[0] ?? '`';
        lines.push('');
      }
      continue;
    }
    if (marker !== undefined && marker.startsWith(fence)) fence = null;
    lines.push('');
  }
  return lines;
}

/**
 * One table row split into cells on unescaped pipes, with `\|` unescaped in the result.
 *
 * The plan's tables carry escaped pipes inside code spans, and several cells are deliberately empty.
 * This is the same splitting `scripts/lib/markdown.ts` performs for the `pnpm gen` parsers — the two
 * must agree about what a cell is, or the acceptance map and this guard could read the same register
 * differently.
 */
function splitRow(row: string): string[] {
  const trimmed = row.trim();
  const cells: string[] = [];
  let cell = '';
  for (let index = 0; index < trimmed.length; index += 1) {
    const character = trimmed[index];
    if (character === '\\' && trimmed[index + 1] === '|') {
      cell += '|';
      index += 1;
      continue;
    }
    if (character === '|') {
      cells.push(cell.trim());
      cell = '';
      continue;
    }
    cell += character;
  }
  cells.push(cell.trim());
  // A GFM row is written with a leading and a trailing pipe, which produce one empty cell at each
  // end. Drop exactly those two, never an empty cell in the middle.
  if (cells.length >= 2 && cells[0] === '') cells.shift();
  if (cells.length >= 1 && cells.at(-1) === '') cells.pop();
  return cells;
}

function isDelimiterRow(line: string): boolean {
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell));
}

/** The body of the section opened by `heading`, up to the next heading of `level` or shallower. */
function sectionBody(
  lines: readonly string[],
  heading: RegExp,
  level: number,
  reference: string,
): string[] {
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) {
    throw new Error(
      `${reference}: no heading matching ${heading.source}. Was the section renamed?`,
    );
  }
  const closing = new RegExp(`^#{1,${String(level)}}\\s`);
  const offset = lines.slice(start + 1).findIndex((line) => closing.test(line));
  return lines.slice(start + 1, offset === -1 ? lines.length : start + 1 + offset);
}

/** The first pipe table in `lines` whose first header cell is `firstHeader`. */
function readTable(lines: readonly string[], firstHeader: string, reference: string): Table {
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (!(lines[index] ?? '').trimStart().startsWith('|')) continue;
    const headers = splitRow(lines[index] ?? '');
    if (headers[0] !== firstHeader || !isDelimiterRow(lines[index + 1] ?? '')) continue;
    const rows: string[][] = [];
    for (let cursor = index + 2; cursor < lines.length; cursor += 1) {
      const row = lines[cursor] ?? '';
      if (!row.trimStart().startsWith('|')) break;
      rows.push(splitRow(row));
    }
    return { headers, rows };
  }
  throw new Error(`${reference}: no table whose first column is \`${firstHeader}\`.`);
}

function cellOf(table: Table, row: readonly string[], header: string): string {
  const index = table.headers.indexOf(header);
  if (index === -1) {
    throw new Error(`the table has no \`${header}\` column; it has ${table.headers.join(', ')}`);
  }
  return row[index] ?? '';
}

/** The contents of the first code span in `text`, or the text itself when it carries none. */
function codeSpan(text: string): string {
  return /`([^`]+)`/.exec(text)?.[1] ?? text.trim();
}

/** `M0` … `M8` from a `Runs at` cell, which may qualify the milestone (`M3 entry`, `M3 start`). */
function milestoneOf(runsAt: string): number | null {
  const digits = /^M(\d+)\b/.exec(runsAt)?.[1];
  return digits === undefined ? null : Number(digits);
}

function registerRow(table: Table, row: readonly string[], withDocument: boolean): RegisterRow {
  const id = cellOf(table, row, 'Id');
  const runsAt = cellOf(table, row, 'Runs at');
  const documentPath = withDocument ? codeSpan(cellOf(table, row, 'Document')) : '';
  const digits = REGISTER_ID_PATTERN.exec(id)?.[1];
  return {
    id,
    number: digits === undefined ? null : Number(digits),
    runsAt,
    milestone: milestoneOf(runsAt),
    documentPath,
    noteFile: documentPath.slice(documentPath.lastIndexOf('/') + 1),
  };
}

/** The single spike register: §4.4 of 12-milestones.md, ids, milestones and note filenames. */
function readRegister(): readonly RegisterRow[] {
  const lines = linesOutsideFences(readFileSync(REGISTER_FILE, 'utf8'));
  const body = sectionBody(lines, /^###\s+4\.4\s+Spikes\s*$/, 3, REGISTER_REFERENCE);
  const table = readTable(body, 'Id', REGISTER_REFERENCE);
  return table.rows.map((row) => registerRow(table, row, true));
}

/** The same register's other view: the "Spikes" section of 14-risks-and-open-questions.md. */
function readRiskRegister(): readonly RegisterRow[] {
  const lines = linesOutsideFences(readFileSync(RISK_REGISTER_FILE, 'utf8'));
  const body = sectionBody(lines, /^##\s+Spikes\s*$/, 2, RISK_REGISTER_REFERENCE);
  const table = readTable(body, 'Id', RISK_REGISTER_REFERENCE);
  return table.rows.map((row) => registerRow(table, row, false));
}

/** D14-11's eight headings, in the template's own order, read from the template. */
function readTemplateHeadings(): readonly string[] {
  const lines = linesOutsideFences(readFileSync(TEMPLATE_FILE, 'utf8'));
  const body = sectionBody(lines, /^##\s+The template\s*$/, 2, TEMPLATE_REFERENCE);
  return readTable(body, 'Heading', TEMPLATE_REFERENCE).rows.map((row) => row[0] ?? '');
}

function readCurrentMilestone(): number {
  const text = readFileSync(CURRENT_MILESTONE_FILE, 'utf8').trim();
  const digits = /^M(\d+)$/.exec(text)?.[1];
  if (digits === undefined) {
    throw new Error(`docs/milestones/CURRENT holds ${JSON.stringify(text)}, not an \`M<n>\` line.`);
  }
  return Number(digits);
}

/** A note split on its level-2 headings, which is the level the template's headings are written at. */
function readNote(file: string, markdown: string): Note {
  const raw = markdown.split('\n');
  const masked = linesOutsideFences(markdown);
  const sections: NoteSection[] = [];
  let heading: string | null = null;
  let body: string[] = [];
  for (const [index, line] of raw.entries()) {
    const opened = /^##\s+(.+?)\s*$/.exec(masked[index] ?? '')?.[1];
    if (opened === undefined) {
      if (heading !== null) body.push(line);
      continue;
    }
    if (heading !== null) sections.push({ heading, body: body.join('\n') });
    heading = opened;
    body = [];
  }
  if (heading !== null) sections.push({ heading, body: body.join('\n') });
  return { file, display: `docs/spikes/${file}`, sections };
}

function sectionNamed(note: Note, heading: string): NoteSection | undefined {
  return note.sections.find((section) => section.heading === heading);
}

/** The first line with content in a section body, which is where a note writes its verdict. */
function openingLine(body: string): string {
  return (
    body
      .split('\n')
      .find((line) => line.trim().length > 0)
      ?.trim() ?? ''
  );
}

/**
 * The template's headings, present exactly once each and in the template's order, or a remedy.
 *
 * A note may carry further sections of its own — S08 appends a dated amendment — so this asserts
 * completeness and order rather than exclusivity, which is what 10-testing-and-quality.md's row
 * ("carries all eight headings") and the plan's own notes both mean.
 */
function headingProblem(note: Note, template: readonly string[]): string {
  const headings = note.sections.map((section) => section.heading);
  const missing = template.filter((heading) => !headings.includes(heading));
  if (missing.length > 0) {
    return (
      `${note.display} is missing the template heading${missing.length > 1 ? 's' : ''} ` +
      `${missing.map((heading) => `"## ${heading}"`).join(', ')}.\n` +
      `Every spike note carries all eight headings of ${TEMPLATE_REFERENCE} (D14-11), in order: ` +
      `${template.join(', ')}. Add the section; do not rename another one into its place.`
    );
  }
  const duplicated = template.filter(
    (heading) => headings.filter((candidate) => candidate === heading).length > 1,
  );
  if (duplicated.length > 0) {
    return (
      `${note.display} repeats the template heading${duplicated.length > 1 ? 's' : ''} ` +
      `${duplicated.join(', ')}. Each of the eight appears exactly once, or the section a reader ` +
      `(and this guard) reads is whichever came first. Merge the duplicates.`
    );
  }
  // Every template heading is present exactly once by the two checks above, so `order` has the
  // template's length and an element-wise comparison is exact.
  const order = headings.filter((heading) => template.includes(heading));
  if (order.some((heading, index) => heading !== template[index])) {
    return (
      `${note.display} orders its template headings ${order.join(', ')}.\n` +
      `${TEMPLATE_REFERENCE} fixes the order ${template.join(', ')}. Move the sections to match it.`
    );
  }
  return '';
}

/** `pass`, `fail`, or a remedy naming what the `Result` section says instead. */
function verdictOf(note: Note): { verdict: 'pass' | 'fail' | null; problem: string } {
  const section = sectionNamed(note, 'Result');
  if (section === undefined) {
    return { verdict: null, problem: `${note.display} has no "## Result" section.` };
  }
  const line = openingLine(section.body);
  const token = VERDICT_PATTERN.exec(line)?.[1];
  if (token === undefined) {
    return {
      verdict: null,
      problem:
        `${note.display}: the "Result" section does not open with a verdict. Its first line is ` +
        `${JSON.stringify(line)}.\nWrite \`**pass**\` or \`**fail**\` as the first token of the ` +
        `section and the evidence after it, the way every other note does. The token is asserted ` +
        `as a form so that a note merely mentioning the word cannot close a milestone gate.`,
    };
  }
  if (token === 'pass' || token === 'fail') return { verdict: token, problem: '' };
  if (token.toLowerCase() === 'open') {
    return {
      verdict: null,
      problem:
        `${note.display} records an \`open\` verdict. D14-11 admits \`pass\` or \`fail\` and never ` +
        `\`open\`: a spike that has not run yet is not a document in docs/spikes/ at all, and "we ` +
        `will look at it later" is not an outcome the "Spikes closed" gate accepts. Run the spike, ` +
        `write the verdict, and execute the recorded fallback in this milestone if it failed.`,
    };
  }
  return {
    verdict: null,
    problem:
      `${note.display} opens its "Result" section with \`**${token}**\`. The vocabulary is exactly ` +
      `\`**pass**\` or \`**fail**\`, lower-case (${TEMPLATE_REFERENCE}).`,
  };
}

/** What the "Fallback executed" section owes, given the verdict: a reference on `fail`, `n/a` on `pass`. */
function fallbackProblem(note: Note, verdict: 'pass' | 'fail' | null): string {
  const section = sectionNamed(note, 'Fallback executed');
  if (section === undefined || verdict === null) return '';
  const body = section.body;
  if (verdict === 'pass') {
    return openingLine(body).toLowerCase().startsWith('n/a')
      ? ''
      : `${note.display} records \`**pass**\`, so its "Fallback executed" section opens with ` +
          `\`n/a\` (${TEMPLATE_REFERENCE}); it opens with ${JSON.stringify(openingLine(body))}. ` +
          `An explanation after the \`n/a\` is welcome — the token comes first.`;
  }
  if (PULL_REQUEST_REFERENCE.test(body) || COMMIT_REFERENCE.test(body)) return '';
  return (
    `${note.display} records \`**fail**\`, and its "Fallback executed" section names no pull ` +
    `request and no commit.\nD14-11 closes a failed spike by executing its recorded fallback inside ` +
    `the same milestone and naming the change that did it, which is the one thing a promise to fill ` +
    `the number in later cannot do. Write the reference in that section as \`#<number>\`, a ` +
    `\`…/pull/<number>\` URL, or \`commit <sha>\`.`
  );
}

/** Notes on disk that the register does not list. `README.md` is the template, not a note. */
function unregisteredNotes(files: readonly string[], registered: ReadonlySet<string>): string[] {
  return files.filter((file) => !registered.has(file));
}

const TEMPLATE_HEADINGS = readTemplateHeadings();
const TEMPLATE_TEXT = readFileSync(TEMPLATE_FILE, 'utf8');
const REGISTER = readRegister();
const RISK_REGISTER = readRiskRegister();
const CURRENT_MILESTONE = readCurrentMilestone();

/** The spikes whose milestone the repository has reached, which are the ones the gate demands. */
const REACHED = REGISTER.filter(
  (row) => row.milestone !== null && row.milestone <= CURRENT_MILESTONE,
);

const NOTE_FILES = readdirSync(SPIKES_DIR)
  .filter((file) => file.endsWith('.md') && file !== 'README.md')
  .toSorted((a, b) => a.localeCompare(b));

const REGISTERED_FILES = new Set(REGISTER.map((row) => row.noteFile).filter((file) => file !== ''));

/**
 * Every note that exists and is registered, validated whatever milestone it belongs to.
 *
 * The milestone axis decides which notes are *demanded*, never which are *checked*: the template
 * admits no unfinished note ("a spike that has not yet run is not a document in this directory"), so
 * a note that arrives early is held to the same eight headings and the same verdict vocabulary.
 */
const NOTES = NOTE_FILES.filter((file) => REGISTERED_FILES.has(file)).map((file) =>
  readNote(file, readFileSync(join(SPIKES_DIR, file), 'utf8')),
);

/**
 * Every remedy is carried by the **asserted value** rather than by `expect`'s message argument.
 *
 * `vitest/valid-expect` accepts only a literal or a template there, never a concatenation, and these
 * remedies are too long for one line — so each check produces `''` when it holds and the whole remedy
 * when it does not. The diff Vitest prints is then the remedy itself, which is what makes a guard a
 * repair instruction rather than a rejection.
 */
function problemList(problems: readonly string[]): string {
  return problems.filter((problem) => problem !== '').join('\n\n');
}

describe('docs.spikes.spec [area:docs]', () => {
  describe(`the spike register of ${REGISTER_REFERENCE}`, () => {
    it('parses into rows with an `S<nn>` id and a milestone each', () => {
      expect(REGISTER.length).toBeGreaterThan(0);
      const malformed = REGISTER.filter((row) => row.number === null).map((row) => row.id);
      const ids = REGISTER.map((row) => row.id);
      const duplicated = ids.filter((id, index) => ids.indexOf(id) !== index);
      const unscheduled = REGISTER.filter((row) => row.milestone === null).map(
        (row) => `${row.id} (\`${row.runsAt}\`)`,
      );
      expect(
        problemList([
          malformed.length === 0
            ? ''
            : `${REGISTER_REFERENCE}: an \`Id\` cell must be \`S<n>\` — the register writes ids ` +
              `unpadded (\`S1\` … \`S15\`) while the note filenames pad them. ` +
              `Offending: ${malformed.join(', ')}`,
          duplicated.length === 0
            ? ''
            : `${REGISTER_REFERENCE} lists ${duplicated.join(', ')} twice. One id, one row: §4.4 ` +
              `is the single register for the whole plan (D12-15).`,
          unscheduled.length === 0
            ? ''
            : `${REGISTER_REFERENCE}: every row's \`Runs at\` cell names the milestone that runs ` +
              `the spike, starting \`M<n>\` (a qualifier such as \`M3 entry\` is fine). ` +
              `${unscheduled.join(', ')} names none. A spike no milestone runs belongs in ` +
              `${RISK_REGISTER_REFERENCE} alone, the way S12 does.`,
        ]),
      ).toBe('');
    });

    it('names a `docs/spikes/S<nn>-<slug>.md` document for every spike', () => {
      const wrong = REGISTER.flatMap((row) => {
        if (row.number === null) return [];
        const expected = `docs/spikes/S${String(row.number).padStart(2, '0')}-<slug>.md`;
        const correct =
          row.documentPath === `docs/spikes/${row.noteFile}` &&
          NOTE_FILE_PATTERN.test(row.noteFile) &&
          row.noteFile.startsWith(`S${String(row.number).padStart(2, '0')}-`);
        return correct ? [] : [`${row.id}: \`${row.documentPath}\` (expected ${expected})`];
      });
      expect(
        wrong.length === 0
          ? ''
          : `${REGISTER_REFERENCE}: a \`Document\` cell is the note's path, built from the row's ` +
              `own id and a lower-case slug. Correct the cell or rename the note so the two agree.` +
              `\n${wrong.join('\n')}`,
      ).toBe('');
    });

    it(`lists the same spikes as ${RISK_REGISTER_REFERENCE}, bar the rows no milestone runs`, () => {
      const here = new Set(REGISTER.map((row) => row.id));
      const there = new Set(RISK_REGISTER.map((row) => row.id));
      const onlyHere = [...here].filter((id) => !there.has(id));
      // The other direction is legitimate for a spike no MVP milestone runs — S12, the post-MVP Yjs
      // v14 gate — and illegitimate for anything with a milestone, which §4.4 would then be missing.
      const scheduledOnlyThere = RISK_REGISTER.filter(
        (row) => !here.has(row.id) && row.milestone !== null,
      ).map((row) => `${row.id} (\`${row.runsAt}\`)`);
      expect(
        problemList([
          onlyHere.length === 0
            ? ''
            : `${REGISTER_REFERENCE} introduces ${onlyHere.join(', ')}, which ` +
              `${RISK_REGISTER_REFERENCE} does not carry. The two are one register in two views ` +
              `(D12-15): add the row there too, with its question, blocker and owner.`,
          scheduledOnlyThere.length === 0
            ? ''
            : `${RISK_REGISTER_REFERENCE} schedules ${scheduledOnlyThere.join(', ')} at a ` +
              `milestone and ${REGISTER_REFERENCE} does not list it. §4.4 is the register every ` +
              `milestone's scope is read from, so a scheduled spike missing from it runs nowhere.`,
        ]),
      ).toBe('');
    });

    it(`assigns every shared spike the same milestone as ${RISK_REGISTER_REFERENCE}`, () => {
      const there = new Map(RISK_REGISTER.map((row) => [row.id, row]));
      const disagreements = REGISTER.flatMap((row) => {
        const other = there.get(row.id);
        if (other === undefined || other.milestone === row.milestone) return [];
        return [`${row.id}: §4.4 says \`${row.runsAt}\`, 14 says \`${other.runsAt}\``];
      });
      expect(
        disagreements.length === 0
          ? ''
          : `The two views of the register disagree about when a spike runs, and a milestone's ` +
              `scope is read from §4.4 while its risk score is read from 14. Only the milestone ` +
              `number is compared, so \`M3 entry\` and \`M3 start\` agree.\n${disagreements.join('\n')}`,
      ).toBe('');
    });
  });

  describe(`the note template of ${TEMPLATE_REFERENCE}`, () => {
    // The template table is what this guard holds every note to. If it stops listing these eight
    // headings the guard would be asserting a template nobody wrote, so the list is pinned here as
    // well as read from the file: a template change is a change to 14-risks-and-open-questions.md
    // first, to the README second and to this expectation third, in one commit (D14-11).
    it('carries exactly the eight headings D14-11 fixes, in the template order', () => {
      expect(TEMPLATE_HEADINGS).toEqual([
        'Question',
        'Why it blocks',
        'Pinned versions',
        'Method',
        'Result',
        'Decision',
        'Fallback executed',
        'Follow-ups',
      ]);
    });

    it('states that a Result is `pass` or `fail` and never `open`', () => {
      expect(TEMPLATE_TEXT).toContain('`pass` or `fail`');
      expect(TEMPLATE_TEXT).toContain('never `open`');
    });
  });

  describe(`the spikes reached at M${String(CURRENT_MILESTONE)} (docs/milestones/CURRENT)`, () => {
    it('is a non-empty set, so the gate cannot pass by finding nothing', () => {
      expect(
        REACHED.map((row) => row.id).join(', '),
        `no row of ${REGISTER_REFERENCE} runs at or before M${String(CURRENT_MILESTONE)}`,
      ).not.toBe('');
    });

    for (const row of REACHED) {
      it(`${row.id} (${row.runsAt}) has its note at ${row.documentPath}`, () => {
        expect(
          NOTE_FILES.includes(row.noteFile)
            ? ''
            : `${row.documentPath} does not exist. ${row.id} runs at \`${row.runsAt}\` and ` +
                `docs/milestones/CURRENT is M${String(CURRENT_MILESTONE)}, so its note is due: ` +
                `write it from the template in ${TEMPLATE_REFERENCE}. A spike without a recorded ` +
                `verdict does not close the milestone.`,
        ).toBe('');
      });
    }
  });

  describe('every note in docs/spikes/', () => {
    it(`is a spike ${REGISTER_REFERENCE} lists`, () => {
      const strays = unregisteredNotes(NOTE_FILES, REGISTERED_FILES);
      expect(
        strays.length === 0
          ? ''
          : `${strays.map((file) => `docs/spikes/${file}`).join('\n')}\nA note in docs/spikes/ ` +
              `belongs to a row of ${REGISTER_REFERENCE}, the single spike register for the whole ` +
              `plan (D12-15). Add the row — question, method, pass criterion and recorded fallback — ` +
              `or delete the note. An unregistered note is how a second, contradictory register starts.`,
      ).toBe('');
    });

    for (const note of NOTES) {
      const { verdict, problem } = verdictOf(note);

      describe(`docs/spikes/${note.file}`, () => {
        it('carries the eight template headings, in order', () => {
          expect(headingProblem(note, TEMPLATE_HEADINGS)).toBe('');
        });

        it('records a verdict of `pass` or `fail`, never `open`', () => {
          expect(problem).toBe('');
        });

        it('accounts for its recorded fallback', () => {
          expect(fallbackProblem(note, verdict)).toBe('');
        });
      });
    }
  });

  /**
   * The negative half: every rule above, shown refusing the shape it exists to catch.
   *
   * A guard that has only ever been run against a compliant tree is a guard nobody has tested. The
   * synthetic notes are built from the live template headings, so they cannot drift away from it
   * either.
   */
  describe('the rules refuse the shapes they exist to catch', () => {
    function syntheticNote(bodies: Readonly<Record<string, string>>, omit?: string): Note {
      const headings = TEMPLATE_HEADINGS.filter((heading) => heading !== omit);
      const markdown = ['# S99 — synthetic', '']
        .concat(headings.flatMap((heading) => [`## ${heading}`, '', bodies[heading] ?? 'text', '']))
        .join('\n');
      return readNote('S99-synthetic.md', markdown);
    }

    it('refuses a note with a heading missing, naming the heading', () => {
      const problem = headingProblem(syntheticNote({}, 'Method'), TEMPLATE_HEADINGS);
      expect(problem).toContain('"## Method"');
      expect(problem).toContain('S99-synthetic.md');
    });

    it('refuses a note whose sections are out of the template order', () => {
      const reordered = readNote(
        'S99-synthetic.md',
        TEMPLATE_HEADINGS.toReversed()
          .map((heading) => `## ${heading}\n\ntext\n`)
          .join('\n'),
      );
      expect(headingProblem(reordered, TEMPLATE_HEADINGS)).toContain(
        'orders its template headings',
      );
    });

    it('refuses an `open` verdict by name', () => {
      const { verdict, problem } = verdictOf(syntheticNote({ Result: '**open.** Still running.' }));
      expect(verdict).toBeNull();
      expect(problem).toContain('never');
    });

    it('refuses a Result that only mentions the word', () => {
      const mention = syntheticNote({
        Result: 'Every criterion above is a pass on all three OSes.',
      });
      expect(verdictOf(mention).problem).toContain('does not open with a verdict');
    });

    it('accepts the three spellings the notes use, and nothing looser', () => {
      expect(verdictOf(syntheticNote({ Result: '**pass.** Evidence.' })).verdict).toBe('pass');
      expect(verdictOf(syntheticNote({ Result: '**pass**, on the measured leg.' })).verdict).toBe(
        'pass',
      );
      expect(verdictOf(syntheticNote({ Result: '**`fail`** — against clause 1.' })).verdict).toBe(
        'fail',
      );
      expect(verdictOf(syntheticNote({ Result: '**Pass.** Evidence.' })).problem).toContain(
        'lower-case',
      );
    });

    it('refuses a failed spike whose fallback promises a reference instead of naming one', () => {
      const note = syntheticNote({
        Result: '**fail.** Clause 1 does not hold.',
        'Fallback executed': 'Pull request: *to be filled in when it is opened.*',
      });
      expect(fallbackProblem(note, 'fail')).toContain('names no pull request and no commit');
    });

    it('accepts a failed spike that names a pull request or a commit', () => {
      const withNumber = syntheticNote({ 'Fallback executed': 'Executed in #412.' });
      const withUrl = syntheticNote({
        'Fallback executed': 'https://github.com/iridium/iridium/pull/412 executed it.',
      });
      const withCommit = syntheticNote({ 'Fallback executed': 'Executed in commit 90a3ec6.' });
      expect(fallbackProblem(withNumber, 'fail')).toBe('');
      expect(fallbackProblem(withUrl, 'fail')).toBe('');
      expect(fallbackProblem(withCommit, 'fail')).toBe('');
    });

    it('requires `n/a` under "Fallback executed" when the spike passed', () => {
      const bare = syntheticNote({ 'Fallback executed': 'We took it anyway.' });
      expect(fallbackProblem(bare, 'pass')).toContain('opens with `n/a`');
      const declared = syntheticNote({ 'Fallback executed': 'n/a — the criterion was met.' });
      expect(fallbackProblem(declared, 'pass')).toBe('');
    });

    it('reports a note the register does not list', () => {
      expect(unregisteredNotes(['S01-a.md', 'S99-b.md'], new Set(['S01-a.md']))).toEqual([
        'S99-b.md',
      ]);
    });

    it('reads headings and table rows outside fenced code blocks only', () => {
      // S05 quotes a shell session whose comment would otherwise read as a heading, and the plan's
      // mermaid diagrams are full of pipes.
      const fenced = readNote(
        'S99-synthetic.md',
        '## Method\n\n```sh\n# from the repository root\n## Result\n```\n\n## Result\n\n**pass.**\n',
      );
      expect(fenced.sections.map((section) => section.heading)).toEqual(['Method', 'Result']);
      expect(verdictOf(fenced).verdict).toBe('pass');
    });
  });
});
