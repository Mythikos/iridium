/**
 * `startServer({ mode })` — one boot path, three modes (10-testing-and-quality.md, "Server boot:
 * `startServer`"; 02-system-architecture.md ARCH-01).
 *
 * | Mode | How it starts | What it is for |
 * |---|---|---|
 * | `in-process` | `buildApp({ mode: 'in-process' })` then `listen` | `integration`, `contract`, `mcp`; white-box access to singletons |
 * | `child` | `node apps/server/dist/main.mjs serve` with `NODE_ENV=test` | the whole `chaos` project — the only mode that can be `SIGKILL`ed — plus `kernel.smoke.integration` |
 * | `container` | the `iridium-server:ci` image | k6 load, Schemathesis, compose boot, the operator drills |
 *
 * Container mode drives the production image with production validation and no fault registry.
 * Its schema, keys, published port and data directory survive kill/restart.
 */
import type { StartedNetwork } from 'testcontainers';

import type { CookieJar } from '../auth/cookie-jar.ts';
import type { DesktopSignIn, WebSignIn } from '../auth/sessions.ts';
import { signInDesktop, signInWeb, stepUp } from '../auth/sessions.ts';
import { issueTickets, restTicketSource } from '../auth/tickets.ts';
import type { NoteClient, NoteClientOptions } from '../clients/note-client.ts';
import { createNoteClient } from '../clients/note-client.ts';
import type { IridiumClientKind, RestClient, RestClientOptions } from '../clients/rest-client.ts';
import { restClient } from '../clients/rest-client.ts';
import type { FaultControl, FaultSpec } from '../faults/control.ts';
import { createFaultControl, formatFaultEnv } from '../faults/control.ts';
import { waitFor, withDeadline } from '../harness/deadline.ts';
import type { WaitOptions } from '../harness/deadline.ts';
import { reserveLoopbackPort } from '../harness/free-port.ts';
import type { SeedApi, SeededUser } from '../seed/seed.ts';
import { createSeedApi } from '../seed/seed.ts';
import type { StructureNodeWriter } from '../seed/structure.ts';
import type { ChildServer } from './child.ts';
import { startChildServer } from './child.ts';
import type { CliResult } from './cli.ts';
import { runIridiumCli } from './cli.ts';
import { createContainerServer, type ContainerServer } from './container.ts';
import type { DatabasePasswords } from './env.ts';
import { buildServerEnv } from './env.ts';
import type { BuildApp, InProcessServer, ServerMode, TestAppInstance } from './in-process.ts';
import { startInProcessServer } from './in-process.ts';
import type { LimitsOverrides } from './limits.ts';
import { collabBootLimits, limitsEnv } from './limits.ts';
import type { MetricsSnapshot } from './metrics.ts';
import { parseMetrics } from './metrics.ts';

export type { ServerMode };

/** Signing in and stepping up, bound to this server (10-testing-and-quality.md, `SessionHelpers`). */
export interface SessionHelpers {
  /** `POST /auth/sessions {client:'web'}`; the result's client carries the `__Host-` cookie. */
  signInWeb(user: SeededUser): Promise<WebSignIn>;
  /** `POST /auth/sessions {client:'desktop'}`; the result's client carries the bearer. */
  signInDesktop(user: SeededUser, deviceName?: string): Promise<DesktopSignIn>;
  /** `POST /auth/reauthenticate`: refresh the step-up window an `/admin/*` route requires. */
  stepUp(client: RestClient, password: string): Promise<void>;
  /**
   * The cached web session for a user, signed in on first use.
   *
   * One session per user per server is what the ticket budget is scoped to, so re-using it is what
   * makes a suite that opens six clients spend one login instead of six.
   */
  current(user: SeededUser): Promise<WebSignIn>;
}

/** Collaboration tickets, bound to this server (10-testing-and-quality.md, `TicketHelpers`). */
export interface TicketHelpers {
  /** `POST /auth/collab-tickets {count}` on the user's cached session. */
  issue(user: SeededUser, count?: number): Promise<readonly string[]>;
  /**
   * Present one ticket twice: the first attachment authenticates, the second is refused
   * `unauthorized`, because a ticket is consumed before it is verified (04 §7.3).
   */
  reuse(user: SeededUser, noteId: string): Promise<{ firstOk: boolean; secondOk: boolean }>;
}

/** What `srv.client()` takes beyond what the server already knows. */
export type ServerNoteClientOptions = Omit<
  NoteClientOptions,
  'wsUrl' | 'noteId' | 'userId' | 'sessionId' | 'tickets'
>;

/** Where the server's `DATABASE_URL` points. Usually `{ ...inject('iridiumMysql'), schema }`. */
export interface ServerDatabase {
  /** Production-image fixtures supply random passwords; other modes default to obvious test values. */
  readonly passwords?: DatabasePasswords;
  readonly host: string;
  readonly port: number;
  /** `iridium_w<N>` for a worker, or a schema a drill provisioned itself. */
  readonly schema: string;
}

export interface StartServerOptions<TApp extends TestAppInstance = TestAppInstance> {
  readonly mode: ServerMode;
  /** Optional fixture-owned container network; lifecycle remains with the calling harness. */
  readonly containerNetwork?: {
    readonly network: StartedNetwork;
    readonly aliases?: readonly string[];
  };
  readonly onResponse?: RestClientOptions['onResponse'];
  readonly db: ServerDatabase;
  /**
   * Armed at boot through `IRIDIUM_FAULT`, in every mode: the child reads it from the environment it
   * is spawned with, and `in-process` reads the explicit environment handed to `buildApp`.
   * Arming *after* boot is `srv.faults.arm()` over the test-only control route.
   */
  readonly faults?: readonly FaultSpec[];
  readonly collab?: {
    readonly debounceMs?: number;
    readonly maxDebounceMs?: number;
    readonly ticketTtlS?: number;
    /**
     * How long `onStoreDocument` awaits a compaction. `in-process` only: it deliberately has no
     * environment key (12-milestones.md §5.2 names it a `LIMITS` member, not an operator knob), so
     * it reaches the product through `buildApp({ limits })` and the `chaos` project runs the
     * production value.
     */
    readonly compactionAwaitTimeoutMs?: number;
  };
  /**
   * The limits this server runs with, rendered as the environment keys an operator would set
   * (`server/limits.ts`). Only the knobs `@iridium/contracts`' `LIMIT_ENV_OVERRIDES` exposes.
   */
  readonly limits?: LimitsOverrides;
  /** Per-test attachment directory under the OS temp dir (fixture policy rule 10). */
  readonly attachmentsDir?: string;
  /**
   * Per-instance configuration. In-process UV_THREADPOOL_SIZE always reports the host value:
   * changing a boot option cannot resize Node's already running threadpool.
   */
  readonly extraEnv?: Readonly<Record<string, string>>;
  /** Inject `buildApp` instead of importing `apps/server/src/app.ts` (`in-process` only). */
  readonly buildApp?: BuildApp<TApp>;
  /** In-process bulk fixture adapter bound to the actual server instance and structural services. */
  readonly structureWriter?: (app: TApp) => StructureNodeWriter;
  /** Override the reserved port; a restart re-uses the original by default. */
  readonly port?: number;
  /** How long to wait for `/readyz` to answer 200. */
  readonly readyTimeoutMs?: number;
}

export interface RestPrincipalOptions {
  readonly bearer?: string;
  readonly client?: IridiumClientKind;
  readonly jar?: CookieJar;
}

export interface TestServer<TApp extends TestAppInstance = TestAppInstance> {
  readonly origin: string;
  /** `ws://127.0.0.1:<port>/collab`. */
  readonly wsUrl: string;
  readonly port: number;
  readonly mode: ServerMode;
  /** Observed process exit; null while running or in-process. Docker reports its actual exit code. */
  readonly lastExit: {
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  } | null;
  /** The schema this server reads and writes, for assertions and for a restart. */
  readonly schema: string;
  /** `child` mode only; empty otherwise. Used to assert on fail-fast messages. */
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];

  /**
   * The Fastify instance, in `in-process` mode only — the white-box access that mode exists for
   * (10-testing-and-quality.md, the mode table: `app.collab.gateway`, `app.authzBus`). `null` in
   * `child` and `container` mode, where the process is not this one.
   */
  readonly app: TApp | null;

  /** A REST client for a principal. Each call gets its own cookie jar unless one is passed. */
  rest(principal?: RestPrincipalOptions): RestClient;
  /** A REST client already carrying the user's web session cookie. */
  loginAs(user: SeededUser): Promise<RestClient>;
  /** A REST client already carrying a desktop bearer for the user. */
  loginAsDesktop(user: SeededUser, deviceName?: string): Promise<RestClient>;
  /** Open a note over the real wire as a seeded user. It does not wait; call `waitSynced()`. */
  client(user: SeededUser, noteId: string, options?: ServerNoteClientOptions): Promise<NoteClient>;
  /** Seeding through the product's own routes and CLI. */
  readonly seed: SeedApi;
  readonly sessions: SessionHelpers;
  readonly tickets: TicketHelpers;
  /** Run `iridium <args…>` against this server's schema and secrets. */
  cli(args: readonly string[]): Promise<CliResult>;
  /** Arm and disarm fault points over the test-only `/__test__/faults` route. */
  readonly faults: FaultControl;
  /** Parsed `GET /metrics`. */
  metrics(): Promise<MetricsSnapshot>;
  /** Poll `/readyz` until it answers 200. */
  waitReady(options?: WaitOptions): Promise<void>;
  /** `SIGKILL` by default. `child` and `container` only: `in-process` cannot be killed. */
  kill(signal?: 'SIGKILL' | 'SIGTERM'): Promise<void>;
  /**
   * Graceful: `app.drain()` then `app.close()` in-process, `SIGTERM` plus the product's own drain in
   * `child`. `drainTimeoutMs` bounds the in-process drain; see `DEFAULT_STOP_DRAIN_MS`.
   */
  stop(options?: { drainTimeoutMs?: number }): Promise<void>;
  /**
   * Kill and bring it back exactly as it was — same schema, same port, same attachment directory —
   * optionally with different faults or debounce values. `child` and `container` only.
   */
  restart(options?: {
    faults?: readonly FaultSpec[];
    collab?: StartServerOptions<TApp>['collab'];
    extraEnv?: Readonly<Record<string, string>>;
  }): Promise<void>;
}

/**
 * How long an `in-process` `stop()` waits for the drain before closing anyway.
 *
 * Shorter than the product's own `SHUTDOWN_DRAIN_MS` (20 000) on purpose: production answers a drain
 * that overruns by exiting the process, and a harness cannot. A suite whose subject *is* the drain
 * uses `child` mode and `SIGTERM`, which runs the product's bound rather than this one, or passes its
 * own `drainTimeoutMs`.
 */
export const DEFAULT_STOP_DRAIN_MS = 10_000;

/** Start a server. The caller owns `stop()`; every suite calls it in an `afterAll`. */
export async function startServer<TApp extends TestAppInstance = TestAppInstance>(
  options: StartServerOptions<TApp>,
): Promise<TestServer<TApp>> {
  const port = options.port ?? (await reserveLoopbackPort());
  const origin = `http://127.0.0.1:${String(port)}`;
  const wsUrl = `ws://127.0.0.1:${String(port)}/collab`;
  // Container tests drive the private HTTP hop behind the deployment's TLS boundary. Origin stays
  // the public HTTPS origin, exactly as it does when a reverse proxy forwards browser requests.
  const publicOrigin =
    options.extraEnv?.['PUBLIC_ORIGIN'] ??
    (options.mode === 'container' ? origin.replace('http:', 'https:') : origin);

  const envFor = (o: {
    faults?: readonly FaultSpec[];
    collab?: StartServerOptions<TApp>['collab'];
    extraEnv?: Readonly<Record<string, string>>;
  }): Record<string, string> =>
    buildServerEnv({
      host: options.db.host,
      port: options.db.port,
      schema: options.db.schema,
      ...(options.db.passwords === undefined ? {} : { passwords: options.db.passwords }),
      publicOrigin,
      faults: formatFaultEnv([...(o.faults ?? [])]),
      ...(o.collab === undefined ? {} : { collab: o.collab }),
      ...(options.attachmentsDir === undefined ? {} : { attachmentsDir: options.attachmentsDir }),
      extraEnv: {
        PORT: String(port),
        ...limitsEnv(options.limits ?? {}),
        ...options.extraEnv,
        ...o.extraEnv,
      },
    });

  let container: ContainerServer | undefined;
  let child: ChildServer | undefined;
  let inProcess: InProcessServer<TApp> | undefined;
  const stdout: string[] = [];
  const stderr: string[] = [];

  const spawnChild = async (o: {
    faults?: readonly FaultSpec[];
    collab?: StartServerOptions<TApp>['collab'];
    extraEnv?: Readonly<Record<string, string>>;
  }): Promise<void> => {
    const started = await startChildServer({ env: envFor(o) });
    child = started;
    stdout.length = 0;
    stderr.length = 0;
    stdout.push(...started.stdout);
    stderr.push(...started.stderr);
  };

  if (options.mode === 'container') {
    container = await createContainerServer({
      port,
      ...(options.containerNetwork === undefined
        ? {}
        : {
            network: options.containerNetwork.network,
            ...(options.containerNetwork.aliases === undefined
              ? {}
              : { networkAliases: options.containerNetwork.aliases }),
          }),
      ...(options.attachmentsDir === undefined ? {} : { attachmentsDir: options.attachmentsDir }),
    });
    try {
      await container.start(
        envFor({
          ...(options.faults === undefined ? {} : { faults: options.faults }),
          ...(options.collab === undefined ? {} : { collab: options.collab }),
        }),
      );
    } catch (error) {
      await container.stop();
      throw error;
    }
  } else if (options.mode === 'child') {
    await spawnChild({
      ...(options.faults === undefined ? {} : { faults: options.faults }),
      ...(options.collab === undefined ? {} : { collab: options.collab }),
    });
  } else {
    // Configuration is parsed once from this boot's explicit environment. Mutating process.env
    // would leak arbitrary extraEnv keys into later boots and race another asynchronous factory.
    // The complete fixture environment also keeps ambient operator settings out of this instance.
    const env = envFor({
      ...(options.faults === undefined ? {} : { faults: options.faults }),
      ...(options.collab === undefined ? {} : { collab: options.collab }),
    });
    // This observes the current Node runtime, rather than an instance-tunable product setting.
    // extraEnv cannot resize an already running pool. Child processes inherit their spawn env;
    // containers retain the image's setting unless a fixture explicitly overrides it.
    const threadpoolSize = process.env['UV_THREADPOOL_SIZE'];
    if (threadpoolSize === undefined) delete env['UV_THREADPOOL_SIZE'];
    else env['UV_THREADPOOL_SIZE'] = threadpoolSize;
    const bootLimits = collabBootLimits(options.limits ?? {}, options.collab ?? {});
    inProcess = await startInProcessServer({
      port,
      env: Object.freeze(env),
      ...(options.buildApp === undefined ? {} : { buildApp: options.buildApp }),
      ...(bootLimits === undefined ? {} : { limits: bootLimits }),
    });
  }

  const rest = (principal: RestPrincipalOptions = {}): RestClient =>
    restClient({
      origin,
      originHeader: publicOrigin,
      ...(options.onResponse === undefined ? {} : { onResponse: options.onResponse }),
      ...(principal.bearer === undefined ? {} : { bearer: principal.bearer }),
      ...(principal.client === undefined ? {} : { client: principal.client }),
      ...(principal.jar === undefined ? {} : { jar: principal.jar }),
    });

  const cli = (args: readonly string[]): Promise<CliResult> =>
    container === undefined ? runIridiumCli(args, { env: envFor({}) }) : container.cli(args);

  /**
   * One web session per user, created on first use.
   *
   * The promise is cached rather than the result, so two clients opened concurrently for the same
   * user share one login instead of racing two — a second login is not wrong, but it spends a
   * session slot and a ticket budget the test did not mean to spend.
   */
  const webSessions = new Map<string, Promise<WebSignIn>>();
  const currentSession = (user: SeededUser): Promise<WebSignIn> => {
    let session = webSessions.get(user.email);
    if (session === undefined) {
      session = signInWeb(rest(), { email: user.email, password: user.password });
      webSessions.set(user.email, session);
    }
    return session;
  };

  const sessions: SessionHelpers = {
    signInWeb: (user) => signInWeb(rest(), { email: user.email, password: user.password }),
    signInDesktop: (user, deviceName) =>
      signInDesktop(rest(), { email: user.email, password: user.password }, deviceName),
    stepUp,
    current: currentSession,
  };

  const noteClient = async (
    user: SeededUser,
    noteId: string,
    clientOptions: ServerNoteClientOptions = {},
  ): Promise<NoteClient> => {
    const session = await currentSession(user);
    return createNoteClient({
      wsUrl,
      origin: publicOrigin,
      noteId,
      userId: session.userId,
      sessionId: session.session.id,
      tickets: restTicketSource(
        session.client,
        clientOptions.clock === undefined ? {} : { clock: clientOptions.clock },
      ),
      ...clientOptions,
    });
  };

  const tickets: TicketHelpers = {
    async issue(user, count = 1): Promise<readonly string[]> {
      const session = await currentSession(user);
      return issueTickets(session.client, count);
    },
    async reuse(user, noteId): Promise<{ firstOk: boolean; secondOk: boolean }> {
      const [ticket] = await tickets.issue(user, 1);
      if (ticket === undefined) {
        throw new Error('@iridium/testkit: the ticket batch came back empty');
      }
      const session = await currentSession(user);
      const attempt = async (): Promise<boolean> => {
        const client = createNoteClient({
          wsUrl,
          origin: publicOrigin,
          noteId,
          userId: session.userId,
          sessionId: session.session.id,
          // The same ticket both times: the point of the case is that the second presentation is
          // refused, and a source that refilled would hide it behind a fresh credential.
          tickets: { next: () => Promise.resolve(ticket), invalidate: () => undefined },
        });
        try {
          await client.waitSynced({ timeoutMs: 5_000 });
          return true;
        } catch {
          // A refused ticket reaches the client as `authenticationFailed`, never as a resolution, so
          // the deadline expiring *is* the refusal. The close log says which reason it was.
          return false;
        } finally {
          await client.close();
        }
      };
      const firstOk = await attempt();
      const secondOk = await attempt();
      return { firstOk, secondOk };
    },
  };

  const structureWriter =
    inProcess === undefined ? undefined : options.structureWriter?.(inProcess.app);
  const seed: SeedApi = createSeedApi({
    client: () => rest(),
    cli,
    ...(structureWriter === undefined ? {} : { structureWriter }),
  });

  const server: TestServer<TApp> = {
    origin,
    wsUrl,
    port,
    mode: options.mode,
    schema: options.db.schema,
    get lastExit() {
      if (container !== undefined) return container.lastExit;
      const process = child?.process;
      if (process === undefined || (process.exitCode === null && process.signalCode === null))
        return null;
      return { code: process.exitCode, signal: process.signalCode };
    },
    get stdout(): readonly string[] {
      return container?.stdout ?? child?.stdout ?? stdout;
    },
    get stderr(): readonly string[] {
      return container?.stderr ?? child?.stderr ?? stderr;
    },
    get app(): TApp | null {
      return inProcess?.app ?? null;
    },
    rest,
    async loginAs(user: SeededUser): Promise<RestClient> {
      return (await currentSession(user)).client;
    },
    async loginAsDesktop(user: SeededUser, deviceName?: string): Promise<RestClient> {
      return (await sessions.signInDesktop(user, deviceName)).client;
    },
    client: noteClient,
    seed,
    sessions,
    tickets,
    cli,
    faults: createFaultControl(rest()),
    async metrics(): Promise<MetricsSnapshot> {
      const token = options.extraEnv?.['METRICS_TOKEN'];
      const response = await rest().request<string>(
        'GET',
        '/metrics',
        token === undefined ? {} : { headers: { Authorization: `Bearer ${token}` } },
      );
      if (response.status !== 200) {
        throw new Error(`@iridium/testkit: GET /metrics answered ${String(response.status)}`);
      }
      return parseMetrics(typeof response.body === 'string' ? response.body : '');
    },
    async waitReady(waitOptions: WaitOptions = {}): Promise<void> {
      await waitFor(async () => (await rest().request('GET', '/readyz')).status === 200, {
        timeoutMs: waitOptions.timeoutMs ?? options.readyTimeoutMs ?? 60_000,
        intervalMs: waitOptions.intervalMs ?? 100,
        description: `${origin}/readyz to answer 200`,
      });
    },
    async kill(signal = 'SIGKILL'): Promise<void> {
      if (container !== undefined) return container.kill(signal);
      if (child === undefined) {
        throw new Error(
          "@iridium/testkit: an in-process server cannot be SIGKILLed — that is why the chaos project uses mode: 'child' (10-testing-and-quality.md, mode table). Use stop() plus a fresh startServer().",
        );
      }
      await child.kill(signal);
    },
    /**
     * Shut the server down the way production does.
     *
     * `child` mode sends `SIGTERM`, and the product's own signal handler runs the ordered drain
     * before it closes. `in-process` has no signal handler, so the harness runs the same two steps in
     * the same order: without the drain, `close()` destroys the pools while the collaboration owner
     * lease still holds its dedicated `dbPersist` connection, and the pool destroy waits for a
     * connection that is never coming back (11-operations-and-deployment.md, the drain phases;
     * `platform` seams §6).
     *
     * A drain failure is reported and then swallowed: `close()` must still run, because a harness
     * that left a listening server behind on a drain timeout would fail the *next* test rather than
     * this one. The reason is printed, so a stuck phase is visible rather than silent.
     */
    async stop(stopOptions: { drainTimeoutMs?: number } = {}): Promise<void> {
      if (container !== undefined) return container.stop();
      if (child !== undefined) {
        await child.kill('SIGTERM');
        return;
      }
      const app = inProcess?.app;
      if (app?.drain !== undefined) {
        const startedAt = Date.now();
        try {
          await withDeadline(app.drain(), {
            timeoutMs: stopOptions.drainTimeoutMs ?? DEFAULT_STOP_DRAIN_MS,
            description: 'the in-process shutdown drain',
          });
        } catch (error) {
          // eslint-disable-next-line no-console -- a harness has no logger, and a stuck drain must be visible
          console.warn(
            `@iridium/testkit: the shutdown drain did not finish in ${String(Date.now() - startedAt)} ms; closing anyway. ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      await inProcess?.close();
    },
    async restart(restartOptions = {}): Promise<void> {
      if (container !== undefined) {
        await container.start(
          envFor({
            faults: restartOptions.faults ?? options.faults ?? [],
            ...((restartOptions.collab ?? options.collab)
              ? { collab: restartOptions.collab ?? options.collab }
              : {}),
            ...(restartOptions.extraEnv === undefined ? {} : { extraEnv: restartOptions.extraEnv }),
          }),
        );
        await server.waitReady();
        return;
      }
      if (child === undefined) {
        throw new Error(
          "@iridium/testkit: restart() exists in 'child' and 'container' modes only; an in-process restart is stop() plus a fresh startServer(), and the test says which it means.",
        );
      }
      const collab = restartOptions.collab ?? options.collab;
      await child.kill('SIGKILL');
      await spawnChild({
        faults: restartOptions.faults ?? options.faults ?? [],
        ...(collab === undefined ? {} : { collab }),
        ...(restartOptions.extraEnv === undefined ? {} : { extraEnv: restartOptions.extraEnv }),
      });
      await server.waitReady();
    },
  };

  return server;
}
