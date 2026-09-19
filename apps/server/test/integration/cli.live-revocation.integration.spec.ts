import { idFromBytes, newId, UserId } from '@iridium/contracts';
import { projectMarkdown } from '@iridium/crdt';
/** A separately spawned operator CLI must invalidate the actual serving process's sockets. */
import {
  assertSchemaName,
  corruptMysqlDeliberately,
  FAULT,
  type NoteClient,
} from '@iridium/testkit';
import { describe, expect, it } from 'vitest';

import { idBytes } from '../../src/auth/ids.ts';
import {
  SESSION_REVOCATION_POLL_MS,
  type SessionCommand,
} from '../../src/authz/session-revocations.ts';
import { startCollab, type CollabHarness } from '../support/collab-harness.ts';
import { ManualClock } from '../support/manual-clock.ts';

function database(harness: CollabHarness) {
  const db = harness.application().database.dbApp;
  if (db === null) throw new Error('The live regression requires its application database.');
  return db;
}

function closing(client: NoteClient) {
  return client.waitClosed({ timeoutMs: 30_000 }).then((close) => ({ close, at: Date.now() }));
}

async function lastRevocationAt(harness: CollabHarness): Promise<number> {
  const row = await database(harness)
    .selectFrom('audit_events')
    .select('occurred_at')
    .where('action', '=', 'session.revoked_all')
    .orderBy('id', 'desc')
    .executeTakeFirstOrThrow();
  // The audit statement is last in the transaction, immediately before COMMIT. This is a
  // conservative deadline: measuring from its occurred_at includes that final database round trip.
  return row.occurred_at.getTime();
}

async function lastCommand(harness: CollabHarness): Promise<SessionCommand> {
  const row = await database(harness)
    .selectFrom('session_revocation_commands')
    .select('id')
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .executeTakeFirstOrThrow();
  const command = await harness.application().authz.sessionCommands.store.find(idFromBytes(row.id));
  if (command === null) throw new Error('The durable operator command disappeared.');
  return command;
}

async function expectDelivered(harness: CollabHarness): Promise<void> {
  const command = await lastCommand(harness);
  expect(command.delivered).toBe(true);
  expect(command.result?.ok).toBe(true);
  expect(await harness.application().authz.sessionCommands.store.pending()).toBeNull();
}

async function userEpoch(harness: CollabHarness, userId: string): Promise<number> {
  const row = await database(harness)
    .selectFrom('users')
    .select('authz_version')
    .where('id', '=', idBytes(userId))
    .executeTakeFirstOrThrow();
  return row.authz_version;
}

const FAST_PASSWORDS = { ARGON2_MEMORY_KIB: '8192', ARGON2_TIME_COST: '1' };

describe('cli.live-revocation.integration [area:authz] [spec:live-revocation] [hp:HP-3]', () => {
  it('closes every targeted live connection within one second and leaves another user writable', async () => {
    const harness = await startCollab({ extraEnv: FAST_PASSWORDS });
    try {
      const cast = await harness.server.seed.kernel();
      const second = await harness.server.seed.note({
        vault: cast.vault,
        name: 'Second',
        admin: cast.admin,
      });
      const [first, otherNote, observer] = await Promise.all([
        harness.open(cast.editorA, cast.note.id),
        harness.open(cast.editorA, second.id),
        harness.open(cast.editorB, cast.note.id),
      ]);
      await Promise.all([
        first.waitFor('saved'),
        otherNote.waitFor('saved'),
        observer.waitFor('saved'),
      ]);
      const targetEpoch = await userEpoch(harness, cast.editorA.id);
      const unaffectedEpoch = await userEpoch(harness, cast.editorB.id);
      const firstClosed = closing(first);
      const otherClosed = closing(otherNote);
      const command = await harness.server.cli([
        'sessions',
        'revoke-all',
        '--user',
        cast.editorA.email,
      ]);
      expect({ code: command.code, stderr: command.code === 0 ? '' : command.stderr }).toEqual({
        code: 0,
        stderr: '',
      });
      const closed = await Promise.all([firstClosed, otherClosed]);
      const committedAt = await lastRevocationAt(harness);
      for (const item of closed) {
        expect(item.close.collabReason).toBe('revoked');
        expect(item.at - committedAt).toBeLessThanOrEqual(1_000);
      }
      const marker = observer.marker('unaffected-by-cli-user-revocation');
      await observer.waitFor('saved');
      expect((await harness.committed(cast.note.id)).text).toContain(marker);
      expect(observer.closes).toEqual([]);
      expect(await userEpoch(harness, cast.editorA.id)).toBe(targetEpoch + 1);
      expect(await userEpoch(harness, cast.editorB.id)).toBe(unaffectedEpoch);
      expect(
        (await harness.server.cli(['sessions', 'revoke-all', '--user', cast.editorA.email])).code,
      ).toBe(0);
      expect(await userEpoch(harness, cast.editorA.id)).toBe(targetEpoch + 1);
      expect((await (await harness.server.loginAs(cast.editorA)).get('/auth/me')).status).toBe(401);
      await expectDelivered(harness);
    } finally {
      await harness.close();
    }
  }, 120_000);

  it('delivers a global CLI revoke to all open users and documents in one poll cohort', async () => {
    const harness = await startCollab({ extraEnv: FAST_PASSWORDS });
    try {
      const cast = await harness.server.seed.kernel();
      const second = await harness.server.seed.note({
        vault: cast.vault,
        name: 'Global',
        admin: cast.admin,
      });
      const actors = [cast.admin, cast.editorA, cast.editorB, cast.editorC, cast.viewer];
      const clients = await Promise.all(
        actors.flatMap((actor) =>
          [cast.note.id, second.id].map((noteId) =>
            harness.open(actor, noteId, {
              role: actor === cast.viewer ? 'viewer' : actor === cast.admin ? 'manager' : 'editor',
            }),
          ),
        ),
      );
      await Promise.all(
        clients.map((client) =>
          client.waitFor(client.userId === cast.viewer.id ? 'read-only' : 'saved'),
        ),
      );
      const epochs = await Promise.all(actors.map((actor) => userEpoch(harness, actor.id)));
      const outsiderEpoch = await userEpoch(harness, cast.outsider.id);
      const closed = clients.map(closing);
      const command = await harness.server.cli(['sessions', 'revoke-all']);
      expect({ code: command.code, stderr: command.code === 0 ? '' : command.stderr }).toEqual({
        code: 0,
        stderr: '',
      });
      const committedAt = await lastRevocationAt(harness);
      for (const item of await Promise.all(closed)) {
        expect(item.close.collabReason).toBe('revoked');
        expect(item.at - committedAt).toBeLessThanOrEqual(1_000);
      }
      await expectDelivered(harness);
      expect(await Promise.all(actors.map((actor) => userEpoch(harness, actor.id)))).toEqual(
        epochs.map((epoch) => epoch + 1),
      );
      expect(await userEpoch(harness, cast.outsider.id)).toBe(outsiderEpoch);
      expect(
        await database(harness)
          .selectFrom('sessions')
          .select('id')
          .where('revoked_at', 'is', null)
          .execute(),
      ).toEqual([]);
    } finally {
      await harness.close();
    }
  }, 120_000);

  it('keeps hostile updates fenced after actual COMMIT while live delivery is deliberately delayed', async () => {
    const clock = new ManualClock();
    const harness = await startCollab({ clock, extraEnv: FAST_PASSWORDS });
    try {
      const cast = await harness.server.seed.kernel();
      const [client, observer] = await Promise.all([
        harness.open(cast.editorA, cast.note.id, { flushDelayMs: false }),
        harness.open(cast.editorB, cast.note.id),
      ]);
      await Promise.all([client.waitFor('saved'), observer.waitFor('saved')]);
      await harness.server.faults.arm(FAULT.authCommandAfterCommit, { arg: 5_000 });
      const executing = harness.server.cli([
        'sessions',
        'revoke-all',
        '--user',
        cast.editorA.email,
      ]);
      await expect
        .poll(() => harness.application().authz.sessionCommands.store.pending(), {
          timeout: 15_000,
        })
        .not.toBeNull();
      // Intent discovery is not revocation: this accepted edit must finish before auth COMMIT.
      const accepted = client.marker('accepted-before-command-execution');
      await client.waitFor('saved');
      await clock.advance(SESSION_REVOCATION_POLL_MS);
      await expect
        .poll(() =>
          harness.logs.some(
            (line) => line.includes('fault.fired') && line.includes(FAULT.authCommandAfterCommit),
          ),
        )
        .toBe(true);
      const command = await lastCommand(harness);
      expect(command.result?.ok).toBe(true); // Independent SQL can see the committed result.
      expect(command.delivered).toBe(false);
      expect(harness.application().authz.sessionFence.blocked(UserId.parse(cast.editorA.id))).toBe(
        true,
      );
      expect(client.closes).toEqual([]); // The adverse delivery window is still open on the wire.
      const hostile = client.marker('hostile-after-revocation-commit');
      const barrier = observer.waitForAck();
      observer.sendStateless({ v: 1, t: 'baseline' });
      await barrier;
      const live = harness
        .application()
        .collab.server.hocuspocus.documents.get(client.documentName);
      if (live === undefined) throw new Error('The attacked document must still be loaded.');
      expect(projectMarkdown(live)).not.toContain(hostile);
      const during = await harness.committed(cast.note.id);
      expect(during.text).toContain(accepted);
      expect(during.text).not.toContain(hostile);
      const closed = closing(client);
      await clock.advance(5_000);
      expect((await closed).close.collabReason).toBe('revoked');
      expect((await executing).code).toBe(0);
      await expectDelivered(harness);
      const unaffected = observer.marker('other-user-after-delivery');
      await observer.waitFor('saved');
      const final = await harness.committed(cast.note.id);
      expect(final.text).toContain(unaffected);
      expect(final.text).not.toContain(hostile);
      expect(observer.text.toJSON()).not.toContain(hostile);
    } finally {
      await harness.close();
    }
  }, 120_000);

  it('rolls back sessions, epochs and result when the final audit INSERT is refused, without falsely closing a socket', async () => {
    const clock = new ManualClock();
    const harness = await startCollab({ clock, extraEnv: FAST_PASSWORDS });
    const schema = harness.server.schema;
    assertSchemaName(schema);
    try {
      const cast = await harness.server.seed.kernel();
      const client = await harness.open(cast.editorA, cast.note.id);
      await client.waitFor('saved');
      const beforeEpoch = await userEpoch(harness, cast.editorA.id);
      const app = harness.application();
      const id = newId();
      await app.authz.sessionCommands.store.submit({
        id,
        userId: UserId.parse(cast.editorA.id),
        actor: { actorType: 'system' },
        context: {},
      });
      // A real schema-scoped permission failure occurs at the required final audit statement.
      await corruptMysqlDeliberately(harness.sql, {
        kind: 'audit-insert-privilege',
        schema,
        granted: false,
      });
      try {
        await app.authz.sessionCommands.relay.poll();
      } finally {
        await corruptMysqlDeliberately(harness.sql, {
          kind: 'audit-insert-privilege',
          schema,
          granted: true,
        });
      }
      expect(app.authz.sessionFence.blocked(UserId.parse(cast.editorA.id))).toBe(true);
      expect((await app.authz.sessionCommands.store.find(id))?.result).toBeNull();
      await app.authz.sessionCommands.relay.poll(); // A locking read proves rollback before release.
      expect(await app.authz.sessionCommands.store.find(id)).toMatchObject({
        result: { ok: false },
        delivered: true,
      });
      expect(await userEpoch(harness, cast.editorA.id)).toBe(beforeEpoch);
      expect(
        await database(harness)
          .selectFrom('audit_events')
          .select('id')
          .where('action', '=', 'session.revoked_all')
          .execute(),
      ).toEqual([]);
      const marker = client.marker('authorized-after-command-rollback');
      await client.waitFor('saved');
      expect((await harness.committed(cast.note.id)).text).toContain(marker);
      expect(client.closes).toEqual([]);
    } finally {
      await harness.close();
    }
  }, 120_000);

  it('retains failed fan-out and replays its durable result after the owning application restarts', async () => {
    const clock = new ManualClock();
    const original = await startCollab({ clock, extraEnv: FAST_PASSWORDS });
    let restarted: CollabHarness | null = null;
    let originalClosed = false;
    try {
      const cast = await original.server.seed.kernel();
      const client = await original.open(cast.editorA, cast.note.id);
      await client.waitFor('saved');
      const app = original.application();
      const beforeEpoch = await userEpoch(original, cast.editorA.id);
      app.authz.bus.subscribe(async (event) => {
        if (event.type === 'session.revoked') throw new Error('retry this durable delivery');
      });
      const id = newId();
      await app.authz.sessionCommands.store.submit({
        id,
        userId: UserId.parse(cast.editorA.id),
        actor: { actorType: 'system' },
        context: {},
      });
      const closed = closing(client);
      await app.authz.sessionCommands.relay.poll();
      expect((await closed).close.collabReason).toBe('revoked');
      expect(await app.authz.sessionCommands.store.find(id)).toMatchObject({
        result: { ok: true },
        delivered: false,
      });
      expect(app.authz.sessionFence.blocked(UserId.parse(cast.editorA.id))).toBe(true);
      await original.close();
      originalClosed = true;
      restarted = await startCollab({ clock, extraEnv: FAST_PASSWORDS });
      const next = restarted.application();
      await next.authz.sessionCommands.relay.poll();
      expect(await next.authz.sessionCommands.store.find(id)).toMatchObject({
        result: { ok: true },
        delivered: true,
      });
      expect(await userEpoch(restarted, cast.editorA.id)).toBe(beforeEpoch + 1);
      expect(
        await database(restarted)
          .selectFrom('audit_events')
          .select('id')
          .where('action', '=', 'session.revoked_all')
          .execute(),
      ).toHaveLength(1);
      expect(await next.authz.sessionCommands.store.pending()).toBeNull();
    } finally {
      await restarted?.close();
      if (!originalClosed) await original.close();
    }
  }, 120_000);

  it('acquires the schema owner lease and completes the same durable command while no server is running', async () => {
    const original = await startCollab({ extraEnv: FAST_PASSWORDS });
    let restarted: CollabHarness | null = null;
    let originalClosed = false;
    try {
      const cast = await original.server.seed.kernel();
      await original.server.sessions.current(cast.editorA);
      const before = await userEpoch(original, cast.editorA.id);
      await original.close();
      originalClosed = true;
      const command = await original.server.cli([
        'sessions',
        'revoke-all',
        '--user',
        cast.editorA.email,
      ]);
      expect({ code: command.code, stderr: command.code === 0 ? '' : command.stderr }).toEqual({
        code: 0,
        stderr: '',
      });
      restarted = await startCollab({ extraEnv: FAST_PASSWORDS });
      expect(await userEpoch(restarted, cast.editorA.id)).toBe(before + 1);
      await expectDelivered(restarted);
      expect(
        await database(restarted)
          .selectFrom('sessions')
          .select('id')
          .where('user_id', '=', idBytes(cast.editorA.id))
          .where('revoked_at', 'is', null)
          .execute(),
      ).toEqual([]);
    } finally {
      await restarted?.close();
      if (!originalClosed) await original.close();
    }
  }, 120_000);

  it('preserves the operator identity and replays an executed global command without repeating mutations or audit', async () => {
    const harness = await startCollab({ clock: new ManualClock(), extraEnv: FAST_PASSWORDS });
    try {
      const cast = await harness.server.seed.kernel();
      await harness.server.sessions.current(cast.editorA);
      const app = harness.application();
      const store = app.authz.sessionCommands.store;
      expect(await store.find(newId())).toBeNull();
      const id = newId();
      const actor = {
        actorType: 'user' as const,
        actorId: cast.admin.id,
        actorDisplay: 'Operator identity retained',
      };
      await store.submit({ id, userId: null, actor, context: {} });
      const command = await store.find(id);
      if (command === null) throw new Error('The submitted command must be recoverable by its id.');
      expect(command).toMatchObject({ id, userId: null, actor, result: null, delivered: false });
      await app.authz.sessionCommands.relay.poll();
      const completed = await store.find(id);
      expect(completed).toMatchObject({ delivered: true, result: { ok: true } });
      const epoch = await userEpoch(harness, cast.editorA.id);
      // An old request snapshot must consult the row under its lock, not execute the work again.
      await expect(store.execute(command)).resolves.toEqual(completed?.result);
      expect(await userEpoch(harness, cast.editorA.id)).toBe(epoch);
      const audit = await database(harness)
        .selectFrom('audit_events')
        .select(['actor_type', 'actor_id', 'actor_display'])
        .where('action', '=', 'session.revoked_all')
        .execute();
      expect(audit).toEqual([
        { actor_type: 'user', actor_id: idBytes(cast.admin.id), actor_display: actor.actorDisplay },
      ]);
      expect(await store.pending()).toBeNull();
    } finally {
      await harness.close();
    }
  }, 120_000);

  it.each(['commit', 'rollback'] as const)(
    'resolves an uncertain %s only after the original command row lock settles',
    async (outcome) => {
      const clock = new ManualClock();
      const harness = await startCollab({ clock, extraEnv: FAST_PASSWORDS });
      const locked = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      try {
        const cast = await harness.server.seed.kernel();
        const app = harness.application();
        const store = app.authz.sessionCommands.store;
        const id = newId();
        await store.submit({
          id,
          userId: UserId.parse(cast.editorA.id),
          actor: { actorType: 'system' },
          context: {},
        });
        const command = await store.find(id);
        if (command === null) throw new Error('Expected the submitted command.');
        const result = { ok: true, users: 1, sessions: [] } as const;
        const preceding = database(harness)
          .transaction()
          .execute(async (trx) => {
            await trx
              .selectFrom('session_revocation_commands')
              .select('id')
              .where('id', '=', idBytes(id))
              .forUpdate()
              .execute();
            await trx
              .updateTable('session_revocation_commands')
              .set({ result: JSON.stringify(result) })
              .where('id', '=', idBytes(id))
              .execute();
            locked.resolve();
            await release.promise;
            if (outcome === 'rollback') throw new Error('known rollback');
          })
          .then(
            () => null,
            (error: unknown) => error,
          );
        await locked.promise;
        let settled = false;
        const resolving = store.resolve(command).then((value) => {
          settled = true;
          return value;
        });
        const schema = harness.server.schema;
        assertSchemaName(schema);
        await expect
          .poll(async () => {
            const rows = await harness.sql
              .rows(`SELECT COUNT(*) FROM performance_schema.data_lock_waits waits
          JOIN performance_schema.data_locks locks ON locks.ENGINE_LOCK_ID=waits.REQUESTING_ENGINE_LOCK_ID
          WHERE locks.OBJECT_SCHEMA='${schema}' AND locks.OBJECT_NAME='session_revocation_commands';`);
            return Number(rows[0]?.[0]);
          })
          .toBeGreaterThan(0);
        expect(settled).toBe(false);
        release.resolve();
        expect(await preceding).toEqual(
          outcome === 'rollback' ? new Error('known rollback') : null,
        );
        expect(await resolving).toEqual(outcome === 'commit' ? result : { ok: false });
      } finally {
        release.resolve();
        await harness.close();
      }
    },
    120_000,
  );
});
