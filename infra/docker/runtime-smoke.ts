/**
 * M0's docker-image runtime proof (12-milestones.md §4.6; 11, "Image hygiene checks").
 * Uses an already-built server image, the real MySQL configuration/roles, production configuration,
 * and only disposable resources under a random Compose project. It never builds or publishes.
 *
 * node infra/docker/runtime-smoke.ts iridium-server:ci mysql:8.4.11
 * node infra/docker/runtime-smoke.ts iridium-server:ci mysql:9.7.2-oraclelinux9
 * The second argument may instead come from CI's IRIDIUM_MYSQL_IMAGE matrix variable.
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const INFRA_ROOT = join(REPO_ROOT, 'infra');
const EXEC_FILE = promisify(execFile);
const COMMAND_TIMEOUT_MS = 240_000;
const READY_TIMEOUT_MS = 60_000;
const DATA_PATHS: readonly string[] = Object.freeze([
  '/data/attachments',
  '/data/staging',
  '/data/exports',
  '/data/desktop-updates',
]);
// These prove the production server reached the real database and its mounted storage. Checks
// for later milestones may still warn; a missing or disconnected core check is never sufficient.
const REQUIRED_READY_CHECKS: readonly string[] = Object.freeze([
  'mysql_version',
  'db_app',
  'db_persist',
  'migrations',
  'collab_owner_lease',
  'grants',
  'durability',
  'attachment_store',
]);
const SECRET_FILES: readonly string[] = Object.freeze([
  'mysql_root_password',
  'db_app_password',
  'db_migrator_password',
  'db_backup_password',
  'auth_password_pepper_v1',
  'audit_hmac_key_v1',
  'mcp_cursor_key_v1',
  'metrics_token',
]);

class RuntimeSmokeError extends Error {
  constructor(message: string) {
    super(`docker-image: ${message}`);
    this.name = 'RuntimeSmokeError';
  }
}

interface DockerOptions {
  readonly cleanup?: boolean;
  readonly timeoutMs?: number;
}

/** The probe runs under the image's default UID, with the same mounts as the running server. */
const RUNTIME_PROBE = `
const fs = require('node:fs');
if (process.getuid() !== 10001 || process.getgid() !== 10001) {
  throw new Error('the image must run as UID:GID 10001:10001');
}
for (const directory of process.argv.slice(1)) {
  if (directory !== '/tmp') {
    const stat = fs.statSync(directory);
    if (stat.uid !== 10001 || stat.gid !== 10001 || (stat.mode & 0o777) !== 0o750) {
      throw new Error('fresh data volume must inherit image ownership and mode: ' + directory);
    }
  }
  const path = directory + '/.runtime-smoke-write';
  fs.writeFileSync(path, 'writable');
  fs.unlinkSync(path);
}
try {
  fs.writeFileSync('/app/dist/.runtime-smoke-write', 'must fail');
} catch (error) {
  if (error.code !== 'EROFS') throw error;
  console.info('UID:GID 10001:10001; fresh data volumes UID:GID 10001:10001 mode 0750; documented paths writable; root filesystem EROFS');
  process.exit(0);
}
throw new Error('the image root filesystem is writable');
`;

function isReady(body: string): boolean {
  const payload: unknown = JSON.parse(body);
  if (
    typeof payload !== 'object' ||
    payload === null ||
    !('status' in payload) ||
    (payload.status !== 'ok' && payload.status !== 'warn') ||
    !('checks' in payload) ||
    !Array.isArray(payload.checks)
  )
    return false;
  const checks: readonly unknown[] = payload.checks;
  return REQUIRED_READY_CHECKS.every((name) =>
    checks.some(
      (check) =>
        typeof check === 'object' &&
        check !== null &&
        'name' in check &&
        check.name === name &&
        'status' in check &&
        check.status === 'ok',
    ),
  );
}

async function awaitReady(url: string, signal: AbortSignal): Promise<string> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let last = 'no readiness response';
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    try {
      // eslint-disable-next-line no-await-in-loop -- each readiness probe observes the previous poll's result.
      const response = await fetch(url, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
      });
      // eslint-disable-next-line no-await-in-loop -- inspect this response before deciding whether to poll again.
      const body = await response.text();
      last = `HTTP ${String(response.status)}: ${body}`;
      if (response.status === 200 && isReady(body)) return body;
    } catch (error) {
      signal.throwIfAborted();
      last = error instanceof Error ? error.message : String(error);
    }
    // eslint-disable-next-line no-await-in-loop -- bounded polling waits between readiness observations.
    await delay(250, undefined, { signal });
  }
  throw new RuntimeSmokeError(`${url} never became ready: ${last}`);
}

async function main(): Promise<void> {
  const [image, mysqlImage = process.env['IRIDIUM_MYSQL_IMAGE'], ...extra] = process.argv.slice(2);
  if (
    !image ||
    !mysqlImage ||
    extra.length > 0 ||
    image.startsWith('-') ||
    mysqlImage.startsWith('-')
  ) {
    console.error(
      'Usage: node infra/docker/runtime-smoke.ts <built-server-image> [mysql-image]; ' +
        'the MySQL image may instead come from IRIDIUM_MYSQL_IMAGE.',
    );
    process.exitCode = 2;
    return;
  }

  const project = `iridium-runtime-smoke-${randomBytes(6).toString('hex')}`;
  const migrationContainer = `${project}-migrate`;
  // File-backed configs become read-only bind mounts. Compose must copy inline content into the
  // container, which it cannot do with a read-only root filesystem. mkdtemp keeps host access private.
  const secretDirectory = await mkdtemp(join(tmpdir(), `${project}-`));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    IRIDIUM_SMOKE_IMAGE: image,
    IRIDIUM_MYSQL_IMAGE: mysqlImage,
    IRIDIUM_SMOKE_SECRET_DIR: secretDirectory,
  };
  const shutdown = new AbortController();
  const interrupt = (): void => shutdown.abort();
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  const compose = [
    'compose',
    '--project-name',
    project,
    '--project-directory',
    INFRA_ROOT,
    '--file',
    join(INFRA_ROOT, 'compose.yaml'),
    '--file',
    join(INFRA_ROOT, 'docker', 'runtime-smoke.compose.yaml'),
    '--profile',
    'full',
  ];

  async function docker(args: readonly string[], options: DockerOptions = {}): Promise<string> {
    const { stdout } = await EXEC_FILE('docker', [...args], {
      cwd: REPO_ROOT,
      env,
      timeout: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      ...(options.cleanup ? {} : { signal: shutdown.signal }),
    });
    return stdout.trim();
  }

  let started = false;
  try {
    for (const file of SECRET_FILES) {
      // eslint-disable-next-line no-await-in-loop -- finish each secret write before failure can trigger directory cleanup.
      await writeFile(join(secretDirectory, file), randomBytes(32).toString('base64'), {
        mode: 0o444,
        flag: 'wx',
      });
    }
    await docker([...compose, 'config', '--quiet']);
    const imageUser = await docker(['image', 'inspect', image, '--format', '{{.Config.User}}']);
    if (!imageUser || /^(?:root|0)(?::|$)/.test(imageUser)) {
      throw new RuntimeSmokeError(`${image} has no non-root default USER; fix server.Dockerfile`);
    }
    console.info(`docker-image: starting ${image} against ${mysqlImage} (${project})`);
    started = true;
    await docker([...compose, 'up', '--detach', '--no-build', '--wait', '--wait-timeout', '180']);
    const container = await docker([...compose, 'ps', '--all', '--quiet', 'server']);
    if (!container || container.includes('\n')) {
      throw new RuntimeSmokeError('expected exactly one server container in the smoke project');
    }

    const readOnly = await docker([
      'inspect',
      '--format',
      '{{.HostConfig.ReadonlyRootfs}}',
      container,
    ]);
    const containerUser = await docker(['inspect', '--format', '{{.Config.User}}', container]);
    if (readOnly !== 'true' || containerUser !== imageUser) {
      throw new RuntimeSmokeError(
        'the server must retain the image USER and a read-only root filesystem',
      );
    }
    const mounts = await docker([
      'inspect',
      '--format',
      '{{range .Mounts}}{{if .RW}}{{println .Destination}}{{end}}{{end}}{{range $path, $options := .HostConfig.Tmpfs}}{{println $path}}{{end}}',
      container,
    ]);
    const actualPaths = [...new Set(mounts.split(/\r?\n/).filter(Boolean))].toSorted();
    const expectedPaths = [...DATA_PATHS, '/tmp'].toSorted();
    if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
      throw new RuntimeSmokeError(`unexpected writable mounts: ${JSON.stringify(actualPaths)}`);
    }
    console.info(await docker(['exec', container, 'node', '-e', RUNTIME_PROBE, ...expectedPaths]));

    const address = await docker([...compose, 'port', 'server', '4000']);
    if (!/^127\.0\.0\.1:\d+$/.test(address)) {
      throw new RuntimeSmokeError(
        `the server port must be published only on loopback; received ${address}`,
      );
    }
    const ready = await awaitReady(`http://${address}/readyz`, shutdown.signal);
    console.info(`docker-image: /readyz HTTP 200 ${ready}`);
    const status = await docker([
      ...compose,
      'run',
      '--rm',
      '--no-deps',
      '--name',
      migrationContainer,
      'server',
      'migrate',
      'status',
    ]);
    console.info(`docker-image: migrate status exited 0\n${status}`);
    console.info(`docker-image: runtime checks passed against ${mysqlImage}`);
  } catch (error) {
    process.exitCode = 1;
    console.error(error);
    if (started) {
      try {
        console.error(
          await docker([...compose, 'logs', '--no-color', '--timestamps'], {
            cleanup: true,
            timeoutMs: 30_000,
          }),
        );
      } catch (logError) {
        console.error('docker-image: failed to collect container logs', logError);
      }
    }
  } finally {
    if (started) {
      try {
        // A cancelled `compose run` may leave its one-off container running. Remove only its exact
        // generated name before down removes this project's network and volumes.
        const oneOff = await docker(
          ['container', 'ls', '--all', '--quiet', '--filter', `name=^/${migrationContainer}$`],
          { cleanup: true, timeoutMs: 30_000 },
        );
        if (oneOff)
          await docker(['container', 'rm', '--force', '--volumes', oneOff], { cleanup: true });
      } catch (cleanupError) {
        process.exitCode = 1;
        console.error(
          `docker-image: one-off cleanup failed for ${migrationContainer}`,
          cleanupError,
        );
      }
      try {
        await docker([...compose, 'down', '--volumes', '--remove-orphans', '--timeout', '45'], {
          cleanup: true,
          timeoutMs: 120_000,
        });
      } catch (cleanupError) {
        process.exitCode = 1;
        console.error(`docker-image: cleanup failed for ${project}`, cleanupError);
      }
    }
    try {
      // This exact directory was created by mkdtemp above and contains only this run's secrets.
      await rm(secretDirectory, { recursive: true, force: true });
    } catch (cleanupError) {
      process.exitCode = 1;
      console.error(`docker-image: secret cleanup failed for ${secretDirectory}`, cleanupError);
    }
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
  }
}

await main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 2;
});
