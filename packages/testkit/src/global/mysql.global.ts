/**
 * Vitest `globalSetup` for the `integration`, `property`, `chaos`, `contract` and `mcp` projects
 * (root `vitest.config.ts` references this exact path).
 *
 * One container per run, one migrated template schema, coordinates handed to the workers. The
 * per-worker schemas are created by `worker-schema.setup.ts`; they are dropped here at teardown,
 * because a worker's `afterAll` cannot know it was the last file that worker will run.
 */
import { Network } from 'testcontainers';
import type { TestProject } from 'vitest/node';

import { dropSchema } from '../env/mysql.ts';
import { startTestEnv } from '../env/start-test-env.ts';
import { setSharedTestEnv } from './shared-env.ts';

/** Every per-worker schema this run may have created, for teardown. */
const WORKER_SCHEMA_PREFIX = 'iridium_w';

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  // The network exists on every project, not only `chaos`: creating it here means
  // `toxiproxy.global.ts` can attach to a MySQL that already carries the `mysql` network alias,
  // instead of the two setups having to agree about which one owns the network.
  const network = await new Network().start();
  const env = await startTestEnv({ network });
  setSharedTestEnv(env);

  project.provide('iridiumMysql', env.mysql);
  console.info(
    `[testkit] mysql ${env.mysql.image} on ${env.mysql.host}:${String(env.mysql.port)}, template ${env.mysql.templateSchema}`,
  );

  return async (): Promise<void> => {
    try {
      const schemas = await env.admin.rows(
        `SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME LIKE '${WORKER_SCHEMA_PREFIX}%'`,
      );
      for (const row of schemas) {
        if (row[0] !== undefined) {
          // DROP DATABASE in sequence: concurrent DDL on one server buys nothing at teardown.
          // eslint-disable-next-line no-await-in-loop
          await dropSchema(env.admin, row[0]);
        }
      }
    } finally {
      setSharedTestEnv(undefined);
      await env.stop();
      await network.stop();
    }
  };
}
