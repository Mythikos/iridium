/**
 * Booting the application for a CLI command.
 *
 * Every command that touches data runs against the **same** `buildApp` the server runs — invariant 1,
 * one boot path — in `in-process` mode, which listens on nothing and starts no scheduler. That is
 * what makes "a CLI command can never see a different schema, a different validation or a different
 * set of secrets than the running server" (`main.ts`'s header) true of the services and not only of
 * the configuration: `admin create-user` reaches the same user service `POST /admin/users` calls,
 * `audit verify-chain` reads the same keyring the writer signs with, and `sessions revoke-all`
 * submits a durable command executed by the serving owner before its `AuthzBus` fan-out.
 *
 * **The booted application logs to stderr, not to stdout.** The boot path writes pino lines —
 * `config.loaded`, the migration status, a degraded readiness check — and half the command inventory
 * offers `--json` so that `jq` can read the answer. A JSON document preceded by four log lines is not
 * a JSON document, so the CLI hands `buildApp` a logger whose destination is stderr and keeps stdout
 * for the command's own output. Nothing is suppressed; it is on the stream diagnostics belong on.
 *
 * The three commands that do **not** boot are `version` (a pure function of the build), `config check`
 * (a pure function of the environment, and the first `ExecStartPre` of the systemd unit, which must
 * work before a database exists) and `migrate` (which holds the migrator credential the serving
 * process deliberately does not have — A7, A8, ARCH-20).
 */
import { newId } from '@iridium/contracts';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';

import { buildApp } from '../app.ts';
import type { IridiumConfig } from '../config/env.ts';
import type { Database } from '../db/index.ts';
import { createLogger, newInstanceId, type ServerLogger } from '../ops/logging.ts';

/**
 * Thrown when a command that needs data finds no connected database.
 *
 * Exit `3` rather than `1`: nothing ran, so this is an unmet precondition and not an internal error,
 * and a cron wrapper that retries on `3` is doing the right thing. The message carries the reason the
 * handle recorded, because "could not connect" without the driver's own sentence is unactionable.
 */
export class DatabaseUnavailableError extends Error {
  readonly exitCode = 3;

  constructor(command: string, reason: string) {
    super(
      `iridium ${command} needs a reachable database and none is connected: ${reason}. Check ` +
        'DATABASE_URL and the `iridium_app` role, then run `iridium config check` to confirm the ' +
        'environment this process parses.',
    );
    this.name = 'DatabaseUnavailableError';
  }
}

/**
 * Builds, readies, runs and closes. The instance never listens and is always closed, including on a
 * throw — a CLI process that leaked a MySQL pool would hang instead of exiting.
 */
export async function withCliApp<T>(
  config: IridiumConfig,
  run: (app: FastifyInstance) => Promise<T>,
): Promise<T> {
  // The logger's own `instanceId` is derived here rather than from `buildApp`'s boot id, because the
  // instance is decorated after the logger it is handed. Same host, same pid, a different boot uuid;
  // nothing in the CLI reads either, and the alternative is a `buildApp` option no server needs.
  const logger = createLogger({
    level: config.ops.logLevel,
    format: config.ops.logFormat,
    instanceId: newInstanceId(newId()),
    destination: process.stderr,
  });
  // `role: 'cli'` is what keeps a command out of the collaboration subsystem: a process that never
  // listens has no use for the `iridium_collab_owner` lease, and taking it would make a running
  // server's `/collab` upgrades fail for the length of an `iridium audit verify-chain`. The repair
  // command and offline session-command execution acquire it explicitly for their own operation.
  const app = await buildApp({ mode: 'in-process', role: 'cli', config, logger });
  await app.ready();
  try {
    return await run(app);
  } finally {
    await shutdown(app, logger);
  }
}

/**
 * The drain, then the close — the same order `serve` follows on SIGTERM (ARCH-06), and for a reason
 * a CLI feels immediately: **without the drain the process never exits.**
 *
 * The collaboration owner lease holds a connection out of `dbPersist` for the life of the process and
 * gives it back in the `resources` drain phase. `app.close()` runs `onClose`, which destroys the
 * pools, and destroying a pool waits for its connections — so a close without a drain waits forever
 * for a connection only the drain returns. Every command that boots therefore drains, exactly as the
 * server does.
 *
 * A drain that fails does **not** change the command's exit code. By the time it runs, the command
 * has committed its transaction and printed its answer; turning a successful `admin create-user` into
 * a failure because a subsystem took too long to let go would tell an operator the user was not
 * created. The reason goes to stderr, where the rest of the diagnostics are.
 */
async function shutdown(app: FastifyInstance, logger: ServerLogger): Promise<void> {
  try {
    await app.drain();
  } catch (error) {
    logger.error(
      { err: error, event: 'persist.drain_timeout' },
      'the command finished, but the drain did not',
    );
  }
  await app.close();
}

/** The application pool, or the refusal that names why there is none. */
export function requireDatabase(app: FastifyInstance, command: string): Kysely<Database> {
  const db = app.database.dbApp;
  if (db === null) {
    throw new DatabaseUnavailableError(command, app.database.connectionError() ?? 'not connected');
  }
  return db;
}
