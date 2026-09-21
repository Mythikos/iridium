/** Persisted claims, retries, cancellation and bounded progress (03 §11.2). */
import { isDeepStrictEqual } from 'node:util';

import {
  idFromBytes,
  Job,
  JobId,
  LIMITS,
  MaintenanceJobType,
  newId,
  parseMaintenancePayload,
  type JobPage,
  type JobProgress,
  type ListJobsQuery,
} from '@iridium/contracts';
import type { Kysely, Selectable } from 'kysely';
import { z } from 'zod';

import type { AuditEventContext, AuditRecorder } from '../auth/audit.ts';
import { idBytes } from '../auth/ids.ts';
import type { OwnerFence } from '../collab/owner-lease.ts';
import type { Database, JobsTable } from '../db/schema.ts';
import { cursorInvalid, type CursorCodec } from '../mcp/cursor.ts';
import type { Clock, TimerHandle } from '../ops/clock.ts';
import { fetchOnePage } from '../rest/pagination.ts';
import { ProblemError } from '../security/problem.ts';

/** A worker checks ownership at every unit boundary and persists its resume cursor here. */
export interface JobContext {
  readonly jobId: string;
  readonly payload: Record<string, unknown>;
  readonly progress: JobProgress | null;
  readonly ownerFence: OwnerFence;
  checkpoint(progress: JobProgress): Promise<void>;
  assertActive(): Promise<void>;
}
/** Handlers perform real work; they cannot change claim state themselves. */
export type JobHandler = (
  context: JobContext,
) => Promise<Record<string, unknown> | JobContinuation>;
/** A successful bounded slice persists its cursor and gives the event loop another admission turn. */
export class JobContinuation {
  readonly progress: JobProgress;
  constructor(progress: JobProgress) {
    this.progress = progress;
  }
}
export interface JobActor {
  readonly userId: string | null;
  readonly sessionId: string | null;
  readonly displayName: string | null;
  readonly context: AuditEventContext;
  readonly credentialType?: 'cli';
}
export interface EnqueueOptions {
  readonly actor?: JobActor;
  readonly ownerFence: OwnerFence;
}
export interface JobSchedulerMetrics {
  finished(
    type: MaintenanceJobType,
    status: 'succeeded' | 'failed' | 'skipped' | 'cancelled',
    durationMs: number,
  ): void;
}
export interface JobSchedulerDeps {
  readonly database: () => Kysely<Database>;
  readonly clock: Clock;
  readonly processId: string;
  readonly handlers: Readonly<Partial<Record<MaintenanceJobType, JobHandler>>>;
  readonly captureFence: () => OwnerFence;
  /** Only the process singleton supplies this; independent claim contenders cannot recover peers. */
  readonly ownerGeneration?: () => string;
  readonly canRun: () => boolean;
  readonly audit: AuditRecorder;
  readonly metrics: JobSchedulerMetrics;
  readonly onError: (error: unknown) => void;
  readonly onTransition?: (event: {
    readonly jobId: string;
    readonly type: MaintenanceJobType;
    readonly attempt: number;
    readonly lockedBy: string;
    readonly status: 'started' | 'succeeded' | 'failed' | 'cancelled';
  }) => void;
}
type JobRow = Selectable<JobsTable>;
type JobWithUser = JobRow & {
  readonly display_name: string | null;
  readonly color_hue: number | null;
};
function jobRows(db: Kysely<Database>) {
  return db
    .selectFrom('jobs')
    .leftJoin('users', 'users.id', 'jobs.requested_by')
    .selectAll('jobs')
    .select(['users.display_name', 'users.color_hue']);
}
/** A lost claim stops before another bounded mutation; it is not a retryable job failure. */
export class JobClaimLost extends Error {
  constructor() {
    super('The maintenance job no longer owns its claim.');
    this.name = 'JobClaimLost';
  }
}
/** The application owns one scheduler; multiple contenders still rely on the SQL claim CAS. */
export class JobScheduler {
  readonly #deps: JobSchedulerDeps;
  #stopped = false;
  #poll: TimerHandle | null = null;
  #work: Promise<void> | null = null;
  #background: Promise<void> | null = null;
  #enqueue: Promise<unknown> = Promise.resolve();
  #recoveredGeneration: string | null = null;
  constructor(deps: JobSchedulerDeps) {
    this.#deps = deps;
  }

  /** Idempotent timer start. Disabled deployments can still invoke the same executor explicitly. */
  start(): void {
    if (this.#poll !== null || this.#stopped) return;
    this.#poll = this.#deps.clock.every(LIMITS.JOB_POLL_INTERVAL_MS, () => {
      void this.runQueuedOnce().catch(this.#deps.onError);
    });
  }
  /** Stop admission synchronously, then await the bounded unit's cooperative exit. */
  async stop(): Promise<void> {
    this.#stopped = true;
    this.#poll?.cancel();
    this.#poll = null;
    await this.#work;
    await this.#background;
    await this.#enqueue;
  }

  /** Complete validated payload and audit commit together, with no active duplicate in this process. */
  async enqueue(
    type: MaintenanceJobType,
    payload: Record<string, unknown>,
    options: EnqueueOptions,
  ): Promise<Job> {
    return this.#submit(type, payload, options);
  }
  /** Automatic discovery yields to an existing selection under the same durable enqueue mutex. */
  enqueueIfIdle(
    type: MaintenanceJobType,
    payload: Record<string, unknown>,
    ownerFence: OwnerFence,
  ): Promise<Job> {
    return this.#submit(type, payload, { ownerFence, reuseAnyActive: true });
  }
  /** CLI metadata intent does not borrow the serving owner's mutation authority. */
  enqueueFromCli(
    type: MaintenanceJobType,
    payload: Record<string, unknown>,
    actor: JobActor,
  ): Promise<Job> {
    return this.#submit(type, payload, { actor: { ...actor, credentialType: 'cli' } });
  }
  async #submit(
    type: MaintenanceJobType,
    payload: Record<string, unknown>,
    options: {
      readonly actor?: JobActor;
      readonly ownerFence?: OwnerFence;
      readonly reuseAnyActive?: boolean;
    },
  ): Promise<Job> {
    if (this.#stopped)
      throw new ProblemError('unavailable', { detail: 'The scheduler is stopping.' });
    if (this.#deps.handlers[type] === undefined)
      throw new ProblemError('validation_failed', {
        detail: 'This process has no executor for the requested maintenance type.',
      });
    let parsed: Record<string, unknown>;
    try {
      parsed = parseMaintenancePayload(type, payload);
    } catch (error) {
      if (error instanceof z.ZodError)
        throw new ProblemError('validation_failed', {
          detail: 'The maintenance payload is invalid.',
          errors: error.issues.map((issue) => ({
            path: `payload.${issue.path.join('.')}`,
            message: issue.message,
            code: issue.code,
          })),
        });
      throw error;
    }
    const work = this.#enqueue.then(async () => {
      const now = this.#deps.clock.date();
      const vaultId = typeof parsed['vaultId'] === 'string' ? parsed['vaultId'] : null;
      const id = await this.#deps
        .database()
        .transaction()
        .execute(async (trx) => {
          await options.ownerFence?.assertCurrent(trx);
          if (options.actor?.userId != null) {
            const actor = await trx
              .selectFrom('users')
              .select(['status', 'is_server_admin'])
              .where('id', '=', idBytes(options.actor.userId))
              .forUpdate()
              .executeTakeFirst();
            if (actor?.status !== 'active' || !actor.is_server_admin)
              throw new ProblemError('forbidden');
          }
          // This existing immutable row is the process-independent enqueue mutex. No content or
          // policy is changed; claims remain independent CAS operations on their own job rows.
          await trx
            .selectFrom('schema_meta')
            .select('key')
            .where('key', '=', 'iridium_version')
            .forUpdate()
            .executeTakeFirstOrThrow();
          if (vaultId !== null) {
            const vault = await trx
              .selectFrom('vaults')
              .select('id')
              .where('id', '=', idBytes(vaultId))
              .executeTakeFirst();
            if (vault === undefined) throw new ProblemError('not_found');
          }
          let active = trx
            .selectFrom('jobs')
            .select(['id', 'payload'])
            .where('type', '=', type)
            .where('status', 'in', ['queued', 'running']);
          active =
            vaultId === null
              ? active.where('vault_id', 'is', null)
              : active.where('vault_id', '=', idBytes(vaultId));
          const existing = await active.orderBy('created_at').limit(1).executeTakeFirst();
          if (
            existing !== undefined &&
            options.reuseAnyActive !== true &&
            !isDeepStrictEqual(existing.payload, parsed)
          )
            throw new ProblemError('invalid_state', {
              detail:
                'This maintenance type already has active work with a different selection for the same vault.',
            });
          const created = existing === undefined ? newId() : idFromBytes(existing.id);
          if (existing === undefined)
            await trx
              .insertInto('jobs')
              .values({
                id: idBytes(created),
                type,
                status: 'queued',
                vault_id: vaultId === null ? null : idBytes(vaultId),
                requested_by: options.actor?.userId == null ? null : idBytes(options.actor.userId),
                payload: JSON.stringify(parsed),
                progress: null,
                result: null,
                error: null,
                attempts: 0,
                locked_by: null,
                locked_at: null,
                created_at: now,
                started_at: null,
                finished_at: null,
              })
              .execute();
          if (options.actor !== undefined)
            await this.#deps.audit.record(trx, {
              action: 'admin.job.triggered',
              actorType: options.actor.userId === null ? 'system' : 'user',
              actorId: options.actor.userId,
              actorDisplay: options.actor.displayName,
              credentialType:
                options.actor.credentialType ??
                (options.actor.sessionId === null ? 'none' : 'session'),
              credentialId: options.actor.sessionId,
              targetType: 'job',
              targetId: created,
              outcome: 'success',
              context: options.actor.context,
              metadata: { type, payload: parsed, reused: existing !== undefined },
            });
          return created;
        });
      return this.get(id);
    });
    this.#enqueue = work.catch(() => undefined);
    return work;
  }

  /** Reads the authoritative row after any transition. */
  async get(id: string): Promise<Job> {
    const row = await jobRows(this.#deps.database())
      .where('jobs.id', '=', idBytes(id))
      .executeTakeFirst();
    if (row === undefined) throw new ProblemError('not_found');
    return this.#dto(row);
  }
  #dto(row: JobWithUser): Job {
    return Job.parse({
      id: idFromBytes(row.id),
      type: row.type,
      status: row.status,
      vaultId: row.vault_id === null ? null : idFromBytes(row.vault_id),
      requestedBy:
        row.requested_by === null
          ? null
          : {
              id: idFromBytes(row.requested_by),
              displayName: row.display_name ?? 'unknown',
              colorHue: row.color_hue ?? 0,
            },
      progress: row.progress,
      result: row.result,
      error: row.error,
      attempts: row.attempts,
      createdAt: row.created_at.toISOString(),
      startedAt: row.started_at?.toISOString() ?? null,
      finishedAt: row.finished_at?.toISOString() ?? null,
    });
  }
  /** Keysets remain bound to the principal and all filters. */
  async list(query: ListJobsQuery, cursors: CursorCodec, principalKey: string): Promise<JobPage> {
    const filter = {
      type: query.type ?? null,
      status: query.status ?? null,
      vaultId: query.vaultId ?? null,
    };
    let select = jobRows(this.#deps.database());
    if (query.type !== undefined) select = select.where('jobs.type', '=', query.type);
    if (query.status !== undefined) select = select.where('jobs.status', '=', query.status);
    if (query.vaultId !== undefined)
      select = select.where('jobs.vault_id', '=', idBytes(query.vaultId));
    if (query.cursor !== undefined) {
      const after = cursors.parse(query.cursor, { kind: 'jobs', filter, principalKey }).a;
      const time = after[0],
        id = after[1];
      if (
        after.length !== 2 ||
        typeof time !== 'string' ||
        typeof id !== 'string' ||
        !JobId.safeParse(id).success ||
        !Number.isFinite(Date.parse(time))
      )
        throw cursorInvalid('The job cursor position is invalid.');
      const createdAt = new Date(time);
      select = select.where((eb) =>
        eb.or([
          eb('jobs.created_at', '<', createdAt),
          eb.and([eb('jobs.created_at', '=', createdAt), eb('jobs.id', '<', idBytes(id))]),
        ]),
      );
    }
    const window = await fetchOnePage(query.limit, (limit) =>
      select.orderBy('jobs.created_at', 'desc').orderBy('jobs.id', 'desc').limit(limit).execute(),
    );
    const items = window.items.map((row) => this.#dto(row));
    const last = window.items.at(-1);
    return {
      items,
      ...(window.hasMore && last !== undefined
        ? {
            nextCursor: cursors.issue({
              kind: 'jobs',
              filter,
              principalKey,
              after: [last.created_at.toISOString(), idFromBytes(last.id)],
            }),
          }
        : {}),
    };
  }
  /** The administrator API permits queued cancellation only. */
  async cancel(id: string, ownerFence: OwnerFence, actor?: JobActor): Promise<Job> {
    return this.#cancel(id, false, ownerFence, actor);
  }
  /** CLI cancellation also marks a running job for cooperative stop at its next boundary. */
  cancelFromCli(id: string, actor: JobActor): Promise<Job> {
    return this.#cancel(id, true, undefined, { ...actor, credentialType: 'cli' });
  }
  async #cancel(
    id: string,
    allowRunning: boolean,
    ownerFence?: OwnerFence,
    actor?: JobActor,
  ): Promise<Job> {
    await this.#deps
      .database()
      .transaction()
      .execute(async (trx) => {
        await ownerFence?.assertCurrent(trx);
        if (actor?.userId != null) {
          const user = await trx
            .selectFrom('users')
            .select(['status', 'is_server_admin'])
            .where('id', '=', idBytes(actor.userId))
            .forUpdate()
            .executeTakeFirst();
          if (user?.status !== 'active' || !user.is_server_admin)
            throw new ProblemError('forbidden');
        }
        const row = await trx
          .selectFrom('jobs')
          .select('status')
          .where('id', '=', idBytes(id))
          .forUpdate()
          .executeTakeFirst();
        if (row === undefined) throw new ProblemError('not_found');
        if (row.status !== 'queued' && !(allowRunning && row.status === 'running'))
          throw new ProblemError('invalid_state', { detail: 'Only queued jobs can be cancelled.' });
        await trx
          .updateTable('jobs')
          .set({ status: 'cancelled', finished_at: this.#deps.clock.date() })
          .where('id', '=', idBytes(id))
          .where('status', '=', row.status)
          .execute();
        if (actor !== undefined)
          await this.#deps.audit.record(trx, {
            action: 'admin.job.cancelled',
            actorType: actor.userId === null ? 'system' : 'user',
            actorId: actor.userId,
            actorDisplay: actor.displayName,
            credentialType: actor.credentialType ?? (actor.sessionId === null ? 'none' : 'session'),
            credentialId: actor.sessionId,
            targetType: 'job',
            targetId: id,
            outcome: 'success',
            context: actor.context,
            metadata: { previousStatus: row.status },
          });
      });
    return this.get(id);
  }
  /** One bounded queued job, serialized locally. The database CAS handles another contender. */
  runQueuedOnce(): Promise<void> {
    if (this.#stopped || !this.#deps.canRun()) return Promise.resolve();
    this.#work ??= this.#run().finally(() => {
      this.#work = null;
    });
    return this.#work;
  }
  /** Own and drain a requested queue wakeup, including bounded retries when timers are disabled. */
  wake(): void {
    this.#background ??= (async () => {
      while (!this.#stopped && this.#deps.canRun()) {
        // eslint-disable-next-line no-await-in-loop -- the owned job must settle before the next claim or retry is admitted
        const next = await this.#deps
          .database()
          .selectFrom('jobs')
          .select('id')
          .where('status', '=', 'queued')
          .where('type', 'in', Object.keys(this.#deps.handlers))
          .limit(1)
          .executeTakeFirst();
        if (next === undefined) return;
        // eslint-disable-next-line no-await-in-loop -- the owned job must settle before the next claim or retry is admitted
        await this.runQueuedOnce();
      }
    })()
      .catch(this.#deps.onError)
      .finally(() => {
        this.#background = null;
      });
  }
  /** CLI and deterministic harnesses use the same claims, retry policy and durable result. */
  async runUntilSettled(id: string): Promise<Job> {
    for (;;) {
      // eslint-disable-next-line no-await-in-loop -- the owned job must settle before the next claim or retry is admitted
      const job = await this.get(id);
      if (job.status !== 'queued' && job.status !== 'running') return job;
      if (this.#stopped || !this.#deps.canRun())
        throw new ProblemError('unavailable', {
          detail: 'Maintenance is paused while persistence is unavailable.',
        });
      // eslint-disable-next-line no-await-in-loop -- the owned job must settle before the next claim or retry is admitted
      await this.runQueuedOnce();
      // eslint-disable-next-line no-await-in-loop -- the owned job must settle before the next claim or retry is admitted
      const current = await this.get(id);
      if (current.status === 'running' && this.#work === null)
        throw new ProblemError('invalid_state', { detail: 'Another worker owns this job.' });
    }
  }
  async #claim(fence: OwnerFence): Promise<JobRow | undefined> {
    const now = this.#deps.clock.date();
    const before = new Date(now.getTime() - LIMITS.JOB_LOCK_TIMEOUT_MS);
    return this.#deps
      .database()
      .transaction()
      .execute(async (trx) => {
        await fence.assertCurrent(trx);
        const candidate = await trx
          .selectFrom('jobs')
          .selectAll()
          .where('type', 'in', Object.keys(this.#deps.handlers))
          .where((eb) =>
            eb.or([
              eb('status', '=', 'queued'),
              eb.and([
                eb('status', '=', 'running'),
                eb.or([eb('locked_at', '<', before), eb('locked_by', '=', this.#deps.processId)]),
              ]),
            ]),
          )
          .orderBy('created_at')
          .orderBy('id')
          .limit(1)
          .executeTakeFirst();
        if (candidate === undefined) return undefined;
        if (candidate.attempts >= LIMITS.JOB_MAX_ATTEMPTS) {
          const changed = await trx
            .updateTable('jobs')
            .set({
              status: 'failed',
              finished_at: now,
              error: candidate.error ?? 'The job exceeded its attempt limit.',
              locked_by: null,
              locked_at: null,
            })
            .where('id', '=', candidate.id)
            .where('status', '=', candidate.status)
            .executeTakeFirst();
          if (changed.numUpdatedRows !== 1n) throw new JobClaimLost();
          return undefined;
        }
        let claim = trx
          .updateTable('jobs')
          .set({
            status: 'running',
            locked_by: this.#deps.processId,
            locked_at: now,
            started_at: candidate.started_at ?? now,
            attempts: candidate.attempts + 1,
          })
          .where('id', '=', candidate.id)
          .where('status', '=', candidate.status)
          .where('attempts', '=', candidate.attempts);
        if (candidate.status === 'running')
          claim = claim
            .where('locked_by', candidate.locked_by === null ? 'is' : '=', candidate.locked_by)
            .where('locked_at', candidate.locked_at === null ? 'is' : '=', candidate.locked_at);
        const changed = await claim.executeTakeFirst();
        return changed.numUpdatedRows === 1n
          ? {
              ...candidate,
              status: 'running',
              locked_by: this.#deps.processId,
              locked_at: now,
              started_at: candidate.started_at ?? now,
              attempts: candidate.attempts + 1,
            }
          : undefined;
      });
  }
  async #run(): Promise<void> {
    const fence = this.#deps.captureFence();
    const generation = this.#deps.ownerGeneration?.();
    if (generation !== undefined && generation !== this.#recoveredGeneration) {
      for (;;) {
        // eslint-disable-next-line no-await-in-loop -- recover former-owner claims in bounded fenced batches before execution
        const changed = await this.#deps
          .database()
          .transaction()
          .execute(async (trx) => {
            await fence.assertCurrent(trx);
            return trx
              .updateTable('jobs')
              .set({ status: 'queued', locked_at: null, locked_by: null })
              .where('status', '=', 'running')
              .where('type', 'in', Object.keys(this.#deps.handlers))
              .limit(LIMITS.JOB_BATCH_SIZE)
              .executeTakeFirst();
          });
        if (changed.numUpdatedRows < BigInt(LIMITS.JOB_BATCH_SIZE)) break;
      }
      this.#recoveredGeneration = generation;
    }
    const row = await this.#claim(fence);
    if (row === undefined) return;
    const type = MaintenanceJobType.parse(row.type);
    const transition = (status: 'started' | 'succeeded' | 'failed' | 'cancelled'): void =>
      this.#deps.onTransition?.({
        jobId: idFromBytes(row.id),
        type,
        attempt: row.attempts,
        lockedBy: this.#deps.processId,
        status,
      });
    transition('started');
    const handler = this.#deps.handlers[type];
    if (handler === undefined) throw new JobClaimLost();
    const started = this.#deps.clock.monotonic();
    let heartbeatWork: Promise<unknown> = Promise.resolve();
    let claimError: unknown;
    let pending: JobProgress | null = row.progress;
    let lastProgress = -Infinity;
    const own = (db: Kysely<Database> = this.#deps.database()) =>
      db
        .updateTable('jobs')
        .where('id', '=', row.id)
        .where('status', '=', 'running')
        .where('locked_by', '=', this.#deps.processId)
        .where('attempts', '=', row.attempts);
    const active = async (): Promise<void> => {
      fence.assertActive();
      if (this.#stopped || claimError !== undefined) throw new JobClaimLost();
      const current = await this.#deps
        .database()
        .selectFrom('jobs')
        .select(['status', 'locked_by', 'attempts'])
        .where('id', '=', row.id)
        .executeTakeFirst();
      if (
        current?.status !== 'running' ||
        current.locked_by !== this.#deps.processId ||
        current.attempts !== row.attempts
      )
        throw new JobClaimLost();
    };
    const heartbeat = this.#deps.clock.every(LIMITS.JOB_HEARTBEAT_MS, () => {
      heartbeatWork = heartbeatWork
        .then(async () => {
          const changed = await this.#deps
            .database()
            .transaction()
            .execute(async (trx) => {
              await fence.assertCurrent(trx);
              return own(trx).set({ locked_at: this.#deps.clock.date() }).executeTakeFirst();
            });
          if (changed.numUpdatedRows !== 1n) throw new JobClaimLost();
          return undefined;
        })
        .catch((error: unknown) => {
          claimError = error;
        });
    });
    const checkpoint = async (progress: JobProgress): Promise<void> => {
      await active();
      pending = progress;
      if (this.#deps.clock.monotonic() - lastProgress < LIMITS.JOB_PROGRESS_INTERVAL_MS) return;
      await this.#deps
        .database()
        .transaction()
        .execute(async (trx) => {
          await fence.assertCurrent(trx);
          const result = await own(trx)
            .set({ progress: JSON.stringify(progress) })
            .executeTakeFirst();
          if (result.numUpdatedRows !== 1n) throw new JobClaimLost();
        });
      lastProgress = this.#deps.clock.monotonic();
    };
    try {
      const result = await handler({
        jobId: idFromBytes(row.id),
        payload: row.payload,
        progress: row.progress,
        ownerFence: fence,
        checkpoint,
        assertActive: active,
      });
      await active();
      if (result instanceof JobContinuation) {
        await this.#deps
          .database()
          .transaction()
          .execute(async (trx) => {
            await fence.assertCurrent(trx);
            const yielded = await own(trx)
              .set({
                status: 'queued',
                progress: JSON.stringify(result.progress),
                // Continuing a completed slice is not a failed attempt. The next claim restores
                // this same attempt number while genuine errors still consume the retry budget.
                attempts: row.attempts - 1,
                locked_by: null,
                locked_at: null,
              })
              .executeTakeFirst();
            if (yielded.numUpdatedRows !== 1n) throw new JobClaimLost();
          });
        return;
      }
      await this.#deps
        .database()
        .transaction()
        .execute(async (trx) => {
          await fence.assertCurrent(trx);
          const finished = await trx
            .updateTable('jobs')
            .set({
              status: 'succeeded',
              result: JSON.stringify(result),
              progress: pending === null ? null : JSON.stringify(pending),
              error: null,
              finished_at: this.#deps.clock.date(),
              locked_by: null,
              locked_at: null,
            })
            .where('id', '=', row.id)
            .where('status', '=', 'running')
            .where('locked_by', '=', this.#deps.processId)
            .where('attempts', '=', row.attempts)
            .executeTakeFirst();
          if (finished.numUpdatedRows !== 1n) throw new JobClaimLost();
        });
      this.#deps.metrics.finished(
        type,
        result['status'] === 'skipped_no_ddl_credential' ? 'skipped' : 'succeeded',
        this.#deps.clock.monotonic() - started,
      );
      transition('succeeded');
    } catch (error) {
      if (error instanceof JobClaimLost) {
        const current = await this.#deps
          .database()
          .selectFrom('jobs')
          .select('status')
          .where('id', '=', row.id)
          .executeTakeFirst();
        if (current?.status === 'cancelled') {
          this.#deps.metrics.finished(type, 'cancelled', this.#deps.clock.monotonic() - started);
          transition('cancelled');
          return;
        }
      }
      // Returning a cooperatively stopped job to queued retains its last durable progress.
      // A generation loss prevents this update, leaving the next owner to reclaim the stale row.
      try {
        await this.#deps
          .database()
          .transaction()
          .execute(async (trx) => {
            await fence.assertCurrent(trx);
            return own(trx)
              .set({
                status: row.attempts >= LIMITS.JOB_MAX_ATTEMPTS ? 'failed' : 'queued',
                error:
                  error instanceof JobClaimLost
                    ? 'shutdown'
                    : error instanceof Error
                      ? error.name
                      : 'JobFailed',
                progress: pending === null ? null : JSON.stringify(pending),
                finished_at:
                  row.attempts >= LIMITS.JOB_MAX_ATTEMPTS ? this.#deps.clock.date() : null,
                locked_by: null,
                locked_at: null,
              })
              .execute();
          });
      } catch (updateError) {
        this.#deps.onError(updateError);
      }
      this.#deps.metrics.finished(type, 'failed', this.#deps.clock.monotonic() - started);
      transition('failed');
      if (!(error instanceof JobClaimLost)) this.#deps.onError(error);
    } finally {
      heartbeat.cancel();
      await heartbeatWork;
    }
  }
}
