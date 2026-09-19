/**
 * Child startup owns the process until the listening handshake transfers it to the caller. Failed
 * startup must await process and stdio closure so another test inherits neither a child nor lost logs.
 */
import type * as ChildProcessApi from 'node:child_process';
import { ChildProcess, spawn } from 'node:child_process';
import type * as FileSystem from 'node:fs';
import { existsSync } from 'node:fs';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeferred, withDeadline } from './harness/deadline.ts';
import { SERVER_DIST_ENTRY } from './paths.ts';
import { startChildServer } from './server/child.ts';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcessApi>();
  return { ...actual, spawn: vi.fn<typeof spawn>() };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof FileSystem>();
  return { ...actual, existsSync: vi.fn<typeof existsSync>(actual.existsSync) };
});

beforeEach(async () => {
  const actual = await vi.importActual<typeof FileSystem>('node:fs');
  // Unit tests drive the process adapter without requiring a prior server build. Every other path
  // still reaches the real filesystem, and requireExistingPath itself remains under test.
  vi.mocked(existsSync).mockImplementation(
    (path) => path === SERVER_DIST_ENTRY || actual.existsSync(path),
  );
});

afterEach(() => {
  vi.mocked(spawn).mockReset();
  vi.mocked(existsSync).mockReset();
  vi.restoreAllMocks();
});

function childDouble() {
  const child = new ChildProcess();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.assign(child, { pid: 12345, stdin: null, stdout, stderr });
  const killRequested = createDeferred<void>();
  const kill = vi.spyOn(child, 'kill').mockImplementation(() => {
    killRequested.resolve(undefined);
    return true;
  });
  vi.mocked(spawn).mockReturnValue(child);

  return {
    child,
    stdout,
    stderr,
    kill,
    killRequested: killRequested.promise,
    close(code: number | null, signal: NodeJS.Signals | null): void {
      Object.assign(child, { exitCode: code, signalCode: signal });
      child.emit('close', code, signal);
      stdout.destroy();
      stderr.destroy();
    },
  };
}

describe('testkit.child-server.unit [area:testkit]', () => {
  it('kills a child that never listens and awaits close before rejecting with both output streams', async () => {
    const fake = childDouble();
    const settled = vi.fn<(value: unknown) => unknown>((value) => value);
    const outcome = startChildServer({ env: {}, listenTimeoutMs: 0 }).then(settled, settled);
    fake.stdout.write('boot began\npartial stdout');
    fake.stderr.write('invalid configuration');

    await withDeadline(fake.killRequested, { description: 'the startup cleanup signal' });
    expect(fake.kill).toHaveBeenCalledWith('SIGKILL');
    expect(settled).not.toHaveBeenCalled();

    fake.stdout.write(' after kill');
    fake.stderr.write(' before close');
    fake.close(null, 'SIGKILL');
    const failure = await outcome;
    expect(failure).toMatchObject({
      name: 'ChildServerStartupError',
      cause: { name: 'WaitTimeoutError', timeoutMs: 0 },
      message: expect.stringContaining('stdout:\nboot began\npartial stdout after kill'),
    });
    expect(failure).toHaveProperty(
      'message',
      expect.stringContaining('stderr:\ninvalid configuration before close'),
    );
    expect(fake.kill).toHaveBeenCalledTimes(1);
  });

  it('reports an early exit with its code and unterminated diagnostics without killing it again', async () => {
    const fake = childDouble();
    const failure = startChildServer({ env: {} }).catch((cause: unknown) => cause);
    fake.stdout.write('reading env');
    fake.stderr.write('PUBLIC_ORIGIN is invalid');
    fake.close(2, null);

    expect(await failure).toMatchObject({
      name: 'ChildServerStartupError',
      message: expect.stringMatching(
        /exited \(2\) before it reported a port[\s\S]*stdout:\nreading env[\s\S]*stderr:\nPUBLIC_ORIGIN is invalid/,
      ),
    });
    expect(fake.kill).not.toHaveBeenCalled();
  });

  it('rejects a failed spawn safely and preserves the original error without signalling a missing process', async () => {
    const fake = childDouble();
    Object.assign(fake.child, { pid: undefined });
    const spawnError = Object.assign(new Error('spawn node ENOENT'), { code: 'ENOENT' });
    const failure = startChildServer({ env: {} }).catch((cause: unknown) => cause);
    fake.child.emit('error', spawnError);
    fake.close(-2, null);

    expect(await failure).toMatchObject({
      name: 'ChildServerStartupError',
      cause: spawnError,
      message: expect.stringContaining('spawn node ENOENT'),
    });
    expect(fake.kill).not.toHaveBeenCalled();
  });

  it('still awaits close after a process error rejects the exit promise', async () => {
    const fake = childDouble();
    const settled = vi.fn<(value: unknown) => unknown>((value) => value);
    const outcome = startChildServer({ env: {} }).then(settled, settled);
    const processError = new Error('child process I/O failed');
    fake.child.emit('error', processError);

    await withDeadline(fake.killRequested, { description: 'the process error cleanup signal' });
    expect(fake.kill).toHaveBeenCalledWith('SIGKILL');
    expect(settled).not.toHaveBeenCalled();
    fake.stderr.write('final child diagnostic');
    fake.close(null, 'SIGKILL');

    expect(await outcome).toMatchObject({
      cause: processError,
      message: expect.stringContaining('stderr:\nfinal child diagnostic'),
    });
  });

  it('passes the child handshake flag and transfers a listening process to the caller for shutdown', async () => {
    const fake = childDouble();
    const starting = startChildServer({ env: { NODE_ENV: 'test' }, inheritEnv: false });
    fake.stdout.write('booting\n{"listen');
    fake.stdout.write('ing":43210}\n');
    const server = await starting;

    expect(spawn).toHaveBeenCalledWith(process.execPath, [SERVER_DIST_ENTRY, 'serve', '--child'], {
      env: { NODE_ENV: 'test' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(server.port).toBe(43210);
    expect(server.stdout).toEqual(['booting', '{"listening":43210}']);
    expect(fake.kill).not.toHaveBeenCalled();

    const stopped = server.kill('SIGTERM');
    expect(fake.kill).toHaveBeenCalledWith('SIGTERM');
    fake.stdout.write('shutdown complete');
    fake.stderr.write('final warning');
    fake.close(null, 'SIGTERM');
    await expect(stopped).resolves.toEqual({ code: null, signal: 'SIGTERM' });
    await expect(server.exited).resolves.toEqual({ code: null, signal: 'SIGTERM' });
    expect(server.stdout).toContain('shutdown complete');
    expect(server.stderr).toEqual(['final warning']);
    await server.kill('SIGTERM');
    expect(fake.kill).toHaveBeenCalledTimes(1);
  });

  it('keeps the missing-binary check before spawning', async () => {
    vi.mocked(existsSync).mockReturnValueOnce(false);
    await expect(startChildServer({ env: {} })).rejects.toThrow(
      /the built server binary is missing.*Build it first/,
    );
    expect(spawn).not.toHaveBeenCalled();
  });
});
