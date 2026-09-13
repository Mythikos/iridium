/**
 * A small, strict Markdown reader for the two generators that parse the plan
 * (`build-non-goals.ts` and `build-acceptance-map.ts`).
 *
 * It is deliberately not a Markdown parser. It understands exactly three shapes, because those are
 * the three the plan uses to state things a generator must read:
 *
 *  - **ATX headings**, so a generator can address "§4.4" rather than a line range;
 *  - **GFM pipe tables**, the plan's inventories;
 *  - **Bullet lists whose items start with a bold lead-in**, the plan's "non-goals the plan fixes
 *    beyond spec §10" form.
 *
 * Strictness is the point. Every function here throws with the heading or the table it could not
 * read rather than returning an empty result, because a generator that silently produces fewer
 * entries when the prose is reshaped is exactly the rot the drift gate exists to prevent
 * (10-testing-and-quality.md, "Inventory completeness"). A table whose shape defeats this reader is
 * a reported failure, never a guess.
 *
 * One escaping rule matters: the plan writes a literal pipe inside a table cell as `\|` (for example
 * `` `cycle \| depth \| cross_vault` ``). Cells are therefore split on unescaped pipes only, and the
 * escape is removed when the cell text is produced.
 */

/** One ATX heading and the body that follows it, up to the next heading of any level. */
export interface Section {
  /** `##` → 2, `###` → 3. */
  readonly level: number;
  /** The heading text with its Markdown intact, e.g. `4.4 Explicit non-goals`. */
  readonly title: string;
  /** 1-based line number of the heading itself, for error messages. */
  readonly line: number;
  /** The lines between this heading and the next, exclusive of both. */
  readonly body: readonly string[];
}

/** A parsed GFM pipe table. */
export interface Table {
  readonly headers: readonly string[];
  readonly rows: readonly (readonly string[])[];
  /** 1-based line number of the header row within the document, for error messages. */
  readonly line: number;
}

/** Split a document into its ATX headings. Lines inside fenced code blocks are ignored. */
export function readSections(markdown: string): Section[] {
  const lines = markdown.replaceAll('\r\n', '\n').split('\n');
  const sections: Section[] = [];
  let fenced = false;
  let current: { level: number; title: string; line: number; body: string[] } | null = null;

  for (const [index, line] of lines.entries()) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const heading = fenced ? null : /^(#{1,6})\s+(.*?)\s*$/.exec(line);
    if (heading !== null) {
      if (current !== null) sections.push(current);
      current = {
        level: heading[1]?.length ?? 0,
        title: heading[2] ?? '',
        line: index + 1,
        body: [],
      };
      continue;
    }
    current?.body.push(line);
  }
  if (current !== null) sections.push(current);
  return sections;
}

/**
 * The one section whose title starts with `prefix`. Throws when there is none or more than one, so a
 * renumbered or renamed section fails the generator instead of quietly emptying its output.
 */
export function requireSection(
  sections: readonly Section[],
  prefix: string,
  source: string,
): Section {
  const matches = sections.filter((section) => section.title.startsWith(prefix));
  if (matches.length === 1 && matches[0] !== undefined) return matches[0];
  const found = sections.map((section) => `  #${'#'.repeat(section.level - 1)} ${section.title}`);
  throw new Error(
    `${source}: expected exactly one section whose heading starts with ${JSON.stringify(prefix)}, ` +
      `found ${matches.length}. Headings in this document:\n${found.join('\n')}`,
  );
}

/** Split one table row into cells on unescaped pipes, unescaping `\|` in the result. */
export function splitRow(row: string): string[] {
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
  // end. Drop exactly those two, never an empty cell in the middle: several plan tables leave a
  // layer column blank on purpose, and that blank is data.
  if (cells.length >= 2 && cells[0] === '') cells.shift();
  if (cells.length >= 1 && cells.at(-1) === '') cells.pop();
  return cells;
}

function isDelimiterRow(line: string): boolean {
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{1,}:?$/.test(cell));
}

/**
 * Every pipe table in `lines`, in document order.
 *
 * `startLine` is the 1-based document line number of `lines[0]`, so error messages can point at the
 * file rather than at an offset inside a section body.
 */
export function readTables(lines: readonly string[], startLine = 1): Table[] {
  const tables: Table[] = [];
  let fenced = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced || !line.trimStart().startsWith('|')) continue;
    const delimiter = lines[index + 1];
    if (delimiter === undefined || !isDelimiterRow(delimiter)) continue;

    const headers = splitRow(line);
    const rows: string[][] = [];
    let cursor = index + 2;
    while (cursor < lines.length) {
      const candidate = lines[cursor] ?? '';
      if (!candidate.trimStart().startsWith('|')) break;
      rows.push(splitRow(candidate));
      cursor += 1;
    }
    tables.push({ headers, rows, line: startLine + index });
    index = cursor - 1;
  }
  return tables;
}

/**
 * The one table in `lines` whose header row equals `headers`, compared case-insensitively.
 *
 * This is how a generator addresses a table: by its columns, not by its position, so inserting a
 * paragraph above it changes nothing and renaming a column fails loudly.
 */
export function requireTable(
  lines: readonly string[],
  headers: readonly string[],
  source: string,
  startLine = 1,
): Table {
  const tables = readTables(lines, startLine);
  const wanted = headers.map((header) => header.toLowerCase());
  const matches = tables.filter(
    (table) =>
      table.headers.length === wanted.length &&
      table.headers.every((header, index) => header.toLowerCase() === wanted[index]),
  );
  if (matches.length === 1 && matches[0] !== undefined) return matches[0];
  const seen = tables.map((table) => `  line ${table.line}: | ${table.headers.join(' | ')} |`);
  throw new Error(
    `${source}: expected exactly one table with the columns | ${headers.join(' | ')} |, ` +
      `found ${matches.length}. Tables here:\n${seen.join('\n') || '  (none)'}`,
  );
}

/** One bullet of a list whose items open with a bold lead-in. */
export interface BoldBullet {
  /** The bold lead-in with its `**` and any trailing full stop removed. */
  readonly lead: string;
  /** The whole bullet, lead-in included, with the list marker removed. */
  readonly text: string;
  /** 1-based document line number of the bullet's first line. */
  readonly line: number;
}

/**
 * Bullets of the form `- **Lead-in.** rest…`, including continuation lines.
 *
 * A bullet without a bold lead-in is skipped rather than half-read: the plan uses plain bullets for
 * prose in the same sections, and a generator that treated those as entries would invent ids.
 */
export function readBoldBullets(lines: readonly string[], startLine = 1): BoldBullet[] {
  const bullets: BoldBullet[] = [];
  let fenced = false;
  let current: { lead: string; parts: string[]; line: number } | null = null;

  const flush = (): void => {
    if (current === null) return;
    bullets.push({ lead: current.lead, text: current.parts.join(' ').trim(), line: current.line });
    current = null;
  };

  for (const [index, raw] of lines.entries()) {
    if (/^\s*(```|~~~)/.test(raw)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const bullet = /^\s*[-*]\s+(.*)$/.exec(raw);
    if (bullet !== null) {
      flush();
      const body = bullet[1] ?? '';
      const bold = /^\*\*(.+?)\*\*/.exec(body);
      if (bold === null) continue;
      current = {
        lead: (bold[1] ?? '').replace(/\.$/, '').trim(),
        parts: [body],
        line: startLine + index,
      };
      continue;
    }
    if (raw.trim() === '') {
      flush();
      continue;
    }
    if (current !== null && /^\s{2,}\S/.test(raw)) current.parts.push(raw.trim());
    else flush();
  }
  flush();
  return bullets;
}

/** Every `` `code span` `` in a string, in order, without the backticks. */
export function codeSpans(text: string): string[] {
  return [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? '');
}

/** Strip the Markdown emphasis, links and code fences a cell may carry, leaving readable prose. */
export function plainText(cell: string): string {
  return cell
    .replaceAll(/`([^`]*)`/g, '$1')
    .replaceAll(/\*\*([^*]*)\*\*/g, '$1')
    .replaceAll(/(?<!\*)\*([^*]+)\*(?!\*)/g, '$1')
    .replaceAll(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replaceAll(/\s+/g, ' ')
    .trim();
}
