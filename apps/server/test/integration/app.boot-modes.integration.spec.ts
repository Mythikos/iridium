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
 * **Where the three documented differences live.** Listening and signal handling are `startServer`'s,
 * not `buildApp`'s — so this file also asserts that no mode listens or installs a signal handler
 * during `buildApp`, which is what makes "the modes differ only in listening, signals and the
 * scheduler" a statement about where the difference *is* rather than only about what is equal. The
 * scheduler is the `jobs` step, an empty stub until M2 (`apps/server/src/jobs/plugin.ts`): at M0 it
 * contributes nothing in any mode, and the assertion below says so rather than implying the
 * difference has been proven.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildServerEnv, workerSchemaName } from '@iridium/testkit';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { buildApp, type ServerMode } from '../../src/app.ts';

/** The three modes of the ARCH-01 table, in the order that table lists them. */
const MODES: readonly ServerMode[] = ['container', 'child', 'in-process'];

/** The mode every other mode is compared against: the one the rest of this project boots. */
const REFERENCE_MODE: ServerMode = 'in-process';

/** The signals `startServer` installs handlers for — never `buildApp` (ARCH-06). */
const SIGNALS: readonly NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];

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
  /** The `jobs` step's contribution to the instance — the scheduler's seam (empty until M2). */
  readonly schedulerDecorated: boolean;
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
      schedulerDecorated: app.hasDecorator('jobs'),
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

  it('starts no scheduler in any mode, the jobs step being an empty stub until M2', () => {
    const decorated = MODES.filter((mode) => recordOf(mode).schedulerDecorated);
    expect(
      decorated.length === 0
        ? ''
        : `the jobs step decorated the instance in ${decorated.join(', ')} mode. The scheduler is ` +
            `the third documented per-mode difference (on in \`container\` and \`child\`, off in ` +
            `\`in-process\`, off everywhere under JOBS_ENABLED=false), and this file is where that ` +
            `difference is asserted: replace this check with one that boots each mode and asserts ` +
            `which of them claims jobs with \`locked_by = <instanceId>\`.`,
    ).toBe('');
  });
});
