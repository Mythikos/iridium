/**
 * The real `buildApp` in `in-process` mode with no database, plus a log capture.
 *
 * Every spike mounts its route on the product's own Fastify instance so that the security plugin's
 * `onRequest` chain (request id, Host guard, hardening headers, rate limiter, load shedding) and the
 * route-policy boot assertion run for real; `database: 'none'` is the same mode `pnpm gen` uses.
 * The port is reserved first so `PUBLIC_ORIGIN` names it, exactly as `@iridium/testkit`'s
 * `startServer` does — the Host guard compares against that origin's host.
 */
import { Writable } from 'node:stream';

import { newId } from '@iridium/contracts';
import { buildServerEnv, reserveLoopbackPort } from '@iridium/testkit';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../../../src/app.ts';
import { createLogger, newInstanceId } from '../../../src/ops/logging.ts';

export interface SpikeApp {
  readonly app: FastifyInstance;
  readonly port: number;
  /** `http://127.0.0.1:<port>` — also `PUBLIC_ORIGIN` and the `/collab` Origin allowlist entry. */
  readonly origin: string;
  readonly wsUrl: string;
  /** `config.server.publicHost`: host **with** port, as `EnvSchema` derives it. */
  readonly publicHost: string;
  /** The hostname alone, which is what `hostHeaderValidation` compares. */
  readonly publicHostname: string;
  /** Every pino line at `warn` or above, parsed. */
  readonly logLines: readonly Record<string, unknown>[];
  /** `ready()` + `listen()` once the spike has registered its routes. */
  listen(): Promise<void>;
  close(): Promise<void>;
}

export interface BuildSpikeAppOptions {
  /** Reuse a port across restarts, as a real restart would. */
  readonly port?: number;
  readonly extraEnv?: Readonly<Record<string, string>>;
}

function parseLogLine(line: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { raw: line };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { raw: line };
  return Object.fromEntries(Object.entries(parsed));
}

export async function buildSpikeApp(options: BuildSpikeAppOptions = {}): Promise<SpikeApp> {
  const port = options.port ?? (await reserveLoopbackPort());
  const origin = `http://127.0.0.1:${String(port)}`;
  const env = buildServerEnv({
    host: '127.0.0.1',
    port: 3306,
    schema: 'iridium_spike',
    publicOrigin: origin,
    extraEnv: { PORT: String(port), ...options.extraEnv },
  });

  const logLines: Record<string, unknown>[] = [];
  let pending = '';
  const destination = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      pending += chunk.toString();
      const parts = pending.split('\n');
      pending = parts.pop() ?? '';
      for (const line of parts) {
        if (line.trim() === '') continue;
        logLines.push(parseLogLine(line));
      }
      callback();
    },
  });
  const logger = createLogger({
    level: 'warn',
    format: 'json',
    instanceId: newInstanceId(newId()),
    destination,
  });

  const app = await buildApp({ mode: 'in-process', database: 'none', env, logger });
  const { publicHost } = app.iridiumConfig.server;
  const publicHostname = app.iridiumConfig.server.publicOrigin.hostname;

  return {
    app,
    port,
    origin,
    wsUrl: `ws://127.0.0.1:${String(port)}/collab`,
    publicHost,
    publicHostname,
    logLines,
    async listen(): Promise<void> {
      await app.ready();
      await app.listen({ port, host: '127.0.0.1' });
    },
    async close(): Promise<void> {
      await app.close();
    },
  };
}

/** Log lines mentioning a double-send — the hijack defect S14 looks for. */
export function doubleSendLines(
  lines: readonly Record<string, unknown>[],
): readonly Record<string, unknown>[] {
  const needles = [
    'FST_ERR_REP_ALREADY_SENT',
    'ERR_HTTP_HEADERS_SENT',
    'ERR_STREAM_WRITE_AFTER_END',
  ];
  return lines.filter((line) => needles.some((needle) => JSON.stringify(line).includes(needle)));
}
