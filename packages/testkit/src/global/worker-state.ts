/**
 * Per-worker schema state, kept out of the setup file so that importing `@iridium/testkit` never
 * registers a Vitest hook as a side effect (a package barrel that calls `beforeAll` at import time
 * throws outside a test run, and would make the harness unusable from a script).
 *
 * `global/worker-schema.setup.ts` writes this state; suites read it.
 */

let schema: string | undefined;
let keep = false;

/** Called by the setup file once the worker's schema exists. */
export function setWorkerSchema(name: string): void {
  schema = name;
  keep = false;
}

/**
 * The schema this worker owns: `iridium_w<VITEST_WORKER_ID>`
 * (10-testing-and-quality.md, "Environment: `startTestEnv`").
 */
export function workerSchema(): string {
  if (schema === undefined) {
    throw new Error(
      '@iridium/testkit: no worker schema. packages/testkit/src/global/worker-schema.setup.ts must be in this project’s `setupFiles` (root vitest.config.ts).',
    );
  }
  return schema;
}

/**
 * Opt this test file out of the per-test truncation, for a suite whose whole point is state that
 * accumulates across tests (a migration sequence, a retention job over aged rows). Call it at the top
 * level of the file, beside the `describe`. Every other file truncates, because a suite that depends
 * on another test's leftovers is a suite whose failures cannot be attributed.
 */
export function keepSchema(): void {
  keep = true;
}

/** Whether the current file opted out. Read by the setup file's `afterEach`. */
export function isSchemaKept(): boolean {
  return keep;
}
