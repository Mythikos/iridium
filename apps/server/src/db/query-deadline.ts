/**
 * Kysely's MySQL driver passes SQL strings, so mysql2 never receives its per-query timeout unless
 * this adapter supplies QueryOptions. A deadline poisons the physical connection before the error
 * returns to Kysely: releasing an in-flight COMMIT would otherwise let another request reuse it.
 * A COMMIT timeout remains an unknown outcome; this layer never retries or claims it rolled back.
 */
import type { MysqlPool, MysqlPoolConnection } from 'kysely';
import type {
  Pool,
  PoolConnection,
  QueryError,
  QueryValues,
  ResultSetHeader,
  RowDataPacket,
} from 'mysql2';

import { systemClock, type Clock } from '../ops/clock.ts';
import { trackPool } from './pool-stats.ts';
import { DB_QUERY_TIMEOUT_MS_MAX } from './pool.ts';

/** Pool acquisition has sent no statement; it can fail without poisoning a later healthy arrival. */
class PoolAcquireTimeoutError extends Error {
  readonly code = 'ETIMEDOUT';
  readonly syscall = 'getConnection';

  constructor(timeoutMs: number) {
    super(`No database connection became available within ${String(timeoutMs)} ms.`);
    this.name = 'PoolAcquireTimeoutError';
  }
}

/** The Kysely-compatible adapter also supplies the occupancy of its actual physical connections. */
interface DeadlinePool extends MysqlPool {
  inUse(): number;
  pendingAcquisitions(): number;
}

/**
 * mysql2's documented timeout callback does not destroy the connection in the pinned driver.
 * Explicit destruction makes the documented contract true for callbacks and streamed queries.
 * Only active operations have deadlines; an idle dedicated owner-lease connection stays reserved.
 */
export function withQueryDeadline(
  pool: Pool,
  timeoutMs: number,
  clock: Clock = systemClock,
): DeadlinePool {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > DB_QUERY_TIMEOUT_MS_MAX)
    throw new RangeError('The database query timeout must be a positive supported timer interval.');
  const gauge = trackPool(pool);
  const wrappers = new WeakMap<PoolConnection, MysqlPoolConnection>();
  let pendingAcquisitions = 0;

  const wrap = (connection: PoolConnection): MysqlPoolConnection => {
    const existing = wrappers.get(connection);
    if (existing !== undefined) return existing;
    let destroyed = false;
    let poisoned: QueryError | undefined;
    const pending = new Set<(error: QueryError) => void>();
    const destroy = (): void => {
      if (destroyed) return;
      destroyed = true;
      gauge.discard(connection);
      connection.destroy();
    };
    const discardTimeout = (error: QueryError | null): void => {
      if (error?.code !== 'PROTOCOL_SEQUENCE_TIMEOUT' || poisoned !== undefined) return;
      poisoned = error;
      destroy();
      // Queued mysql2 commands have no native timer until they start; none may survive this socket.
      for (const reject of pending) reject(error);
    };
    const wrapped: MysqlPoolConnection = {
      get config() {
        return connection.config;
      },
      get threadId() {
        return connection.threadId;
      },
      connect: (callback) => connection.connect(callback),
      destroy,
      release(): void {
        if (!destroyed) connection.release();
      },
      query(sql, parameters: QueryValues, callback) {
        // Kysely's rollback after an uncertain COMMIT must preserve that original outcome.
        if (poisoned !== undefined) throw poisoned;
        const options = { sql, timeout: timeoutMs };
        if (callback === undefined) {
          const command = connection.query(options, parameters);
          const reject = (error: QueryError): void => {
            pending.delete(reject);
            command.emit('error', error);
          };
          const onError = (error: QueryError): void => {
            pending.delete(reject);
            discardTimeout(error);
          };
          pending.add(reject);
          command.on('error', onError);
          command.once('end', () => {
            pending.delete(reject);
            command.removeListener('error', onError);
          });
          return command;
        }
        // A late socket error or response cannot settle a command twice after its deadline.
        let settled = false;
        const reject = (error: QueryError): void => {
          if (settled) return;
          settled = true;
          pending.delete(reject);
          callback(error, []);
        };
        pending.add(reject);
        try {
          return connection.query<RowDataPacket[] | ResultSetHeader>(
            options,
            parameters,
            (error, rows) => {
              if (settled) return;
              settled = true;
              pending.delete(reject);
              discardTimeout(error);
              callback(error, rows);
            },
          );
        } catch (error) {
          pending.delete(reject);
          throw error;
        }
      },
    };
    wrappers.set(connection, wrapped);
    return wrapped;
  };

  return {
    inUse: () => gauge.inUse,
    pendingAcquisitions: () => pendingAcquisitions,
    getConnection(callback): void {
      pendingAcquisitions += 1;
      let pending = true;
      const timer = clock.after(timeoutMs, () => {
        pending = false;
        pendingAcquisitions -= 1;
        rejectAcquisition(callback, new PoolAcquireTimeoutError(timeoutMs));
      });
      try {
        pool.getConnection((error, connection) => {
          if (!pending) {
            if (error === null) connection.release();
            return;
          }
          pending = false;
          pendingAcquisitions -= 1;
          timer.cancel();
          if (error !== null) callback(error, connection);
          else callback(null, wrap(connection));
        });
      } catch (error) {
        timer.cancel();
        if (!pending) throw error;
        pending = false;
        pendingAcquisitions -= 1;
        rejectAcquisition(callback, error);
      }
    },
    end(callback): void {
      gauge.detach();
      pool.end(callback);
    },
  };
}

/** Match mysql2's error-only callback at the foreign Kysely boundary; no connection exists yet. */
function rejectAcquisition(
  callback: Parameters<MysqlPool['getConnection']>[0],
  error: unknown,
): void {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Kysely requires a connection even on error, while mysql2 passes undefined and Kysely ignores it
  callback(error, undefined as never);
}
