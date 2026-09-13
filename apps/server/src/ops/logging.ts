/**
 * The pino logger (11-operations-and-deployment.md, "Logging"; ARCH-15).
 *
 * One JSON object per line on stdout, the level formatter emitting the label rather than the
 * number, ISO timestamps, and a `redact` list that covers credentials, note content and Yjs update
 * bytes. Fastify runs with `disableRequestLogging: true` and the ops plugin writes exactly one
 * `http.request` line per response, so a request produces one line and never three.
 *
 * `LOG_FORMAT=pretty` selects the `pino-pretty` transport and is refused in production by
 * `EnvSchema`, so a production deployment cannot emit a non-machine-readable stream.
 *
 * The contract `logging-redaction.integration` asserts is absolute: every line on stdout and
 * stderr parses as one pino JSON object, boot lines included. That is why nothing in
 * `apps/server/src` calls `console.*` and why the MCP SDK's one construction-time `console.warn`
 * is wrapped rather than tolerated.
 */
import { hostname } from 'node:os';

import { pino, type DestinationStream, type Logger, type LoggerOptions } from 'pino';

import { BUILD_INFO, SERVICE_NAME } from './build-info.ts';

/** The pino instance the whole process shares. */
export type ServerLogger = Logger;

/** What `createLogger` needs from the configuration: the two observability knobs. */
export interface LoggingOptions {
  readonly level: string;
  readonly format: 'json' | 'pretty';
  /** `<hostname>:<pid>:<boot-uuid-short>` — present on every line so two processes are separable. */
  readonly instanceId: string;
  /** Test seam: a stream to write to instead of stdout, used by `logging-redaction.integration`. */
  readonly destination?: DestinationStream;
}

/**
 * The redaction paths of 11-operations-and-deployment.md, "pino configuration". `*.markdown` and
 * `*.update` are defensive rather than expected: no code path logs note content, and these paths
 * make a future mistake harmless instead of a disclosure.
 */
export const REDACT_PATHS: readonly string[] = Object.freeze([
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.token',
  '*.secret',
  '*.markdown',
  '*.update',
]);

/** `<hostname>:<pid>:<boot-uuid-short>`; the boot id makes two runs on one host distinguishable. */
export function newInstanceId(bootId: string): string {
  return `${hostname()}:${String(process.pid)}:${bootId.slice(0, 8)}`;
}

/** Builds the process logger. Called once, by `buildApp`. */
export function createLogger(options: LoggingOptions): ServerLogger {
  const base: LoggerOptions = {
    level: options.level,
    formatters: { level: (label) => ({ level: label }) },
    timestamp: pino.stdTimeFunctions.isoTime,
    base: {
      service: SERVICE_NAME,
      version: BUILD_INFO.version,
      commit: BUILD_INFO.commit,
      pid: process.pid,
      instanceId: options.instanceId,
    },
    redact: { paths: [...REDACT_PATHS], censor: '[redacted]' },
  };

  if (options.destination !== undefined) {
    return pino(base, options.destination);
  }
  if (options.format === 'pretty') {
    return pino({ ...base, transport: { target: 'pino-pretty' } });
  }
  return pino(base);
}
