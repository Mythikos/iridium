/**
 * Typed fixture accessors (10-testing-and-quality.md, "Test data and fixtures policy").
 *
 * Every committed corpus is reached through this module rather than by a path literal, so a fixture
 * that moves breaks one file instead of thirty, and so the accessors can carry what the policy
 * requires: synthetic content only, loaded through product paths, and a version that golden artefacts
 * embed (`IRIDIUM_FIXTURE_VERSION`, rule 7).
 *
 * The corpora are **data**, not code: `.oxfmtrc.jsonc` and `oxlint.config.ts` both exclude
 * `packages/testkit/src/fixtures/**`, because reformatting a CRLF file or a hostile Markdown vector
 * would destroy the thing under test. This module is the one file in that directory that is neither.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { FIXTURES_ROOT } from '../paths.ts';

/**
 * Bumped whenever a committed fixture's content changes (fixture policy rule 7). Golden artefacts
 * embed it, so a stale golden fails loudly instead of quietly comparing against the wrong input.
 */
export const IRIDIUM_FIXTURE_VERSION = 1;

/** The vault corpora that enter the system through the real import job (fixture policy rule 2). */
export type FixtureVaultName = 'demo' | 'obsidian-sample';

/** Absolute path to a fixture vault's root directory. */
export function fixtureVaultPath(name: FixtureVaultName): string {
  return join(FIXTURES_ROOT, 'vaults', name);
}

/** Absolute path to the hostile Markdown corpus (10-testing-and-quality.md, "The hostile corpus"). */
export const HOSTILE_CORPUS_PATH: string = join(FIXTURES_ROOT, 'hostile');

/** Absolute path to the vendored CommonMark example set; see its `PROVENANCE.md`. */
export const COMMONMARK_SPEC_PATH: string = join(FIXTURES_ROOT, 'commonmark', 'spec.json');

export interface FixtureFile {
  /** Path relative to the corpus root, always with `/` separators, whatever the host OS uses. */
  readonly path: string;
  readonly absolutePath: string;
  readonly bytes: number;
}

function walk(root: string, current: string, out: FixtureFile[]): void {
  for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const absolutePath = join(current, entry.name);
    if (entry.isDirectory()) {
      walk(root, absolutePath, out);
      continue;
    }
    out.push({
      path: relative(root, absolutePath).split(sep).join('/'),
      absolutePath,
      bytes: statSync(absolutePath).size,
    });
  }
}

/**
 * Every file in a fixture directory, depth-first and sorted, **including** dotfiles: `.obsidian/` and
 * `.trash/` are exactly what the Obsidian importer has to decide about, so a listing that hid them
 * would hide the test.
 */
export function listFixtureFiles(root: string): readonly FixtureFile[] {
  const out: FixtureFile[] = [];
  walk(root, root, out);
  return out;
}

/** Raw bytes, for the CRLF, CR and BOM cases where the encoding *is* the fixture. */
export function readFixtureBytes(absolutePath: string): Buffer {
  return readFileSync(absolutePath);
}

/** UTF-8 text, byte-for-byte: no line-ending normalisation and no BOM stripping. */
export function readFixtureText(absolutePath: string): string {
  return readFileSync(absolutePath, 'utf8');
}

/** One CommonMark conformance example. */
export interface CommonMarkExample {
  readonly markdown: string;
  readonly html: string;
  readonly example: number;
  readonly start_line: number;
  readonly end_line: number;
  readonly section: string;
}

/** The 652 examples of CommonMark 0.31.2, in specification order. */
export function readCommonMarkExamples(): readonly CommonMarkExample[] {
  return JSON.parse(readFileSync(COMMONMARK_SPEC_PATH, 'utf8')) as CommonMarkExample[];
}

/** What `expectations.json` says must **not** appear for one hostile fixture. */
export interface HostileExpectation {
  /** The vector class of the table in 10-testing-and-quality.md, "The hostile corpus". */
  readonly class: string;
  readonly forbiddenTags: readonly string[];
  readonly forbiddenAttributes: readonly string[];
  readonly forbiddenUrlSchemes: readonly string[];
  /** Observable side effects for the browser and Electron layers. */
  readonly forbiddenEffects: readonly string[];
  /** The positive half: text that must survive verbatim (fenced code keeps hostile markup as text). */
  readonly mustContain: readonly string[];
  readonly forbiddenIds?: readonly string[];
  readonly forbiddenClassPrefixes?: readonly string[];
  readonly requiredIdPrefix?: string;
}

export interface HostileCorpus {
  readonly fixtureVersion: number;
  /** The host every "did a request escape?" assertion watches for. */
  readonly sinkHost: string;
  readonly files: Readonly<Record<string, HostileExpectation>>;
}

/** The corpus manifest defines membership; workspace metadata such as CHANGELOG.md is not input. */
export function readHostileCorpus(): HostileCorpus {
  return JSON.parse(
    readFileSync(join(HOSTILE_CORPUS_PATH, 'expectations.json'), 'utf8'),
  ) as HostileCorpus;
}

class UndeclaredHostileFixtureError extends Error {
  constructor(name: string) {
    super(`Hostile fixture ${name} is not declared in expectations.json; add its security expectations before reading it as corpus input.`);
    this.name = 'UndeclaredHostileFixtureError';
  }
}

/** The Markdown source of one hostile fixture, restricted to an `expectations.json` key. */
export function readHostileFixture(name: string): string {
  if (!Object.hasOwn(readHostileCorpus().files, name)) throw new UndeclaredHostileFixtureError(name);
  return readFileSync(join(HOSTILE_CORPUS_PATH, name), 'utf8');
}
