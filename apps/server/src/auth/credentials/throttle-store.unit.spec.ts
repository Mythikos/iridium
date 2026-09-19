/**
 * `auth.throttle-store.unit` (04-auth-and-access-control.md sections 3.7 and 10.2; A8): the pool
 * contract `RateLimiterMySQL` drives — `getConnection`, then `query` with `?` values and `??`
 * identifiers, `rollback` and `release` — presented over one pinned Kysely connection. A `SELECT`
 * answers rows, anything else an affected-row count, a statement failure reaches the callback as an
 * `Error`, the operations of one connection run in order, a failed `ROLLBACK` is swallowed,
 * `release` returns the connection exactly once, and a missing database is the typed error the
 * insurance limiter takes over from.
 */
import { corruptCallbackDeliberately } from '@iridium/testkit';
import { describe, expect, it } from 'vitest';

import { fakeDatabase, type ScriptedAnswer } from '../../../test/support/fake-driver.ts';
import {
  createThrottleStoreClient,
  ThrottleStoreUnavailableError,
  type ThrottleConnection,
  type ThrottleQueryResult,
} from './throttle-store.ts';

/** Waits for a callback-style call, so each library-shaped step is one `await`. */
function acquire(
  client: ReturnType<typeof createThrottleStoreClient>,
): Promise<ThrottleConnection> {
  return new Promise((resolve, reject) => {
    client.getConnection((error, connection) => {
      if (error !== null || connection === undefined) reject(error ?? new Error('no connection'));
      else resolve(connection);
    });
  });
}

function query(
  connection: ThrottleConnection,
  statement: string,
  values?: readonly unknown[],
): Promise<{ error: Error | null; result: ThrottleQueryResult | undefined }> {
  return new Promise((resolve) => {
    const callback = (error: Error | null, result?: ThrottleQueryResult): void => {
      resolve({ error, result });
    };
    if (values === undefined) connection.query(statement, callback);
    else connection.query(statement, values, callback);
  });
}

describe('auth.throttle-store.unit [area:auth]', () => {
  it('delivers the typed error, and no connection, while the database is not connected', async () => {
    const client = createThrottleStoreClient(() => null);
    await expect(acquire(client)).rejects.toBeInstanceOf(ThrottleStoreUnavailableError);
  });

  it('delivers the acquisition failure when the pool cannot hand out a connection', async () => {
    const fake = fakeDatabase({
      script: () => ({ rows: [] }),
      acquireError: new Error('pool closed'),
    });
    const client = createThrottleStoreClient(() => fake.db);
    await expect(acquire(client)).rejects.toThrow('pool closed');
  });

  it('answers a SELECT with its rows and anything else with the affected-row count', async () => {
    const answers: Record<number, ScriptedAnswer> = {
      1: { rows: [{ points: 3, expire: 1_000 }] },
      2: { numAffectedRows: 2n },
      3: { rows: [] },
    };
    const fake = fakeDatabase({ script: (_query, ordinal) => answers[ordinal] ?? { rows: [] } });
    const client = createThrottleStoreClient(() => fake.db);
    const connection = await acquire(client);

    const selected = await query(connection, 'SELECT points, expire FROM ?? WHERE `key` = ?', [
      'login_throttle',
      'login:abc',
    ]);
    expect(selected).toStrictEqual({ error: null, result: [{ points: 3, expire: 1_000 }] });
    // `??` became a quoted identifier and `?` an escaped value: the library's own placeholders.
    expect(fake.executed[0]?.sql).toBe(
      "SELECT points, expire FROM `login_throttle` WHERE `key` = 'login:abc'",
    );

    const updated = await corruptCallbackDeliberately(
      (statement) => query(connection, statement),
      'expire-throttle-before-5',
    );
    expect(updated).toStrictEqual({ error: null, result: { affectedRows: 2 } });
    // A statement whose result carries no count is zero rows affected, never undefined.
    const uncounted = await corruptCallbackDeliberately(
      (statement) => query(connection, statement),
      'uncounted-throttle-delete',
    );
    expect(uncounted).toStrictEqual({ error: null, result: { affectedRows: 0 } });
  });

  it('runs a statement the library issues without a callback, such as its table check', async () => {
    const fake = fakeDatabase({ script: () => ({ numAffectedRows: 0n }) });
    const connection = await acquire(createThrottleStoreClient(() => fake.db));
    corruptCallbackDeliberately(
      (statement) => connection.query(statement),
      'no-callback-throttle-delete',
    );
    await expect.poll(() => fake.executed.length).toBe(1);
    expect(fake.executed[0]?.sql).toBe('DELETE FROM `login_throttle` WHERE expire < 1');
  });

  it('reports a failed statement to the callback as an Error, whatever was thrown', async () => {
    const fake = fakeDatabase({
      script: (_query, ordinal) =>
        ordinal === 1 ? { throws: new Error('deadlock') } : { throws: 'not an error object' },
    });
    const client = createThrottleStoreClient(() => fake.db);
    const connection = await acquire(client);
    const first = await query(connection, 'SELECT 1');
    expect(first.error?.message).toBe('deadlock');
    expect(first.result).toBeUndefined();
    const second = await query(connection, 'SELECT 2');
    expect(second.error).toBeInstanceOf(Error);
    expect(second.error?.message).toBe('not an error object');
  });

  it('runs one connection operations in order, including a rollback the library never awaits', async () => {
    const fake = fakeDatabase({
      script: (executed) =>
        executed.sql === 'ROLLBACK' ? { throws: new Error('connection lost') } : { rows: [] },
    });
    const client = createThrottleStoreClient(() => fake.db);
    const connection = await acquire(client);
    const first = query(connection, 'SELECT 1');
    connection.rollback();
    const second = query(connection, 'SELECT 2');
    await Promise.all([first, second]);
    expect(fake.executed.map((executed) => executed.sql)).toStrictEqual([
      'SELECT 1',
      'ROLLBACK',
      'SELECT 2',
    ]);
  });

  it('returns the pinned connection to the pool exactly once, however often release is called', async () => {
    const fake = fakeDatabase({ script: () => ({ rows: [] }) });
    const client = createThrottleStoreClient(() => fake.db);
    const connection = await acquire(client);
    expect(fake.lifecycle).toStrictEqual(['acquire']);
    connection.release();
    connection.release();
    await expect.poll(() => fake.lifecycle).toStrictEqual(['acquire', 'release']);
    // A second acquisition after the release is a fresh pin.
    await acquire(client);
    expect(fake.lifecycle).toStrictEqual(['acquire', 'release', 'acquire']);
  });
});
