/**
 * The three operational paths, in one place because four different rules are written against the
 * same set and a fourth list would eventually disagree with the other three.
 *
 * `/healthz`, `/readyz` and `/metrics` are exempt from the Host guard (so a container health check
 * can address `127.0.0.1:4000` directly, ARCH-03), from rate limiting, from load shedding, and from
 * the not-ready gate — the last of which is the load-bearing one: while migrations are pending the
 * process must still answer `iridium_migrations_pending` and the readiness gauges, because a
 * monitoring system that goes blind at the moment it is needed is the worse outcome
 * (11-operations-and-deployment.md, "Boot sequence and fail-closed readiness").
 */

/** Liveness. Performs no database work, which is why the container `HEALTHCHECK` uses it (OPS-23). */
export const HEALTHZ_PATH = '/healthz';
/** Readiness: the fifteen checks, fail-closed on `migrations`. */
const READYZ_PATH = '/readyz';
/** The Prometheus exposition, protected by `METRICS_TOKEN` or `METRICS_ALLOW_CIDR`. */
const METRICS_PATH = '/metrics';

/** `/healthz`, `/readyz`, `/metrics`. */
export const OPS_PATHS: readonly string[] = Object.freeze([
  HEALTHZ_PATH,
  READYZ_PATH,
  METRICS_PATH,
]);

/** Whether a request path is one of the three operational endpoints. */
export function isOpsPath(path: string): boolean {
  const queryStart = path.indexOf('?');
  const bare = queryStart === -1 ? path : path.slice(0, queryStart);
  return OPS_PATHS.includes(bare);
}
