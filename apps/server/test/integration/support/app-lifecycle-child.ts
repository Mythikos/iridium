/** Process-level lifecycle probe. Imports product source so this suite never needs its own build. */
import { writeFileSync } from 'node:fs';

import { startServer } from '../../../src/app.ts';
import { createLogger } from '../../../src/ops/logging.ts';

export type LifecycleScenario =
  | 'listen-failure'
  | 'ready-failure'
  | 'graceful'
  | 'writer-failure'
  | 'writer-timeout'
  | 'close-timeout';

export interface LifecycleExit {
  readonly code: number;
  readonly leaseHeld: boolean;
  readonly resourcesReached: boolean;
  readonly closeStarted: boolean;
  readonly closed: boolean;
}

export interface LifecycleMessage {
  readonly type: 'started' | 'writer-entered' | 'boot-error';
  readonly leaseHeld?: boolean;
  readonly message?: string;
}

async function report(message: LifecycleMessage): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (process.send === undefined) throw new Error('the lifecycle probe needs an IPC parent');
    process.send(message, (error) => {
      if (error === null) resolve();
      else reject(error);
    });
  });
}

async function run(): Promise<void> {
  const scenario = process.argv[2];
  if (
    scenario !== 'listen-failure' &&
    scenario !== 'ready-failure' &&
    scenario !== 'graceful' &&
    scenario !== 'writer-failure' &&
    scenario !== 'writer-timeout' &&
    scenario !== 'close-timeout'
  )
    throw new Error(`invalid lifecycle scenario: ${String(scenario)}`);
  const exitPath = process.argv[3];
  if (exitPath === undefined) throw new Error('missing lifecycle exit record path');
  const startupFailure = scenario === 'ready-failure' || scenario === 'listen-failure';
  // A failing log destination is a real onReady failure, after the readiness checks acquired the
  // owner lease. It uses buildApp's logger seam instead of replacing ready() or the product factory.
  const logger =
    scenario === 'ready-failure'
      ? createLogger({
          level: 'warn',
          format: 'json',
          instanceId: 'lifecycle-ready-failure',
          destination: {
            write(line: string): void {
              const record: { state?: string } = JSON.parse(line);
              if (record.state === 'ready') throw new Error('lifecycle readiness log failed');
            },
          },
        })
      : undefined;
  let started: Awaited<ReturnType<typeof startServer>>;
  try {
    started = await startServer({ mode: 'child', ...(logger === undefined ? {} : { logger }) });
  } catch (error) {
    await report({
      type: 'boot-error',
      message: error instanceof Error ? error.message : String(error),
    });
    process.disconnect();
    // Natural exit proves startup released the actual listener, pools and dedicated lease connection.
    process.exitCode = startupFailure ? 0 : 1;
    return;
  }
  if (startupFailure) {
    await started.app.drain();
    await started.app.close();
    throw new Error('the expected startup failure did not occur');
  }

  const { app } = started;
  let resourcesReached = false;
  let closeStarted = false;
  let closed = false;
  // This synchronous exit record also survives process.exit(1). In particular, the writer-failure
  // cases must still own the lease when the process dies, rather than releasing it ahead of writers.
  process.once('exit', (code) => {
    const record: LifecycleExit = {
      code,
      leaseHeld: app.collab.ownerLease.held,
      resourcesReached,
      closeStarted,
      closed,
    };
    writeFileSync(exitPath, JSON.stringify(record));
  });

  const releaseWriter = Promise.withResolvers<void>();
  app.onDrain({
    phase: 'writers',
    name: 'test.lifecycle-writer',
    run: async () => {
      await report({ type: 'writer-entered', leaseHeld: app.collab.ownerLease.held });
      if (scenario === 'writer-failure') throw new Error('lifecycle writer failed');
      if (scenario !== 'close-timeout') await releaseWriter.promise;
    },
  });
  app.onDrain({
    phase: 'resources',
    name: 'test.lifecycle-resources',
    run: async () => {
      resourcesReached = true;
    },
  });
  // Model a resource close that cannot finish, through the database handle the real onClose hook
  // calls. This leaves real MySQL sockets open, so exitCode alone can never make the test pass.
  const destroy = app.database.destroy.bind(app.database);
  app.database.destroy = async () => {
    closeStarted = true;
    if (scenario === 'close-timeout') await new Promise<void>(() => undefined);
    await destroy();
    closed = true;
  };

  process.on('message', (message: unknown) => {
    if (message === 'shutdown') {
      // Windows child.kill('SIGTERM') is an unconditional OS termination. Emit the event in this
      // disposable child so the same production handler executes on every test platform.
      process.emit('SIGTERM');
    } else if (message === 'release-writer') {
      releaseWriter.resolve();
    }
  });
  // IPC itself must not keep a successfully closed server alive.
  process.channel?.unref();
  await report({ type: 'started', leaseHeld: app.collab.ownerLease.held });
}

void run().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
