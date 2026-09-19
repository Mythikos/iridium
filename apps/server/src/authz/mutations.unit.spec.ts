/** Real Kysely transaction outcomes, with only database and live-I/O boundaries scripted. */
import { UserId } from '@iridium/contracts';
import { describe, expect, it, onTestFinished } from 'vitest';

import { ManualClock } from '../../test/support/manual-clock.ts';
import { buildWithoutDatabase } from '../../test/support/no-database-app.ts';
import { ownedFakeDatabase } from '../../test/support/owned-fake-database.ts';
import { idBytes } from '../auth/ids.ts';
import { InProcessAuthzBus, type AuthzEvent } from './bus.ts';
import { AUTHZ_MUTATION_RETRY_MS, AuthzMutations, authzMutations } from './mutations.ts';
import { SessionCommandFence } from './session-command-fence.ts';

const USER = UserId.parse('019948c4-0000-7000-8000-000000000001');
const OTHER = UserId.parse('019948c4-0000-7000-8000-000000000002');
const OPTIONS = { userId: USER, isolation: 'read committed' } as const;
const EVENT: AuthzEvent = { type: 'user.disabled', userId: USER };

async function fixture(deliver?: (event: AuthzEvent) => Promise<boolean>) {
  const clock = new ManualClock();
  const fence = new SessionCommandFence();
  const published: AuthzEvent[] = [];
  const uncertain: unknown[] = [];
  const observed: Array<{ readonly userId: UserId; readonly disabled: boolean }> = [];
  const state = {
    commitFailure: false,
    committedDespiteFailure: false,
    beginFailure: false,
    dbUnavailable: false,
    disabled: false,
    staged: false,
    revalidationFailure: false,
    settle: Promise.resolve(),
  };
  const fake = await ownedFakeDatabase({
    script: (query) => {
      if (state.dbUnavailable) return { throws: new Error('database unavailable') };
      if (query.sql.startsWith('update `users`')) {
        state.staged = true;
        return { numAffectedRows: 1n };
      }
      return { rows: [{ id: idBytes(USER), status: state.disabled ? 'disabled' : 'active' }] };
    },
    transaction: (phase) => {
      if (phase === 'begin' && state.beginFailure) throw new Error('begin unavailable');
      if (phase === 'commit') {
        if (!state.commitFailure || state.committedDespiteFailure) state.disabled ||= state.staged;
        state.staged = false;
        if (state.commitFailure) throw new Error('COMMIT reply lost');
      }
      if (phase === 'rollback') state.staged = false;
    },
  });
  const bus = new InProcessAuthzBus({ onHandlerError: (_type, error) => uncertain.push(error) });
  bus.subscribe((event) => {
    published.push(event);
  });
  const mutations = new AuthzMutations({
    database: () => fake.db,
    owner: () => fake.owner,
    fence,
    clock,
    settleWrites: () => state.settle,
    deliver: deliver ?? ((event) => bus.publishAndWait(event)),
    revalidate: async (userId) => {
      if (state.revalidationFailure) throw new Error('live session lookup unavailable');
      const row = await fake.db
        .selectFrom('users')
        .select('status')
        .where('id', '=', idBytes(userId))
        .executeTakeFirstOrThrow();
      observed.push({ userId, disabled: row.status === 'disabled' });
    },
    uncertain: (_id, _userId, error) => {
      uncertain.push(error);
    },
  });
  onTestFinished(async () => {
    await mutations.stop();
    await fake.close();
  });
  const disable = () =>
    mutations.run(
      OPTIONS,
      async (trx) => {
        await trx
          .updateTable('users')
          .set({ status: 'disabled' })
          .where('id', '=', idBytes(USER))
          .execute();
        return 'changed';
      },
      () => [EVENT],
    );
  return { fake, state, clock, fence, mutations, disable, bus, published, uncertain, observed };
}

describe('authz.mutations.unit [area:authz]', () => {
  it('keeps an admitted request tied to its original generation after this process reacquires', async () => {
    const s = await fixture();
    const admitted = s.mutations.forOwner(s.fake.owner.captureFence());
    await s.fake.owner.relinquish();
    expect(await s.fake.owner.tryAcquire()).toBe(true);
    await expect(
      admitted.run(
        OPTIONS,
        async () => 'stale',
        () => [EVENT],
      ),
    ).rejects.toMatchObject({ name: 'CollabOwnershipLost' });
    expect(s.fence.blocked(USER)).toBe(false);
    expect(s.published).toEqual([]);
    const fresh = s.mutations.forOwner(s.fake.owner.captureFence());
    await expect(
      fresh.run(
        OPTIONS,
        async () => 'current',
        () => [EVENT],
      ),
    ).resolves.toBe('current');
    expect(s.published).toEqual([EVENT]);
  });

  it('shares serving bindings across registrations and joins recovery before Fastify closes', async () => {
    const s = await fixture();
    const booted = await buildWithoutDatabase();
    const app = booted.app;
    const revalidated: UserId[] = [];
    const host: Parameters<typeof authzMutations>[0] = {
      clock: s.clock,
      log: app.log,
      addHook: app.addHook.bind(app),
      authz: { sessionFence: s.fence, bus: s.bus },
      database: { dbApp: s.fake.db },
      collab: {
        ownerLease: s.fake.owner,
        persistence: { drainForUser: () => s.state.settle },
        gateway: {
          revalidateUser: async (userId: UserId | null) => {
            if (userId !== null) revalidated.push(userId);
          },
        },
      },
    };
    const bound = authzMutations(host);
    expect(authzMutations(host)).toBe(bound);
    await app.ready();
    onTestFinished(() => booted.close());
    await bound.run(
      OPTIONS,
      async () => 'unchanged',
      () => [EVENT],
    );
    expect(s.published).toEqual([EVENT]);
    s.state.commitFailure = true;
    await expect(
      bound.run(
        OPTIONS,
        async () => 'unknown',
        () => [EVENT],
      ),
    ).rejects.toThrow('COMMIT reply lost');
    expect(s.fence.blocked(USER)).toBe(true);
    s.state.commitFailure = false;
    await bound.recover();
    expect(revalidated).toEqual([USER]);
    expect(s.fence.blocked(USER)).toBe(false);
    await app.close();
    expect(s.clock.pendingTimers).toBe(0);
  });

  it('fences synchronously, drains before SQL, guards ownership first and joins post-COMMIT fanout', async () => {
    const s = await fixture();
    const drain = Promise.withResolvers<void>();
    const delivery = Promise.withResolvers<void>();
    const delivering = Promise.withResolvers<void>();
    s.state.settle = drain.promise;
    s.bus.subscribe(() => {
      delivering.resolve();
      return delivery.promise;
    });
    const running = s.disable();
    expect(s.fence.blocked(USER)).toBe(true);
    expect(s.fence.blocked(OTHER)).toBe(false);
    expect(s.fake.executed).toEqual([]);
    drain.resolve();
    await delivering.promise;
    expect(s.fake.executed[0]?.sql).toContain('from `collab_owner_fence`');
    expect(s.fake.executed[0]?.sql).toContain('for share');
    expect(s.fake.lifecycle).toContain('commit');
    expect(s.state.disabled).toBe(true);
    expect(s.fence.blocked(USER)).toBe(true);
    delivery.resolve();
    await expect(running).resolves.toBe('changed');
    expect(s.published).toEqual([EVENT]);
    expect(s.fence.blocked(USER)).toBe(false);
    expect(s.clock.pendingTimers).toBe(0);
  });

  it.each(['drain', 'begin', 'body', 'events'] as const)(
    'restores admission without fanout when %s fails before COMMIT',
    async (phase) => {
      const s = await fixture();
      const failure = new Error(`${phase} refused`);
      if (phase === 'drain') s.state.settle = Promise.reject(failure);
      if (phase === 'begin') s.state.beginFailure = true;
      const running = s.mutations.run(
        OPTIONS,
        async (trx) => {
          await trx
            .updateTable('users')
            .set({ status: 'disabled' })
            .where('id', '=', idBytes(USER))
            .execute();
          if (phase === 'body') throw failure;
          return true;
        },
        () => {
          if (phase === 'events') throw failure;
          return [EVENT];
        },
      );
      await expect(running).rejects.toThrow(phase === 'begin' ? 'begin unavailable' : failure);
      expect(s.state.disabled).toBe(false);
      expect(s.published).toEqual([]);
      expect(s.fence.blocked(USER)).toBe(false);
      expect(s.uncertain).toEqual([]);
      expect(s.fake.lifecycle).not.toContain('commit');
    },
  );

  it('refuses a generation lost while drain was pending before business SQL', async () => {
    const s = await fixture();
    const drain = Promise.withResolvers<void>();
    s.state.settle = drain.promise;
    const running = s.disable();
    const outcome = running.catch((error: unknown) => error);
    await s.fake.owner.relinquish();
    drain.resolve();
    expect(await outcome).toMatchObject({ name: 'CollabOwnershipLost' });
    expect(s.fake.executed.some((query) => query.sql.startsWith('update `users`'))).toBe(false);
    expect(s.fence.blocked(USER)).toBe(false);
    expect(s.published).toEqual([]);
  });

  it.each([false, true])(
    'reconciles an ambiguous COMMIT with actual committed=%s without inventing events',
    async (committed) => {
      const s = await fixture();
      s.state.commitFailure = true;
      s.state.committedDespiteFailure = committed;
      await expect(s.disable()).rejects.toThrow('COMMIT reply lost');
      expect(s.fence.blocked(USER)).toBe(true);
      expect(s.published).toEqual([]);
      expect(s.clock.pendingTimers).toBe(1);
      s.state.commitFailure = false;
      s.state.dbUnavailable = true;
      await s.clock.advance(AUTHZ_MUTATION_RETRY_MS);
      await s.mutations.recover();
      expect(s.fence.blocked(USER)).toBe(true);
      expect(s.observed).toEqual([]);
      s.state.dbUnavailable = false;
      const before = s.fake.executed.length;
      await s.clock.advance(AUTHZ_MUTATION_RETRY_MS);
      await s.mutations.recover();
      const recovery = s.fake.executed.slice(before);
      expect(recovery[0]?.sql).toContain('from `collab_owner_fence`');
      expect(recovery[1]?.sql).toContain('from `users`');
      expect(recovery[1]?.sql).toContain('for update');
      expect(s.observed).toEqual([{ userId: USER, disabled: committed }]);
      expect(s.fence.blocked(USER)).toBe(false);
      expect(s.published).toEqual([]);
    },
  );

  it('retains a committed fence across failed fanout and unavailable session reads, then revalidates', async () => {
    const s = await fixture();
    s.bus.subscribe(() => {
      throw new Error('close delivery unavailable');
    });
    await expect(s.disable()).rejects.toMatchObject({ code: 'unavailable' });
    expect(s.state.disabled).toBe(true);
    expect(s.fence.blocked(USER)).toBe(true);
    s.state.revalidationFailure = true;
    await s.mutations.recover();
    expect(s.fence.blocked(USER)).toBe(true);
    s.state.revalidationFailure = false;
    await s.mutations.recover();
    expect(s.observed).toEqual([{ userId: USER, disabled: true }]);
    expect(s.fence.blocked(USER)).toBe(false);
    expect(s.published).toEqual([EVENT]);
  });

  it('joins a rejected and a pending publication before reconciling, and shutdown joins deliveries', async () => {
    const publication = Promise.withResolvers<boolean>();
    const started = Promise.withResolvers<void>();
    const failure = new Error('publication transport unavailable');
    const s = await fixture(async (event) => {
      if (event.type === 'user.disabled' && event.userId === USER) throw failure;
      started.resolve();
      return publication.promise;
    });
    const run = s.mutations.run(
      OPTIONS,
      async () => 'changed',
      () => [EVENT, { type: 'user.disabled', userId: OTHER }],
    );
    const outcome = run.catch((error: unknown) => error);
    await started.promise;
    await s.mutations.recover();
    expect(s.fence.blocked(USER)).toBe(true);
    expect(s.uncertain).toEqual([]);
    expect(s.observed).toEqual([]);
    expect(s.clock.pendingTimers).toBe(0);
    publication.resolve(true);
    expect(await outcome).toMatchObject({ code: 'unavailable' });
    expect(s.fence.blocked(USER)).toBe(true);
    expect(s.clock.pendingTimers).toBe(1);
    await s.mutations.recover();
    expect(s.observed).toEqual([{ userId: USER, disabled: false }]);
    expect(s.fence.blocked(USER)).toBe(false);

    const pending = Promise.withResolvers<boolean>();
    const delivering = Promise.withResolvers<void>();
    const shutdown = await fixture(async () => {
      delivering.resolve();
      return pending.promise;
    });
    const running = shutdown.disable();
    await delivering.promise;
    let stopped = false;
    const stopping = shutdown.mutations.stop().then(() => {
      stopped = true;
      return stopped;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(shutdown.fence.blocked(USER)).toBe(true);
    pending.resolve(true);
    await expect(running).resolves.toBe('changed');
    await stopping;
    expect(stopped).toBe(true);
    expect(shutdown.fence.blocked(USER)).toBe(false);
    await expect(shutdown.disable()).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('joins concurrent recovery and cancels owned retries on shutdown while retaining an unknown fence', async () => {
    const s = await fixture();
    s.state.commitFailure = true;
    await expect(s.disable()).rejects.toThrow('COMMIT reply lost');
    const first = s.mutations.recover();
    expect(s.mutations.recover()).toBe(first);
    await s.mutations.stop();
    await first;
    expect(s.clock.pendingTimers).toBe(0);
    expect(s.fence.blocked(USER)).toBe(true);
    await s.mutations.recover();
    expect(s.observed).toEqual([]);
  });
});
