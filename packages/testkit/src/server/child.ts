/**
 * `startServer({ mode: 'child' })` — the only mode that can prove HP-1 and HP-2, because it is the
 * only one that can be `SIGKILL`ed mid-transaction (10-testing-and-quality.md, the mode table).
 *
 * It spawns the shipped binary — `node apps/server/dist/main.mjs serve --child` with `NODE_ENV=test` — and
 * reads the `{"listening":<port>}` line ARCH-01 requires the child to print on stdout. Nothing about
 * the boot path differs from production except the environment, which is the point.
 */
import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';

/** `stdio: ['ignore', 'pipe', 'pipe']`: no stdin, both outputs captured for assertions. */
type PipedChild = ChildProcessByStdio<null, Readable, Readable>;
import { createDeferred, withDeadline } from '../harness/deadline.ts';
import { SERVER_DIST_ENTRY, requireExistingPath } from '../paths.ts';
import { SERVER_NOT_BUILT_HINT } from './cli.ts';

export interface ChildServerOptions {
  readonly env: Readonly<Record<string, string>>;
  /** How long to wait for the `{"listening":<port>}` line. */
  readonly listenTimeoutMs?: number;
  /** Inherit the ambient environment as well (ARCH-25). On by default. */
  readonly inheritEnv?: boolean;
}

export interface ChildServer {
  readonly process: PipedChild;
  readonly port: number;
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
  /** Resolves with the exit code / signal once the process is gone. */
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  kill(signal: NodeJS.Signals): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

class ChildServerStartupError extends Error {
  constructor(cause: unknown, stdout: readonly string[], stderr: readonly string[]) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(
      `@iridium/testkit: the child server failed to start: ${reason}\nstdout:\n${stdout.join('\n')}\nstderr:\n${stderr.join('\n')}`,
      { cause },
    );
    this.name = 'ChildServerStartupError';
  }
}

const LISTENING = /\{"listening":\s*(\d+)\}/;

/** ARCH-01: the `child` mode reports its ephemeral port on stdout as `{"listening":<port>}`. */
function parseListeningPort(line: string): number | undefined {
  const match = LISTENING.exec(line);
  const raw = match?.[1];
  return raw === undefined ? undefined : Number.parseInt(raw, 10);
}

function ambientEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

/** Spawn the built server and resolve once it reports the port it is listening on. */
export async function startChildServer(options: ChildServerOptions): Promise<ChildServer> {
  requireExistingPath(SERVER_DIST_ENTRY, 'the built server binary', SERVER_NOT_BUILT_HINT);

  const child: PipedChild = spawn(process.execPath, [SERVER_DIST_ENTRY, 'serve', '--child'], {
    env: options.inheritEnv === false ? { ...options.env } : { ...ambientEnv(), ...options.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stdout: string[] = [];
  const stderr: string[] = [];
  const listening = createDeferred<number>();
  const exited = createDeferred<{ code: number | null; signal: NodeJS.Signals | null }>();
  // An error can reject `exited` before stdio closes. Startup cleanup still owns that lifetime.
  const closed = createDeferred<void>();

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  let stdoutBuffer = '';
  child.stdout.on('data', (chunk: string) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop() ?? '';
    for (const line of lines) {
      stdout.push(line);
      const reported = parseListeningPort(line);
      if (reported !== undefined) {
        listening.resolve(reported);
      }
    }
  });

  let stderrBuffer = '';
  child.stderr.on('data', (chunk: string) => {
    stderrBuffer += chunk;
    const lines = stderrBuffer.split('\n');
    stderrBuffer = lines.pop() ?? '';
    for (const line of lines) {
      stderr.push(line);
    }
  });

  child.on('error', (error) => {
    listening.reject(error);
    exited.reject(error);
  });
  child.on('close', (code, signal) => {
    if (stdoutBuffer !== '') {
      stdout.push(stdoutBuffer);
    }
    if (stderrBuffer !== '') {
      stderr.push(stderrBuffer);
    }
    listening.reject(
      new Error(
        `@iridium/testkit: the child server exited (${String(code ?? signal)}) before it reported a port.\n${stderr.join('\n')}`,
      ),
    );
    exited.resolve({ code, signal });
    closed.resolve(undefined);
  });

  // A spawn error rejects `exited` too; keep a handler on it so a failure never surfaces as an
  // unhandled rejection that kills an unrelated later test.
  void exited.promise.catch(() => undefined);

  const port = await withDeadline(listening.promise, {
    timeoutMs: options.listenTimeoutMs ?? 60_000,
    description: 'the child server to print {"listening":<port>} on stdout (ARCH-01)',
  }).catch(async (cause: unknown): Promise<never> => {
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
    // `close` also follows a failed spawn and captures the final, possibly unterminated output.
    await closed.promise;
    throw new ChildServerStartupError(cause, stdout, stderr);
  });

  return {
    process: child,
    port,
    stdout,
    stderr,
    exited: exited.promise,
    async kill(signal): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill(signal);
      }
      return exited.promise;
    },
  };
}
