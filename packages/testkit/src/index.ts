/**
 * `@iridium/testkit` — the single entry point for every harness
 * (10-testing-and-quality.md, "`@iridium/testkit`").
 *
 * The package *drives* the product and publishes no behaviour that exists inside it: a spec file may
 * import it only from `apps/server`, `apps/e2e` or `tooling/mutation`, and `turbo boundaries` plus
 * `knip --production` enforce that `apps/server`'s production code never does.
 *
 * What is here at M0 (12-milestones.md §4.3, the `@iridium/testkit` row):
 *
 * - `startTestEnv()` — MySQL in Testcontainers with the shipped `my.cnf` and `01_roles.sh`, a migrated
 *   template schema, and per-worker schemas `iridium_w<N>`;
 * - `startServer({ mode })` — `in-process` from the product's `buildApp`, `child` from the built
 *   binary under `NODE_ENV=test` so it can be `SIGKILL`ed;
 * - Toxiproxy helpers and the four named toxics;
 * - the `IRIDIUM_FAULT` registry constants and the control-route wrapper;
 * - `createOriginWebSocket` — the `ws` subclass that injects `Origin`, which is what `NoteClient` is
 *   built on;
 * - `restClient` — global `fetch` plus `X-Iridium-Client` and a cookie jar;
 * - `toMatchOpenApi` — swagger-parser plus ajv against the committed OpenAPI document;
 * - the committed fixture corpora and their typed accessors;
 * - the msw handler skeleton;
 * - the Vitest global-setup and per-worker setup files the root `vitest.config.ts` references.
 *
 * What M1 adds (12-milestones.md §5.2, the `@iridium/testkit` row):
 *
 * - `NoteClient` over `@iridium/collab-client`'s real `NoteSession`, with the waiters, the
 *   transition, stateless and close logs, and the hand-built frames a spoofing test needs;
 * - `seed.kernel()` — the M1 cast, vault `V` and note `N`, created through the product's own CLI and
 *   routes, so the seed is itself a smoke test;
 * - `startServer({ limits })`, `srv.client()`, `srv.seed`, `srv.sessions`, `srv.tickets`, `srv.cli()`
 *   on top of M0's `kill`/`restart`/`faults`;
 * - `toDominate`, the HP-1 matcher, and the shared property arbitraries;
 * - named database probes in `db/corrupt.ts` and read-only metadata observations in `db/inspect.ts`,
 *   using only caller-owned executors/transports and no product schema imports.
 *
 * Still seams rather than code, each with the milestone that fills it: the `TestServer` members that
 * need a product database type (`db`, `dbRoot`) or later protocol support (`vaultChannel`, `mcp`),
 * plus the later shared `assertNoteInvariants` and `countQueries` helpers. These do not require a
 * second database connection path in the testkit.
 */

// --- paths ------------------------------------------------------------------
export {
  FIXTURES_ROOT,
  MYSQL_CONF_FILE,
  MYSQL_INIT_DIR,
  MYSQL_INIT_ROLES_FILE,
  OPENAPI_DOCUMENT,
  REPO_ROOT,
  SERVER_APP_MODULE,
  SERVER_DIST_ENTRY,
  TESTKIT_PACKAGE_ROOT,
  requireExistingPath,
} from './paths.ts';

// --- deliberate database probes ---------------------------------------------
export type {
  AdminCorruption,
  CallbackWriteProbe,
  DeliberateCorruption,
  MysqlWriteProbe,
} from './db/corrupt.ts';
export {
  corruptCallbackDeliberately,
  corruptDeliberately,
  corruptMysqlDeliberately,
  corruptShippedMysqlDeliberately,
  probeShippedMysqlWrite,
} from './db/corrupt.ts';
export type { DatabaseProbeCell } from './db/inspect.ts';
export {
  inspectAdvisoryLock,
  inspectApplicationPrivileges,
  inspectConnectionIdentity,
  inspectCreationCounts,
  inspectGrantCriticalState,
  inspectGuardedIndexes,
  inspectMigrationHistory,
  inspectRoleAuthentication,
  inspectRoleGrants,
  inspectSchemaColumnCount,
  inspectSchemaColumns,
  inspectSchemaFingerprint,
  inspectSchemaTables,
  inspectSessionLockTimeouts,
  inspectTablesWithoutPrimaryKey,
  inspectTransportValue,
  inspectVisibleConnectionCount,
} from './db/inspect.ts';

// --- environment ------------------------------------------------------------
export type { TestEnv, TestEnvMysql, TestEnvOptions } from './env/start-test-env.ts';
export { startTestEnv } from './env/start-test-env.ts';
export type { MysqlAdmin, StartMysqlOptions } from './env/mysql.ts';
export {
  DB_ROLES,
  DEFAULT_MYSQL_IMAGE,
  FIXTURE_REDO_LOG_CAPACITY,
  MOUNTED_FILE_MODE,
  MYSQL_CONF_TARGET,
  MYSQL_FIXTURE_COMMAND,
  MYSQL_INIT_TARGET,
  MYSQL_NETWORK_ALIAS,
  PRESERVED_TABLES,
  REQUIRED_MYSQL_IMAGES,
  ROLE_AUTH_PLUGIN,
  ROLE_SECRET_FILES,
  SHIPPED_VARIABLES,
  assertSchemaName,
  assertShippedConfiguration,
  createSchema,
  dropSchema,
  listTables,
  mysqlAdmin,
  mysqlAdminByContainerId,
  parseMysqlRows,
  replicateSchemaGrants,
  resolveMysqlImage,
  startMysql,
  truncateAll,
} from './env/mysql.ts';
export type {
  ProxyHandle,
  StartToxiproxyOptions,
  ToxicDirection,
  ToxicHandle,
  ToxicKind,
  ToxicSpec,
  ToxiproxyFixture,
} from './env/toxiproxy.ts';
export {
  COLLAB_PROXY_NAME,
  MYSQL_PROXY_NAME,
  TOXIC,
  TOXIPROXY_CONTROL_PORT,
  TOXIPROXY_IMAGE,
  ToxiproxyApi,
  connectToxiproxy,
  startToxiproxy,
} from './env/toxiproxy.ts';

// --- Vitest wiring ----------------------------------------------------------
export type { ProvidedToxiproxy } from './global/provided.ts';
export { isSchemaKept, keepSchema, workerSchema } from './global/worker-state.ts';
export { peekSharedTestEnv, requireSharedTestEnv, setSharedTestEnv } from './global/shared-env.ts';

// --- server boot ------------------------------------------------------------
export type {
  RestPrincipalOptions,
  ServerDatabase,
  ServerMode,
  ServerNoteClientOptions,
  SessionHelpers,
  StartServerOptions,
  TestServer,
  TicketHelpers,
} from './server/start-server.ts';
export { startServer } from './server/start-server.ts';
export type { BuildAppLimits, LimitOverrideName, LimitsOverrides } from './server/limits.ts';
export {
  LIMIT_ENV_OVERRIDE_KEYS,
  LIMIT_OVERRIDE_ENV,
  LIMIT_OVERRIDE_ENV_KEYS,
  collabBootLimits,
  limitsEnv,
} from './server/limits.ts';
export type { BuildApp, InProcessServer, TestAppInstance } from './server/in-process.ts';
export { loadBuildApp, startInProcessServer } from './server/in-process.ts';
export type { ChildServer, ChildServerOptions } from './server/child.ts';
export { startChildServer } from './server/child.ts';
export type { CliOptions, CliResult, MigrateOptions } from './server/cli.ts';
export { SERVER_NOT_BUILT_HINT, migrateSchema, runIridiumCli } from './server/cli.ts';
export type { DatabasePasswords, ServerEnvOptions } from './server/env.ts';
export {
  DEFAULT_DATABASE_NAME,
  TEMPLATE_SCHEMA,
  TEST_DB_PASSWORDS,
  TEST_SECRETS,
  buildServerEnv,
  databaseUrl,
  workerSchemaName,
} from './server/env.ts';
export type { MetricSample, MetricsSnapshot } from './server/metrics.ts';
export { metricTotal, parseMetricSamples, parseMetrics } from './server/metrics.ts';

// --- clients ----------------------------------------------------------------
export type { Cookie, CookieJar } from './auth/cookie-jar.ts';
export { createCookieJar, parseSetCookie, pathMatches } from './auth/cookie-jar.ts';
export type {
  HttpMethod,
  IridiumClientKind,
  RestClient,
  RestClientOptions,
  RestRequestInit,
  RestResponse,
} from './clients/rest-client.ts';
export {
  API_BASE_PATH,
  CLIENT_HEADER,
  CLIENT_VERSION_HEADER,
  DEFAULT_CLIENT_VERSION,
  FETCH_SITE_HEADER,
  ORIGIN_HEADER as REST_ORIGIN_HEADER,
  isUnsafeMethod,
  restClient,
} from './clients/rest-client.ts';

// --- sessions, tickets and seeding -------------------------------------------
export type { Credentials, DesktopSignIn, SignedInSession, WebSignIn } from './auth/sessions.ts';
export {
  CURRENT_SESSION_PATH,
  REAUTHENTICATE_PATH,
  SESSIONS_PATH,
  revokeOwnSession,
  signInDesktop,
  signInWeb,
  signOut,
  stepUp,
} from './auth/sessions.ts';
export type { RestTicketSourceOptions } from './auth/tickets.ts';
export {
  COLLAB_TICKETS_PATH,
  fixedTicketSource,
  issueTickets,
  restTicketSource,
} from './auth/tickets.ts';
export type {
  SeedApi,
  SeedApiOptions,
  SeedRole,
  SeededAdmin,
  SeededNote,
  SeededUser,
  SeededVault,
} from './seed/seed.ts';
export {
  SEED_EMAIL_DOMAIN,
  SEED_PASSWORD,
  createSeedApi,
  setPasswordTokenFrom,
} from './seed/seed.ts';
export type { KernelSeed } from './seed/kernel.ts';
export {
  KERNEL_LOCAL_PARTS,
  KERNEL_NOTE_MARKDOWN,
  KERNEL_NOTE_NAME,
  KERNEL_VAULT_NAME,
  seedKernel,
} from './seed/kernel.ts';
export type {
  OriginWebSocketOptions,
  TestWebSocket,
  TestWebSocketConstructor,
} from './clients/origin-ws.ts';
export { ORIGIN_HEADER, createOriginWebSocket, openOriginWebSocket } from './clients/origin-ws.ts';
export type {
  CollabProvider,
  CollabSocket,
  NoteAck,
  NoteClient,
  NoteClientClose,
  NoteClientOptions,
  SaveStateTarget,
} from './clients/note-client.ts';
export { createNoteClient, noteClientWebSocket } from './clients/note-client.ts';
export type { AwarenessEntry } from './clients/awareness-frame.ts';
export {
  MESSAGE_TYPE_AWARENESS,
  MESSAGE_TYPE_STATELESS,
  awarenessFrame,
  encodeAwarenessUpdate,
  statelessFrame,
} from './clients/awareness-frame.ts';

// --- faults -----------------------------------------------------------------
export type {
  FaultArgument,
  FaultConstantName,
  FaultLifetime,
  FaultPoint,
  FaultPointDescriptor,
} from './faults/points.ts';
export { FAULT, FAULT_POINTS, describeFault, pointFromConstantName } from './faults/points.ts';
export type { ArmedFault, FaultControl, FaultSpec } from './faults/control.ts';
export {
  FAULT_CONTROL_PATH,
  FAULT_ENV_VAR,
  assertValidFaultSpec,
  createFaultControl,
  formatFaultEnv,
  formatFaultSpec,
  parseFaultEnv,
  parseFaultSpec,
} from './faults/control.ts';

// --- matchers ---------------------------------------------------------------
export type {
  OpenApiCheck,
  OpenApiOracle,
  OpenApiOracleOptions,
  OpenApiSource,
  OpenApiSubject,
} from './matchers/to-match-openapi.ts';
export {
  createOpenApiOracle,
  escapeJsonPointerSegment,
  registerOpenApiMatcher,
} from './matchers/to-match-openapi.ts';
export { registerDominanceMatcher } from './matchers/to-dominate.ts';

// --- harness utilities ------------------------------------------------------
export type { Deferred, WaitOptions } from './harness/deadline.ts';
export {
  DEFAULT_WAIT_INTERVAL_MS,
  DEFAULT_WAIT_TIMEOUT_MS,
  WaitTimeoutError,
  createDeferred,
  waitFor,
  withDeadline,
} from './harness/deadline.ts';
export { reserveLoopbackPort } from './harness/free-port.ts';
export type { MarkerSequence } from './harness/markers.ts';
export {
  MARKER_CLOSE,
  MARKER_IMPORT,
  MARKER_OPEN,
  countMarkers,
  createMarkerSequence,
  findMarkers,
  formatMarker,
} from './harness/markers.ts';

// --- fixtures ---------------------------------------------------------------
export type {
  CommonMarkExample,
  FixtureFile,
  FixtureVaultName,
  HostileCorpus,
  HostileExpectation,
} from './fixtures/index.ts';
export {
  COMMONMARK_SPEC_PATH,
  HOSTILE_CORPUS_PATH,
  IRIDIUM_FIXTURE_VERSION,
  fixtureVaultPath,
  listFixtureFiles,
  readCommonMarkExamples,
  readFixtureBytes,
  readFixtureText,
  readHostileCorpus,
  readHostileFixture,
} from './fixtures/index.ts';

// --- msw --------------------------------------------------------------------
export type { HttpMethodLower, OperationStub } from './msw/handlers.ts';
export {
  MSW_API_BASE,
  MSW_ORIGIN,
  handlers,
  notImplementedHandlers,
  operationsFromOpenApi,
  problemDetails,
} from './msw/handlers.ts';

// --- property budgets and arbitraries ---------------------------------------
export type { DbPropertyBudget, PropertyBudget } from './property/config.ts';
export { PROP, PROP_DB, PROP_SIZE } from './property/config.ts';
export type { HostileStringOptions, TextInsertion } from './property/arbitraries.ts';
export { HOSTILE_UNITS, hostileString, noteText, textInsertion } from './property/arbitraries.ts';

export { probeRejectedMysqlRolePlugin, type MysqlRolePluginProbe } from './env/mysql-probes.ts';
export {
  startShippedMysqlClient,
  type ShippedMysqlClient,
  type ShippedMysqlClientOptions,
  type DatabaseRole,
} from './env/shipped-mysql-client.ts';

// Shared-socket and ticket I/O seams for connected harnesses.
export { CollabTicketError, createCollabSocket, warnsBeforeUnload } from '@iridium/collab-client';

export {
  createVaultClient,
  type VaultClient,
  type VaultClientOptions,
} from './clients/vault-client.ts';

export {
  runSchemathesis,
  type SchemathesisOptions,
  type SchemathesisResult,
} from './contract/schemathesis.ts';
