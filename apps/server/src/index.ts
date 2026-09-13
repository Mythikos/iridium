/**
 * `@iridium/server`'s programmatic surface: the boot path and the configuration loader, and nothing
 * else.
 *
 * The package publishes no `exports` entry but `./package.json` (02-system-architecture.md, the
 * package table), and `dependents.allow: []` means no workspace may depend on it — so this module is
 * not an API for other packages. It exists for the two consumers that drive the server *in this
 * repository* and need a named surface rather than a deep path: `@iridium/testkit`'s
 * `startServer({ mode: 'in-process' })` and the `pnpm gen` step that exports the OpenAPI document
 * from `app.swagger()` with `database: 'none'`.
 *
 * `main.ts` is deliberately **not** re-exported: it runs the CLI at module evaluation, so importing it
 * would start a process. A consumer that wants the CLI spawns the built binary, which is what the
 * harness does.
 *
 * `knip.jsonc` lists this module as a non-production entry of the package for exactly that reason:
 * the shipped entries are `src/main.ts` and `src/ops/healthcheck.ts`, and this is the surface the
 * repository's own tooling reaches the server through.
 */

export { buildApp, startServer } from './app.ts';
export type { BuildAppOptions, ServerMode, StartedServer } from './app.ts';
export { loadConfig, loadConfigDetailed, redactConfig } from './config/env.ts';
export type { IridiumConfig, LoadedConfig, RawEnv } from './config/env.ts';
export { ConfigError } from './config/config-error.ts';
export type { DatabaseHandle, DatabaseMode } from './boot/db.ts';
export { assertRoutePolicies, RoutePolicyError } from './authz/route-policy.ts';
export type { RegisteredRoute, RouteAuth } from './authz/route-policy.ts';
export { READYZ_CHECK_NAMES } from './ops/readiness.ts';
export { applyOpenApiPlugin, hasOpenApi, openApiDocument } from './ops/openapi.ts';
export type { ReadyzBody, ReadyzCheck, ReadyzCheckName, ReadyzStatus } from './ops/readiness.ts';
