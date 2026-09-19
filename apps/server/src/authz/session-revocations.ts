/**
 * Durable operator commands, executed where the live collaboration connections are owned. The CLI
 * enqueues intent; it never commits a revocation behind the serving process's epoch table. A local
 * fence precedes the transaction, whose result and final audit commit with the session changes.
 * Unknown COMMIT outcomes keep that fence until a fresh locking read proves the durable result.
 */
import { idFromBytes, SessionId, UserId, type UserId as UserIdValue } from '@iridium/contracts';
import type { FastifyInstance } from 'fastify';
import type { Kysely, Selectable, Transaction } from 'kysely';

import type { AuditEventContext, AuditEventInput, AuditWriter } from '../audit/chain.ts';
import { idBytes, userIdFromBytes } from '../auth/ids.ts';
import { KyselySessionRepository } from '../auth/sessions/repository.ts';
import { revokeUserSessions } from '../auth/sessions/revoke.ts';
import type { CollabOwnerLease } from '../collab/owner-lease.ts';
import type {
  Database,
  SessionRevocationCommandResult,
  SessionRevocationCommandsTable,
} from '../db/schema.ts';
import type { Clock, TimerHandle } from '../ops/clock.ts';
import { bumpAuthzVersion } from '../vaults/service.ts';
import { AuthzStoreUnavailableError } from './authorize.ts';
import type { AuthzEvent } from './bus.ts';
import type { SessionCommandFence } from './session-command-fence.ts';

export type SessionRevocation = Extract<AuthzEvent, { type: 'session.revoked' }>;
export type SessionCommandResult = SessionRevocationCommandResult;

/** Internal command-discovery cadence; it adds no database read to message admission. */
export const SESSION_REVOCATION_POLL_MS = 250;

export interface SessionCommandRequest {
  readonly id: string;
  /** Null means all users holding sessions at execution, not a stale list captured by the CLI. */
  readonly userId: UserIdValue | null;
  readonly actor: Pick<AuditEventInput, 'actorType' | 'actorId' | 'actorDisplay'>;
  readonly context: AuditEventContext;
}

export interface SessionCommand extends SessionCommandRequest {
  readonly result: SessionCommandResult | null;
  readonly delivered: boolean;
}

/** Database seam: resolution must lock the same row the revoking transaction held through COMMIT. */
export interface SessionCommandStore {
  pending(): Promise<SessionCommand | null>;
  execute(command: SessionCommand): Promise<SessionCommandResult>;
  resolve(command: SessionCommand): Promise<SessionCommandResult>;
  markDelivered(commandId: string): Promise<void>;
}

interface StoreOptions {
  readonly database: () => Kysely<Database> | null;
  readonly owner: () => Pick<CollabOwnerLease, 'captureGeneration' | 'assertCurrent'>;
  readonly audit: () => Pick<AuditWriter, 'record'>;
  readonly clock: Clock;
}

function fromRow(row: Selectable<SessionRevocationCommandsTable>): SessionCommand {
  return {
    id: idFromBytes(row.id),
    userId: row.user_id === null ? null : userIdFromBytes(row.user_id),
    actor: {
      actorType: row.actor_type,
      actorId: row.actor_id === null ? null : idFromBytes(row.actor_id),
      actorDisplay: row.actor_display,
    },
    context: row.context,
    result: row.result,
    delivered: row.delivered_at !== null,
  };
}

/** All command SQL; a result is durable evidence, never an inference from a lost driver response. */
export class KyselySessionCommandStore implements SessionCommandStore {
  readonly #options: StoreOptions;

  constructor(options: StoreOptions) {
    this.#options = options;
  }

  /** Only intent is committed here. The serving owner performs every authorization mutation. */
  async submit(request: SessionCommandRequest): Promise<void> {
    await this.#db()
      .insertInto('session_revocation_commands')
      .values({
        id: idBytes(request.id),
        user_id: request.userId === null ? null : idBytes(request.userId),
        actor_type: request.actor.actorType,
        actor_id: request.actor.actorId == null ? null : idBytes(request.actor.actorId),
        actor_display: request.actor.actorDisplay ?? null,
        context: JSON.stringify(request.context),
        created_at: this.#options.clock.date(),
        result: null,
        delivered_at: null,
      })
      .execute();
  }

  async find(commandId: string): Promise<SessionCommand | null> {
    const row = await this.#db()
      .selectFrom('session_revocation_commands')
      .selectAll()
      .where('id', '=', idBytes(commandId))
      .executeTakeFirst();
    return row === undefined ? null : fromRow(row);
  }

  async pending(): Promise<SessionCommand | null> {
    // Serializing commands cannot delay an already-committed revocation: discovery precedes the
    // authorization transaction. All sessions in one global command are still swept on one tick.
    const row = await this.#db()
      .selectFrom('session_revocation_commands')
      .selectAll()
      .where('delivered_at', 'is', null)
      .orderBy('created_at')
      .orderBy('id')
      .limit(1)
      .executeTakeFirst();
    return row === undefined ? null : fromRow(row);
  }

  async execute(command: SessionCommand): Promise<SessionCommandResult> {
    return this.#transaction(async (trx) => {
      const row = await this.#lock(trx, command.id);
      if (row.result !== null) return row.result;
      const targets =
        command.userId === null
          ? (
              await trx
                .selectFrom('sessions')
                .select('user_id')
                .distinct()
                .where('revoked_at', 'is', null)
                .execute()
            ).map((entry) => userIdFromBytes(entry.user_id))
          : [command.userId];
      const repository = new KyselySessionRepository(trx);
      const sessions: { readonly userId: string; readonly sessionId: string }[] = [];
      const now = this.#options.clock.date();
      for (const userId of targets.toSorted()) {
        // User PK before session rows, matching password/admin mutations. Global commands acquire
        // users in one deterministic order; the audit head remains the final lock.
        // eslint-disable-next-line no-await-in-loop -- parent before its sessions
        await trx
          .selectFrom('users')
          .select('id')
          .where('id', '=', idBytes(userId))
          .forUpdate()
          .executeTakeFirstOrThrow();
        // eslint-disable-next-line no-await-in-loop -- one user's sessions under that parent lock
        const ids = await revokeUserSessions(repository, userId, 'admin', now.getTime());
        if (ids.length > 0) {
          // eslint-disable-next-line no-await-in-loop -- one epoch bump per affected user
          await bumpAuthzVersion(trx, idBytes(userId), now);
        }
        for (const sessionId of ids) sessions.push({ userId, sessionId });
      }
      const result: SessionCommandResult = { ok: true, users: targets.length, sessions };
      await trx
        .updateTable('session_revocation_commands')
        .set({ result: JSON.stringify(result) })
        .where('id', '=', idBytes(command.id))
        .execute();
      // Last statement: result, epochs and sessions are already in the same transaction.
      await this.#options.audit().record(trx, {
        action: 'session.revoked_all',
        ...command.actor,
        credentialType: 'cli',
        ...(command.userId === null ? {} : { targetType: 'user', targetId: command.userId }),
        targets: sessions.map((entry) => ({ type: 'session', id: entry.sessionId })),
        outcome: 'success',
        reason: 'admin',
        context: command.context,
        metadata: {
          scope: command.userId === null ? 'server' : 'user',
          users: targets.length,
          revoked: sessions.length,
        },
      });
      return result;
    });
  }

  async resolve(command: SessionCommand): Promise<SessionCommandResult> {
    return this.#transaction(async (trx) => {
      // FOR UPDATE waits for the earlier transaction to end, then reads its latest result. A
      // nonlocking SELECT returning null could race a still-committing transaction and is unsafe.
      const row = await this.#lock(trx, command.id);
      if (row.result !== null) return row.result;
      const result: SessionCommandResult = { ok: false };
      await trx
        .updateTable('session_revocation_commands')
        .set({ result: JSON.stringify(result) })
        .where('id', '=', idBytes(command.id))
        .execute();
      return result;
    });
  }

  async markDelivered(commandId: string): Promise<void> {
    await this.#transaction(async (trx) => {
      await trx
        .updateTable('session_revocation_commands')
        .set({ delivered_at: this.#options.clock.date() })
        .where('id', '=', idBytes(commandId))
        .where('result', 'is not', null)
        .execute();
    });
  }

  async #lock(trx: Transaction<Database>, id: string) {
    return trx
      .selectFrom('session_revocation_commands')
      .selectAll()
      .where('id', '=', idBytes(id))
      .forUpdate()
      .executeTakeFirstOrThrow();
  }

  async #transaction<T>(work: (trx: Transaction<Database>) => Promise<T>): Promise<T> {
    const owner = this.#options.owner();
    const generation = owner.captureGeneration();
    return this.#db()
      .transaction()
      .setIsolationLevel('read committed')
      .execute(async (trx) => {
        // First statement, shared through COMMIT: a replacement owner cannot pass an unfinished
        // transaction, and an obsolete process cannot mutate after the generation changed.
        await owner.assertCurrent(trx, generation);
        return work(trx);
      });
  }

  #db(): Kysely<Database> {
    const db = this.#options.database();
    if (db === null) throw new AuthzStoreUnavailableError();
    return db;
  }
}

export interface SessionCommandRelayOptions {
  readonly clock: Clock;
  readonly store: SessionCommandStore;
  readonly fence: SessionCommandFence;
  readonly ownsCollaboration: () => boolean;
  readonly settleWrites: (userId: UserIdValue | null) => Promise<void>;
  readonly deliver: (event: SessionRevocation) => Promise<boolean>;
  readonly beforeDelivery: () => Promise<void>;
  readonly onError: (error: unknown) => void;
}

interface ActiveCommand {
  readonly command: SessionCommand;
  result: SessionCommandResult | null;
  uncertain: boolean;
}

/** One owned command at a time; shutdown joins work and never releases an uncertain fence. */
export class SessionCommandRelay {
  readonly #options: SessionCommandRelayOptions;
  #timer: TimerHandle | null = null;
  #running: Promise<void> | null = null;
  #active: ActiveCommand | null = null;
  #stopped = false;

  constructor(options: SessionCommandRelayOptions) {
    this.#options = options;
  }

  start(): void {
    if (this.#stopped || this.#timer !== null) return;
    this.#timer = this.#options.clock.every(SESSION_REVOCATION_POLL_MS, () => {
      void this.poll();
    });
  }

  poll(): Promise<void> {
    if (this.#stopped || !this.#options.ownsCollaboration()) return Promise.resolve();
    this.#running ??= this.#turn()
      .catch(this.#options.onError)
      .finally(() => {
        this.#running = null;
      });
    return this.#running;
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#timer?.cancel();
    this.#timer = null;
    await this.#running;
  }

  async #execute(command: SessionCommand): Promise<SessionCommandResult> {
    await this.#options.settleWrites(command.userId);
    return this.#options.store.execute(command);
  }

  async #turn(): Promise<void> {
    const { store, fence, ownsCollaboration, deliver } = this.#options;
    if (this.#active === null) {
      const command = await store.pending();
      if (command === null || this.#stopped || !ownsCollaboration()) return;
      this.#active = { command, result: command.result, uncertain: false };
    }
    const active = this.#active;
    fence.begin(active.command.id, active.command.userId);
    if (active.result === null) {
      try {
        active.result = active.uncertain
          ? await store.resolve(active.command)
          : await this.#execute(active.command);
      } catch (error) {
        active.uncertain = true;
        throw error;
      }
    }
    if (active.result.ok) {
      await this.#options.beforeDelivery();
      const outcomes = await Promise.allSettled(
        active.result.sessions.map(async (entry) =>
          deliver({
            type: 'session.revoked',
            userId: UserId.parse(entry.userId),
            sessionId: SessionId.parse(entry.sessionId),
            reason: 'admin',
          }),
        ),
      );
      if (outcomes.some((outcome) => outcome.status === 'rejected' || !outcome.value)) {
        throw new Error(
          'A session revocation subscriber failed; the command remains fenced for retry.',
        );
      }
    }
    // A confirmed rollback resumes waiters without publishing or closing anything. A committed
    // result reaches every subscriber before this edge; a later acknowledgement error is replayable.
    fence.finish(active.command.id);
    this.#active = null;
    await store.markDelivered(active.command.id);
  }
}

export interface SessionCommandServices {
  readonly store: KyselySessionCommandStore;
  readonly relay: SessionCommandRelay;
}

/** Called during authz boot; dependencies registered later are resolved only by the ready process. */
export function createSessionCommandServices(
  app: FastifyInstance,
  fence: SessionCommandFence,
): SessionCommandServices {
  const store = new KyselySessionCommandStore({
    database: () => app.database.dbApp,
    owner: () => app.collab.ownerLease,
    audit: () => app.audit,
    clock: app.clock,
  });
  const relay = new SessionCommandRelay({
    clock: app.clock,
    store,
    fence,
    ownsCollaboration: () => app.collab.ownerLease.held,
    settleWrites: (userId) => app.collab.persistence.drainForUser(userId),
    deliver: (event) => app.authz.bus.publishAndWait(event),
    beforeDelivery: () => app.faults.delay('auth.command-after-commit'),
    onError: (error) =>
      app.log.error(
        { err: error, event: 'authz.revocation.delivery_failed' },
        'session command outcome or delivery remains pending',
      ),
  });
  app.addHook('onReady', async () => {
    if (app.role !== 'server') return;
    relay.start();
    app.onDrain({ phase: 'jobs', name: 'authz.stop-session-commands', run: () => relay.stop() });
  });
  app.addHook('onClose', () => relay.stop());
  return { store, relay };
}
