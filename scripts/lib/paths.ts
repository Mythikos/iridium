/**
 * Filesystem anchors for the `pnpm gen` pipeline (12-milestones.md §4.3, "Codegen pipeline") and for
 * the `static`-job checks that run beside it (10-testing-and-quality.md, "CI lanes").
 *
 * Every path is derived from this module's own location, never from `process.cwd()`: `pnpm gen` is
 * run from the repository root, from a package directory through Turbo, and from the `static` CI
 * job, and a generated artefact that lands in a different place depending on the caller is a drift
 * gate that fails for the wrong reason. The checks are held to the same rule for the same reason —
 * a licence scan that walks a different closure depending on where it was invoked is not a gate.
 *
 * The committed artefacts listed here are exactly the set `gen.drift.guard` checks
 * (10-testing-and-quality.md, "Guard tests"): `openapi.json`, `paths.d.ts`, `mcp/tools.schema.json`,
 * the desktop IPC typings, the msw handler skeleton, `docs/non-goals.json` and
 * `docs/acceptance-map.json`. `apps/server/src/db/schema.ts` is on that list too, but it is
 * hand-written and only *compared* against generated output — see `check-kysely-schema.ts`.
 */
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** `<repo>/scripts/` — the directory holding the pipeline. */
export const SCRIPTS_ROOT: string = fileURLToPath(new URL('../', import.meta.url));

/** `<repo>/` — the pnpm workspace root. */
export const REPO_ROOT: string = resolve(SCRIPTS_ROOT, '..');

/** `<repo>/docs/plan/` — the specification the parsers read. */
export const PLAN_ROOT: string = join(REPO_ROOT, 'docs', 'plan');

/** `<repo>/docs/` — where the two generated documentation artefacts land. */
export const DOCS_ROOT: string = join(REPO_ROOT, 'docs');

/** The plan documents the generators parse, named rather than globbed so a rename is a hard error. */
export const PLAN_DOCUMENTS = {
  /** §4.4 Explicit non-goals, and §1.3 for the two composite claims. */
  vision: join(PLAN_ROOT, '01-vision-scope-and-principles.md'),
  /** The five inventories `scripts/build-acceptance-map.ts` parses. */
  testing: join(PLAN_ROOT, '10-testing-and-quality.md'),
  /** §4.6's M0 exit criteria, asserted by the acceptance-map builder's self-check. */
  milestones: join(PLAN_ROOT, '12-milestones.md'),
  /** The traceability matrix, whose `Milestone` column is the fallback milestone source. */
  traceability: join(PLAN_ROOT, '15-requirements-traceability.md'),
} as const;

/** `docs/milestones/CURRENT` — the one line that says which milestone is open. */
export const CURRENT_MILESTONE_FILE: string = join(REPO_ROOT, 'docs', 'milestones', 'CURRENT');

/** Every artefact `pnpm gen` writes, and the one it only reads. */
export const ARTEFACTS = {
  /** Step 1: `app.swagger()` from an `in-process` app with no database. */
  openapi: join(REPO_ROOT, 'packages', 'contracts', 'openapi', 'openapi.json'),
  /** Step 3: `openapi-typescript` over that document. */
  apiClientPaths: join(REPO_ROOT, 'packages', 'api-client', 'src', 'generated', 'paths.d.ts'),
  /** Step 4's comparison target. Hand-written by design (03-data-model.md §1.3). */
  kyselySchema: join(REPO_ROOT, 'apps', 'server', 'src', 'db', 'schema.ts'),
  /** Step 5: the frozen MCP tool set, empty until M3. */
  mcpTools: join(REPO_ROOT, 'packages', 'contracts', 'mcp', 'tools.schema.json'),
  /** Step 6: the `window.iridium` typings (02-system-architecture.md, the `pnpm gen` artefact table). */
  desktopIpc: join(REPO_ROOT, 'packages', 'contracts', 'src', 'generated', 'desktop-ipc.d.ts'),
  /**
   * Step 7: the generated half of the msw handler skeleton.
   *
   * It sits under a `generated/` directory so it inherits the repository-wide `**\/generated\/**`
   * exclusions of `.oxfmtrc.jsonc` and `oxlint.config.ts`, exactly like the api-client artefact.
   * `packages/testkit/src/msw/handlers.ts` beside it stays hand-written: the origin convention, the
   * `ProblemDetails` shape and the `501` default are decisions, not derivations.
   */
  mswOperations: join(REPO_ROOT, 'packages', 'testkit', 'src', 'msw', 'generated', 'operations.ts'),
  /** Step 8: the declared non-goals, read by `guards.non-goals.guard`. */
  nonGoals: join(DOCS_ROOT, 'non-goals.json'),
  /** Step 9: the acceptance map, read by `guards.acceptance-map.guard`. Written last. */
  acceptanceMap: join(DOCS_ROOT, 'acceptance-map.json'),
} as const;

/** Source modules the generators read rather than write. */
export const SOURCES = {
  /** The hand-written `NonGoalId` union the generated ids must equal. */
  nonGoalIds: join(REPO_ROOT, 'packages', 'contracts', 'src', 'non-goals.ts'),
  /** The typed `window.iridium` surface the desktop shell ships at M0. */
  desktopBridge: join(REPO_ROOT, 'apps', 'desktop', 'src', 'shared', 'bridge.ts'),
  /** The `ipcMain.handle` registry, so the generated channel list cannot outrun the shell. */
  desktopIpcRegistry: join(REPO_ROOT, 'apps', 'desktop', 'src', 'main', 'ipc.ts'),
} as const;

/** `<repo>/apps/server` — the package that owns kysely-codegen, kysely-ctl and the migrations. */
export const SERVER_ROOT: string = join(REPO_ROOT, 'apps', 'server');

/** `<repo>/packages/testkit` — the package that owns msw. */
export const TESTKIT_ROOT: string = join(REPO_ROOT, 'packages', 'testkit');

/** `<repo>/packages/api-client` — the package that owns the generated `paths.d.ts`. */
export const API_CLIENT_ROOT: string = join(REPO_ROOT, 'packages', 'api-client');

/**
 * `<repo>/tooling/api-codegen` — the leaf package that declares openapi-typescript.
 *
 * It is not the artefact's owner: openapi-typescript prints through TypeScript's JavaScript compiler
 * API, which the native TypeScript 7 checker does not ship (R-T10), so the tool lives in a package
 * whose `typescript` is the `@typescript/typescript6` alias (A2), the way Stryker's checker does in
 * `tooling/mutation`. `@iridium/api-client` compiles the output with TypeScript 7 like everything else.
 */
export const API_CODEGEN_ROOT: string = join(REPO_ROOT, 'tooling', 'api-codegen');

/** `<repo>/packages/contracts` — the package that owns @redocly/cli. */
export const CONTRACTS_ROOT: string = join(REPO_ROOT, 'packages', 'contracts');

/** `<repo>/reports/` — the untracked directory every lane writes its evidence into. */
export const REPORTS_ROOT: string = join(REPO_ROOT, 'reports');

/**
 * The four workspaces whose **production** dependency closure the licence scan walks
 * (10-testing-and-quality.md, "License and supply-chain scan"; D10-12).
 *
 * They are the four things a site actually runs: the server, the two hosts and the stdio bridge.
 * Everything else in the workspace is a build-time or test-time dependency and is out of scope by
 * specification, which is why this is a fixed list rather than a glob over `apps/*`.
 */
export const PRODUCTION_WORKSPACES: readonly string[] = [
  SERVER_ROOT,
  join(REPO_ROOT, 'apps', 'web'),
  join(REPO_ROOT, 'apps', 'desktop'),
  join(REPO_ROOT, 'packages', 'mcp-bridge'),
];

/** `<repo>/apps/web/dist` — the Vite output `turbo run build --filter=@iridium/web` produces. */
export const WEB_DIST: string = join(REPO_ROOT, 'apps', 'web', 'dist');

/** `<repo>/apps/desktop/dist/renderer` — the renderer half of the desktop build. */
export const DESKTOP_RENDERER_DIST: string = join(REPO_ROOT, 'apps', 'desktop', 'dist', 'renderer');

/**
 * The files the `static`-job checks read as *rules*, as opposed to as evidence.
 *
 * Named rather than globbed for the same reason `PLAN_DOCUMENTS` is: a rename must be a hard error
 * naming the file, not a check that quietly starts passing because it found nothing to read.
 */
export const CHECK_INPUTS = {
  /** Reviewed licence exceptions (10-testing-and-quality.md, "License and supply-chain scan"). */
  licenseExceptions: join(SCRIPTS_ROOT, 'license-exceptions.json'),
  /** The committed renderer bundle ceilings (07-client-applications.md §9.4; 10, "Client budgets"). */
  bundleBudget: join(SCRIPTS_ROOT, 'bundle-budget.json'),
  /** The recorded `// Stryker disable` count (10-testing-and-quality.md, "Mutation"). */
  strykerDisableBudget: join(SCRIPTS_ROOT, 'stryker-disable-budget.json'),
  /** The flake quarantine register (10-testing-and-quality.md, "Flake policy"; D10-15). */
  quarantine: join(REPO_ROOT, 'apps', 'e2e', 'QUARANTINE.md'),
  /** Known-and-accepted Schemathesis findings (10-testing-and-quality.md, "REST — fuzzing"). */
  schemathesisExclusions: join(SERVER_ROOT, 'test', 'contract', 'schemathesis-exclusions.toml'),
  /** The MCP conformance baseline, which admits no entries at all (skeleton A51). */
  conformanceBaseline: join(SERVER_ROOT, 'test', 'mcp', 'conformance-baseline.yaml'),
  /** Deliberate CommonMark deviations (10-testing-and-quality.md, `markdown.commonmark.unit`). */
  commonmarkDeviations: join(TESTKIT_ROOT, 'src', 'fixtures', 'commonmark', 'deviations.json'),
  /** The k6 load baseline, committed at M8 (D10-14). */
  loadBaseline: join(SERVER_ROOT, 'test', 'load', 'baseline.json'),
} as const;

/** The committed fixture trees whose total weight is capped at 5 MB (D10-17). */
export const FIXTURE_ROOTS: readonly string[] = [
  join(TESTKIT_ROOT, 'src', 'fixtures'),
  join(SERVER_ROOT, 'test', 'fixtures'),
];
