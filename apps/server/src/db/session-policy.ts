/** Serving session lock waits must expire before the transport's command deadline (03 §7.4). */
import type { MysqlPool, MysqlPoolConnection } from 'kysely';

import { DB_QUERY_TIMEOUT_MS_MIN, DB_QUERY_TIMEOUT_MS_MAX } from './pool.ts';

/** The minimum also reserves a timeout-sweep second and a response second after this lock wait. */
export function servingLockWaitSeconds(queryTimeoutMs: number): number {
  if (
    !Number.isInteger(queryTimeoutMs) ||
    queryTimeoutMs < DB_QUERY_TIMEOUT_MS_MIN ||
    queryTimeoutMs > DB_QUERY_TIMEOUT_MS_MAX
  ) {
    throw new RangeError(
      `DB_QUERY_TIMEOUT_MS must be an integer from ${String(DB_QUERY_TIMEOUT_MS_MIN)} to ${String(DB_QUERY_TIMEOUT_MS_MAX)}.`,
    );
  }
  return Math.floor(queryTimeoutMs / 1_000 / 2);
}

/**
 * Initialize each physical serving connection before Kysely can borrow it. Initialization uses the
 * bounded adapter itself; a failed SET destroys the connection rather than leaking an unchecked
 * session or handing it to a request. Idle dedicated owner connections are left alone.
 */
export function withServingSession(pool: MysqlPool, queryTimeoutMs: number): MysqlPool {
  const seconds = servingLockWaitSeconds(queryTimeoutMs);
  const initialized = new WeakSet<MysqlPoolConnection>();
  return {
    getConnection(callback): void {
      pool.getConnection((error, connection) => {
        if (error !== null && error !== undefined) {
          callback(error, connection);
          return;
        }
        if (initialized.has(connection)) {
          callback(null, connection);
          return;
        }
        try {
          connection.query(
            `SET SESSION innodb_lock_wait_timeout = ${String(seconds)}, lock_wait_timeout = ${String(seconds)}`,
            [],
            (failure) => {
              if (failure !== null && failure !== undefined) {
                connection.destroy();
                callback(failure, connection);
                return;
              }
              initialized.add(connection);
              callback(null, connection);
            },
          );
        } catch (failure) {
          connection.destroy();
          callback(failure, connection);
        }
      });
    },
    end: (callback) => pool.end(callback),
  };
}
