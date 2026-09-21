/**
 * Running the product's own CLI (`apps/server/dist/main.mjs`) as a child process.
 *
 * Fixture policy rule 2 is that state enters the system through product paths, and the first one every
 * suite needs is `iridium migrate up`: the template schema and every per-worker schema are migrated by
 * the shipped migrator under the `iridium_migrator` role, never by a SQL file
 * (10-testing-and-quality.md, "Environment: `startTestEnv`"). The same entry point later carries
 * `iridium admin create-user`, `iridium backup` and the operator drills, so the spawn lives here once.
 */
import { spawn } from 'node:child_process';

import { SERVER_DIST_ENTRY, requireExistingPath } from '../paths.ts';
import type { DatabasePasswords } from './env.ts';
import { buildServerEnv } from './env.ts';

export interface CliResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CliOptions {
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

/** The message every "the server was not built" failure produces, in one place. */
export const SERVER_NOT_BUILT_HINT =
  'Build it first: `pnpm turbo run build --filter=@iridium/server`. The child and container harness modes, and every migration the fixture runs, drive the shipped binary rather than a second boot path.';

function inheritedEnv(): Record<string, string> {
  // ARCH-25: the child inherits the whole job environment on purpose — `EnvSchema` lists the reserved
  // harness namespaces as known-and-ignored so that inheriting `IRIDIUM_PROP_RUNS` or
  // `IRIDIUM_MYSQL_IMAGE` cannot stop the process from listening.
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

/** Run `iridium <args…>` to completion. Never throws on a non-zero exit; the caller decides. */
export async function runIridiumCli(
  args: readonly string[],
  options: CliOptions = {},
): Promise<CliResult> {
  requireExistingPath(SERVER_DIST_ENTRY, 'the built server binary', SERVER_NOT_BUILT_HINT);

  const child = spawn(process.execPath, [SERVER_DIST_ENTRY, ...args], {
    env: { ...inheritedEnv(), ...options.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
  });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  return new Promise<CliResult>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });
}

export interface MigrateOptions {
  readonly passwords?: DatabasePasswords;
  readonly extraEnv?: Readonly<Record<string, string>>;
  /** The MySQL coordinates on this machine; a container object is never needed. */
  readonly host: string;
  readonly port: number;
  readonly schema: string;
  /** Only used to satisfy the `PUBLIC_ORIGIN` requirement of `EnvSchema`; nothing listens. */
  readonly publicOrigin?: string;
  readonly timeoutMs?: number;
}

/**
 * Apply every migration to a schema through `iridium migrate up`, under `DATABASE_MIGRATE_URL`
 * (the `iridium_migrator` role — the only one that may execute DDL).
 */
export async function migrateSchema(options: MigrateOptions): Promise<void> {
  const env = buildServerEnv({
    host: options.host,
    port: options.port,
    schema: options.schema,
    ...(options.passwords === undefined ? {} : { passwords: options.passwords }),
    ...(options.extraEnv === undefined ? {} : { extraEnv: options.extraEnv }),
    publicOrigin: options.publicOrigin ?? 'http://127.0.0.1:4000',
  });
  // Disposable schemas explicitly authorize rebuilds through the same flag an operator uses.
  const result = await runIridiumCli(['migrate', 'up', '--allow-long-running'], {
    env,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  if (result.code !== 0) {
    throw new Error(
      `@iridium/testkit: \`iridium migrate up\` on schema ${options.schema} exited ${String(result.code ?? result.signal)}.\n${result.stderr || result.stdout}`,
    );
  }
}
