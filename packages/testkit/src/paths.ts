/**
 * Filesystem anchors for the harness (10-testing-and-quality.md, "`@iridium/testkit`").
 *
 * Every path is derived from this module's own location rather than from `process.cwd()`, because the
 * harness is called from the repository root (Vitest), from a package directory (`pnpm --filter … test`)
 * and from `dist` (a consumer importing `@iridium/testkit`). `src/paths.ts` compiles to `dist/paths.js`
 * — `rootDir: src`, `outDir: dist` — so `new URL('../', import.meta.url)` is the package root in both
 * layouts. `testkit.fixtures.unit` pins that invariant, because moving this file one directory deeper
 * would silently move every fixture and infrastructure path with it.
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** `<repo>/packages/testkit/` — the directory holding this package's `package.json`. */
export const TESTKIT_PACKAGE_ROOT: string = fileURLToPath(new URL('../', import.meta.url));

/** `<repo>/` — the pnpm workspace root. */
export const REPO_ROOT: string = resolve(TESTKIT_PACKAGE_ROOT, '..', '..');

/** `<repo>/packages/testkit/src/fixtures/` — committed fixture corpora (fixture policy rule 5). */
export const FIXTURES_ROOT: string = join(TESTKIT_PACKAGE_ROOT, 'src', 'fixtures');

/**
 * The shipped MySQL server configuration, mounted into the Testcontainers fixture at
 * `/etc/mysql/conf.d/iridium.cnf` exactly as `infra/compose.yaml` mounts it
 * (11-operations-and-deployment.md, "Reference topology"). Owned by `infra/`, never copied here.
 */
export const MYSQL_CONF_FILE: string = join(REPO_ROOT, 'infra', 'docker', 'mysql', 'my.cnf');

/**
 * The shipped role bootstrap, mounted at `/docker-entrypoint-initdb.d/01_roles.sh` so `iridium_app`,
 * `iridium_migrator` and `iridium_backup` exist in tests exactly as in production
 * (03-data-model.md §2; 11-operations-and-deployment.md, "Roles"; OPS-11 renamed it from `01_roles.sql`).
 */
export const MYSQL_INIT_ROLES_FILE: string = join(
  REPO_ROOT,
  'infra',
  'docker',
  'mysql',
  'init',
  '01_roles.sh',
);

/** The directory `01_roles.sh` lives in; every file in it is mounted into the init directory. */
export const MYSQL_INIT_DIR: string = join(REPO_ROOT, 'infra', 'docker', 'mysql', 'init');

/** The built server binary `startServer({ mode: 'child' })` spawns (`tsdown` output of `apps/server`). */
export const SERVER_DIST_ENTRY: string = join(REPO_ROOT, 'apps', 'server', 'dist', 'main.mjs');

/** The server's `buildApp` module, imported by path because `@iridium/server` must not depend on itself. */
export const SERVER_APP_MODULE: string = join(REPO_ROOT, 'apps', 'server', 'src', 'app.ts');

/** The committed OpenAPI document `toMatchOpenApi` validates against (`pnpm gen` writes it). */
export const OPENAPI_DOCUMENT: string = join(
  REPO_ROOT,
  'packages',
  'contracts',
  'openapi',
  'openapi.json',
);

/**
 * Assert that a path produced above exists, naming the artefact and the command that creates it.
 * A missing harness input is a setup error with a fix, never an `ENOENT` from three frames down.
 */
export function requireExistingPath(path: string, artefact: string, fix: string): string {
  if (!existsSync(path)) {
    throw new Error(`@iridium/testkit: ${artefact} is missing at ${path}. ${fix}`);
  }
  return path;
}
