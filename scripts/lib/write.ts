/**
 * Deterministic writes for every generated artefact.
 *
 * `gen.drift.guard` is `pnpm gen && git diff --exit-code`, so a generator that is not
 * byte-deterministic turns the gate into a coin toss. Three rules make it deterministic:
 *
 *  - **LF only.** The repository normalises on LF (`.gitattributes` `* text=auto eol=lf`) and the
 *    development machine is Windows, so a generator that emitted CRLF would show the whole file as
 *    changed on every run.
 *  - **One trailing newline.** POSIX text files end in a newline; `.editorconfig` requires it.
 *  - **Two-space JSON.** The same indent `.editorconfig` fixes for source, so a human reading a
 *    generated document is not reading a different style from the rest of the repository.
 *
 * `writeIfChanged` compares before writing so a no-op run does not touch mtimes, which keeps Turbo's
 * and Vite's watchers quiet during `pnpm gen:check`.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative } from 'node:path';

import { REPO_ROOT } from './paths.ts';

/** What one write did, for the pipeline summary. */
export interface WriteOutcome {
  /** Repository-relative, forward slashes, so the summary reads the same on both platforms. */
  readonly path: string;
  readonly bytes: number;
  readonly changed: boolean;
}

/** Repository-relative path with forward slashes, for every message this pipeline prints. */
export function repoRelative(absolute: string): string {
  return relative(REPO_ROOT, absolute).replaceAll('\\', '/');
}

/** Normalise to LF with exactly one trailing newline. */
export function normalizeText(text: string): string {
  return `${text.replaceAll('\r\n', '\n').replace(/\n+$/, '')}\n`;
}

/**
 * Serialise a value the way every generated JSON artefact in this repository is serialised.
 *
 * Key order is the insertion order of the object the generator built, deliberately: the plan fixes
 * the order of several of these lists (MCP registration order, the §4.4 non-goal order, the
 * acceptance-row order), and sorting here would destroy information the gate is meant to protect.
 */
export function serializeJson(value: unknown): string {
  return normalizeText(JSON.stringify(value, null, 2));
}

/** Write `text` to `path`, creating parents, and report whether the bytes actually changed. */
export function writeIfChanged(path: string, text: string): WriteOutcome {
  const normalized = normalizeText(text);
  let previous: string | null = null;
  try {
    previous = readFileSync(path, 'utf8');
  } catch {
    previous = null;
  }
  const bytes = Buffer.byteLength(normalized, 'utf8');
  if (previous === normalized) {
    return { path: repoRelative(path), bytes, changed: false };
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, normalized, 'utf8');
  return { path: repoRelative(path), bytes, changed: true };
}

/** `writeIfChanged` for a JSON document. */
export function writeJsonIfChanged(path: string, value: unknown): WriteOutcome {
  return writeIfChanged(path, serializeJson(value));
}

/**
 * `writeIfChanged`, or the same comparison with the write suppressed.
 *
 * This is what makes `--check` "the same code path with the write suppressed"
 * (10-testing-and-quality.md, "Inventory completeness"): the artefact is computed either way, so the
 * check cannot pass on a generator that would have produced different bytes.
 */
export function writeOrCompare(path: string, text: string, check: boolean): WriteOutcome {
  if (!check) return writeIfChanged(path, text);
  const normalized = normalizeText(text);
  let previous: string | null = null;
  try {
    previous = readFileSync(path, 'utf8');
  } catch {
    previous = null;
  }
  return {
    path: repoRelative(path),
    bytes: Buffer.byteLength(normalized, 'utf8'),
    changed: previous !== normalized,
  };
}

/** `writeOrCompare` for a JSON document. */
export function writeJsonOrCompare(path: string, value: unknown, check: boolean): WriteOutcome {
  return writeOrCompare(path, serializeJson(value), check);
}

/**
 * The banner every generated source file carries.
 *
 * It names the generator and the command, because the first thing anyone does with an unexpected
 * diff in a generated file is look for who wrote it, and `linguist-generated` in `.gitattributes`
 * only hides it from review — it does not say what to run.
 */
export function generatedBanner(generator: string, source: string): string {
  return [
    '/**',
    ' * GENERATED FILE — do not edit.',
    ' *',
    ` * Written by \`${generator}\` from ${source}.`,
    ' * Run `pnpm gen` to regenerate; `gen.drift.guard` fails the `static` job on any difference.',
    ' */',
  ].join('\n');
}
