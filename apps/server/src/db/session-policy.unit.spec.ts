/** The session policy owns initialization before a physical connection reaches Kysely. */
import { Readable } from 'node:stream';

import type { MysqlPool, MysqlPoolConnection } from 'kysely';
import { describe, expect, it, vi } from 'vitest';

import { fakeDatabase } from '../../test/support/fake-driver.ts';
import { ManualClock } from '../../test/support/manual-clock.ts';
import type { OwnerFence } from '../collab/owner-lease.ts';
import { DB_QUERY_TIMEOUT_MS_MAX } from './pool.ts';
import { servingLockWaitSeconds, withServingSession } from './session-policy.ts';
import { withVaultLock } from './withVaultLock.ts';

function fixture(): {
  pool: MysqlPool;
  connection: MysqlPoolConnection;
  pending: { complete: Parameters<MysqlPoolConnection['query']>[2] };
  statements: string[];
  destroyed: ReturnType<typeof vi.fn>;
  released: ReturnType<typeof vi.fn>;
  ended: ReturnType<typeof vi.fn>;
  behavior: { acquireError: Error | null; queryError: Error | null };
} {
  const pending: { complete: Parameters<MysqlPoolConnection['query']>[2] } = {
    complete: undefined,
  };
  const statements: string[] = [];
  const destroyed = vi.fn<() => void>();
  const released = vi.fn<() => void>();
  const ended = vi.fn<() => void>();
  const behavior = { acquireError: null as Error | null, queryError: null as Error | null };
  const connection: MysqlPoolConnection = {
    config: {},
    threadId: 1,
    connect: (callback) => callback?.(null),
    release: released,
    destroy: destroyed,
    query: (statement, _parameters, callback) => {
      if (behavior.queryError !== null) throw behavior.queryError;
      statements.push(statement);
      pending.complete = callback;
      return { stream: () => Readable.from([]) };
    },
  };
  const pool: MysqlPool = {
    getConnection: (callback) => callback(behavior.acquireError, connection),
    end: (callback) => {
      ended();
      callback(null);
    },
  };
  return { pool, connection, pending, statements, destroyed, released, ended, behavior };
}

function borrow(pool: MysqlPool): Promise<MysqlPoolConnection> {
  return new Promise((resolve, reject) => {
    pool.getConnection((error, connection) => {
      if (error !== null && error !== undefined) reject(error);
      else resolve(connection);
    });
  });
}

describe('db.session-policy.unit [area:db]', () => {
  it.each([
    [2_000, 1],
    [2_500, 1],
    [10_000, 5],
    [60_000, 30],
    [DB_QUERY_TIMEOUT_MS_MAX, 1_073_741],
  ])('gives MySQL a %ims command budget with a bounded %is lock wait', (budget, seconds) => {
    expect(servingLockWaitSeconds(budget)).toBe(seconds);
    expect(seconds * 1_000).toBeLessThan(budget);
  });

  it.each([
    1,
    1_999,
    0,
    -1,
    2_000.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    DB_QUERY_TIMEOUT_MS_MAX + 1,
  ])('refuses an incompatible command deadline %s', (budget) =>
    expect(() => servingLockWaitSeconds(budget)).toThrow('DB_QUERY_TIMEOUT_MS'),
  );

  it.each([1, 5, 50])(
    'structural transactions preserve a smaller serving baseline and restore %is',
    async (baseline) => {
      const database = fakeDatabase({
        script: (query) => {
          if (query.sql.startsWith('SELECT @@SESSION')) return { rows: [{ value: baseline }] };
          if (query.sql.startsWith('select'))
            return { rows: [{ tree_version: 1, status: 'active' }] };
          return { numAffectedRows: 1n };
        },
      });
      const ownerFence: OwnerFence = {
        assertActive: vi.fn<OwnerFence['assertActive']>(),
        assertCurrent: vi.fn<OwnerFence['assertCurrent']>().mockResolvedValue(undefined),
      };
      try {
        expect(
          await withVaultLock(
            {
              db: database.db,
              clock: new ManualClock(),
              ownerFence,
              vaultId: '0192baca-8123-7123-8123-000000000001',
            },
            (context) => context.bumpTreeVersion(),
          ),
        ).toBe(2);
        expect(
          database.executed
            .filter((query) => query.sql.startsWith('SET SESSION'))
            .map((query) => query.sql),
        ).toEqual([
          `SET SESSION innodb_lock_wait_timeout = ${String(Math.min(baseline, 5))}`,
          `SET SESSION innodb_lock_wait_timeout = ${String(baseline)}`,
        ]);
        expect(database.lifecycle).toEqual(['acquire', 'begin', 'commit', 'release']);
      } finally {
        await database.db.destroy();
      }
    },
  );

  it('withholds the connection until both session lock budgets are installed, once per physical lifetime', async () => {
    const state = fixture();
    const serving = withServingSession(state.pool, 10_000);
    const delivered = vi.fn<() => void>();
    const first = borrow(serving).then((connection) => {
      delivered();
      return connection;
    });
    await Promise.resolve();
    expect(delivered).not.toHaveBeenCalled();
    expect(state.statements).toEqual([
      'SET SESSION innodb_lock_wait_timeout = 5, lock_wait_timeout = 5',
    ]);
    state.pending.complete?.(null, []);
    expect(await first).toBe(state.connection);
    expect(await borrow(serving)).toBe(state.connection);
    expect(state.statements).toHaveLength(1);
    expect(state.destroyed).not.toHaveBeenCalled();
    await new Promise<void>((resolve) => serving.end(() => resolve()));
    expect(state.ended).toHaveBeenCalledOnce();
  });

  it('destroys a session whose initialization was refused and rejects the borrower', async () => {
    const state = fixture();
    const serving = withServingSession(state.pool, 2_000);
    const failure = new Error('SET failed');
    const first = borrow(serving);
    state.pending.complete?.(failure, []);
    await expect(first).rejects.toBe(failure);
    expect(state.destroyed).toHaveBeenCalledOnce();
    expect(state.released).not.toHaveBeenCalled();
  });

  it('handles a synchronous driver failure without publishing or caching the connection', async () => {
    const state = fixture();
    const failure = new Error('closed connection');
    state.behavior.queryError = failure;
    await expect(borrow(withServingSession(state.pool, 2_000))).rejects.toBe(failure);
    expect(state.destroyed).toHaveBeenCalledOnce();
    expect(state.statements).toEqual([]);
  });

  it('preserves an acquisition failure without touching a connection it never acquired', async () => {
    const state = fixture();
    const failure = new Error('pool closed');
    state.behavior.acquireError = failure;
    await expect(borrow(withServingSession(state.pool, 2_000))).rejects.toBe(failure);
    expect(state.destroyed).not.toHaveBeenCalled();
    expect(state.statements).toEqual([]);
  });
});
