/**
 * The pinned command-line tools of the codegen pipeline, in one table.
 *
 * Every version here is the catalog version of `pnpm-workspace.yaml` (`catalogMode: strict`,
 * `saveExact: true`), and `from` is the workspace whose manifest declares the tool. That is the
 * workspace that owns the artefact it produces (09-api-reference.md §6, the artefact table), with one
 * exception: openapi-typescript needs the TypeScript 6 alias, so it is declared by a leaf tooling
 * package that nothing compiles against, and only its output belongs to `packages/api-client`:
 *
 *   `@redocly/cli`        lints  `packages/contracts/openapi/openapi.json`   → packages/contracts
 *   `openapi-typescript`  writes `packages/api-client/src/generated/…`        → tooling/api-codegen
 *   `kysely-codegen`      reads  the migrated database                        → apps/server
 *
 * Recording the pin here rather than inside each step means a step prints the installed version
 * beside the pinned one, so a drift between the catalog and the lockfile is visible in the pipeline
 * summary instead of being discovered as a behaviour change.
 */
import { API_CODEGEN_ROOT, CONTRACTS_ROOT, SERVER_ROOT } from './paths.ts';
import type { ToolSpec } from './process.ts';

/** `@redocly/cli 2.52.1 lint` — step 2. */
export const REDOCLY: ToolSpec = {
  pkg: '@redocly/cli',
  bin: 'redocly',
  from: CONTRACTS_ROOT,
  pinnedVersion: '2.52.1',
};

/** `openapi-typescript 7.13.0` — step 3. */
export const OPENAPI_TYPESCRIPT: ToolSpec = {
  pkg: 'openapi-typescript',
  bin: 'openapi-typescript',
  from: API_CODEGEN_ROOT,
  pinnedVersion: '7.13.0',
};

/** `kysely-codegen 0.20.0` — step 4. */
export const KYSELY_CODEGEN: ToolSpec = {
  pkg: 'kysely-codegen',
  bin: 'kysely-codegen',
  from: SERVER_ROOT,
  pinnedVersion: '0.20.0',
};
