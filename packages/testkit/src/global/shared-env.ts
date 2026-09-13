/**
 * The one `TestEnv` a Vitest run owns, shared between the `globalSetup` files.
 *
 * The `chaos` project declares two global setups — `mysql.global.ts` then `toxiproxy.global.ts` — and
 * they run in the same Vitest node process, so a module-level handle is how the second one reaches the
 * network and container the first one created. It is deliberately not exported from the package
 * barrel: a worker process has its own module registry and would see `undefined`, which is why worker
 * state travels through `project.provide()` instead.
 */
import type { TestEnv } from '../env/start-test-env.ts';

let current: TestEnv | undefined;

export function setSharedTestEnv(env: TestEnv | undefined): void {
  current = env;
}

/** The run's environment, or `undefined` when no `globalSetup` has started one in this process. */
export function peekSharedTestEnv(): TestEnv | undefined {
  return current;
}

/** The run's environment, or a failure naming the `globalSetup` that was supposed to create it. */
export function requireSharedTestEnv(): TestEnv {
  if (current === undefined) {
    throw new Error(
      '@iridium/testkit: no TestEnv in this process. packages/testkit/src/global/mysql.global.ts must be listed before any other globalSetup for this project (root vitest.config.ts).',
    );
  }
  return current;
}
