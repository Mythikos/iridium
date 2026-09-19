/** A real held InnoDB row must return server 1205 before the serving command deadline expires. */
import {
  corruptDeliberately,
  inspectConnectionIdentity,
  inspectSessionLockTimeouts,
} from '@iridium/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { classifyDatabaseFailure, toProblem } from '../../src/db/failure.ts';
import { createDatabaseLayer } from '../../src/db/index.ts';
import { createMaintDb, migrateToLatest } from '../../src/db/migrator.ts';
import { toProblemDetails } from '../../src/security/problem.ts';
import { startIridiumMysql, type IridiumMysql } from '../db-mysql-container.ts';

let mysql: IridiumMysql;
let blocker: ReturnType<typeof createMaintDb>;

beforeAll(async () => {
  mysql = await startIridiumMysql();
  blocker = createMaintDb(mysql.migratorUrl());
  await migrateToLatest({ db: blocker.db, target: blocker.target });
}, 600_000);

afterAll(async () => {
  await blocker?.db.destroy();
  await mysql?.stop();
});

describe('db.lock-timeout.integration [area:db]', () => {
  it.each([
    ['app', 2_000, 1],
    ['persist', 2_000, 1],
    ['app', 10_000, 5],
    ['persist', 10_000, 5],
  ] as const)(
    'returns busy and preserves the %s connection under a %ims budget',
    async (pool, queryTimeoutMs, lockSeconds) => {
      const layer = await createDatabaseLayer({
        url: mysql.appUrl(),
        poolApp: 1,
        poolPersist: 1,
        queryTimeoutMs,
      });
      const target = pool === 'app' ? layer.dbApp : layer.dbPersist;
      try {
        await target.connection().execute(async (connection) => {
          const session = await inspectSessionLockTimeouts(connection);
          expect(session.rows[0]).toMatchObject({
            row_wait: lockSeconds,
            metadata_wait: lockSeconds,
          });
          const original = await connection
            .selectFrom('schema_meta')
            .select('value')
            .where('key', '=', 'api_version')
            .executeTakeFirstOrThrow();
          await blocker.db.transaction().execute(async (lock) => {
            await lock
              .selectFrom('schema_meta')
              .select('value')
              .where('key', '=', 'iridium_version')
              .forUpdate()
              .execute();
            const outcome = await connection
              .transaction()
              .execute(async (transaction) => {
                await transaction
                  .updateTable('schema_meta')
                  .set({ value: 'uncommitted-lock-probe' })
                  .where('key', '=', 'api_version')
                  .execute();
                await corruptDeliberately(transaction, { kind: 'contend-install-row' });
              })
              .then(
                () => ({ error: null }),
                (error: unknown) => ({ error }),
              );
            expect(outcome.error).toMatchObject({ errno: 1205, code: 'ER_LOCK_WAIT_TIMEOUT' });
            expect(classifyDatabaseFailure(outcome.error)).toEqual({ kind: 'lock_wait_timeout' });
            const problem = toProblem(outcome.error);
            if (problem === null) throw new Error('The actual lock failure was not classified.');
            expect(
              toProblemDetails(problem.code, 'lock-wait-probe', problem.extensions),
            ).toMatchObject({ code: 'busy', status: 503, retryAfterMs: 1_000 });
            const after = await inspectConnectionIdentity(connection);
            expect(after.rows[0]?.id).toBe(session.rows[0]?.id);
            expect(
              await connection
                .selectFrom('schema_meta')
                .select('value')
                .where('key', '=', 'api_version')
                .executeTakeFirstOrThrow(),
            ).toEqual(original);
          });
          // Retry belongs to the caller after the blocker releases; the original attempt never wrote.
          expect(
            (await corruptDeliberately(connection, { kind: 'contend-install-row' }))
              .numAffectedRows,
          ).toBe(1n);
        });
      } finally {
        await layer.destroy();
      }
    },
    30_000,
  );
});
