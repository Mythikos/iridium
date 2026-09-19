import { setImmediate } from 'node:timers/promises';

import { newId, UserId } from '@iridium/contracts';
import { describe, expect, it, vi } from 'vitest';

import { fakeDatabase } from '../../test/support/fake-driver.ts';
import { ManualClock } from '../../test/support/manual-clock.ts';
import { buildWithoutDatabase } from '../../test/support/no-database-app.ts';
import { buildApp } from '../app.ts';
import type { AuditEventInput } from '../audit/chain.ts';
import { idBytes } from '../auth/ids.ts';
import { CollabOwnerLease, CollabOwnershipLost } from '../collab/owner-lease.ts';
import { createLogger } from '../ops/logging.ts';
import { AuthzStoreUnavailableError } from './authorize.ts';
import { SessionCommandFence } from './session-command-fence.ts';
import {
  KyselySessionCommandStore,
  SESSION_REVOCATION_POLL_MS,
  SessionCommandRelay,
  type SessionCommand,
  type SessionCommandResult,
  type SessionCommandStore,
  type SessionRevocation,
} from './session-revocations.ts';

function fixture(count = 1) {
  const userId = UserId.parse(newId());
  const command: SessionCommand = {
    id: newId(),
    userId,
    actor: { actorType: 'system' },
    context: {},
    result: null,
    delivered: false,
  };
  const result: SessionCommandResult = {
    ok: true,
    users: 1,
    sessions: Array.from({ length: count }, () => ({ userId, sessionId: newId() })),
  };
  const clock = new ManualClock();
  const fence = new SessionCommandFence();
  const delivered: SessionRevocation[] = [];
  const errors: unknown[] = [];
  const state = {
    owner: true,
    reads: 0,
    executions: 0,
    resolutions: 0,
    drains: 0,
    acknowledgements: 0,
    rejectDelivery: false,
    row: command,
  };
  const store: SessionCommandStore = {
    async pending() {
      state.reads++;
      return state.row.delivered ? null : state.row;
    },
    async execute() {
      state.executions++;
      state.row = { ...state.row, result };
      return result;
    },
    async resolve() {
      state.resolutions++;
      const resolved = state.row.result ?? { ok: false };
      state.row = { ...state.row, result: resolved };
      return resolved;
    },
    async markDelivered() {
      state.acknowledgements++;
      state.row = { ...state.row, delivered: true };
    },
  };
  const options = {
    clock,
    store,
    fence,
    ownsCollaboration: () => state.owner,
    settleWrites: async () => {
      state.drains++;
    },
    deliver: async (event: SessionRevocation) => {
      delivered.push(event);
      return !state.rejectDelivery;
    },
    beforeDelivery: async () => undefined,
    onError: (error: unknown) => {
      errors.push(error);
    },
  };
  const relay = new SessionCommandRelay(options);
  return { userId, command, result, clock, fence, store, state, options, relay, delivered, errors };
}

/** Real command SQL and owner fencing, with only the database transport and audit sink scripted. */
async function storeFixture(
  command: SessionCommand,
  live: ReadonlyMap<string, readonly string[]> = new Map(),
) {
  const clock = new ManualClock();
  let generation: Buffer = Buffer.alloc(16);
  const state: {
    result: SessionCommandResult | null;
    deliveredAt: Date | null;
    auditError: Error | null;
  } = {
    result: command.result,
    deliveredAt: null,
    auditError: null,
  };
  const audit: AuditEventInput[] = [];
  const isolationLevels: (string | undefined)[] = [];
  const ownerWarnings: unknown[] = [];
  const fake = fakeDatabase({
    script: (query) => {
      if (query.sql.trim() === 'SELECT 1') return { rows: [{ value: 1 }] };
      if (query.sql.includes('information_schema.SCHEMATA'))
        return { rows: [{ name: 'unit_revocations' }] };
      if (
        query.sql.includes('GET_LOCK') ||
        query.sql.includes('RELEASE_LOCK') ||
        query.sql.includes('IS_USED_LOCK')
      )
        return { rows: [{ value: 1 }] };
      if (query.sql.includes('`collab_owner_fence`')) {
        if (query.sql.startsWith('update')) {
          const next = query.parameters[0];
          if (!Buffer.isBuffer(next)) throw new Error('owner generation must be binary');
          generation = next;
          return { numAffectedRows: 1n };
        }
        return { rows: [{ id: 1, generation }] };
      }
      if (
        query.sql.startsWith('select') &&
        query.sql.includes('from `session_revocation_commands`')
      ) {
        return {
          rows: [
            {
              id: idBytes(command.id),
              user_id: command.userId === null ? null : idBytes(command.userId),
              actor_type: command.actor.actorType,
              actor_id: command.actor.actorId == null ? null : idBytes(command.actor.actorId),
              actor_display: command.actor.actorDisplay ?? null,
              context: command.context,
              created_at: clock.date(),
              result: state.result,
              delivered_at: state.deliveredAt,
            },
          ],
        };
      }
      if (query.sql.startsWith('select distinct'))
        return { rows: [...live.keys()].map((id) => ({ user_id: idBytes(id) })) };
      if (query.sql.startsWith('select') && query.sql.includes('from `users`')) {
        return { rows: [{ id: query.parameters[0], authz_version: 2 }] };
      }
      if (query.sql.startsWith('select') && query.sql.includes('from `sessions`')) {
        const user = [...live.keys()].find((id) =>
          idBytes(id).equals(
            Buffer.from(query.parameters[0] instanceof Uint8Array ? query.parameters[0] : []),
          ),
        );
        return {
          rows: (user === undefined ? [] : (live.get(user) ?? [])).map((id) => ({
            id: idBytes(id),
          })),
        };
      }
      if (query.sql.startsWith('update') || query.sql.startsWith('insert'))
        return { numAffectedRows: 1n };
      throw new Error('unexpected command-store SQL: ' + query.sql);
    },
    transaction: (phase, settings) => {
      if (phase === 'begin') isolationLevels.push(settings?.isolationLevel);
    },
  });
  const owner = new CollabOwnerLease({
    db: () => fake.db,
    poolSize: 4,
    logger: {
      info: () => undefined,
      warn: (fields) => {
        ownerWarnings.push(fields);
      },
    },
  });
  const acquired = await owner.tryAcquire();
  expect(ownerWarnings).toEqual([]);
  expect(acquired).toBe(true);
  const queryOffset = fake.executed.length;
  const lifecycleOffset = fake.lifecycle.length;
  const isolationOffset = isolationLevels.length;
  const store = new KyselySessionCommandStore({
    database: () => fake.db,
    clock,
    owner: () => owner,
    audit: () => ({
      async record(trx, event) {
        expect(trx.isTransaction).toBe(true);
        expect(fake.lifecycle.at(-1)).toBe('begin');
        expect(fake.executed.at(-1)?.sql).toContain(
          'update `session_revocation_commands` set `result` = ?',
        );
        audit.push(event);
        if (state.auditError !== null) throw state.auditError;
        return {
          id: 1,
          chainId: 'server',
          occurredAt: clock.date(),
          keyVersion: 1,
          prevHash: Buffer.alloc(32),
          hash: Buffer.alloc(32),
        };
      },
    }),
  });
  return {
    store,
    clock,
    get isolationLevels() {
      return isolationLevels.slice(isolationOffset);
    },
    state,
    audit,
    owner,
    get executed() {
      return fake.executed.slice(queryOffset);
    },
    get lifecycle() {
      return fake.lifecycle.slice(lifecycleOffset);
    },
    replaceOwner() {
      generation = Buffer.alloc(16, 255);
    },
    close: () => owner.release(),
  };
}

describe('authz.session-revocations.unit [area:authz] [hp:HP-3]', () => {
  it('discovers one command on the injected clock, sweeps all 513 sessions together, and leaves completed history out of future polls', async () => {
    const f = fixture(513);
    f.relay.start();
    f.relay.start();
    expect(f.clock.pendingTimers).toBe(1);
    await f.clock.advance(SESSION_REVOCATION_POLL_MS - 1);
    expect(f.state.reads).toBe(0);
    await f.clock.advance(1);
    await expect.poll(() => f.state.acknowledgements).toBe(1);
    expect(f.delivered).toHaveLength(513);
    expect(new Set(f.delivered.map((event) => event.sessionId)).size).toBe(513);
    expect(f.state).toMatchObject({ executions: 1, drains: 1, acknowledgements: 1 });
    expect(f.fence.blocked(f.userId)).toBe(false);
    await f.relay.poll();
    expect(f.state.executions).toBe(1);
    expect(f.errors).toEqual([]);
    await f.relay.stop();
    expect(f.clock.pendingTimers).toBe(0);
    f.relay.start();
    await f.relay.poll();
    expect(f.clock.pendingTimers).toBe(0);
    expect(f.state.reads).toBe(2);
  });

  it('does no background SQL on a standby, then executes after ownership acquisition', async () => {
    const f = fixture();
    f.state.owner = false;
    await f.relay.poll();
    expect(f.state.reads).toBe(0);
    f.state.owner = true;
    await f.relay.poll();
    expect(f.state.executions).toBe(1);
    await f.relay.stop();
  });

  it.each(['ownership lost', 'shutdown'] as const)(
    'does not execute a discovered command after %s during the read',
    async (cause) => {
      const f = fixture();
      const blocked = Promise.withResolvers<SessionCommand | null>();
      f.store.pending = () => blocked.promise;
      const polling = f.relay.poll();
      expect(f.relay.poll()).toBe(polling);
      const stopping = cause === 'shutdown' ? f.relay.stop() : null;
      if (cause === 'ownership lost') f.state.owner = false;
      blocked.resolve(f.command);
      await polling;
      await stopping;
      expect(f.state.executions).toBe(0);
      expect(f.fence.blocked(f.userId)).toBe(false);
      await f.relay.stop();
    },
  );

  it('fences before waiting for admitted writes and never mutates until that full drain finishes', async () => {
    const f = fixture();
    const writes = Promise.withResolvers<void>();
    const relay = new SessionCommandRelay({ ...f.options, settleWrites: () => writes.promise });
    const polling = relay.poll();
    await Promise.resolve();
    expect(f.fence.blocked(f.userId)).toBe(true);
    expect(f.state.executions).toBe(0);
    writes.resolve();
    await polling;
    expect(f.state.executions).toBe(1);
    expect(f.fence.blocked(f.userId)).toBe(false);
    await relay.stop();
  });

  it('retains an unknown COMMIT fence through failed resolution, then delivers the durable result without executing again', async () => {
    const f = fixture();
    const execute = f.store.execute.bind(f.store);
    const resolve = f.store.resolve.bind(f.store);
    f.store.execute = async (command) => {
      await execute(command);
      throw new Error('COMMIT response lost');
    };
    f.store.resolve = async () => {
      throw new Error('resolution database unreachable');
    };
    await f.relay.poll();
    expect(f.fence.blocked(f.userId)).toBe(true);
    expect(f.delivered).toEqual([]);
    await f.relay.poll();
    expect(f.fence.blocked(f.userId)).toBe(true);
    expect(f.state.executions).toBe(1);
    f.store.resolve = resolve;
    await f.relay.poll();
    expect(f.state).toMatchObject({ executions: 1, resolutions: 1, acknowledgements: 1 });
    expect(f.fence.blocked(f.userId)).toBe(false);
    expect(f.delivered).toHaveLength(1);
    expect(f.errors).toHaveLength(2);
    await f.relay.stop();
  });

  it('a proven rollback resumes admission without publishing a false revocation', async () => {
    const f = fixture();
    f.store.execute = async () => {
      throw new Error('audit statement failed');
    };
    await f.relay.poll();
    expect(f.fence.blocked(f.userId)).toBe(true);
    await f.relay.poll();
    expect(f.state.row.result).toEqual({ ok: false });
    expect(f.state.row.delivered).toBe(true);
    expect(f.delivered).toEqual([]);
    expect(f.fence.blocked(f.userId)).toBe(false);
    await f.relay.stop();
  });

  it('replays a committed result after restart and an acknowledgement failure without repeating its mutation', async () => {
    const f = fixture();
    f.state.row = { ...f.command, result: f.result };
    const acknowledge = f.store.markDelivered.bind(f.store);
    f.store.markDelivered = async () => {
      throw new Error('acknowledgement failed');
    };
    await f.relay.poll();
    expect(f.state.executions).toBe(0);
    expect(f.delivered).toHaveLength(1);
    expect(f.fence.blocked(f.userId)).toBe(false);
    await f.relay.stop();
    f.store.markDelivered = acknowledge;
    const restarted = new SessionCommandRelay(f.options);
    await restarted.poll();
    expect(f.delivered).toHaveLength(2);
    expect(f.delivered[0]).toEqual(f.delivered[1]);
    expect(f.state.executions).toBe(0);
    expect(f.state.row.delivered).toBe(true);
    await restarted.stop();
  });

  it('a failed subscriber retains the fence, starts all other sweeps, and retries the same committed result', async () => {
    const f = fixture(2);
    f.state.rejectDelivery = true;
    await f.relay.poll();
    expect(f.delivered).toHaveLength(2);
    expect(f.fence.blocked(f.userId)).toBe(true);
    expect(f.state.acknowledgements).toBe(0);
    expect(f.errors).toEqual([
      new Error('A session revocation subscriber failed; the command remains fenced for retry.'),
    ]);
    f.state.rejectDelivery = false;
    await f.relay.poll();
    expect(f.delivered).toHaveLength(4);
    expect(f.state.executions).toBe(1);
    expect(f.fence.blocked(f.userId)).toBe(false);
    await f.relay.stop();
  });

  it('shutdown joins an active async delivery and leaves its failed outcome fenced', async () => {
    const f = fixture(2);
    const delayed = Promise.withResolvers<boolean>();
    const invoked: SessionRevocation[] = [];
    const relay = new SessionCommandRelay({
      ...f.options,
      deliver: (event) => {
        invoked.push(event);
        return delayed.promise;
      },
    });
    const polling = relay.poll();
    await expect.poll(() => invoked.length).toBe(2);
    const stop = relay.stop();
    delayed.reject(new Error('subscriber failed asynchronously'));
    await Promise.all([polling, stop]);
    expect(f.state.acknowledgements).toBe(0);
    expect(f.fence.blocked(f.userId)).toBe(true);
    expect(f.errors).toHaveLength(1);
  });

  it.each(['throw', 'reject'] as const)(
    'shutdown joins every delivery when one subscriber fails with an unexpected %s',
    async (failure) => {
      const f = fixture(2);
      const pending = Promise.withResolvers<boolean>();
      const allStarted = Promise.withResolvers<void>();
      const invoked: SessionRevocation[] = [];
      const relay = new SessionCommandRelay({
        ...f.options,
        deliver: (event) => {
          invoked.push(event);
          if (invoked.length === 1) {
            const error = new Error('unexpected subscriber failure');
            if (failure === 'throw') throw error;
            return Promise.reject(error);
          }
          allStarted.resolve();
          return pending.promise;
        },
      });
      const polling = relay.poll();
      await allStarted.promise;
      let stopped = false;
      const stopping = relay.stop().then(() => {
        stopped = true;
        return undefined;
      });
      // A fresh event-loop turn drains every promise continuation from the rejected delivery.
      // The other delivery still owns work, so neither poll nor shutdown may report completion.
      await setImmediate();
      expect(stopped).toBe(false);
      expect(f.errors).toEqual([]);
      expect(f.state.acknowledgements).toBe(0);
      expect(f.fence.blocked(f.userId)).toBe(true);
      pending.resolve(true);
      await Promise.all([polling, stopping]);
      expect(stopped).toBe(true);
      expect(invoked).toHaveLength(2);
      expect(f.errors).toHaveLength(1);
      expect(f.state.acknowledgements).toBe(0);
      expect(f.fence.blocked(f.userId)).toBe(true);
    },
  );

  it('contains discovery failures before fencing any user and retries discovery later', async () => {
    const f = fixture();
    const pending = f.store.pending.bind(f.store);
    f.store.pending = async () => {
      throw new Error('database offline');
    };
    await f.relay.poll();
    expect(f.fence.blocked(f.userId)).toBe(false);
    f.store.pending = pending;
    await f.relay.poll();
    expect(f.delivered).toHaveLength(1);
    expect(f.errors).toHaveLength(1);
    await f.relay.stop();
  });

  it('refuses database-free request submission, discovery and lookup', async () => {
    const f = fixture();
    const store = new KyselySessionCommandStore({
      database: () => null,
      clock: f.clock,
      owner: () => {
        throw new Error('an owner cannot exist without a database');
      },
      audit: () => {
        throw new Error('audit cannot run without a database');
      },
    });
    await expect(store.submit(f.command)).rejects.toBeInstanceOf(AuthzStoreUnavailableError);
    await expect(store.pending()).rejects.toBeInstanceOf(AuthzStoreUnavailableError);
    await expect(store.find(f.command.id)).rejects.toBeInstanceOf(AuthzStoreUnavailableError);
  });

  it('persists only operator intent and faithfully distinguishes pending and delivered command rows', async () => {
    const base = fixture().command;
    const command: SessionCommand = {
      ...base,
      actor: { actorType: 'user', actorId: base.userId, actorDisplay: 'operator' },
      context: { ip: '127.0.0.1' },
    };
    const f = await storeFixture(command);
    try {
      await f.store.submit(command);
      expect(f.executed).toHaveLength(1);
      expect(f.executed[0]?.sql).toBe(
        'insert into `session_revocation_commands` (`id`, `user_id`, `actor_type`, `actor_id`, `actor_display`, `context`, `created_at`, `result`, `delivered_at`) values (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      );
      expect(f.executed[0]?.parameters).toEqual([
        idBytes(command.id),
        idBytes(UserId.parse(command.userId)),
        'user',
        idBytes(UserId.parse(command.userId)),
        'operator',
        JSON.stringify(command.context),
        f.clock.date(),
        null,
        null,
      ]);
      expect(f.lifecycle).not.toContain('begin');
      expect(f.audit).toEqual([]);
      await expect(f.store.pending()).resolves.toEqual(command);
      expect(f.executed.at(-1)?.sql).toContain(
        'where `delivered_at` is null order by `created_at`, `id` limit ?',
      );
      expect(f.executed.at(-1)?.parameters).toEqual([1]);
      f.state.result = { ok: false };
      f.state.deliveredAt = f.clock.date();
      await expect(f.store.find(command.id)).resolves.toEqual({
        ...command,
        result: { ok: false },
        delivered: true,
      });
      expect(f.executed.at(-1)?.parameters).toEqual([idBytes(command.id)]);
    } finally {
      await f.close();
    }
  });

  it.each(['user', 'server'] as const)(
    'revokes %s scope under the owner and user locks, bumps affected epochs once, and audits the durable result last',
    async (scope) => {
      const base = fixture().command;
      const first = UserId.parse('019948c4-0000-7000-8000-000000000001');
      const second = UserId.parse('019948c4-0000-7000-8000-000000000002');
      const firstSessions = [newId(), newId()];
      const secondSessions = [newId()];
      const command = { ...base, userId: scope === 'user' ? first : null };
      const f = await storeFixture(
        command,
        new Map([
          [second, secondSessions],
          [first, firstSessions],
        ]),
      );
      const sessions = firstSessions.map((sessionId) => ({ userId: first, sessionId }));
      if (scope === 'server')
        sessions.push(...secondSessions.map((sessionId) => ({ userId: second, sessionId })));
      const result = { ok: true, users: scope === 'server' ? 2 : 1, sessions };
      try {
        await expect(f.store.execute(command)).resolves.toEqual(result);
        expect(f.executed[0]?.sql).toContain('from `collab_owner_fence`');
        expect(f.executed[1]?.sql).toContain(
          'from `session_revocation_commands` where `id` = ? for update',
        );
        expect(f.executed[1]?.parameters).toEqual([idBytes(command.id)]);
        const parents = f.executed.filter(
          (query) => query.sql === 'select `id` from `users` where `id` = ? for update',
        );
        expect(parents.map((query) => query.parameters)).toEqual(
          (scope === 'server' ? [first, second] : [first]).map((id) => [idBytes(id)]),
        );
        const revoked = f.executed.filter((query) => query.sql.startsWith('update `sessions`'));
        expect(revoked.map((query) => query.parameters)).toEqual(
          (scope === 'server' ? [firstSessions, secondSessions] : [firstSessions]).map((ids) => {
            const parameters: unknown[] = [f.clock.date(), 'admin'];
            parameters.push(...ids.map(idBytes));
            return parameters;
          }),
        );
        expect(revoked.every((query) => query.sql.endsWith('and `revoked_at` is null'))).toBe(true);
        const epochs = f.executed.filter((query) => query.sql.startsWith('update `users`'));
        expect(epochs.map((query) => query.parameters)).toEqual(
          (scope === 'server' ? [first, second] : [first]).map((id) => [
            f.clock.date(),
            idBytes(id),
          ]),
        );
        expect(
          epochs.every((query) => query.sql.includes('`authz_version` = authz_version + 1')),
        ).toBe(true);
        expect(f.executed.at(-1)?.parameters).toEqual([
          JSON.stringify(result),
          idBytes(command.id),
        ]);
        expect(f.audit).toEqual([
          {
            action: 'session.revoked_all',
            ...command.actor,
            credentialType: 'cli',
            ...(scope === 'user' ? { targetType: 'user', targetId: first } : {}),
            targets: sessions.map(({ sessionId }) => ({ type: 'session', id: sessionId })),
            outcome: 'success',
            reason: 'admin',
            context: command.context,
            metadata: { scope, users: result.users, revoked: sessions.length },
          },
        ]);
        expect(f.lifecycle).toEqual(['acquire', 'begin', 'commit', 'release']);
        expect(f.isolationLevels).toEqual(['read committed']);
      } finally {
        await f.close();
      }
    },
  );

  it('records an empty user sweep without inventing a session or bumping that user epoch', async () => {
    const command = fixture().command;
    const f = await storeFixture(command);
    try {
      await expect(f.store.execute(command)).resolves.toEqual({ ok: true, users: 1, sessions: [] });
      expect(
        f.executed.some(
          (query) =>
            query.sql.startsWith('update `users`') || query.sql.startsWith('update `sessions`'),
        ),
      ).toBe(false);
      expect(f.audit[0]).toMatchObject({
        metadata: { scope: 'user', users: 1, revoked: 0 },
        targets: [],
      });
    } finally {
      await f.close();
    }
  });

  it.each(['execute', 'resolve'] as const)(
    '%s reuses the locked durable result instead of repeating mutations or audit',
    async (method) => {
      const base = fixture();
      const f = await storeFixture({ ...base.command, result: base.result });
      try {
        await expect(f.store[method](base.command)).resolves.toEqual(base.result);
        expect(f.executed).toHaveLength(2);
        expect(f.executed[1]?.sql).toContain('for update');
        expect(f.audit).toEqual([]);
        expect(f.lifecycle).toEqual(['acquire', 'begin', 'commit', 'release']);
      } finally {
        await f.close();
      }
    },
  );

  it('proves rollback with a locking read and durable false result before acknowledging a command', async () => {
    const command = fixture().command;
    const f = await storeFixture(command);
    try {
      await expect(f.store.resolve(command)).resolves.toEqual({ ok: false });
      expect(f.executed[1]?.sql).toContain('for update');
      expect(f.executed[2]).toEqual({
        sql: 'update `session_revocation_commands` set `result` = ? where `id` = ?',
        parameters: [JSON.stringify({ ok: false }), idBytes(command.id)],
      });
      expect(f.audit).toEqual([]);
      await f.store.markDelivered(command.id);
      expect(f.executed.at(-2)?.sql).toContain('from `collab_owner_fence`');
      expect(f.executed.at(-1)).toEqual({
        sql: 'update `session_revocation_commands` set `delivered_at` = ? where `id` = ? and `result` is not null',
        parameters: [f.clock.date(), idBytes(command.id)],
      });
    } finally {
      await f.close();
    }
  });

  it('rolls back if the audit sink fails, and never starts command SQL after an owner replacement', async () => {
    const command = fixture().command;
    const f = await storeFixture(command);
    try {
      f.state.auditError = new Error('audit sink unavailable');
      await expect(f.store.execute(command)).rejects.toBe(f.state.auditError);
      expect(f.lifecycle).toEqual(['acquire', 'begin', 'rollback', 'release']);
      const before = f.executed.length;
      f.replaceOwner();
      await expect(f.store.markDelivered(command.id)).rejects.toBeInstanceOf(CollabOwnershipLost);
      expect(f.executed.slice(before)).toHaveLength(1);
      expect(f.executed.at(-1)?.sql).toContain('from `collab_owner_fence`');
    } finally {
      await f.close();
    }
  });

  it('wires server readiness, the post-commit delay, delivery errors and both shutdown paths to the relay', async () => {
    const lines: string[] = [];
    const configSource = await buildWithoutDatabase();
    const clock = new ManualClock();
    const logger = createLogger({
      level: 'error',
      format: 'json',
      instanceId: 'session-command-unit',
      destination: {
        write: (line: string) => {
          lines.push(line);
        },
      },
    });
    const app = await buildApp({
      mode: 'in-process',
      database: 'none',
      clock,
      logger,
      config: configSource.app.iridiumConfig,
    });
    const { relay, store } = app.authz.sessionCommands;
    const start = vi.spyOn(relay, 'start');
    const stop = vi.spyOn(relay, 'stop');
    const drain = vi.spyOn(app, 'onDrain');
    try {
      await app.ready();
      expect(start).toHaveBeenCalledOnce();
      expect(drain).toHaveBeenCalledWith(
        expect.objectContaining({ phase: 'jobs', name: 'authz.stop-session-commands' }),
      );
      vi.spyOn(app.collab.ownerLease, 'held', 'get').mockReturnValue(true);
      const discoveryError = new Error('command discovery unavailable');
      const pending = vi.spyOn(store, 'pending').mockRejectedValueOnce(discoveryError);
      await relay.poll();
      expect(lines).toContainEqual(
        expect.stringContaining('"event":"authz.revocation.delivery_failed"'),
      );
      expect(lines).toContainEqual(
        expect.stringContaining('session command outcome or delivery remains pending'),
      );
      expect(lines).toContainEqual(expect.stringContaining('command discovery unavailable'));
      const f = fixture();
      pending.mockResolvedValue({ ...f.command, result: f.result });
      vi.spyOn(store, 'markDelivered').mockResolvedValue(undefined);
      const delay = vi.spyOn(app.faults, 'delay');
      const delivered: unknown[] = [];
      const unsubscribe = app.authz.bus.subscribe((event) => {
        delivered.push(event);
      });
      await relay.poll();
      unsubscribe();
      expect(delay).toHaveBeenCalledWith('auth.command-after-commit');
      expect(delivered).toEqual(
        f.result.ok
          ? f.result.sessions.map((entry) => ({
              type: 'session.revoked',
              userId: entry.userId,
              sessionId: entry.sessionId,
              reason: 'admin',
            }))
          : [],
      );
      await app.drain();
      expect(stop).toHaveBeenCalledOnce();
      await app.close();
      expect(stop).toHaveBeenCalledTimes(2);
      expect(clock.pendingTimers).toBe(0);
    } finally {
      vi.restoreAllMocks();
      await app.close();
      await configSource.close();
    }
  });

  it('a CLI boot adds no relay timer or lease and shutdown cancels every owned timer', async () => {
    const configSource = await buildWithoutDatabase();
    const clock = new ManualClock();
    const cli = await buildApp({
      mode: 'in-process',
      role: 'cli',
      database: 'none',
      clock,
      config: configSource.app.iridiumConfig,
    });
    try {
      const beforeReady = clock.pendingTimers;
      await cli.ready();
      expect(clock.pendingTimers).toBe(beforeReady);
      expect(cli.collab.ownerLease.held).toBe(false);
      await cli.drain();
    } finally {
      await cli.close();
      await configSource.close();
    }
    expect(clock.pendingTimers).toBe(0);
  });
});
