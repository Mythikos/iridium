/**
 * `app.boot-modes.integration` (10-testing-and-quality.md, "Ops, restore, release and the seam
 * contract suites"; 02-system-architecture.md invariant 1 and ARCH-01).
 *
 * One boot path. `buildApp({ mode })` is the only `Fastify(` construction site in the repository, and
 * the three modes are configuration of one tree rather than three trees: they differ in **listening,
 * signals and the scheduler**, and in nothing else. This file is the behavioural half of that claim —
 * `guards.one-boot-path.guard` owns the static half, which is that no second construction site
 * exists — so it boots the real application three times against the real database and compares what
 * came out.
 *
 * **What is compared.** For `in-process`, `child` and `container`:
 *
 *  - the route table the route-policy plugin collects (`app.routes()`: method, url and the declared
 *    `config.auth` of every route, in registration order), which is what `authorize()` and the boot
 *    assertion read;
 *  - the served radix tree (`app.printRoutes()`), which is the same table as Fastify will actually
 *    route it, auto-generated `HEAD` routes included;
 *  - the plugin tree (`app.printPlugins()`, with avvio's timings stripped), which is the
 *    registration order of every plugin in the boot sequence;
 *  - the instance surface — every decorator the eleven boot steps added.
 *
 * **What `container` mode means here.** `buildApp` is the subject, not the process: the row asks for
 * `buildApp` in all three modes, and `buildApp` neither listens nor spawns anything, so all three
 * boots happen in this process against the worker schema. That is the whole of the claim for the
 * route tables and the plugin order — the tree `container` mode builds is compared byte for byte
 * with the other two. What this file therefore does *not* prove is the container image itself: the
 * process-level `container` boot needs `infra/docker/server.Dockerfile` and the `iridium-server:ci`
 * image, which is why `@iridium/testkit`'s `startServer({ mode: 'container' })` refuses rather than
 * degrading, and the image's own proof is the compose-boot and load lanes. Nothing about the mode is
 * skipped here: `buildApp({ mode: 'container' })` really is called, readied and asserted.
 *
 * **The fourth axis is the role, not the mode.** `in-process` is both the harness's server and every
 * CLI command, and the two differ in one way that matters: a server competes for the
 * `iridium_collab_owner` lease and mounts `/collab`, while `iridium migrate status` must do neither —
 * a command run while the server is down would otherwise hold the lock for the length of the command.
 * `buildApp({ role })` is what says which, so the last case here boots the same mode twice and
 * compares the two.
 *
 * **Where the three documented differences live.** Listening and signal handling are `startServer`'s,
 * not `buildApp`'s — so this file also asserts that no mode listens or installs a signal handler
 * during `buildApp`, which is what makes "the modes differ only in listening, signals and the
 * scheduler" a statement about where the difference *is* rather than only about what is equal. The
 * scheduler arrives at M2. M1 exposes the explicit maintenance `run` operation in every mode;
 * asserting that shared surface does not claim a scheduler exists.
 */
import { fork } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildServerEnv, inspectVisibleConnectionCount, workerSchemaName } from '@iridium/testkit';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { buildApp, type ServerMode, type ServerRole } from '../../src/app.ts';
import type {
  LifecycleExit,
  LifecycleMessage,
  LifecycleScenario,
} from './support/app-lifecycle-child.ts';

/** The three modes of the ARCH-01 table, in the order that table lists them. */
const MODES: readonly ServerMode[] = ['container', 'child', 'in-process'];

/** The mode every other mode is compared against: the one the rest of this project boots. */
const REFERENCE_MODE: ServerMode = 'in-process';

/** The signals `startServer` installs handlers for — never `buildApp` (ARCH-06). */
const SIGNALS: readonly NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];

/** An entry document with no `__CSP_NONCE__` placeholder, which boot step 7 refuses. */
const ENTRY_WITHOUT_NONCE = ['<!doctype html>', '<title>no nonce</title>', ''].join('\n');

/** avvio prints a load time per plugin; the order is the subject, the milliseconds are noise. */
const PLUGIN_TIMING = / \d+ ms/g;

/** Everything one boot is asked about, captured so the instance can be closed before comparison. */
interface BootRecord {
  readonly mode: ServerMode;
  /** `app.mode` — the one value that is meant to differ between these records. */
  readonly declaredMode: ServerMode;
  /** `app.routes()`, rendered one route per line. */
  readonly routeTable: string;
  /** `app.printRoutes()`, the radix tree Fastify serves. */
  readonly servedRoutes: string;
  /** `app.printPlugins()` without avvio's timings. */
  readonly pluginTree: string;
  /** Every decorator on the instance, sorted, so the comparison is order-independent. */
  readonly decorators: readonly string[];
  /** `true` if `buildApp` opened a socket. It never should: listening is `startServer`'s job. */
  readonly listening: boolean;
  /** Signal handlers `buildApp` added, by signal. Always zero for the same reason. */
  readonly signalHandlersAdded: Readonly<Record<string, number>>;
  /** The explicit M1 maintenance surface; the due-job scheduler arrives at M2. */
  readonly maintenanceOperations: readonly string[];
}

const scratch = mkdtempSync(join(tmpdir(), 'iridium-boot-modes-'));
const records = new Map<ServerMode, BootRecord>();

/**
 * The schema `global/worker-schema.setup.ts` created, named the way that file names it.
 *
 * `workerSchema()` is the accessor for exactly this, and it cannot be used from a spec file: the
 * setup file is loaded by source path while `@iridium/testkit` resolves through the package's
 * `exports` to `dist/`, so the barrel's copy of the module never sees the setup's write. Deriving
 * the name from the same worker id is the honest reading of the same fact; the seam is
 * `@iridium/testkit`'s to close.
 */
const WORKER_SCHEMA = workerSchemaName(process.env['VITEST_WORKER_ID'] ?? '1');

function renderRouteTable(app: FastifyInstance): string {
  return app
    .routes()
    .map((route) => `${route.method} ${route.url} ${JSON.stringify(route.auth)}`)
    .join('\n');
}

async function boot(mode: ServerMode): Promise<BootRecord> {
  const mysql = inject('iridiumMysql');
  const before = Object.fromEntries(
    SIGNALS.map((signal) => [signal, process.listenerCount(signal)]),
  );
  const app = await buildApp({
    mode,
    // No socket is opened in any of the three boots, so `PUBLIC_ORIGIN` only has to be the origin
    // the configuration parses and the collaboration allowlist would carry.
    env: buildServerEnv({
      host: mysql.host,
      port: mysql.port,
      schema: WORKER_SCHEMA,
      publicOrigin: 'http://127.0.0.1:4000',
      attachmentsDir: join(scratch, mode),
    }),
    database: 'connect',
  });
  try {
    await app.ready();
    return {
      mode,
      declaredMode: app.mode,
      routeTable: renderRouteTable(app),
      servedRoutes: app.printRoutes({ commonPrefix: false }),
      pluginTree: app.printPlugins().replaceAll(PLUGIN_TIMING, ''),
      decorators: Object.keys(app).toSorted(),
      listening: app.server.listening,
      signalHandlersAdded: Object.fromEntries(
        SIGNALS.map((signal) => [signal, process.listenerCount(signal) - (before[signal] ?? 0)]),
      ),
      maintenanceOperations: Object.keys(app.jobs).toSorted(),
    };
  } finally {
    await app.close();
  }
}

/** The record of a mode that was booted in `beforeAll`; absent means the boot itself failed. */
function recordOf(mode: ServerMode): BootRecord {
  const record = records.get(mode);
  if (record === undefined) throw new Error(`buildApp({ mode: '${mode}' }) produced no record`);
  return record;
}

/** Each comparison names the mode, the property and the first line on which the two differ. */
function difference(property: string, mode: ServerMode, actual: string, expected: string): string {
  if (actual === expected) return '';
  const actualLines = actual.split('\n');
  const expectedLines = expected.split('\n');
  const at = expectedLines.findIndex((line, index) => actualLines[index] !== line);
  const line = at === -1 ? actualLines.length : at;
  return (
    `buildApp({ mode: '${mode}' }) and buildApp({ mode: '${REFERENCE_MODE}' }) do not agree on the ` +
    `${property}. First difference at line ${String(line + 1)}:\n` +
    `  ${REFERENCE_MODE}: ${expectedLines[line] ?? '(nothing)'}\n` +
    `  ${mode}: ${actualLines[line] ?? '(nothing)'}\n` +
    `The three modes are one plugin tree under three configurations (02-system-architecture.md ` +
    `invariant 1): they may differ in listening, in signal handling and in whether the scheduler ` +
    `runs, and in nothing a route table or a plugin order can see. Move the difference into ` +
    `startServer or into the jobs step, or the second boot path has arrived.`
  );
}

/** Every remedy is carried by the asserted value, so Vitest's diff prints the repair instruction. */
function problemList(problems: readonly string[]): string {
  return problems.filter((problem) => problem !== '').join('\n\n');
}

/** The modes that are compared against the reference — every mode but the reference itself. */
const COMPARED = MODES.filter((mode) => mode !== REFERENCE_MODE);

/**
 * The three boots, written out one per line rather than driven from `MODES`.
 *
 * They are sequential on purpose: all three read the worker's schema, and `migrateOnBoot` makes
 * concurrent boots race over the same migration table. Spelling the three calls out also puts the
 * row's claim — `buildApp` is called in `container`, `child` and `in-process` mode — in the file as
 * three literal calls; the first assertion below fails if this list and `MODES` ever disagree.
 */
beforeAll(async () => {
  records.set('container', await boot('container'));
  records.set('child', await boot('child'));
  records.set('in-process', await boot('in-process'));
}, 120_000);

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

interface LifecycleResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly messages: readonly LifecycleMessage[];
  readonly stdout: string;
  readonly stderr: string;
  readonly exitPath: string;
}

function isLifecycleMessage(value: unknown): value is LifecycleMessage {
  if (typeof value !== 'object' || value === null || !('type' in value)) return false;
  return (
    (value.type === 'started' || value.type === 'writer-entered' || value.type === 'boot-error') &&
    (!('leaseHeld' in value) || typeof value.leaseHeld === 'boolean') &&
    (!('message' in value) || typeof value.message === 'string')
  );
}

/** Every probe has its own process: a regression cannot leave sockets or signal handlers here. */
/**
 * The child's own stderr, with the runtime's warnings removed.
 *
 * These assertions mean "the server wrote nothing to stderr", not "this Node emitted no warnings".
 * Node 26 prints an `ExperimentalWarning` for Web Storage on every boot, which is the runtime
 * talking about itself and says nothing about the product; leaving it in would make the advisory
 * Node 26 lane (A4/D10-19) fail for a warning no assertion is about. Anything the server writes is
 * kept, so a real stderr regression still fails.
 */
function withoutRuntimeWarnings(stderr: string): string {
  return stderr
    .split('\n')
    .filter(
      (line) =>
        !/^\(node:\d+\)\s+\w*Warning:/.test(line) &&
        !line.startsWith('(Use `node --trace-warnings'),
    )
    .join('\n');
}

async function runLifecycle(scenario: LifecycleScenario, port = 0): Promise<LifecycleResult> {
  const mysql = inject('iridiumMysql');
  const exitPath = join(scratch, `${scenario}-exit.json`);
  const child = fork(
    fileURLToPath(new URL('./support/app-lifecycle-child.ts', import.meta.url)),
    [scenario, exitPath],
    {
      execArgv: [],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      // This is a test failure bound, not the production shutdown mechanism. A probe that reaches
      // it returns SIGKILL rather than the expected exit code and its synchronous exit record.
      timeout: 20_000,
      killSignal: 'SIGKILL',
      env: {
        ...process.env,
        ...buildServerEnv({
          host: mysql.host,
          port: mysql.port,
          schema: WORKER_SCHEMA,
          publicOrigin: 'http://127.0.0.1:4000',
          attachmentsDir: join(scratch, scenario),
          extraEnv: {
            PORT: String(port),
            SHUTDOWN_DRAIN_MS: scenario === 'graceful' ? '10000' : '1000',
          },
        }),
      },
    },
  );
  const messages: LifecycleMessage[] = [];
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });
  child.on('message', (raw) => {
    if (!isLifecycleMessage(raw)) return;
    const message = raw;
    messages.push(message);
    if (message.type === 'started') child.send('shutdown');
    if (message.type === 'writer-entered' && scenario === 'graceful') child.send('release-writer');
  });
  const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    },
  );
  return { ...outcome, messages, stdout, stderr: withoutRuntimeWarnings(stderr), exitPath };
}

describe('app.boot-modes.integration [area:ops]', () => {
  it('builds every mode of the ARCH-01 table from the one buildApp', () => {
    expect([...records.keys()].toSorted()).toEqual([...MODES].toSorted());
    for (const mode of MODES) expect(recordOf(mode).declaredMode).toBe(mode);
    // A comparison of three empty tables would pass; the M0 route set is what makes it mean something.
    expect(recordOf(REFERENCE_MODE).routeTable).toContain('GET /healthz');
    expect(recordOf(REFERENCE_MODE).routeTable).toContain('GET /readyz');
    expect(recordOf(REFERENCE_MODE).routeTable).toContain('GET /metrics');
  });

  it('registers one route table, with one declared policy per route, in all three modes', () => {
    const reference = recordOf(REFERENCE_MODE);
    expect(
      problemList(
        COMPARED.flatMap((mode) => [
          difference(
            'route table `app.routes()` reads',
            mode,
            recordOf(mode).routeTable,
            reference.routeTable,
          ),
          difference(
            'routes Fastify serves',
            mode,
            recordOf(mode).servedRoutes,
            reference.servedRoutes,
          ),
        ]),
      ),
    ).toBe('');
  });

  it('registers the same plugins in the same order in all three modes', () => {
    const reference = recordOf(REFERENCE_MODE);
    expect(
      problemList(
        COMPARED.map((mode) =>
          difference(
            'plugin registration order',
            mode,
            recordOf(mode).pluginTree,
            reference.pluginTree,
          ),
        ),
      ),
    ).toBe('');
  });

  it('decorates the same instance surface in all three modes, and differs only in `mode`', () => {
    const reference = recordOf(REFERENCE_MODE);
    expect(
      problemList(
        COMPARED.map((mode) =>
          difference(
            'set of instance decorators',
            mode,
            recordOf(mode).decorators.join('\n'),
            reference.decorators.join('\n'),
          ),
        ),
      ),
    ).toBe('');
    // The one difference the modes are allowed inside `buildApp`, stated rather than implied.
    expect(new Set(MODES.map((mode) => recordOf(mode).declaredMode)).size).toBe(MODES.length);
  });

  it('neither listens nor installs a signal handler in any mode', () => {
    const listening = MODES.filter((mode) => recordOf(mode).listening);
    const handlers = MODES.flatMap((mode) =>
      SIGNALS.filter((signal) => (recordOf(mode).signalHandlersAdded[signal] ?? 0) !== 0).map(
        (signal) => `${mode} added a ${signal} handler`,
      ),
    );
    expect(
      problemList([
        listening.length === 0
          ? ''
          : `buildApp opened a socket in ${listening.join(', ')} mode. Listening belongs to ` +
            `startServer — \`container\` on BIND_ADDRESS:PORT, \`child\` on an ephemeral port it ` +
            `prints, \`in-process\` never — which is what lets a test build the app and call ` +
            `app.inject() without a port (ARCH-01).`,
        handlers.length === 0
          ? ''
          : `${handlers.join('; ')}. Signal handling is installSignalHandlers' job inside ` +
            `startServer, and only outside \`in-process\` mode; a handler installed during ` +
            `buildApp would outlive every test that ever built an app (ARCH-06).`,
      ]),
    ).toBe('');
  });

  it('defaults the role to `server` and builds no collaboration surface under `cli`', async () => {
    const mysql = inject('iridiumMysql');
    const buildWithRole = async (role: ServerRole | undefined): Promise<FastifyInstance> =>
      buildApp({
        mode: 'in-process',
        env: buildServerEnv({
          host: mysql.host,
          port: mysql.port,
          schema: WORKER_SCHEMA,
          publicOrigin: 'http://127.0.0.1:4000',
          attachmentsDir: join(scratch, `role-${role ?? 'default'}`),
        }),
        database: 'connect',
        ...(role === undefined ? {} : { role }),
      });

    const defaulted = await buildWithRole(undefined);
    const cli = await buildWithRole('cli');
    try {
      await defaulted.ready();
      await cli.ready();
      // Every boot that listens is a server, so the absent option means `server`; a command says so.
      expect(defaulted.role).toBe('server');
      expect(cli.role).toBe('cli');
      const collabRoutes = cli.routes().filter((route) => route.url === '/collab');
      expect(
        collabRoutes.length === 0
          ? ''
          : 'a `cli` boot mounted /collab. A command neither serves documents nor may take the ' +
              '`iridium_collab_owner` lease, so the collaboration step is gated on the role rather ' +
              'than on the mode.',
      ).toBe('');
    } finally {
      await defaulted.close();
      await cli.close();
    }
  });

  it('releases what it opened when a later step throws, and rejects with that error', async () => {
    const mysql = inject('iridiumMysql');
    const env = (webDir: string | null): Record<string, string> => ({
      ...buildServerEnv({
        host: mysql.host,
        port: mysql.port,
        schema: WORKER_SCHEMA,
        publicOrigin: 'http://127.0.0.1:4000',
        attachmentsDir: join(scratch, 'teardown'),
      }),
      ...(webDir === null ? {} : { IRIDIUM_WEB_DIR: webDir }),
    });

    // A web bundle whose entry document carries no CSP nonce placeholder. Boot step 7 refuses it,
    // which is a real failure of a step *after* the database rather than an injected one — the same
    // shape as the ENOENT that first showed this up.
    const webDir = join(scratch, 'web-without-nonce');
    mkdirSync(webDir, { recursive: true });
    writeFileSync(join(webDir, 'index.html'), ENTRY_WITHOUT_NONCE, 'utf8');

    // A healthy instance, both to hold the baseline connection count and to ask MySQL for it. The
    // app account has no `PROCESS` privilege, so `information_schema.processlist` shows it only its
    // own threads — which is exactly the set a leaked pool would add to.
    const healthy = await buildApp({ mode: 'in-process', env: env(null), database: 'connect' });
    try {
      await healthy.ready();
      const db = healthy.database.dbApp;
      if (db === null) throw new Error('the reference boot opened no application pool');
      const appConnections = async (): Promise<number> => {
        return inspectVisibleConnectionCount(db);
      };

      const before = await appConnections();
      const failed = buildApp({ mode: 'in-process', env: env(webDir), database: 'connect' });

      // The error the boot actually failed on, unchanged — not a teardown error raised after it.
      await expect(failed).rejects.toThrow(/nonce/i);

      // And the pools that boot opened are gone. Before `buildApp` was made exception-safe, the
      // `onClose` hook that destroys them was registered after the step that threw, so nothing ever
      // ran it: the caller never receives the instance, so nobody else can close it, and the process
      // printed its one-line error and then hung on the open handles.
      await expect.poll(appConnections, { timeout: 10_000 }).toBeLessThanOrEqual(before);
    } finally {
      await healthy.close();
    }
  });

  it.each(['ready-failure', 'listen-failure'] as const)(
    'releases startup resources and exits naturally after %s',
    async (scenario) => {
      const occupied = createServer();
      await new Promise<void>((resolve, reject) => {
        occupied.once('error', reject);
        occupied.listen(0, '127.0.0.1', resolve);
      });
      try {
        const address = occupied.address();
        if (address === null || typeof address === 'string')
          throw new Error('no occupied TCP port');
        const result = await runLifecycle(scenario, address.port);
        expect({ code: result.code, signal: result.signal, stderr: result.stderr }).toMatchObject({
          code: 0,
          signal: null,
          stderr: '',
        });
        const failure = result.messages.find((message) => message.type === 'boot-error');
        expect(failure?.message).toMatch(
          scenario === 'ready-failure' ? /lifecycle readiness log failed/ : /EADDRINUSE/,
        );
        expect(result.messages.some((message) => message.type === 'started')).toBe(false);
      } finally {
        await new Promise<void>((resolve, reject) => {
          occupied.close((error) => {
            if (error === undefined) resolve();
            else reject(error);
          });
        });
      }
    },
  );

  it.each(['graceful', 'writer-failure', 'writer-timeout', 'close-timeout'] as const)(
    'bounds %s shutdown without closing ahead of unfinished writers',
    async (scenario) => {
      const result = await runLifecycle(scenario);
      expect({ code: result.code, signal: result.signal, stderr: result.stderr }).toMatchObject({
        code: scenario === 'graceful' ? 0 : 1,
        signal: null,
        stderr: '',
      });
      expect(result.messages).toEqual([
        { type: 'started', leaseHeld: true },
        { type: 'writer-entered', leaseHeld: true },
      ]);
      const failedWriter = scenario === 'writer-failure' || scenario === 'writer-timeout';
      const exited: LifecycleExit = JSON.parse(readFileSync(result.exitPath, 'utf8'));
      expect(exited).toEqual({
        code: scenario === 'graceful' ? 0 : 1,
        leaseHeld: failedWriter,
        resourcesReached: !failedWriter,
        closeStarted: !failedWriter,
        closed: scenario === 'graceful',
      });
    },
  );

  it('exposes the same explicit maintenance operation in every mode', () => {
    expect(MODES.map((mode) => recordOf(mode).maintenanceOperations)).toEqual(
      MODES.map(() => ['run']),
    );
  });
});
