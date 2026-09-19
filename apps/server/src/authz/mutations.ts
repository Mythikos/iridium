/** Admission and durability barrier for serving-owner authorization mutations. */
import { newId, type UserId } from '@iridium/contracts';
import type { FastifyInstance } from 'fastify';
import type { IsolationLevel, Kysely, Transaction } from 'kysely';

import { idBytes } from '../auth/ids.ts';
import type { CollabOwnerLease, OwnerFence } from '../collab/owner-lease.ts';
import type { Database } from '../db/schema.ts';
import type { Clock, TimerHandle } from '../ops/clock.ts';
import { requireConnected } from '../rest/handler-context.ts';
import { ProblemError } from '../security/problem.ts';
import type { AuthzEvent } from './bus.ts';
import type { SessionCommandFence } from './session-command-fence.ts';

export interface AuthzMutationOptions {
  readonly userId: UserId;
  readonly isolation: IsolationLevel;
}

interface Dependencies {
  readonly database: () => Kysely<Database>;
  readonly owner: () => Pick<CollabOwnerLease, 'captureFence'>;
  readonly fence: Pick<SessionCommandFence, 'begin' | 'finish'>;
  readonly settleWrites: (userId: UserId) => Promise<void>;
  readonly deliver: (event: AuthzEvent) => Promise<boolean>;
  readonly clock: Clock;
  readonly revalidate: (userId: UserId) => Promise<void>;
  readonly uncertain: (operationId: string, userId: UserId, error: unknown) => void;
}

/**
 * A fence synchronously prevents Yjs apply before draining accepted updates. The owner-generation
 * shared lock is the first transaction statement; ordinary business locks and the final audit keep
 * their existing order. All fan-out finishes before admission resumes. A failed COMMIT response is
 * not proof of rollback: that user remains fenced until authoritative per-connection reconciliation.
 */
export class AuthzMutations {
  readonly #deps: Dependencies;
  readonly #pending = new Map<string, UserId>();
  readonly #active = new Set<Promise<unknown>>();
  #timer: TimerHandle | null = null;
  #recovering: Promise<void> | null = null;
  #stopped = false;

  constructor(deps: Dependencies) {
    this.#deps = deps;
  }

  /** Bind the original request admission, before password/auth/database awaits can lose ownership. */
  forOwner(owner: OwnerFence): AuthzMutationRunner {
    return { run: (options, work, eventsOf) => this.#start(owner, options, work, eventsOf) };
  }

  run<T>(
    options: AuthzMutationOptions,
    work: (trx: Transaction<Database>) => Promise<T>,
    eventsOf: (result: T) => readonly AuthzEvent[],
  ): Promise<T> {
    return this.#start(this.#deps.owner().captureFence(), options, work, eventsOf);
  }

  #start<T>(
    owner: OwnerFence,
    options: AuthzMutationOptions,
    work: (trx: Transaction<Database>) => Promise<T>,
    eventsOf: (result: T) => readonly AuthzEvent[],
  ): Promise<T> {
    if (this.#stopped)
      return Promise.reject(new ProblemError('unavailable', { detail: 'The server is closing.' }));
    const running = this.#run(owner, options, work, eventsOf).finally(() => {
      this.#active.delete(running);
    });
    this.#active.add(running);
    return running;
  }

  async #run<T>(
    owner: OwnerFence,
    options: AuthzMutationOptions,
    work: (trx: Transaction<Database>) => Promise<T>,
    eventsOf: (result: T) => readonly AuthzEvent[],
  ): Promise<T> {
    owner.assertActive();
    const operationId = newId();
    this.#deps.fence.begin(operationId, options.userId);
    let release = true;
    try {
      await this.#deps.settleWrites(options.userId);
      let events: readonly AuthzEvent[] = [];
      const result = await this.#deps
        .database()
        .transaction()
        .setIsolationLevel(options.isolation)
        .execute(async (trx) => {
          await owner.assertCurrent(trx);
          const value = await work(trx);
          events = eventsOf(value);
          // Kysely next sends COMMIT. A transport failure after this point has an unknown outcome.
          release = false;
          return value;
        });
      // Invoke every publication now; an asynchronous subscriber cannot delay another close sweep.
      const delivered = await Promise.allSettled(
        events.map(async (event) => this.#deps.deliver(event)),
      );
      if (!delivered.every((outcome) => outcome.status === 'fulfilled' && outcome.value)) {
        throw new ProblemError('unavailable', {
          detail: 'The authorization change committed, but its live connections remain fenced.',
        });
      }
      release = true;
      return result;
    } catch (error) {
      if (!release) {
        this.#pending.set(operationId, options.userId);
        this.#deps.uncertain(operationId, options.userId, error);
        this.#schedule();
      }
      throw error;
    } finally {
      if (release) this.#deps.fence.finish(operationId);
    }
  }

  /** One recovery turn, shared by the timer and shutdown's join. Never releases on an I/O failure. */
  recover(): Promise<void> {
    if (this.#stopped) return Promise.resolve();
    this.#timer?.cancel();
    this.#timer = null;
    this.#recovering ??= this.#recoverPending().finally(() => {
      this.#recovering = null;
      this.#schedule();
    });
    return this.#recovering;
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#timer?.cancel();
    this.#timer = null;
    await Promise.allSettled(this.#active);
    await this.#recovering;
  }

  #schedule(): void {
    if (this.#stopped || this.#timer !== null || this.#pending.size === 0) return;
    this.#timer = this.#deps.clock.after(AUTHZ_MUTATION_RETRY_MS, () => {
      this.#timer = null;
      void this.recover();
    });
  }

  async #recoverPending(): Promise<void> {
    await Promise.all(
      [...this.#pending].map(async ([operationId, userId]) => {
        try {
          const owner = this.#deps.owner().captureFence();
          await this.#deps
            .database()
            .transaction()
            .setIsolationLevel('read committed')
            .execute(async (trx) => {
              await owner.assertCurrent(trx);
              // Every mutation had already locked this user before attempting COMMIT. This locking
              // read waits for that transaction to end; a plain read could observe its older state.
              await trx
                .selectFrom('users')
                .select('id')
                .where('id', '=', idBytes(userId))
                .forUpdate()
                .executeTakeFirst();
            });
          // Each socket's session is checked independently, even if another socket reseeds an epoch.
          // Reads happen after the old transaction ended. No event is invented for a rolled-back write.
          await this.#deps.revalidate(userId);
          this.#pending.delete(operationId);
          this.#deps.fence.finish(operationId);
        } catch (error) {
          this.#deps.uncertain(operationId, userId, error);
        }
      }),
    );
  }
}

export type AuthzMutationRunner = Pick<AuthzMutations, 'run'>;

/** Internal recovery cadence, unrelated to per-message authorization or its SQL budget. */
export const AUTHZ_MUTATION_RETRY_MS = 250;

const instances = new WeakMap<object, AuthzMutations>();

/** Only the serving I/O capabilities the binding uses, so tests need no substitute auth service. */
interface MutationHost {
  readonly database: Pick<FastifyInstance['database'], 'dbApp'>;
  readonly authz: Pick<FastifyInstance['authz'], 'sessionFence' | 'bus'>;
  readonly collab: {
    readonly ownerLease: Pick<CollabOwnerLease, 'captureFence'>;
    readonly persistence: Pick<FastifyInstance['collab']['persistence'], 'drainForUser'>;
    readonly gateway: Pick<FastifyInstance['collab']['gateway'], 'revalidateUser'>;
  };
  readonly clock: Clock;
  readonly log: Pick<FastifyInstance['log'], 'error'>;
  readonly addHook: FastifyInstance['addHook'];
}

/** Lazy bindings work during route registration, before collaboration has acquired its lease. */
export function authzMutations(app: MutationHost): AuthzMutations {
  const existing = instances.get(app.authz);
  if (existing !== undefined) return existing;
  const mutations = new AuthzMutations({
    database: () => requireConnected(app.database.dbApp),
    owner: () => app.collab.ownerLease,
    fence: app.authz.sessionFence,
    settleWrites: (userId) => app.collab.persistence.drainForUser(userId),
    deliver: (event) => app.authz.bus.publishAndWait(event),
    clock: app.clock,
    revalidate: (userId) => app.collab.gateway.revalidateUser(userId),
    uncertain: (operationId, userId, error) => {
      app.log.error(
        { event: 'authz.mutation.uncertain', operationId, userId, err: error },
        'authorization outcome or live delivery is uncertain; principal admission remains fenced',
      );
    },
  });
  instances.set(app.authz, mutations);
  app.addHook('onClose', () => mutations.stop());
  return mutations;
}
