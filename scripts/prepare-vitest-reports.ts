/** Preserve raw lane blobs, then relocate copies to the merge runner before evaluating coverage. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { isRecord, parseJson } from './lib/json.ts';
import { REPO_ROOT } from './lib/paths.ts';

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function commit(): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
}

function reports(directory: string): string[] {
  const names = readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .toSorted();
  if (names.length === 0) throw new Error(`No Vitest blobs in ${directory}`);
  return names;
}

/** Capture alongside each raw blob; unique lane names also keep the sidecars collision-free. */
export function capture(directory: string, root: string, sha: string): void {
  for (const name of reports(directory)) {
    const raw = readFileSync(join(directory, name), 'utf8');
    writeFileSync(
      join(directory, `${name}.origin`),
      JSON.stringify({ format: 1, root, commit: sha, sha256: digest(raw) }) + '\n',
    );
  }
}

/** Rewrite only a complete root prefix, including native Windows paths and file URLs. */
function relocate(value: string, sourceRoot: string, targetRoot: string): string {
  const source = sourceRoot.replaceAll('\\', '/').replace(/\/$/, '');
  const target = targetRoot.replaceAll('\\', '/').replace(/\/$/, '');
  const unix = value.replaceAll('\\', '/');
  if (unix === source || unix.startsWith(`${source}/`)) return target + unix.slice(source.length);
  const sourceUrl = /^[A-Za-z]:\//.test(source) ? `file:///${source}` : `file://${source}`;
  if (unix === sourceUrl || unix.startsWith(`${sourceUrl}/`)) {
    const targetUrl = /^[A-Za-z]:\//.test(target) ? `file:///${target}` : `file://${target}`;
    return targetUrl + unix.slice(sourceUrl.length);
  }
  return value;
}

/**
 * Vitest 5's blob is a flatted string pool. Keep every index, reference and numeric counter;
 * relocating both string values and object keys joins coverage for one source across OSes.
 * Reject a format change or a key collision instead of silently losing evidence.
 */
export function relocateBlob(raw: string, sourceRoot: string, targetRoot: string): string {
  const pool = parseJson(raw);
  if (!Array.isArray(pool) || !Array.isArray(pool[0]) || pool[0].length !== 6) {
    throw new Error('Unsupported Vitest blob format');
  }
  const version: unknown = pool[Number(pool[0][0])];
  if (typeof version !== 'string' || !version.startsWith('5.')) {
    throw new Error('Expected a Vitest 5 blob');
  }
  function visit(value: unknown): unknown {
    if (typeof value === 'string') return relocate(value, sourceRoot, targetRoot);
    if (Array.isArray(value)) return value.map(visit);
    if (!isRecord(value)) return value;
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const relocated = relocate(key, sourceRoot, targetRoot);
      if (Object.hasOwn(result, relocated))
        throw new Error(`Relocated key collision: ${relocated}`);
      Object.defineProperty(result, relocated, {
        value: visit(child),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return result;
  }
  return JSON.stringify(visit(pool));
}

/** Verify origin and integrity before producing a separate directory containing only merge blobs. */
export function prepare(input: string, output: string, root: string, sha: string): void {
  if (resolve(input) === resolve(output)) throw new Error('Raw reports must remain unchanged');
  const prepared = reports(input).map((name) => {
    const raw = readFileSync(join(input, name), 'utf8');
    const origin = parseJson(readFileSync(join(input, `${name}.origin`), 'utf8'));
    if (
      !isRecord(origin) ||
      origin['format'] !== 1 ||
      typeof origin['root'] !== 'string' ||
      origin['commit'] !== sha ||
      origin['sha256'] !== digest(raw)
    ) {
      throw new Error(`Invalid origin, commit or checksum for ${name}`);
    }
    return { name, relocated: relocateBlob(raw, origin['root'], root) };
  });
  mkdirSync(output, { recursive: true });
  if (readdirSync(output).length > 0) throw new Error('Merge output directory must be empty');
  for (const { name, relocated } of prepared) writeFileSync(join(output, name), relocated);
}

if (import.meta.main) {
  try {
    const [mode, input, output] = process.argv.slice(2);
    if (mode === 'capture' && input !== undefined && output === undefined) {
      capture(resolve(REPO_ROOT, input), REPO_ROOT, commit());
    } else if (
      mode === 'merge' &&
      input !== undefined &&
      output !== undefined &&
      process.argv.length === 5
    ) {
      prepare(resolve(REPO_ROOT, input), resolve(REPO_ROOT, output), REPO_ROOT, commit());
    } else {
      throw new Error(
        'Usage: prepare-vitest-reports.ts capture <raw-dir> | merge <raw-dir> <merge-dir>',
      );
    }
    console.info(`Vitest report ${mode} complete (${pathToFileURL(REPO_ROOT).href})`);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
