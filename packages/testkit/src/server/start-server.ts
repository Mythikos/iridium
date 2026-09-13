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
 * `container` mode is not implemented at M0: it needs `infra/docker/server.Dockerfile` and the
 * `iridium-server:ci` image the `integration` job builds, neither of which exists yet. Asking for it
 * fails with that sentence rather than silently degrading to `child`, because the two modes differ in
 * exactly the property the suites that want `container` are testing — `NODE_ENV=production` disables
 * the fault registry.
 */
import type { CookieJar } from '../auth/cookie-jar.ts';
import type { IridiumClientKind, RestClient } from '../clients/rest-client.ts';
import { restClient } from '../clients/rest-client.ts';
import type { FaultControl, FaultSpec } from '../faults/control.ts';
import { createFaultControl, formatFaultEnv } from '../faults/control.ts';
import { waitFor } from '../harness/deadline.ts';
import type { WaitOptions } from '../harness/deadline.ts';
import { reserveLoopbackPort } from '../harness/free-port.ts';
import type { ChildServer } from './child.ts';
import { startChildServer } from './child.ts';
import { buildServerEnv } from './env.ts';
import type { BuildApp, InProcessServer, ServerMode } from './in-process.ts';
import { startInProcessServer } from './in-process.ts';
import type { MetricsSnapshot } from './metrics.ts';
import { parseMetrics } from './metrics.ts';

export type { ServerMode };

/** Where the server's `DATABASE_URL` points. Usually `{ ...inject('iridiumMysql'), schema }`. */
export interface ServerDatabase {
  readonly host: string;
  readonly port: number;
  /** `iridium_w<N>` for a worker, or a schema a drill provisioned itself. */
  readonly schema: string;
}

export interface StartServerOptions {
  readonly mode: ServerMode;
  readonly db: ServerDatabase;
  /** Armed at spawn through `IRIDIUM_FAULT`; `child` and `container` modes. */
  readonly faults?: readonly FaultSpec[];
  readonly collab?: {
    readonly debounceMs?: number;
    readonly maxDebounceMs?: number;
    readonly ticketTtlS?: number;
  };
  /** Per-test attachment directory under the OS temp dir (fixture policy rule 10). */
  readonly attachmentsDir?: string;
  readonly extraEnv?: Readonly<Record<string, string>>;
  /** Inject `buildApp` instead of importing `apps/server/src/app.ts` (`in-process` only). */
  readonly buildApp?: BuildApp;
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

export interface TestServer {
  readonly origin: string;
  /** `ws://127.0.0.1:<port>/collab`. */
  readonly wsUrl: string;
  readonly port: number;
  readonly mode: ServerMode;
  /** The schema this server reads and writes, for assertions and for a restart. */
  readonly schema: string;
  /** `child` mode only; empty otherwise. Used to assert on fail-fast messages. */
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];

  /** A REST client for a principal. Each call gets its own cookie jar unless one is passed. */
  rest(principal?: RestPrincipalOptions): RestClient;
  /** Arm and disarm fault points over the test-only `/__test__/faults` route. */
  readonly faults: FaultControl;
  /** Parsed `GET /metrics`. */
  metrics(): Promise<MetricsSnapshot>;
  /** Poll `/readyz` until it answers 200. */
  waitReady(options?: WaitOptions): Promise<void>;
  /** `SIGKILL` by default. `child` and `container` only: `in-process` cannot be killed. */
  kill(signal?: 'SIGKILL' | 'SIGTERM'): Promise<void>;
  /** Graceful: `app.close()` in-process, `SIGTERM` plus drain in `child`. */
  stop(): Promise<void>;
  /**
   * Kill and bring it back exactly as it was — same schema, same port, same attachment directory —
   * optionally with different faults or debounce values. `child` and `container` only.
   */
  restart(options?: {
    faults?: readonly FaultSpec[];
    collab?: StartServerOptions['collab'];
    extraEnv?: Readonly<Record<string, string>>;
  }): Promise<void>;
}

function modeNotAvailable(mode: ServerMode): Error {
  return new Error(
    `@iridium/testkit: startServer({ mode: '${mode}' }) is not available yet. ` +
      'The container mode needs infra/docker/server.Dockerfile and the `iridium-server:ci` image the ' +
      '`integration` job builds (10-testing-and-quality.md, mode table; 12-milestones.md §4.3 CI row). ' +
      "It is not silently downgraded to 'child', because container mode runs NODE_ENV=production and " +
      'therefore has no fault registry — the difference the suites that ask for it are testing.',
  );
}

/** Start a server. The caller owns `stop()`; every suite calls it in an `afterAll`. */
export async function startServer(options: StartServerOptions): Promise<TestServer> {
  if (options.mode === 'container') {
    throw modeNotAvailable('container');
  }

  const port = options.port ?? (await reserveLoopbackPort());
  const origin = `http://127.0.0.1:${String(port)}`;

  const envFor = (o: {
    faults?: readonly FaultSpec[];
    collab?: StartServerOptions['collab'];
    extraEnv?: Readonly<Record<string, string>>;
  }): Record<string, string> =>
    buildServerEnv({
      host: options.db.host,
      port: options.db.port,
      schema: options.db.schema,
      publicOrigin: origin,
      faults: formatFaultEnv([...(o.faults ?? [])]),
      ...(o.collab === undefined ? {} : { collab: o.collab }),
      ...(options.attachmentsDir === undefined ? {} : { attachmentsDir: options.attachmentsDir }),
      extraEnv: { PORT: String(port), ...options.extraEnv, ...o.extraEnv },
    });

  let child: ChildServer | undefined;
  let inProcess: InProcessServer | undefined;
  const stdout: string[] = [];
  const stderr: string[] = [];

  const spawnChild = async (o: {
    faults?: readonly FaultSpec[];
    collab?: StartServerOptions['collab'];
    extraEnv?: Readonly<Record<string, string>>;
  }): Promise<void> => {
    const started = await startChildServer({ env: envFor(o) });
    child = started;
    stdout.length = 0;
    stderr.length = 0;
    stdout.push(...started.stdout);
    stderr.push(...started.stderr);
  };

  if (options.mode === 'child') {
    await spawnChild({
      ...(options.faults === undefined ? {} : { faults: options.faults }),
      ...(options.collab === undefined ? {} : { collab: options.collab }),
    });
  } else {
    // `in-process` reads `process.env` in boot step 1, exactly as the child does from its own.
    Object.assign(process.env, envFor({}));
    inProcess = await startInProcessServer({
      port,
      ...(options.buildApp === undefined ? {} : { buildApp: options.buildApp }),
    });
  }

  const rest = (principal: RestPrincipalOptions = {}): RestClient =>
    restClient({
      origin,
      ...(principal.bearer === undefined ? {} : { bearer: principal.bearer }),
      ...(principal.client === undefined ? {} : { client: principal.client }),
      ...(principal.jar === undefined ? {} : { jar: principal.jar }),
    });

  const server: TestServer = {
    origin,
    wsUrl: `ws://127.0.0.1:${String(port)}/collab`,
    port,
    mode: options.mode,
    schema: options.db.schema,
    get stdout(): readonly string[] {
      return child?.stdout ?? stdout;
    },
    get stderr(): readonly string[] {
      return child?.stderr ?? stderr;
    },
    rest,
    faults: createFaultControl(rest()),
    async metrics(): Promise<MetricsSnapshot> {
      const response = await rest().request<string>('GET', '/metrics');
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
      if (child === undefined) {
        throw new Error(
          "@iridium/testkit: an in-process server cannot be SIGKILLed — that is why the chaos project uses mode: 'child' (10-testing-and-quality.md, mode table). Use stop() plus a fresh startServer().",
        );
      }
      await child.kill(signal);
    },
    async stop(): Promise<void> {
      if (child !== undefined) {
        await child.kill('SIGTERM');
        return;
      }
      await inProcess?.close();
    },
    async restart(restartOptions = {}): Promise<void> {
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
