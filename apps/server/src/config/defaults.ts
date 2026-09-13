/**
 * The two network defaults that more than one entry point needs to agree on.
 *
 * `EnvSchema` owns every other default inline, where the key is declared, because a table of
 * defaults away from the keys is a table that drifts. These two are the exception: `dist/healthcheck.mjs`
 * is a separate bundle that must reach the same socket `serve` bound, and it cannot load `EnvSchema`
 * to find out — the probe runs on a slim image with no database, no secrets and a five-second budget,
 * while `EnvSchema` requires `DATABASE_URL` and `PUBLIC_ORIGIN` and exits `2` without them
 * (11-operations-and-deployment.md, "Configuration and secrets"; OPS-03).
 *
 * So the number lives here, in a leaf module with no imports, and both consumers read it. A second
 * literal `4000` in the probe would be a health check that silently passes on a stale port after
 * someone changes the schema.
 */

/** `BIND_ADDRESS` when unset: loopback, because the documented topology terminates TLS at a proxy. */
export const DEFAULT_BIND_ADDRESS = '127.0.0.1';

/** `PORT` when unset. */
export const DEFAULT_PORT = 4_000;
