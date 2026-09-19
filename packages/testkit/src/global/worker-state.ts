/**
 * Per-worker schema state, kept out of the setup file so that importing `@iridium/testkit` never
 * registers a Vitest hook as a side effect (a package barrel that calls `beforeAll` at import time
 * throws outside a test run, and would make the harness unusable from a script).
 *
 * `global/worker-schema.setup.ts` writes this state; suites read it.
 */

/** One per worker realm, shared by setup's source import and package consumers of dist. */
interface WorkerState {
  schema: string | undefined;
  keep: boolean;
}
const STATE = Symbol.for('@iridium/testkit.worker-schema');
const shared = globalThis as typeof globalThis & { [STATE]?: WorkerState };
const state: WorkerState = (shared[STATE] ??= { schema: undefined, keep: false });

/** Clear the preceding file before this file is collected and can call keepSchema(). */
export function resetWorkerSchema(): void {
  state.schema = undefined;
  state.keep = false;
}

/** Called by the setup file once the worker's schema exists. */
export function setWorkerSchema(name: string): void {
  state.schema = name;
}

/**
 * The schema this worker owns: `iridium_w<VITEST_WORKER_ID>`
 * (10-testing-and-quality.md, "Environment: `startTestEnv`").
 */
export function workerSchema(): string {
  if (state.schema === undefined) {
    throw new Error(
      '@iridium/testkit: no worker schema. packages/testkit/src/global/worker-schema.setup.ts must be in this project’s `setupFiles` (root vitest.config.ts).',
    );
  }
  return state.schema;
}

/**
 * Opt this test file out of the per-test truncation, for a suite whose whole point is state that
 * accumulates across tests (a migration sequence, a retention job over aged rows). Call it at the top
 * level of the file, beside the `describe`. Every other file truncates, because a suite that depends
 * on another test's leftovers is a suite whose failures cannot be attributed.
 */
export function keepSchema(): void {
  state.keep = true;
}

/** Whether the current file opted out. Read by the setup file's `afterEach`. */
export function isSchemaKept(): boolean {
  return state.keep;
}
