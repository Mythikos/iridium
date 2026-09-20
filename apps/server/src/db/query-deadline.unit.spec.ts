/** Real Kysely and the deadline adapter; only mysql2's callback/stream I/O boundary is scripted. */
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

import {
  corruptCallbackDeliberately,
  corruptDeliberately,
  inspectTransportValue,
} from '@iridium/testkit';
import { Kysely, MysqlDialect, type MysqlPool, type MysqlPoolConnection } from 'kysely';
import { createPool, type QueryOptions } from 'mysql2';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ManualClock } from '../../test/support/manual-clock.ts';
import { createDb } from './index.ts';
import { DB_QUERY_TIMEOUT_MS_MAX } from './pool.ts';
import { withQueryDeadline } from './query-deadline.ts';

class DriverCommand extends EventEmitter {
  stream(): Readable {
    const stream = new Readable({ objectMode: true, read(): void {} });
    this.on('result', (row: unknown) => stream.push(row));
    this.on('end', () => stream.push(null));
    this.on('error', (error: Error) => stream.destroy(error));
    return stream;
  }
}

interface DriverCall {
  readonly options: QueryOptions;
  readonly parameters: unknown;
  readonly command: DriverCommand;
  readonly callback: ((error: unknown, rows: unknown) => void) | undefined;
}

class DriverConnection extends EventEmitter {
  readonly config = { host: 'mysql-fixture', database: 'fixture' };
  readonly threadId = 42;
  readonly calls: DriverCall[] = [];
  readonly owner: DriverPool;
  releaseCount = 0;
  destroyCount = 0;
  connectCount = 0;
  respond: ((call: DriverCall) => void) | undefined;

  constructor(owner: DriverPool) {
    super();
    this.owner = owner;
  }

  query(
    options: QueryOptions,
    parameters: unknown,
    callback?: (error: unknown, rows: unknown) => void,
  ): DriverCommand {
    const command = new DriverCommand();
    const call = { options, parameters, callback, command };
    this.calls.push(call);
    this.respond?.(call);
    return command;
  }

  release(): void {
    this.releaseCount += 1;
    this.owner.emit('release', this);
  }

  destroy(): void {
    // A dead peer need not acknowledge closure or emit release/end; the adapter must account now.
    this.destroyCount += 1;
  }

  connect(callback?: (error: unknown) => void): void {
    this.connectCount += 1;
    callback?.(null);
  }
}

type Acquire = (error: unknown, connection?: DriverConnection) => void;

class DriverPool extends EventEmitter {
  readonly connection = new DriverConnection(this);
  readonly pending: Acquire[] = [];
  autoAcquire = true;
  acquisitionError: Error | undefined;
  throwOnAcquire: Error | undefined;
  endError: Error | undefined;
  endCount = 0;

  getConnection(callback: Acquire): void {
    if (this.throwOnAcquire !== undefined) throw this.throwOnAcquire;
    if (this.acquisitionError !== undefined) callback(this.acquisitionError);
    else if (this.autoAcquire) {
      this.emit('acquire', this.connection);
      callback(null, this.connection);
    } else this.pending.push(callback);
  }

  completeAcquisition(error: unknown = null): void {
    const callback = this.pending.shift();
    if (callback === undefined) throw new Error('No pending driver acquisition.');
    if (error === null) this.emit('acquire', this.connection);
    callback(error, error === null ? this.connection : undefined);
  }

  end(callback: (error: unknown) => void): void {
    this.endCount += 1;
    callback(this.endError ?? null);
  }
}

let driver: DriverPool;
vi.mock('mysql2', () => ({ createPool: () => driver }));

function fixture(timeoutMs = 100) {
  const clock = new ManualClock();
  const bounded = withQueryDeadline(createPool({}), timeoutMs, clock);
  return { bounded, clock };
}

function acquire(pool: MysqlPool): Promise<MysqlPoolConnection> {
  return new Promise((resolve, reject) => {
    pool.getConnection((error, connection) => {
      if (error !== null) reject(error);
      else resolve(connection);
    });
  });
}

function lastCall(): DriverCall {
  const call = driver.connection.calls.at(-1);
  if (call === undefined) throw new Error('The driver never received a statement.');
  return call;
}

function nativeTimeout(): Error & { code: string; fatal: boolean } {
  return Object.assign(new Error('Query inactivity timeout'), {
    code: 'PROTOCOL_SEQUENCE_TIMEOUT',
    fatal: false,
  });
}

beforeEach(() => {
  driver = new DriverPool();
});

describe('db.query-deadline.unit [area:db]', () => {
  it('counts unresolved acquisitions exactly through success, timeout, late arrival and immediate failures', async () => {
    driver.autoAcquire = false;
    const { bounded, clock } = fixture();
    const first = acquire(bounded);
    const second = acquire(bounded);
    const timedOut = second.catch((error: unknown) => error);
    expect(bounded.pendingAcquisitions()).toBe(2);
    driver.completeAcquisition();
    await first;
    expect(bounded.pendingAcquisitions()).toBe(1);
    await clock.advance(100);
    expect(await timedOut).toMatchObject({ code: 'ETIMEDOUT' });
    expect(bounded.pendingAcquisitions()).toBe(0);
    driver.completeAcquisition();
    expect(bounded.pendingAcquisitions()).toBe(0);
    expect(driver.connection.releaseCount).toBe(1);
    const failure = new Error('acquisition refused');
    driver.acquisitionError = failure;
    await expect(acquire(bounded)).rejects.toBe(failure);
    expect(bounded.pendingAcquisitions()).toBe(0);
    driver.throwOnAcquire = failure;
    await expect(acquire(bounded)).rejects.toBe(failure);
    expect(bounded.pendingAcquisitions()).toBe(0);
  });

  it('forwards native timeout, SQL, parameters, results and connection metadata without an idle deadline', async () => {
    const { bounded, clock } = fixture();
    const connection = await acquire(bounded);
    const callback = vi.fn<(error: unknown, rows: unknown) => void>();
    const parameters = ['private-note-text', 5];
    connection.query('SELECT ? AS body, ? AS version', parameters, callback);
    expect(lastCall().options).toEqual({
      sql: 'SELECT ? AS body, ? AS version',
      timeout: 100,
    });
    expect(lastCall().parameters).toBe(parameters);
    const rows = [{ body: 'private-note-text', version: 5 }];
    lastCall().callback?.(null, rows);
    expect(callback).toHaveBeenCalledExactlyOnceWith(null, rows);
    expect(connection.threadId).toBe(42);
    expect(connection.config).toBe(driver.connection.config);
    const connected = vi.fn<(error: unknown) => void>();
    connection.connect(connected);
    expect(connected).toHaveBeenCalledExactlyOnceWith(null);
    expect(driver.connection.connectCount).toBe(1);
    expect(clock.pendingTimers).toBe(0);
    await clock.advance(60_000);
    expect(driver.connection.destroyCount).toBe(0);
    expect(bounded.inUse()).toBe(1);
    connection.release();
    expect(bounded.inUse()).toBe(0);
    expect(await acquire(bounded)).toBe(connection);
    connection.release();
  });

  it('destroys a timed-out statement before rejection, ignores late callbacks and never returns its slot', async () => {
    const { bounded } = fixture();
    const connection = await acquire(bounded);
    const observations: unknown[] = [];
    corruptCallbackDeliberately(
      (statement) =>
        connection.query(statement, ['secret'], (error) => {
          observations.push({
            error,
            destroyed: driver.connection.destroyCount,
            inUse: bounded.inUse(),
          });
        }),
      'deadline-note-update',
    );
    const failure = nativeTimeout();
    lastCall().callback?.(failure, undefined);
    lastCall().callback?.(null, []);
    expect(observations).toEqual([{ error: failure, destroyed: 1, inUse: 0 }]);
    expect(() => connection.query('rollback', [], () => undefined)).toThrow(failure);
    expect(driver.connection.calls).toHaveLength(1);
    connection.destroy();
    connection.release();
    expect(driver.connection.destroyCount).toBe(1);
    expect(driver.connection.releaseCount).toBe(0);
  });

  it('settles queued callbacks and streams when the active command poisons their shared socket', async () => {
    const { bounded } = fixture();
    const connection = await acquire(bounded);
    const first = vi.fn<(error: unknown, rows: unknown) => void>();
    const queued = vi.fn<(error: unknown, rows: unknown) => void>();
    connection.query('SELECT first', [], first);
    const active = lastCall();
    connection.query('SELECT queued', [], queued);
    const waiting = lastCall();
    const streamed = Readable.from(
      connection.query('SELECT streamed', []).stream({ objectMode: true }),
    ).toArray();
    const outcome = streamed.catch((error: unknown) => error);
    const failure = nativeTimeout();
    active.callback?.(failure, undefined);
    waiting.callback?.(null, [{ impossible: true }]);
    expect(first).toHaveBeenCalledExactlyOnceWith(failure, undefined);
    expect(queued).toHaveBeenCalledExactlyOnceWith(failure, []);
    expect(await outcome).toBe(failure);
    expect(driver.connection.destroyCount).toBe(1);
    expect(bounded.inUse()).toBe(0);
  });
  it('retains a normal SQL refusal and keeps its healthy connection reusable', async () => {
    const { bounded } = fixture();
    const connection = await acquire(bounded);
    const callback = vi.fn<(error: unknown, rows: unknown) => void>();
    const duplicate = Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY' });
    corruptCallbackDeliberately(
      (statement) => connection.query(statement, ['duplicate'], callback),
      'duplicate-user-insert',
    );
    lastCall().callback?.(duplicate, undefined);
    expect(callback).toHaveBeenCalledExactlyOnceWith(duplicate, undefined);
    expect(driver.connection.destroyCount).toBe(0);
    connection.release();
    expect(bounded.inUse()).toBe(0);
  });

  it('keeps streamed rows and completion intact with the native query deadline', async () => {
    const { bounded } = fixture();
    const connection = await acquire(bounded);
    const rows = Readable.from(
      connection.query('SELECT body FROM notes', []).stream({ objectMode: true }),
    ).toArray();
    expect(lastCall().options.timeout).toBe(100);
    lastCall().command.emit('result', { body: 'first' });
    lastCall().command.emit('result', { body: 'second' });
    lastCall().command.emit('end');
    await expect(rows).resolves.toEqual([{ body: 'first' }, { body: 'second' }]);
    expect(driver.connection.destroyCount).toBe(0);
    connection.release();
  });

  it('rejects a streamed timeout and discards the physical connection before the consumer sees it', async () => {
    const { bounded } = fixture();
    const connection = await acquire(bounded);
    const rows = Readable.from(
      connection.query('SELECT body FROM notes', []).stream({ objectMode: true }),
    ).toArray();
    const failure = nativeTimeout();
    const outcome = rows.catch((error: unknown) => error);
    lastCall().command.emit('error', failure);
    expect(driver.connection.destroyCount).toBe(1);
    expect(bounded.inUse()).toBe(0);
    expect(await outcome).toBe(failure);
  });

  it('bounds acquisition and releases a healthy late arrival without ever issuing the abandoned SQL', async () => {
    driver.autoAcquire = false;
    const { bounded, clock } = fixture();
    const pending = acquire(bounded);
    const outcome = pending.catch((error: unknown) => error);
    await clock.advance(100);
    expect(await outcome).toMatchObject({ code: 'ETIMEDOUT', syscall: 'getConnection' });
    driver.completeAcquisition();
    expect(driver.connection.releaseCount).toBe(1);
    expect(driver.connection.destroyCount).toBe(0);
    expect(driver.connection.calls).toEqual([]);
    expect(bounded.inUse()).toBe(0);
    expect(clock.pendingTimers).toBe(0);
  });

  it('ignores a late acquisition failure without touching an absent connection', async () => {
    driver.autoAcquire = false;
    const { bounded, clock } = fixture();
    const callback = vi.fn<(error: unknown, rows: unknown) => void>();
    bounded.getConnection(callback);
    await clock.advance(100);
    driver.completeAcquisition(new Error('connection failed after its borrower expired'));
    expect(callback).toHaveBeenCalledTimes(1);
    expect(driver.connection.releaseCount).toBe(0);
    expect(bounded.inUse()).toBe(0);
  });

  it.each(['callback', 'throw'] as const)(
    'cancels acquisition timers on a driver %s failure',
    async (kind) => {
      const failure = new Error('connect refused');
      if (kind === 'callback') driver.acquisitionError = failure;
      else driver.throwOnAcquire = failure;
      const { bounded, clock } = fixture();
      await expect(acquire(bounded)).rejects.toBe(failure);
      expect(clock.pendingTimers).toBe(0);
      expect(bounded.inUse()).toBe(0);
    },
  );

  it('does not reinterpret a consumer callback exception as a second acquisition failure', () => {
    const { bounded, clock } = fixture();
    const failure = new Error('consumer failed');
    const callback = vi.fn<() => never>(() => {
      throw failure;
    });
    expect(() => bounded.getConnection(callback)).toThrow(failure);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(clock.pendingTimers).toBe(0);
    driver.connection.release();
  });

  it('counts physical identities through duplicate acquire, release, end and error events', async () => {
    const { bounded } = fixture();
    const first = await acquire(bounded);
    driver.emit('acquire', driver.connection);
    expect(bounded.inUse()).toBe(1);
    first.release();
    driver.emit('release', driver.connection);
    expect(bounded.inUse()).toBe(0);
    await acquire(bounded);
    driver.connection.emit('end');
    expect(bounded.inUse()).toBe(0);
    await acquire(bounded);
    driver.connection.emit('error', new Error('fatal socket error'));
    expect(bounded.inUse()).toBe(0);
    expect(driver.connection.listenerCount('end')).toBe(0);
  });

  it('detaches all gauge listeners on shutdown and preserves a pool-end error', async () => {
    const { bounded } = fixture();
    await acquire(bounded);
    const failure = new Error('shutdown refused');
    driver.endError = failure;
    const ended = vi.fn<(error: unknown) => void>();
    bounded.end(ended);
    expect(ended).toHaveBeenCalledExactlyOnceWith(failure);
    expect(driver.endCount).toBe(1);
    expect(bounded.inUse()).toBe(0);
    expect(driver.listenerCount('acquire')).toBe(0);
    expect(driver.listenerCount('release')).toBe(0);
    expect(driver.connection.listenerCount('error')).toBe(0);
    expect(driver.connection.listenerCount('end')).toBe(0);
  });

  it('preserves an uncertain COMMIT through real Kysely cleanup, with no retry or false rollback', async () => {
    const { bounded } = fixture();
    const failure = nativeTimeout();
    driver.connection.respond = (call) =>
      call.callback?.(call.options.sql === 'commit' ? failure : null, []);
    const db = new Kysely<Record<string, never>>({ dialect: new MysqlDialect({ pool: bounded }) });
    try {
      await expect(
        db.transaction().execute(async (trx) => {
          await corruptDeliberately(trx, { kind: 'transport-insert', value: 1 });
          return 'saved';
        }),
      ).rejects.toBe(failure);
      expect(driver.connection.calls.map((call) => call.options.sql)).toEqual([
        'begin',
        'INSERT INTO note_updates VALUES (?)',
        'commit',
      ]);
      expect(driver.connection.destroyCount).toBe(1);
      expect(driver.connection.releaseCount).toBe(0);
      expect(bounded.inUse()).toBe(0);
    } finally {
      await db.destroy();
    }
  });

  it('wires createDb query accounting and physical pool occupancy through the actual adapter', async () => {
    const clock = new ManualClock();
    driver.connection.respond = (call) => call.callback?.(null, [{ value: 1 }]);
    const handle = createDb(
      { host: 'fixture', port: 3306, user: 'fixture', password: 'fixture', database: 'fixture' },
      2,
      500,
      3_500,
      clock,
    );
    try {
      await inspectTransportValue(handle.db);
      expect(lastCall().options.timeout).toBe(3_500);
      expect(handle.queriesExecuted()).toBe(1);
      expect(handle.inUse()).toBe(0);
      expect(clock.pendingTimers).toBe(0);
    } finally {
      await handle.db.destroy();
    }
  });

  it.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, DB_QUERY_TIMEOUT_MS_MAX + 1])(
    'rejects an invalid internal deadline %s before registering driver listeners',
    (timeoutMs) => {
      expect(() => fixture(timeoutMs)).toThrow(RangeError);
      expect(driver.listenerCount('acquire')).toBe(0);
    },
  );
});
