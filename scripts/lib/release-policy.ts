/** Release selection and current-version operator notes (D12-1/D12-2 and OPS-29). */
export const MIGRATION_ROOTS: readonly string[] = [
  'apps/server/migrations/',
  'apps/server/src/migrations/',
];

export interface ReleasePlan {
  readonly version: string;
  readonly milestone: string;
  readonly jobs: Readonly<{
    verify: boolean;
    server_image: boolean;
    bridge: boolean;
    desktop: boolean;
    release_feed: boolean;
    drill: boolean;
  }>;
}

/** Canonical SemVer product tags, including prereleases; package tags are not product releases. */
export function productVersion(tag: string): string | null {
  const numeric = '(?:0|[1-9][0-9]*)';
  const prereleasePart = `(?:${numeric}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)`;
  const pattern = new RegExp(
    `^v(${numeric}\\.${numeric}\\.${numeric}(?:-${prereleasePart}(?:\\.${prereleasePart})*)?)$`,
  );
  return pattern.exec(tag)?.[1] ?? null;
}

export class ReleasePolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReleasePolicyError';
  }
}

/** CURRENT is the last exited milestone, never an override supplied by a workflow dispatch. */
export function selectRelease(tag: string, packageVersion: string, current: string): ReleasePlan {
  const version = productVersion(tag);
  if (version === null) throw new ReleasePolicyError(`Not a canonical product release tag: ${tag}`);
  if (version !== packageVersion) {
    throw new ReleasePolicyError(
      `Tag ${tag} does not match apps/server/package.json ${packageVersion}`,
    );
  }
  if (!/^M[0-8]$/.test(current)) {
    throw new ReleasePolicyError(`Invalid docs/milestones/CURRENT: ${current}`);
  }
  const [major, minor] = version.split('.');
  const milestone = Number(current.slice(1));
  if ((major === '0' && minor !== String(milestone)) || (major !== '0' && milestone !== 8)) {
    throw new ReleasePolicyError(`Tag ${tag} is inconsistent with exited milestone ${current}`);
  }
  return {
    version,
    milestone: current,
    jobs: {
      verify: milestone >= 1,
      server_image: milestone >= 1,
      bridge: milestone >= 3,
      desktop: milestone >= 5,
      release_feed: milestone >= 5,
      drill: milestone >= 8,
    },
  };
}

/** Stable aliases never move to a prerelease. The exact version is always published. */
export function releaseImageTags(version: string, repository: string): string[] {
  if (productVersion(`v${version}`) === null)
    throw new ReleasePolicyError(`Invalid image version: ${version}`);
  if (repository.length === 0 || /[\s,]/.test(repository)) {
    throw new ReleasePolicyError('IMAGE_NAME must name one image repository');
  }
  const [major = '', minor = ''] = version.split('.');
  const versions = version.includes('-') ? [version] : [version, `${major}.${minor}`, major];
  return versions.map((value) => `${repository}:${value}`);
}

function punctuation(character: string | undefined): boolean {
  const code = character?.codePointAt(0) ?? 0;
  return (
    (code >= 33 && code <= 47) ||
    (code >= 58 && code <= 64) ||
    (code >= 91 && code <= 96) ||
    (code >= 123 && code <= 126)
  );
}

/** End of a complete CommonMark destination, including escaped and balanced parentheses. */
function destinationEnd(text: string, start: number): number | null {
  const angle = text[start] === '<';
  let cursor = start + (angle ? 1 : 0);
  let depth = 0;
  while (cursor < text.length) {
    const character = text[cursor] ?? '';
    if (character === '\\' && punctuation(text[cursor + 1])) {
      cursor += 2;
      continue;
    }
    if (angle) {
      if (character === '>') return cursor + 1;
      if (character === '<' || character === '\n') return null;
    } else {
      const code = character.charCodeAt(0);
      if (code <= 32 || code === 127) break;
      if (character === '(') depth++;
      if (character === ')') {
        if (depth === 0) return null;
        depth--;
      }
    }
    cursor++;
  }
  return !angle && cursor > start && depth === 0 ? cursor : null;
}

function finishDefinitionLine(text: string, start: number): number | null {
  let cursor = start;
  while (text[cursor] === ' ' || text[cursor] === '\t') cursor++;
  if (cursor === text.length) return cursor;
  return text[cursor] === '\n' ? cursor + 1 : null;
}

function titleEnd(text: string, start: number): number | null {
  const opening = text[start];
  if (opening !== '"' && opening !== "'" && opening !== '(') return null;
  const closing = opening === '(' ? ')' : opening;
  for (let cursor = start + 1; cursor < text.length; cursor++) {
    const character = text[cursor];
    if (character === '\\' && punctuation(text[cursor + 1])) {
      cursor++;
      continue;
    }
    if (opening === '(' && character === '(') return null;
    if (character === closing) {
      return /\n[ \t]*\n/.test(text.slice(start, cursor)) ? null : cursor + 1;
    }
  }
  return null;
}

/** Reference definitions may continue their label, destination and title on subsequent lines. */
function referenceDefinitionEnd(text: string, start: number): number | null {
  const prefix = /^ {0,3}\[((?:\\.|[^[\]\\]){1,999})\]:[ \t]*/u.exec(text.slice(start));
  if (prefix === null || (prefix[1] ?? '').trim() === '' || /\n[ \t]*\n/.test(prefix[1] ?? ''))
    return null;
  let cursor = start + prefix[0].length;
  if (text[cursor] === '\n') {
    cursor++;
    while (text[cursor] === ' ' || text[cursor] === '\t') cursor++;
  }
  const destination = destinationEnd(text, cursor);
  if (destination === null) return null;
  const withoutTitle = finishDefinitionLine(text, destination);
  cursor = destination;
  while (text[cursor] === ' ' || text[cursor] === '\t') cursor++;
  if (text[cursor] === '\n') {
    cursor++;
    while (text[cursor] === ' ' || text[cursor] === '\t') cursor++;
  }
  // A title needs separating whitespace. Invalid content on the destination's line makes the
  // whole definition visible; invalid following-line content remains its own visible paragraph.
  if (cursor === destination) return withoutTitle;
  const title = titleEnd(text, cursor);
  return title === null ? withoutTitle : (finishDefinitionLine(text, title) ?? withoutTitle);
}

function withoutReferenceDefinitions(lines: readonly string[]): string[] {
  const text = lines.join('\n');
  const visible: string[] = [];
  let cursor = 0;
  let paragraph = false;
  while (cursor < text.length) {
    const definition = paragraph ? null : referenceDefinitionEnd(text, cursor);
    if (definition !== null) {
      cursor = definition;
      continue;
    }
    const newline = text.indexOf('\n', cursor);
    const end = newline === -1 ? text.length : newline;
    const line = text.slice(cursor, end);
    if (!/^(?: {4}|\t)/.test(line)) visible.push(line);
    // Definitions cannot interrupt a paragraph (CommonMark 4.7). Changesets emits ATX release
    // and subsection headings and ordinary list paragraphs; blank lines end those paragraphs.
    paragraph = line.trim() !== '' && !/^ {0,3}(?:#{1,6}(?:[ \t]|$)|(?:=+|-+)[ \t]*$)/.test(line);
    cursor = end + 1;
  }
  return visible;
}

/**
 * Visible lines of the pinned Changesets Markdown format. Match fence character and length so a
 * shorter nested fence cannot expose a quoted historical flag. HTML comments, indented code,
 * and link-reference definitions are not operator notes. Inline code remains visible:
 * `[migration]` is a valid printed flag.
 */
function visibleLines(markdown: string): string[] {
  const visible: string[] = [];
  let fence: { character: string; length: number } | null = null;
  let comment = false;
  for (const original of markdown.split(/\r?\n/)) {
    if (fence !== null) {
      const closing = /^ {0,3}(`+|~+)\s*$/.exec(original)?.[1];
      if (
        closing !== undefined &&
        closing[0] === fence.character &&
        closing.length >= fence.length
      ) {
        fence = null;
      }
      continue;
    }
    let line = '';
    let cursor = 0;
    while (cursor < original.length) {
      if (comment) {
        const end = original.indexOf('-->', cursor);
        if (end === -1) break;
        comment = false;
        cursor = end + 3;
      } else {
        const start = original.indexOf('<!--', cursor);
        if (start === -1) {
          line += original.slice(cursor);
          break;
        }
        line += original.slice(cursor, start);
        comment = true;
        cursor = start + 4;
      }
    }
    const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (opening?.[1] !== undefined) {
      fence = { character: opening[1][0] ?? '', length: opening[1].length };
      continue;
    }
    visible.push(line);
  }
  return withoutReferenceDefinitions(visible);
}

/** The required flag must belong to the new server release, never an earlier release's notes. */
export function releaseNoteIssues(
  changelog: string,
  version: string,
  changedPaths: readonly string[],
): string[] {
  const lines = visibleLines(changelog);
  const headings = lines.flatMap((line, index) => {
    const title = /^ {0,3}##[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/.exec(line)?.[1];
    return title === undefined ? [] : [{ title, index }];
  });
  const matching = headings.filter((heading) => heading.title === version);
  if (matching.length !== 1 || headings[0]?.title !== version) {
    return [`apps/server/CHANGELOG.md must begin with exactly one ## ${version} release section`];
  }
  const start = matching[0]?.index;
  if (start === undefined) throw new Error('Matching release heading disappeared');
  const remaining = lines.slice(start + 1);
  const next = remaining.findIndex((line) => /^ {0,3}#{1,2}(?:[ \t]|$)/.test(line));
  const body = remaining.slice(0, next === -1 ? undefined : next).join('\n');
  const migrations = changedPaths.filter((path) =>
    MIGRATION_ROOTS.some((root) => path.startsWith(root)),
  );
  if (migrations.length > 0 && !/(?<!\\)\[migration\]/.test(body)) {
    return [
      `apps/server/CHANGELOG.md ## ${version} needs a visible [migration] flag for: ${migrations.join(', ')}`,
    ];
  }
  return [];
}
