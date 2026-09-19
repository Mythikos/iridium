/**
 * `db.dedicated-connection.unit` — the reservation primitive the owner lease stands on
 * (05-collaboration-and-durability.md, "Global fairness and the persist pool"; 12-milestones.md §5.2).
 *
 * A reservation holds one pool connection until it is released, refuses a pool it would exhaust,
 * and — when given the instance — registers an `onClose` hook that releases it, so `app.close()`
 * without a drain never waits on a connection nobody will return. The last case pins the order
 * Fastify runs `onClose` hooks in, because the backstop's safety depends on it: hooks run in reverse
 * registration order, so a release registered at the collab step runs *after* the pool destroy
 * registered at the end of `buildApp`, and the release is therefore written to be safe once the pool
 * has already ended.
 */
import { describe, expect, it } from 'vitest';

import { fakeDatabase } from '../../test/support/fake-driver.ts';
import { buildWithoutDatabase } from '../../test/support/no-database-app.ts';
import { PoolTooSmallForReservationError, reserveConnection } from './dedicated-connection.ts';

describe('db.dedicated-connection.unit [area:db]', () => {
  it('refuses a pool of one, naming the remedy', async () => {
    const fake = fakeDatabase({ script: () => ({ rows: [] }) });
    await expect(reserveConnection({ db: fake.db, poolSize: 1, label: 'test' })).rejects.toThrow(
      PoolTooSmallForReservationError,
    );
    expect(fake.lifecycle).toEqual([]);
  });

  it('holds one connection until released, proves it with one round trip, and releases once', async () => {
    const fake = fakeDatabase({ script: () => ({ rows: [{ '1': 1 }] }) });
    const reservation = await reserveConnection({ db: fake.db, poolSize: 4, label: 'test' });
    expect(reservation.held).toBe(true);
    expect(fake.executed.map((query) => query.sql)).toEqual(['SELECT 1']);
    expect(fake.lifecycle).toEqual(['acquire']);
    await reservation.release();
    await reservation.release();
    expect(reservation.held).toBe(false);
    expect(fake.lifecycle).toEqual(['acquire', 'release']);
  });

  it('registers an onClose release when given the instance, and the hook is idempotent with a manual release', async () => {
    const fake = fakeDatabase({ script: () => ({ rows: [{ '1': 1 }] }) });
    const hooks: Array<() => Promise<void>> = [];
    const reservation = await reserveConnection({
      db: fake.db,
      poolSize: 4,
      label: 'test',
      closeWith: { addHook: (_name, hook) => hooks.push(hook) },
    });
    expect(hooks).toHaveLength(1);
    await hooks[0]?.();
    expect(reservation.held).toBe(false);
    await reservation.release();
    expect(fake.lifecycle).toEqual(['acquire', 'release']);
  });

  it('runs onClose hooks in reverse registration order, so a release registered by the collab step runs after the pool destroy', async () => {
    const booted = await buildWithoutDatabase();
    const order: string[] = [];
    booted.app.addHook('onClose', async () => {
      order.push('registered-first');
    });
    booted.app.addHook('onClose', async () => {
      order.push('registered-second');
    });
    await booted.close();
    expect(order).toEqual(['registered-second', 'registered-first']);
  });
});
