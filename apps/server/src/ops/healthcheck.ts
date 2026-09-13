/**
 * `dist/healthcheck.mjs` — the container health probe (11-operations-and-deployment.md, "Container
 * image"; OPS-03, OPS-23).
 *
 * The image's `HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3` runs
 * `node /app/dist/healthcheck.mjs`. It performs `GET /healthz` against the loopback address this
 * process listens on and exits `0` on HTTP 200, `1` otherwise. The slim base image has no `curl`, and
 * adding one for a health probe is needless attack surface.
 *
 * Three properties make this a second tsdown entry rather than a sub-command of `main.mjs`:
 *
 * 1. **It is database-free.** `/healthz` performs no database work (OPS-23) precisely so a database
 *    outage cannot mark the container unhealthy and trip the restart policy — restarting discards
 *    every loaded `Y.Doc` and the in-process ticket store, turning a recoverable blip into
 *    user-visible data risk. A probe that loaded the server's boot path would undo that.
 * 2. **It does not parse `EnvSchema`.** `loadConfig()` requires `DATABASE_URL` and `PUBLIC_ORIGIN`
 *    and exits `2` without them, so a probe built on it would report "unhealthy" for a configuration
 *    problem the running server has already survived — and it reads the file-backed secrets, which
 *    the probe has no business touching. It reads the two keys that decide *which socket to open* and
 *    nothing else; `DEFAULT_PORT` is shared with `EnvSchema` rather than restated, so the probe can
 *    never address a stale port.
 * 3. **It is bounded.** Docker kills the probe at its own `--timeout`, which reports a timeout as a
 *    failed check on a server that may be perfectly healthy but slow to accept. The request carries
 *    its own shorter deadline so the answer is this module's, not the supervisor's.
 *
 * The address is always loopback, never `BIND_ADDRESS`: the probe runs inside the container it is
 * probing, `/healthz` is exempt from the Host guard exactly so it can be addressed as
 * `127.0.0.1:4000` (ARCH-03), and a server bound to `0.0.0.0` is reachable on loopback anyway. In
 * the air-gapped profile Fastify terminates TLS itself, so `TLS_CERT_FILE` selects HTTPS with
 * `rejectUnauthorized: false` — the peer is this same process over the loopback interface, and the
 * certificate is issued for the public name rather than for `127.0.0.1`.
 */
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

import { DEFAULT_PORT } from '../config/defaults.ts';
import { processEnv, type RawEnv } from '../config/process-env.ts';
import { HEALTHZ_PATH } from './paths.ts';

/** Loopback, because the probe runs inside the container it probes. */
export const PROBE_HOST = '127.0.0.1';

/**
 * The probe's own deadline, comfortably inside the image's `--timeout=5s` so that a slow answer is
 * reported by this module as a failed probe rather than by Docker as a killed one.
 */
export const PROBE_TIMEOUT_MS = 4_000;

/** `0` healthy, `1` not. The probe has no other vocabulary: Docker reads only these two. */
export const PROBE_EXIT = Object.freeze({ healthy: 0, unhealthy: 1 });

const HTTP_OK = 200;

/** Where the probe should send its request, derived from the same keys `serve` binds with. */
export interface ProbeTarget {
  readonly port: number;
  readonly tls: boolean;
}

/**
 * Resolves the target from an environment record.
 *
 * A `PORT` that is absent, unparseable or out of range falls back to `DEFAULT_PORT` rather than
 * failing: the probe's job is to answer "is the server up", and it must not report a healthy server
 * unhealthy because of a value the server itself already rejected at boot.
 */
export function resolveProbeTarget(env: RawEnv): ProbeTarget {
  const raw = env.PORT;
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  const port = Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : DEFAULT_PORT;
  const certFile = env.TLS_CERT_FILE;
  return { port, tls: certFile !== undefined && certFile !== '' };
}

/**
 * Performs the request and resolves to the exit code. Never rejects: every failure mode — connection
 * refused, DNS, timeout, a non-200 status — is the same answer to the only question Docker asked.
 */
export async function probeHealthz(target: ProbeTarget): Promise<number> {
  const send = target.tls ? httpsRequest : httpRequest;
  return new Promise<number>((resolve) => {
    let settled = false;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      resolve(code);
    };

    const request = send(
      {
        host: PROBE_HOST,
        port: target.port,
        path: HEALTHZ_PATH,
        method: 'GET',
        timeout: PROBE_TIMEOUT_MS,
        // The peer is this same process over loopback, and its certificate is issued for the public
        // name, not for 127.0.0.1. Verifying it here would fail every probe in the air-gapped profile.
        ...(target.tls ? { rejectUnauthorized: false } : {}),
      },
      (response) => {
        const healthy = response.statusCode === HTTP_OK;
        // The body is drained rather than read: nothing here parses it, and an undrained response
        // keeps the socket open past the process's useful life.
        response.resume();
        response.on('end', () => finish(healthy ? PROBE_EXIT.healthy : PROBE_EXIT.unhealthy));
        response.on('error', () => finish(PROBE_EXIT.unhealthy));
      },
    );

    request.on('timeout', () => {
      request.destroy();
      finish(PROBE_EXIT.unhealthy);
    });
    request.on('error', () => finish(PROBE_EXIT.unhealthy));
    request.end();
  });
}

/** The process entry. Kept separate from the two functions above so each stays directly testable. */
async function main(): Promise<void> {
  process.exitCode = await probeHealthz(resolveProbeTarget(processEnv()));
}

void main();
