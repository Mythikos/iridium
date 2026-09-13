/**
 * Running the pinned command-line tools of the codegen pipeline.
 *
 * Two decisions, both about Windows. The development machine is Windows and CI is Linux, and a
 * pipeline that behaves differently on the two is a pipeline whose drift gate cannot be trusted.
 *
 *  - **Binaries are resolved to their JavaScript entry point and run under `process.execPath`,**
 *    never through `node_modules/.bin`. On Windows that directory holds `.cmd` shims, which need
 *    `shell: true`, which reintroduces quoting rules that differ between `cmd.exe` and a POSIX
 *    shell. Resolving the package's own `bin` entry and spawning `node <entry> …` removes the shell
 *    from the pipeline entirely, so argument arrays mean the same thing on both platforms.
 *  - **A missing tool is an error with a remedy, never a skip.** Every tool the plan pins is
 *    supposed to be installed; when one is not, the step says which package declares it and what to
 *    add, because a drift gate that silently skips a step is worse than a red one.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { isRecord, parseJson, stringMember } from './json.ts';
import { repoRelative } from './write.ts';

/** A pinned command-line tool and the workspace whose manifest declares it. */
export interface ToolSpec {
  /** The npm package name, e.g. `kysely-codegen`. */
  readonly pkg: string;
  /**
   * The `bin` entry to run. Omit when the package's `bin` is a bare string or has one entry whose
   * key equals the package name.
   */
  readonly bin?: string;
  /** Absolute path of the workspace directory whose `node_modules` should resolve the package. */
  readonly from: string;
  /** The catalog version the plan pins, printed in the summary so a mismatch is visible. */
  readonly pinnedVersion: string;
}

/** A tool that resolved, with the exact file that will be executed. */
export interface ResolvedTool {
  readonly pkg: string;
  readonly entry: string;
  readonly version: string;
  readonly pinnedVersion: string;
}

/** Thrown when a pinned tool is not installed. Carries the remedy, not just the absence. */
export class MissingToolError extends Error {
  readonly pkg: string;

  constructor(spec: ToolSpec, cause: string) {
    super(
      `${spec.pkg} is not installed (the plan pins ${spec.pkg}@${spec.pinnedVersion}).\n` +
        `  Looked under ${repoRelative(spec.from)}/node_modules — ${cause}\n` +
        `  Remedy: add "${spec.pkg}": "catalog:" to ${repoRelative(spec.from)}/package.json ` +
        'devDependencies and run `pnpm install`.',
    );
    this.name = 'MissingToolError';
    this.pkg = spec.pkg;
  }
}

/** Thrown when a tool ran and failed. Carries the command and both streams. */
export class ToolFailedError extends Error {
  readonly exitCode: number;

  constructor(label: string, exitCode: number, stdout: string, stderr: string) {
    const streams = [stdout.trim(), stderr.trim()].filter((s) => s !== '').join('\n');
    super(`${label} exited ${exitCode}${streams === '' ? '' : `\n${streams}`}`);
    this.name = 'ToolFailedError';
    this.exitCode = exitCode;
  }
}

function binEntry(manifest: unknown, spec: ToolSpec): string | null {
  if (!isRecord(manifest)) return null;
  const bin = manifest['bin'];
  if (typeof bin === 'string') return bin;
  if (isRecord(bin)) {
    const direct = bin[spec.bin ?? spec.pkg];
    if (typeof direct === 'string') return direct;
    const only = Object.values(bin);
    const single = only[0];
    if (spec.bin === undefined && only.length === 1 && typeof single === 'string') return single;
  }
  return null;
}

/** Resolve a pinned tool to the JavaScript file `node` should run. */
export function resolveTool(spec: ToolSpec): ResolvedTool {
  const require = createRequire(join(spec.from, 'package.json'));
  let manifestPath: string;
  try {
    manifestPath = require.resolve(`${spec.pkg}/package.json`);
  } catch {
    throw new MissingToolError(spec, 'the package is not in the dependency graph.');
  }
  const manifest = parseJson(readFileSync(manifestPath, 'utf8'));
  const entry = binEntry(manifest, spec);
  if (entry === null) {
    throw new MissingToolError(spec, `its manifest declares no "${spec.bin ?? spec.pkg}" bin.`);
  }
  const version = stringMember(manifest, 'version') ?? 'unknown';
  return {
    pkg: spec.pkg,
    entry: join(dirname(manifestPath), entry),
    version,
    pinnedVersion: spec.pinnedVersion,
  };
}

/** What a completed process reported. */
export interface RunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface RunOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  /** Bytes of captured output before the child is killed. Generated documents can be large. */
  readonly maxBuffer?: number;
}

const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;

/** Run a resolved tool under the current Node binary and return its streams. */
export function runTool(
  tool: ResolvedTool,
  args: readonly string[],
  options: RunOptions = {},
): RunResult {
  const result = spawnSync(process.execPath, [tool.entry, ...args], {
    cwd: options.cwd,
    env: options.env === undefined ? process.env : { ...process.env, ...options.env },
    encoding: 'utf8',
    maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
    // No shell: the argument array is passed to the process verbatim on every platform.
    shell: false,
    windowsHide: true,
  });
  if (result.error !== undefined) throw result.error;
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? 1,
  };
}

/** `runTool`, but a non-zero exit is a `ToolFailedError` carrying both streams. */
export function runToolOrThrow(
  tool: ResolvedTool,
  args: readonly string[],
  options: RunOptions = {},
): RunResult {
  const result = runTool(tool, args, options);
  if (result.exitCode !== 0) {
    throw new ToolFailedError(
      `${tool.pkg}@${tool.version}`,
      result.exitCode,
      result.stdout,
      result.stderr,
    );
  }
  return result;
}
