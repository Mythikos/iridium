/**
 * A scripted Kysely driver for the unit layer (10-testing-and-quality.md, "Mocks": the unit project
 * may substitute an I/O adapter). It is the adapter under `Kysely<Database>` itself — every query
 * the code under test compiles is recorded and answered by a script — so a module that takes a
 * Kysely instance can be driven to its error and empty-result branches without a database and
 * without mocking Kysely's own API.
 *
 * The SQL is compiled by the real `MysqlQueryCompiler`, so the recorded statements are exactly what
 * a MySQL server would receive; only the transport is scripted.
 */
import {
  Kysely,
  MysqlAdapter,
  MysqlIntrospector,
  MysqlQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
  type TransactionSettings,
} from 'kysely';

import type { Database } from '../../src/db/index.ts';

/** One statement the code under test executed, as compiled. */
export interface ExecutedQuery {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

/** What the script answers a statement with: rows, an affected-row count, or a throw. */
export type ScriptedAnswer =
  | { readonly rows: readonly unknown[] }
  | { readonly numAffectedRows: bigint }
  | { readonly insertId: bigint }
  | { readonly throws: unknown };

/** Decides the answer to each statement, in execution order. */
export type QueryScript = (query: ExecutedQuery, ordinal: number) => ScriptedAnswer;

/** What the fake driver exposes beside the Kysely instance. */
export interface FakeDatabase {
  readonly db: Kysely<Database>;
  /** Every executed statement, in order. */
  readonly executed: readonly ExecutedQuery[];
  /** `begin` / `commit` / `rollback` / `acquire` / `release`, in order. */
  readonly lifecycle: readonly string[];
}

export interface FakeDatabaseOptions {
  readonly script: QueryScript;
  /** When set, `acquireConnection` rejects with it — the "pool is gone" branch of an adapter. */
  readonly acquireError?: Error;
  /** Transport-level transaction responses, including a lost COMMIT acknowledgement. */
  readonly transaction?: (
    phase: 'begin' | 'commit' | 'rollback',
    settings?: TransactionSettings,
  ) => Promise<void> | void;
}

class ScriptedConnection implements DatabaseConnection {
  readonly #script: QueryScript;
  readonly #executed: ExecutedQuery[];

  constructor(script: QueryScript, executed: ExecutedQuery[]) {
    this.#script = script;
    this.#executed = executed;
  }

  async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
    const query: ExecutedQuery = { sql: compiled.sql, parameters: compiled.parameters };
    this.#executed.push(query);
    const answer = this.#script(query, this.#executed.length);
    if ('throws' in answer) throw answer.throws;
    if ('insertId' in answer) return { rows: [], insertId: answer.insertId };
    if ('rows' in answer) {
      // The script hands back the rows the caller's query shape expects; a driver cannot know `R`.
      // eslint-disable-next-line typescript/no-unsafe-type-assertion -- the script owns the row shape
      return { rows: [...answer.rows] as R[] };
    }
    return { rows: [], numAffectedRows: answer.numAffectedRows };
  }

  streamQuery(): never {
    throw new Error('the fake driver does not script streaming queries');
  }
}

class FakeDriver implements Driver {
  readonly #connection: ScriptedConnection;
  readonly #lifecycle: string[];
  readonly #acquireError: Error | undefined;
  readonly #transaction: FakeDatabaseOptions['transaction'];

  constructor(
    connection: ScriptedConnection,
    lifecycle: string[],
    acquireError: Error | undefined,
    transaction: FakeDatabaseOptions['transaction'],
  ) {
    this.#connection = connection;
    this.#lifecycle = lifecycle;
    this.#acquireError = acquireError;
    this.#transaction = transaction;
  }

  async init(): Promise<void> {
    // Nothing to open.
  }

  async acquireConnection(): Promise<DatabaseConnection> {
    if (this.#acquireError !== undefined) throw this.#acquireError;
    this.#lifecycle.push('acquire');
    return this.#connection;
  }

  async beginTransaction(
    _connection: DatabaseConnection,
    settings: TransactionSettings,
  ): Promise<void> {
    this.#lifecycle.push('begin');
    await this.#transaction?.('begin', settings);
  }

  async commitTransaction(): Promise<void> {
    this.#lifecycle.push('commit');
    await this.#transaction?.('commit');
  }

  async rollbackTransaction(): Promise<void> {
    this.#lifecycle.push('rollback');
    await this.#transaction?.('rollback');
  }

  async releaseConnection(): Promise<void> {
    this.#lifecycle.push('release');
  }

  async destroy(): Promise<void> {
    // Nothing to close.
  }
}

/** A `Kysely<Database>` whose every statement is answered by `script`. */
export function fakeDatabase(options: FakeDatabaseOptions): FakeDatabase {
  const executed: ExecutedQuery[] = [];
  const lifecycle: string[] = [];
  const driver = new FakeDriver(
    new ScriptedConnection(options.script, executed),
    lifecycle,
    options.acquireError,
    options.transaction,
  );
  const db = new Kysely<Database>({
    dialect: {
      createAdapter: () => new MysqlAdapter(),
      createDriver: () => driver,
      createIntrospector: (instance) => new MysqlIntrospector(instance),
      createQueryCompiler: () => new MysqlQueryCompiler(),
    },
  });
  return { db, executed, lifecycle };
}

/** A script that answers every statement with no rows: the "nothing there" database. */
export const EMPTY_SCRIPT: QueryScript = () => ({ rows: [] });
