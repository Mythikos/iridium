/** Schema-scoped ownership and connection lifetime (D10-33). */
import { describe, expect, it } from 'vitest';

import { fakeDatabase, type QueryScript } from '../../test/support/fake-driver.ts';
import { CollabOwnerLease, CollabOwnershipLost } from './owner-lease.ts';

function harness(schema: string, script?: QueryScript, onLost?: () => Promise<void>) {
  let generation: Buffer = Buffer.alloc(16);
  const events: Array<Readonly<Record<string, unknown>>> = [];
  const fake = fakeDatabase({
    script: (query, ordinal) => {
      if (query.sql.includes('information_schema.SCHEMATA')) {
        return { rows: [{ name: schema }] };
      }
      if (query.sql.includes('`collab_owner_fence`')) {
        if (query.sql.startsWith('update')) {
          const next = query.parameters[0];
          if (!Buffer.isBuffer(next)) throw new Error('generation must be binary(16)');
          generation = next;
          return { numAffectedRows: 1n };
        }
        return { rows: [{ id: 1, generation }] };
      }
      return script?.(query, ordinal) ?? { rows: [{ value: 1 }] };
    },
  });
  const lease = new CollabOwnerLease({
    db: () => fake.db,
    poolSize: 4,
    ...(onLost === undefined ? {} : { onLost }),
    logger: {
      info: (fields) => events.push(fields),
      warn: (fields) => events.push(fields),
    },
  });
  return {
    ...fake,
    lease,
    events,
    replaceGeneration: () => {
      generation = Buffer.alloc(16, 255);
    },
  };
}

describe('collab.owner-lease.unit [area:collab]', () => {
  it('names one lock per canonical schema and bounds long Unicode names', async () => {
    const first = harness('iridium');
    const same = harness('iridium');
    const other = harness('部署'.repeat(32));
    const targets = [first, same, other];
    try {
      expect(await Promise.all(targets.map((target) => target.lease.tryAcquire()))).toEqual([
        true,
        true,
        true,
      ]);
      expect(first.lease.lockName).toBe(same.lease.lockName);
      expect(other.lease.lockName).not.toBe(first.lease.lockName);
      for (const target of targets) {
        expect(target.lease.lockName).toMatch(/^iridium_collab_owner:[A-Za-z0-9_-]{43}$/);
        expect(target.lease.lockName).toHaveLength(64);
        const acquisition = target.executed.find((query) => query.sql.includes('GET_LOCK'));
        expect(acquisition?.parameters).toEqual([target.lease.lockName]);
        expect(acquisition?.sql).toContain('GET_LOCK(?, 0)');
        expect(target.executed.find((query) => query.sql.includes('SCHEMATA'))?.sql).toContain(
          'WHERE SCHEMA_NAME = DATABASE()',
        );
      }
    } finally {
      await Promise.all(targets.map((target) => target.lease.release()));
    }
  });

  it('holds one connection, verifies without stacking acquisitions, and releases the same name once', async () => {
    const target = harness('iridium');
    await target.lease.tryAcquire();
    const lockName = target.lease.lockName;
    try {
      expect(await target.lease.tryAcquire()).toBe(true);
      expect(target.lifecycle).toEqual(['acquire', 'acquire', 'begin', 'commit', 'release']);
      expect(target.lease.connectionReserved).toBe(true);
      expect(target.executed.filter((query) => query.sql.includes('GET_LOCK'))).toHaveLength(1);
      expect(target.executed.filter((query) => query.sql.includes('SCHEMATA'))).toHaveLength(1);
      expect(
        target.executed.find((query) => query.sql.includes('IS_USED_LOCK'))?.parameters,
      ).toEqual([lockName]);
    } finally {
      await target.lease.release();
    }
    await target.lease.release();
    expect(target.lifecycle).toEqual([
      'acquire',
      'acquire',
      'begin',
      'commit',
      'release',
      'release',
    ]);
    expect(target.executed.filter((query) => query.sql.includes('RELEASE_LOCK'))).toHaveLength(1);
    expect(target.executed.find((query) => query.sql.includes('RELEASE_LOCK'))?.parameters).toEqual(
      [lockName],
    );
    expect(target.lease.held).toBe(false);
    expect(target.lease.connectionReserved).toBe(false);
    expect(target.lease.lockName).toBeNull();
    expect(await target.lease.tryAcquire()).toBe(false);
  });

  it('keeps a denied reservation, retries on readiness, and logs one denial per episode', async () => {
    let available = false;
    const target = harness('iridium', (query) => ({
      rows: [{ value: query.sql.includes('GET_LOCK') ? Number(available) : 1 }],
    }));
    try {
      expect(await target.lease.tryAcquire()).toBe(false);
      target.lease.noteDenied();
      target.lease.noteDenied();
      expect(
        target.events.filter((event) => event['event'] === 'collab.owner_lease.denied'),
      ).toHaveLength(1);
      expect(target.lease.connectionReserved).toBe(true);
      available = true;
      expect(await target.lease.tryAcquire()).toBe(true);
      expect(target.lifecycle).toEqual(['acquire', 'acquire', 'begin', 'commit', 'release']);
      target.lease.noteDenied();
      expect(
        target.events.filter((event) => event['event'] === 'collab.owner_lease.denied'),
      ).toHaveLength(2);
    } finally {
      await target.lease.release();
    }
  });

  it('fails closed and returns the connection if the selected schema cannot be resolved', async () => {
    const fake = fakeDatabase({ script: () => ({ rows: [] }) });
    const errors: unknown[] = [];
    const lease = new CollabOwnerLease({
      db: () => fake.db,
      poolSize: 4,
      logger: { info: () => undefined, warn: (fields) => errors.push(fields['err']) },
    });
    expect(await lease.tryAcquire()).toBe(false);
    expect(lease.lockName).toBeNull();
    expect(lease.connectionReserved).toBe(false);
    expect(fake.lifecycle).toEqual(['acquire', 'release']);
    expect(fake.executed.some((query) => query.sql.includes('GET_LOCK'))).toBe(false);
    expect(errors[0]).toMatchObject({ name: 'CollabLeaseSchemaError' });
    await lease.release();
  });

  it('resolves the schema again after a broken dedicated connection', async () => {
    let broken = false;
    const target = harness('iridium', (query) => {
      if (broken && query.sql.includes('IS_USED_LOCK'))
        return { throws: new Error('connection lost') };
      return { rows: [{ value: 1 }] };
    });
    try {
      expect(await target.lease.tryAcquire()).toBe(true);
      const lockName = target.lease.lockName;
      broken = true;
      expect(await target.lease.tryAcquire()).toBe(false);
      expect(target.lease.connectionReserved).toBe(false);
      expect(target.lease.lockName).toBeNull();
      broken = false;
      expect(await target.lease.tryAcquire()).toBe(true);
      expect(target.lease.lockName).toBe(lockName);
      expect(target.executed.filter((query) => query.sql.includes('SCHEMATA'))).toHaveLength(2);
      expect(target.lifecycle).toEqual([
        'acquire',
        'acquire',
        'begin',
        'commit',
        'release',
        'release',
        'acquire',
        'acquire',
        'begin',
        'commit',
        'release',
      ]);
    } finally {
      await target.lease.release();
    }
  });

  it('allows CLI repair to relinquish and reacquire its schema lease', async () => {
    const target = harness('iridium');
    try {
      expect(await target.lease.tryAcquire()).toBe(true);
      const lockName = target.lease.lockName;
      await target.lease.relinquish();
      expect(target.lease.connectionReserved).toBe(false);
      expect(await target.lease.tryAcquire()).toBe(true);
      expect(target.lease.lockName).toBe(lockName);
    } finally {
      await target.lease.release();
    }
  });

  it('registers cleanup before ready and can acquire or reacquire later without registering hooks', async () => {
    const fake = fakeDatabase({
      script: (query) => ({
        rows: query.sql.includes('SCHEMATA') ? [{ name: 'iridium' }] : [{ value: 1, id: 1 }],
      }),
    });
    const hooks: Array<() => Promise<void>> = [];
    let ready = false;
    const lease = new CollabOwnerLease({
      db: () => fake.db,
      poolSize: 4,
      logger: { info: () => undefined, warn: () => undefined },
      closeWith: {
        addHook(_name, hook) {
          if (ready) throw new Error('onClose cannot be registered after ready');
          hooks.push(hook);
        },
      },
    });
    expect(hooks).toHaveLength(1);
    ready = true;
    expect(await lease.tryAcquire()).toBe(true);
    await lease.relinquish();
    expect(await lease.tryAcquire()).toBe(true);
    expect(hooks).toHaveLength(1);
    await hooks[0]?.();
    expect(lease.connectionReserved).toBe(false);
    expect(await lease.tryAcquire()).toBe(false);
    expect(fake.lifecycle).toEqual([
      'acquire',
      'acquire',
      'begin',
      'commit',
      'release',
      'release',
      'acquire',
      'acquire',
      'begin',
      'commit',
      'release',
      'release',
    ]);
  });

  it('joins concurrent probes and releases a reservation still being acquired during shutdown', async () => {
    const target = harness('iridium');
    const first = target.lease.tryAcquire();
    const second = target.lease.tryAcquire();
    expect(second).toBe(first);
    const released = target.lease.release();
    expect(await first).toBe(false);
    await released;
    expect(target.lease.held).toBe(false);
    expect(target.lease.connectionReserved).toBe(false);
    expect(target.lifecycle).toEqual([]);
    expect(target.executed.filter((query) => query.sql.includes('GET_LOCK'))).toHaveLength(0);
  });

  it('holds a shared generation lock through each transaction and invalidates stale captured fences', async () => {
    const target = harness('iridium');
    try {
      expect(() => target.lease.captureFence()).toThrow(CollabOwnershipLost);
      expect(await target.lease.tryAcquire()).toBe(true);
      const fence = target.lease.captureFence();
      await target.db.transaction().execute(async (trx) => {
        await fence.assertCurrent(trx);
      });
      const shared = target.executed.find((query) => query.sql.endsWith('for share'));
      expect(shared?.sql).toBe(
        'select `generation` from `collab_owner_fence` where `id` = ? for share',
      );
      expect(shared?.parameters).toEqual([1]);
      target.replaceGeneration();
      await expect(
        target.db.transaction().execute((trx) => fence.assertCurrent(trx)),
      ).rejects.toBeInstanceOf(CollabOwnershipLost);
      expect(target.lease.held).toBe(false);
      expect(() => fence.assertActive()).toThrow(CollabOwnershipLost);
      expect(
        target.events.filter((event) => event['event'] === 'collab.owner_lease.lost'),
      ).toHaveLength(1);
      await target.lease.relinquish();
      expect(await target.lease.tryAcquire()).toBe(true);
      expect(() => target.lease.captureFence().assertActive()).not.toThrow();
      expect(() => fence.assertActive()).toThrow(CollabOwnershipLost);
    } finally {
      await target.lease.release();
    }
  });

  it('fences synchronously after a lost probe and joins document cleanup before publishing a new generation', async () => {
    let alive = true;
    let fenced = false;
    const cleanup = Promise.withResolvers<void>();
    const target = harness(
      'iridium',
      () => ({ rows: [{ value: Number(alive) }] }),
      () => {
        fenced = true;
        return cleanup.promise;
      },
    );
    try {
      expect(await target.lease.tryAcquire()).toBe(true);
      const fence = target.lease.captureFence();
      alive = false;
      expect(await target.lease.tryAcquire()).toBe(false);
      expect(fenced).toBe(true);
      expect(() => fence.assertActive()).toThrow(CollabOwnershipLost);
      alive = true;
      const reclaim = target.lease.tryAcquire();
      await Promise.resolve();
      expect(target.lease.held).toBe(false);
      cleanup.resolve();
      expect(await reclaim).toBe(true);
      expect(() => fence.assertActive()).toThrow(CollabOwnershipLost);
    } finally {
      cleanup.resolve();
      await target.lease.release();
    }
  });

  it('remains unavailable if old-document cleanup fails instead of reviving stale writers', async () => {
    let alive = true;
    const target = harness(
      'iridium',
      () => ({ rows: [{ value: Number(alive) }] }),
      async () => {
        throw new Error('unload failed');
      },
    );
    try {
      expect(await target.lease.tryAcquire()).toBe(true);
      alive = false;
      expect(await target.lease.tryAcquire()).toBe(false);
      alive = true;
      expect(await target.lease.tryAcquire()).toBe(false);
      expect(target.lease.held).toBe(false);
      expect(
        target.events.filter((event) => event['event'] === 'collab.owner_lease.cleanup_failed'),
      ).toHaveLength(1);
    } finally {
      await target.lease.release();
    }
  });
});
