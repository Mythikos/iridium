/** Production-image lifecycle for the harness, including actual Linux signals on every host. */
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GenericContainer, Wait, getContainerRuntimeClient } from 'testcontainers';
import type { StartedNetwork, StartedTestContainer } from 'testcontainers';

import { withDeadline } from '../harness/deadline.ts';
import type { CliResult } from './cli.ts';

/** Fixed internal port; only the loopback-published host port is reserved by startServer. */
const CONTAINER_PORT = 4000;

/** Testcontainers exposes Docker's host configuration to subclasses for image-specific constraints. */
class ProductionImage extends GenericContainer {
  readonly #publishedPort: number;
  constructor(image: string, publishedPort: number) {
    super(image);
    this.#publishedPort = publishedPort;
    this.hostConfig.ReadonlyRootfs = true;
  }

  protected override beforeContainerCreated(): Promise<void> {
    this.hostConfig.PortBindings = {
      [`${String(CONTAINER_PORT)}/tcp`]: [
        { HostIp: '127.0.0.1', HostPort: String(this.#publishedPort) },
      ],
    };
    return Promise.resolve();
  }
}

/** Container-owned files survive kill/restart and are deleted only by the final stop. */
export interface ContainerServer {
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
  readonly lastExit: { readonly code: number; readonly signal: null } | null;
  start(env: Readonly<Record<string, string>>): Promise<void>;
  kill(signal?: NodeJS.Signals): Promise<void>;
  stop(): Promise<void>;
  cli(args: readonly string[]): Promise<CliResult>;
}

/** Prepare one disposable runtime; the image's UID, entrypoint and production mode remain intact. */
export async function createContainerServer(options: {
  readonly port: number;
  readonly image?: string;
  readonly network?: StartedNetwork;
  readonly networkAliases?: readonly string[];
  readonly attachmentsDir?: string;
}): Promise<ContainerServer> {
  const scratch = await mkdtemp(join(tmpdir(), 'iridium-container-'));
  // Only disposable test data is shared with UID 10001. No secret file is written here.
  await chmod(scratch, 0o777);
  const mounts = await Promise.all(
    ['attachments', 'backups', 'tmp', 'logs'].map(async (name) => {
      const source =
        name === 'attachments' && options.attachmentsDir !== undefined
          ? options.attachmentsDir
          : join(scratch, name);
      await mkdir(source, { recursive: true });
      if (source.startsWith(scratch)) await chmod(source, 0o777);
      return { source, target: `/data/${name}`, mode: 'rw' as const };
    }),
  );
  const stdout: string[] = [];
  const stderr: string[] = [];
  let started: StartedTestContainer | undefined;
  let stopped = false;
  let lastExit: { readonly code: number; readonly signal: null } | null = null;

  const kill = async (signal: NodeJS.Signals = 'SIGKILL'): Promise<void> => {
    if (started === undefined) return;
    const runtime = await getContainerRuntimeClient();
    const container = runtime.container.getById(started.getId());
    const state = (await container.inspect()).State;
    if (!state.Running) {
      lastExit = { code: state.ExitCode, signal: null };
      return;
    }
    const exited = container.wait();
    await container.kill({ signal });
    let status: { StatusCode: number };
    try {
      status = await withDeadline(exited, {
        timeoutMs: 25_000,
        description: 'container exit after signal',
      });
    } catch (error) {
      if ((await container.inspect()).State.Running) await container.kill({ signal: 'SIGKILL' });
      await exited;
      throw error;
    }
    lastExit = { code: status.StatusCode, signal: null };
    if (signal === 'SIGTERM' && status.StatusCode !== 0) {
      throw new Error(
        `@iridium/testkit: graceful container shutdown exited ${String(status.StatusCode)}.\n${stdout.join('')}\n${stderr.join('')}`,
      );
    }
  };

  return {
    stdout,
    stderr,
    get lastExit() {
      return lastExit;
    },
    async start(env): Promise<void> {
      if (stopped) throw new Error('@iridium/testkit: a stopped container harness cannot restart');
      if (env['IRIDIUM_FAULT'])
        throw new Error('@iridium/testkit: production container mode has no fault registry');
      if (started !== undefined) {
        await kill();
        await started.stop();
        started = undefined;
      }
      lastExit = null;
      const containerEnv: Record<string, string> = {
        ...env,
        NODE_ENV: 'production',
        BIND_ADDRESS: '0.0.0.0',
        PORT: String(CONTAINER_PORT),
        ATTACHMENTS_DIR: '/data/attachments',
      };
      for (const key of ['DATABASE_URL', 'DATABASE_MIGRATE_URL', 'DATABASE_BACKUP_URL']) {
        const raw = containerEnv[key];
        if (raw === undefined) continue;
        const url = new URL(raw);
        if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
          url.hostname = 'host.docker.internal';
        containerEnv[key] = url.href;
      }
      stdout.length = 0;
      stderr.length = 0;
      try {
        const image = new ProductionImage(
          options.image ?? process.env['IRIDIUM_TEST_SERVER_IMAGE'] ?? 'iridium-server:ci',
          options.port,
        )
          .withEnvironment(containerEnv)
          .withExtraHosts([{ host: 'host.docker.internal', ipAddress: 'host-gateway' }])
          .withExposedPorts({ container: CONTAINER_PORT, host: options.port })
          .withBindMounts(mounts)
          .withTmpFs({ '/tmp': 'rw,noexec,nosuid,size=64m' })
          .withSecurityOpt('no-new-privileges:true')
          .withDroppedCapabilities('ALL')
          .withWaitStrategy(Wait.forHttp('/healthz', CONTAINER_PORT).forStatusCode(200))
          .withStartupTimeout(60_000)
          .withLogConsumer((stream) => {
            stream.on('data', (chunk: Buffer) => stdout.push(chunk.toString('utf8')));
            stream.on('err', (chunk: Buffer) => stderr.push(chunk.toString('utf8')));
          });
        if (options.network !== undefined) image.withNetwork(options.network);
        if (options.networkAliases !== undefined)
          image.withNetworkAliases(...options.networkAliases);
        started = await image.start();
      } catch (error) {
        throw new Error(
          `@iridium/testkit: production image failed to start.\n${stdout.join('')}\n${stderr.join('')}`,
          { cause: error },
        );
      }
    },
    kill,
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      try {
        try {
          await kill('SIGTERM');
        } finally {
          await started?.stop();
        }
      } finally {
        // mkdtemp returned this exact owned directory; caller-owned attachment directories remain.
        await rm(scratch, { recursive: true, force: true });
      }
    },
    async cli(args): Promise<CliResult> {
      if (started === undefined)
        throw new Error('@iridium/testkit: container CLI requires a running server');
      const result = await started.exec(['node', '/app/dist/main.mjs', ...args]);
      return { code: result.exitCode, signal: null, stdout: result.stdout, stderr: result.stderr };
    },
  };
}
