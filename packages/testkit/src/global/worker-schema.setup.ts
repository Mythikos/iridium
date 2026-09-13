/**
 * Vitest `setupFiles` for the `integration`, `property`, `contract` and `mcp` projects (root
 * `vitest.config.ts` references this exact path).
 *
 * Each worker owns `iridium_w<VITEST_WORKER_ID>` — created, granted and migrated through the product's
 * own `iridium migrate up` — and every test is handed it empty. Two details are not incidental:
 *
 * - **Creation is idempotent, not per file.** With `isolate: true` a setup file's module state resets
 *   for every test file, but the schema in MySQL does not; the schema is therefore created and
 *   migrated only when it is absent, which is what makes "one schema per worker" true in practice
 *   rather than only in the plan.
 * - **Dropping happens in the global teardown**, not in an `afterAll` here, because a worker cannot
 *   know which of its files is the last one (fixture policy rule 10 — a leaked schema is a test bug).
 */
import { afterEach, beforeAll, inject } from 'vitest';

import type { MysqlAdmin } from '../env/mysql.ts';
import {
  createSchema,
  mysqlAdminByContainerId,
  replicateSchemaGrants,
  truncateAll,
} from '../env/mysql.ts';
import { migrateSchema } from '../server/cli.ts';
import { DEFAULT_DATABASE_NAME, workerSchemaName } from '../server/env.ts';
import { isSchemaKept, setWorkerSchema } from './worker-state.ts';

let admin: MysqlAdmin | undefined;
let schema: string | undefined;

async function schemaIsMigrated(client: MysqlAdmin, name: string): Promise<boolean> {
  const rows = await client.rows(
    `SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = '${name}' AND TABLE_NAME = 'kysely_migration'`,
  );
  return rows[0]?.[0] === '1';
}

beforeAll(async () => {
  const mysql = inject('iridiumMysql');
  // Vitest 5 numbers workers from 1; the fallback keeps a single-threaded run working.
  const workerId = process.env['VITEST_WORKER_ID'] ?? '1';
  const name = workerSchemaName(workerId);
  const client = await mysqlAdminByContainerId(mysql.containerId);

  if (!(await schemaIsMigrated(client, name))) {
    await createSchema(client, name);
    await replicateSchemaGrants(client, DEFAULT_DATABASE_NAME, name);
    await migrateSchema({ host: mysql.host, port: mysql.port, schema: name });
  }

  admin = client;
  schema = name;
  setWorkerSchema(name);
});

afterEach(async () => {
  if (isSchemaKept() || admin === undefined || schema === undefined) {
    return;
  }
  await truncateAll(admin, schema);
});
