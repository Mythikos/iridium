/**
 * The source walk and the comment/string mask the three collaboration guards share
 * (`collab.initial-state-only-path.guard`, `collab.no-reinit.guard`, `guards.seq-is-number.guard`).
 *
 * A guard that greps raw text fails on the comments that record the very rule it enforces, so every
 * scan runs over a view in which comments — and, where the construct cannot live in a string, string
 * contents — are replaced by spaces of the same length; a reported offset is still the real
 * `file:line`. The masking follows `guards.one-boot-path.guard` line for line.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT: string = fileURLToPath(new URL('../../../../', import.meta.url));

/** A scanned module: its repository-relative path and the three views the matchers read. */
export interface Source {
  readonly path: string;
  /** Comments and string/template/regex contents replaced by spaces, offsets preserved. */
  readonly code: string;
  /** Comments replaced by spaces, string contents intact, offsets preserved. */
  readonly noComments: string;
  /** The raw text, for rendering the reported line. */
  readonly raw: string;
}

function walk(dir: string, files: string[] = []): string[] {
  const entryStat = statSync(dir, { throwIfNoEntry: false });
  if (entryStat === undefined) return files; // a path not created at this milestone
  if (entryStat.isFile()) {
    if (/\.(?:tsx?|cts)$/.test(dir)) files.push(dir);
    return files;
  }
  const entries = readdirSync(dir);
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'dist' || entry === 'generated') continue;
    if (entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, files);
    else if (entry.endsWith('.ts') || entry.endsWith('.tsx') || entry.endsWith('.cts'))
      files.push(full);
  }
  return files;
}

/**
 * Replace comments — and, when asked, string, template and regular-expression literal contents —
 * with spaces, preserving every offset and newline so a match still reports the real line.
 */
export function mask(source: string, options: { readonly strings: boolean }): string {
  const out = source.split('');
  const erase = (from: number, to: number): void => {
    for (let index = from; index < to && index < out.length; index += 1) {
      if (out[index] !== '\n') out[index] = ' ';
    }
  };
  let previousSignificant = '';
  let index = 0;
  while (index < source.length) {
    const character = source[index] ?? '';
    const next = source[index + 1] ?? '';
    if (character === '/' && next === '/') {
      let end = index;
      while (end < source.length && source[end] !== '\n') end += 1;
      erase(index, end);
      index = end;
      continue;
    }
    if (character === '/' && next === '*') {
      const close = source.indexOf('*/', index + 2);
      const end = close === -1 ? source.length : close + 2;
      erase(index, end);
      index = end;
      continue;
    }
    if (character === '/' && !/[A-Za-z0-9_$)\]]/.test(previousSignificant)) {
      let end = index + 1;
      let inCharacterClass = false;
      while (end < source.length) {
        const inner = source[end];
        if (inner === '\\') {
          end += 2;
          continue;
        }
        if (inner === '[') inCharacterClass = true;
        else if (inner === ']') inCharacterClass = false;
        else if (inner === '\n') break;
        else if (inner === '/' && !inCharacterClass) break;
        end += 1;
      }
      if (options.strings) erase(index + 1, end);
      previousSignificant = '/';
      index = Math.min(end + 1, source.length);
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      let end = index + 1;
      while (end < source.length) {
        const inner = source[end];
        if (inner === '\\') {
          end += 2;
          continue;
        }
        if (inner === character) break;
        if (character !== '`' && inner === '\n') break;
        end += 1;
      }
      if (options.strings) erase(index + 1, end);
      previousSignificant = character;
      index = Math.min(end + 1, source.length);
      continue;
    }
    if (!/\s/.test(character)) previousSignificant = character;
    index += 1;
  }
  return out.join('');
}

/** The three views of one file's text. */
export function sourceOf(path: string, raw: string): Source {
  return {
    path,
    code: mask(raw, { strings: true }),
    noComments: mask(raw, { strings: false }),
    raw,
  };
}

/** Every TypeScript module under the repository-relative directories, as sources. */
export function sourcesUnder(dirs: readonly string[]): Source[] {
  return dirs.flatMap((dir) =>
    walk(join(REPO_ROOT, dir)).map((file) =>
      sourceOf(relative(REPO_ROOT, file).replaceAll('\\', '/'), readFileSync(file, 'utf8')),
    ),
  );
}

/** `file:line: <the source line>` for an offset into any of one source's three aligned views. */
export function locate(source: Source, offset: number): string {
  const line = source.code.slice(0, offset).split('\n').length;
  const text = (source.raw.split('\n')[line - 1] ?? '').trim();
  return `${source.path}:${String(line)}: ${text}`;
}

/** Whether a repository-relative path is a test or a test double: `*.spec.ts`, `test/`, `testing/`. */
export function isTestPath(path: string): boolean {
  return (
    /\.spec\.tsx?$/.test(path) ||
    path.includes('/test/') ||
    path.includes('/testing/') ||
    path.includes('/tests/')
  );
}

export function escapeForRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\/]/g, (character) => `\\${character}`);
}
