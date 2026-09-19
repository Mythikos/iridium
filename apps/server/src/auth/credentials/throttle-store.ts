/**
 * The `storeClient` `RateLimiterMySQL` runs on, backed by the `dbApp` Kysely instance
 * (04-auth-and-access-control.md section 3.7; 03-data-model.md section 3, `login_throttle`).
 *
 * `rate-limiter-flexible` wants a mysql2 pool: `getConnection(cb)`, then `conn.query(sql, values,
 * cb)` with `?` values and `??` identifiers, `conn.release()` and `conn.rollback()`. The database
 * layer hands out Kysely instances rather than its pools — one pool per role, owned in one place
 * (03 section 1.3) — so this adapter presents that contract over `db.connection()`, which pins one
 * connection for as long as the limiter holds it. Nothing here is Iridium's SQL: the statements are
 * the library's, formatted by mysql2's own `format` so `??` and `?` mean what the library means.
 *
 * Each pinned connection serialises its own operations, because the library fires `rollback()`
 * and `release()` without awaiting the first: the second must still run after it.
 */
import { sql, type Kysely } from 'kysely';
import { format } from 'mysql2';

import type { Database } from '../../db/index.ts';

/** The result shape the library reads: rows for a `SELECT`, an affected-row count otherwise. */
export type ThrottleQueryResult = readonly Record<string, unknown>[] | { affectedRows: number };

type QueryCallback = (error: Error | null, result?: ThrottleQueryResult) => void;

/** One pinned connection, as the library drives it — mysql2's shape, where each extra is optional. */
export interface ThrottleConnection {
  query(statement: string, values?: readonly unknown[], callback?: QueryCallback): void;
  query(statement: string, callback: QueryCallback): void;
  rollback(): void;
  release(): void;
}

/** The pool contract `RateLimiterMySQL` calls with `storeType: 'pool'`. */
export interface ThrottleStoreClient {
  getConnection(callback: (error: Error | null, connection?: ThrottleConnection) => void): void;
}

/** A `Kysely<Database>` source; `null` while the database is not connected (boot step 2). */
export type DbSource = () => Kysely<Database> | null;

/** Thrown into the library when no connection exists; the insurance limiter takes over. */
export class ThrottleStoreUnavailableError extends Error {
  constructor() {
    super(
      'the login throttle store is unavailable: dbApp is not connected. The in-memory insurance ' +
        'limiter keeps blocking until it is (04-auth-and-access-control.md section 10.2).',
    );
    this.name = 'ThrottleStoreUnavailableError';
  }
}

const SELECT_STATEMENT = /^\s*select\b/i;

function isSelect(statement: string): boolean {
  return SELECT_STATEMENT.test(statement);
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

class PinnedConnection implements ThrottleConnection {
  readonly #bound: Kysely<Database>;
  readonly #done: () => void;
  #chain: Promise<void> = Promise.resolve();
  #released = false;

  constructor(bound: Kysely<Database>, done: () => void) {
    this.#bound = bound;
    this.#done = done;
  }

  query(
    statement: string,
    valuesOrCallback?: readonly unknown[] | QueryCallback,
    maybeCallback?: QueryCallback,
  ): void {
    const values = Array.isArray(valuesOrCallback) ? valuesOrCallback : [];
    const callback =
      typeof valuesOrCallback === 'function' ? valuesOrCallback : (maybeCallback ?? (() => {}));
    this.#enqueue(async () => {
      let result: ThrottleQueryResult;
      try {
        const text = format(statement, [...values]);
        const executed = await sql.raw<Record<string, unknown>>(text).execute(this.#bound);
        result = isSelect(statement)
          ? executed.rows
          : { affectedRows: Number(executed.numAffectedRows ?? 0n) };
      } catch (error) {
        callback(asError(error));
        return;
      }
      callback(null, result);
    });
  }

  rollback(): void {
    this.#enqueue(async () => {
      try {
        await sql.raw('ROLLBACK').execute(this.#bound);
      } catch {
        // The library fires rollback on a failed statement and never awaits it; a rollback that
        // fails on a broken connection is released next and the insurance limiter takes over.
      }
    });
  }

  release(): void {
    this.#enqueue(async () => {
      if (this.#released) return;
      this.#released = true;
      this.#done();
    });
  }

  #enqueue(work: () => Promise<void>): void {
    this.#chain = this.#chain.then(work, work);
  }
}

/**
 * Builds the store client. `source` is read per acquisition, so a limiter constructed before the
 * database connected starts using it the moment `dbApp` exists.
 */
export function createThrottleStoreClient(source: DbSource): ThrottleStoreClient {
  return {
    getConnection(deliver): void {
      const db = source();
      if (db === null) {
        deliver(new ThrottleStoreUnavailableError());
        return;
      }
      db.connection()
        .execute(
          (bound) =>
            new Promise<void>((release) => {
              deliver(null, new PinnedConnection(bound, release));
            }),
        )
        .catch((error: unknown) => {
          deliver(asError(error));
        });
    },
  };
}
