/**
 * Pool occupancy for iridium_db_pool_in_use. Identity matters: mysql2 hands a busy connection
 * directly to a queued borrower without release/acquire events, and a destroyed connection never
 * emits release. Track the documented pool and connection events, plus explicit adapter discards.
 */
import type { Pool, PoolConnection } from 'mysql2';

export interface PoolGauge {
  readonly inUse: number;
  /** Forget a connection destroyed by the driver adapter before its peer acknowledges shutdown. */
  discard(connection: PoolConnection): void;
  detach(): void;
}

/** Count physical checked-out connections, including the idle but reserved owner-lease session. */
export function trackPool(pool: Pool): PoolGauge {
  const active = new Map<PoolConnection, () => void>();
  const discard = (connection: PoolConnection): void => {
    const remove = active.get(connection);
    if (remove === undefined) return;
    active.delete(connection);
    connection.removeListener('end', remove);
    connection.removeListener('error', remove);
  };
  const onAcquire = (connection: PoolConnection): void => {
    if (active.has(connection)) return;
    const remove = (): void => discard(connection);
    active.set(connection, remove);
    connection.once('end', remove);
    connection.once('error', remove);
  };
  pool.on('acquire', onAcquire);
  pool.on('release', discard);
  return {
    get inUse(): number {
      return active.size;
    },
    discard,
    detach(): void {
      pool.removeListener('acquire', onAcquire);
      pool.removeListener('release', discard);
      for (const connection of active.keys()) discard(connection);
    },
  };
}
