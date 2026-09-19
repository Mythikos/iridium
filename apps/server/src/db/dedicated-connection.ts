/**
 * One connection, taken out of a pool and never returned until the process releases it.
 *
 * This is the facility the `iridium_collab_owner` boot lease needs (05-collaboration-and-durability.md,
 * "Global fairness and the persist pool"; 12-milestones.md §5.2 `collab`): `GET_LOCK` is a *session*
 * lock, so the connection that acquires it has to be the same connection for the whole life of the
 * lease. A pooled connection would hand the lock to whichever request happened to borrow it next, and
 * releasing it back to the pool would release the lock at an arbitrary later moment.
 *
 * The lease itself belongs to `apps/server/src/collab/owner-lease.ts`; what lives here is the
 * primitive, because the reservation is a property of the database layer and the rule it enforces —
 * **never used inside a row-locking transaction** — is a database rule. A `GET_LOCK` held on a
 * connection that is also running `SELECT … FOR UPDATE` would join the lease's lifetime to a row lock's,
 * and a lock-wait timeout inside that transaction would then look like a lost lease.
 *
 * The mechanism is Kysely's `db.connection()`, whose callback holds one connection for as long as the
 * callback runs. The reservation therefore *is* a callback that waits on a promise the holder resolves
 * — an unusual shape, and the reason it is wrapped in one named function rather than repeated.
 *
 * **`dbPersist` is the pool to reserve from** (`DB_POOL_PERSIST`, default 4): the writer needs the other
 * three and REST traffic must not be able to starve the lease. Reserving from `dbApp` would put the
 * lease behind a REST burst; reserving the *only* connection of a single-connection pool would deadlock
 * the writer, which is why `reserveConnection` refuses a pool it would exhaust.
 */
import { sql, type Kysely } from 'kysely';

import type { Database } from './schema.ts';

/** The smallest pool a reservation leaves usable: one for the lease, at least one for the writer. */
const MIN_POOL_SIZE_FOR_RESERVATION = 2;

/** A connection held out of the pool. The holder releases it; nothing else may. */
export interface ReservedConnection {
  /** A Kysely instance bound to exactly this connection. */
  readonly db: Kysely<Database>;
  /** What the reservation is for, as it appears in log lines. */
  readonly label: string;
  /** Whether the connection is still held. */
  readonly held: boolean;
  /** Returns the connection to the pool. Idempotent; resolves once the pool has it back. */
  release(): Promise<void>;
}

/** Thrown when a reservation would leave the pool with nothing for its primary purpose. */
export class PoolTooSmallForReservationError extends Error {
  readonly code = 'db.pool_too_small';
  readonly exitCode = 2;

  constructor(label: string, poolSize: number) {
    super(
      `reserving a dedicated connection for ${label} needs a pool of at least ` +
        `${String(MIN_POOL_SIZE_FOR_RESERVATION)}, and this one is sized ${String(poolSize)}. ` +
        'The reservation is permanent for the life of the process, so a pool of one would leave the ' +
        'persistence writer with no connection at all. Raise DB_POOL_PERSIST (11-operations-and-' +
        'deployment.md, "Configuration and secrets").',
    );
    this.name = 'PoolTooSmallForReservationError';
  }
}

/** The one Fastify member a reservation registers with: the instance's `onClose` hook list. */
export interface CloseHookHost {
  addHook(name: 'onClose', hook: () => Promise<void>): unknown;
}

export interface ReserveConnectionOptions {
  /** The pool to take the connection out of — `dbPersist` for the owner lease. */
  readonly db: Kysely<Database>;
  /** `DB_POOL_PERSIST`, so the reservation can refuse to starve the pool it borrows from. */
  readonly poolSize: number;
  /** Names the reservation in errors and log lines, e.g. `collab_owner_lease`. */
  readonly label: string;
  /**
   * When given, the reservation registers an `onClose` hook that releases it, so `app.close()`
   * without a drain returns the connection whether or not the graceful path ran first. The drain's
   * `resources` phase stays the ordered release; this is the backstop, and `release()` is idempotent.
   */
  readonly closeWith?: CloseHookHost;
}

/**
 * Takes one connection out of the pool and resolves once it is established.
 *
 * The returned `db` is a Kysely instance bound to that connection: every statement issued through it
 * runs on the same MySQL session, which is what makes a session-scoped `GET_LOCK` outlive a request.
 *
 * @throws PoolTooSmallForReservationError when the pool has fewer than two connections.
 */
export async function reserveConnection(
  options: ReserveConnectionOptions,
): Promise<ReservedConnection> {
  const { db, poolSize, label } = options;
  if (poolSize < MIN_POOL_SIZE_FOR_RESERVATION) {
    throw new PoolTooSmallForReservationError(label, poolSize);
  }

  let releaseHold: (() => void) | null = null;
  const holdUntilReleased = new Promise<void>((resolve) => {
    releaseHold = resolve;
  });

  // The `connection()` callback *is* the reservation: it holds the connection until it returns, so it
  // returns only once `release()` has resolved `holdUntilReleased`. `held` is that callback's promise;
  // `release()` awaits it, which is what makes this a handed-off task with an owner rather than a
  // floating promise.
  let held: Promise<void> | null = null;
  const established = new Promise<Kysely<Database>>((resolve, reject) => {
    held = db
      .connection()
      .execute(async (connection) => {
        // One round trip proves the connection is really established before the caller is told it is,
        // so a lease that cannot connect fails here rather than on its first `GET_LOCK`.
        await sql`SELECT 1`.execute(connection);
        resolve(connection);
        await holdUntilReleased;
      })
      .catch((error: unknown) => {
        reject(error instanceof Error ? error : new Error(String(error)));
      });
  });

  const connection = await established;
  let released = false;

  const reservation: ReservedConnection = {
    db: connection,
    label,
    get held(): boolean {
      return !released;
    },
    async release(): Promise<void> {
      if (released) return;
      released = true;
      releaseHold?.();
      await held;
    },
  };
  options.closeWith?.addHook('onClose', () => reservation.release());
  return reservation;
}
