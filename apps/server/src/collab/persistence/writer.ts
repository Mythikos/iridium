/**
 * `NoteWriter` — the single component that turns in-memory Yjs updates into committed rows
 * (05-collaboration-and-durability.md, "The NoteWriter"; 03-data-model.md §8.4; skeleton A16, A19).
 *
 * Exactly one writer exists per loaded document, created in `afterLoadDocument` and disposed in
 * `afterUnloadDocument`. It owns:
 *
 *  - **one FIFO** of captured updates plus the interleaved compaction jobs (a job records how many
 *    updates were enqueued before it and runs only once that many have committed, so a snapshot can
 *    never be taken mid-batch);
 *  - **one in-flight transaction at a time**, run in the scheduler's round-robin;
 *  - **coalescing** of contiguous same-`(actor, session, origin)` runs into one row each, bounded by
 *    the batch caps and split so a stored row is never wider than one wire frame;
 *  - **the acknowledgement**: `persisted {seq, sv}` broadcast only after COMMIT resolved;
 *  - **its own retry**: backoff 200 ms → 5 s with full jitter, `failed` after 10 attempts or 30 s,
 *    `persist-failed` on every failure; Hocuspocus retries nothing;
 *  - **the bounded queue**: 5 000 updates or 32 MiB → `backpressure`, read-only for every connection,
 *    left again below half of both bounds;
 *  - **the unload**: the veto conditions of `beforeUnloadDocument`, and the completion of a vetoed
 *    unload once the writer drains with no connection left.
 *
 * Every state transition is the table in "Writer state reference". The writer never rejects into the
 * scheduler and never throws into Yjs; a failure is a state and a message, not an exception.
 */
import {
  LIMITS,
  encodeStateless,
  type NoteId,
  type PersistFailedReason,
  type UserId,
} from '@iridium/contracts';
import {
  createNoteDoc,
  deleteSetFingerprint,
  mergeV1,
  prefixSuffixDiff,
  projectMarkdown,
  storedSv,
} from '@iridium/crdt';

import { HeadSeqCasViolation } from '../../db/cas.ts';
import { classifyDatabaseFailure } from '../../db/failure.ts';
import type { Clock, TimerHandle } from '../../ops/clock.ts';
import { contentHash } from '../../projection/hash.ts';
import type { PrepareProjection } from '../../projection/prepare.ts';
import { CollabOwnershipLost } from '../owner-lease.ts';
import { UnloadVeto } from '../rejection.ts';
import { BACKOFF_BASE_MS, FAILED_RETRY_INTERVAL_MS, hasFailed, retryDelayMs } from './backoff.ts';
import { capture, runCompaction, type CompactionFaults } from './compactor.ts';
import {
  CheckpointTimeout,
  CheckpointUnavailable,
  CompactionTimeout,
  CompactionUnavailable,
  NoteTrashedDuringWrite,
  PersistenceDrainUnavailable,
  RevisionContentRefused,
  RestoreTimeout,
} from './errors.ts';
import { PersistenceUnavailable } from './kysely-store.ts';
import { applyLoaded } from './loader.ts';
import type { Schedulable, WriterScheduler } from './scheduler.ts';
import type { PersistenceStore } from './store.ts';
import {
  COMPACT_TRIGGER_RANK,
  type Captured,
  type CheckpointRequest,
  type CheckpointResult,
  type CompactResult,
  type CompactTrigger,
  type LastEditor,
  type PendingUpdate,
  type Persisted,
  type RestoreRequest,
  type RestoreResult,
  type RevisionInsert,
  type UpdateActor,
  type UpdateInsert,
  type WriteRun,
  type WriterIdentity,
  type WriterState,
} from './types.ts';

/**
 * The connection surface the writer touches: the read-only flag and a per-connection message. The
 * role is optional because a Hocuspocus connection's context is filled by `onAuthenticate`; a
 * connection without one is treated as a viewer.
 */
export interface WriterConnection {
  readOnly: boolean;
  readonly context: {
    readonly role?: 'viewer' | 'editor' | 'manager' | undefined;
    readonly userId?: UserId;
  };
  sendStateless(payload: string): void;
}

/** A retry keeps this exact prefix and row identity even while later edits join the FIFO. */
interface WriteAttempt {
  readonly batch: readonly PendingUpdate[];
  readonly runs: readonly WriteRun[];
  readonly rows: readonly UpdateInsert[];
  readonly from: number;
  readonly now: Date;
  submitted: boolean;
}

/** The document surface the writer touches — what a Hocuspocus `Document` provides. */
export interface WriterDocument {
  broadcastStateless(payload: string): void;
  getConnectionsCount(): number;
  getConnections(): readonly WriterConnection[];
}

/** The fault registry slice the writer fires (`ops/faults.ts`). */
export interface WriterFaults {
  hold(point: string): Promise<void>;
  fire(
    point: string,
    connectionId?: string,
  ): { readonly fired: boolean; readonly arg: number | undefined };
  delay(point: string): Promise<void>;
  crash(point: string): void;
  maybeThrow(point: string, error: () => Error): void;
}

/** The metrics the writer moves. Slices of `app.metrics` and of the collab counters. */
export interface WriterMetrics {
  readonly persistLatencySeconds: { observe(value: number): void };
  readonly persistFailuresTotal: { inc(labels: { reason: string }): void };
  readonly compactionsTotal: { inc(labels: { trigger: string; status: string }): void };
  readonly noteStateBytes: { observe(value: number): void };
  readonly stateVectorOversizeTotal: { inc(): void };
  readonly contentInvalidTotal: { inc(labels: { reason: string }): void };
}

/** The three logging methods the writer uses. */
export interface WriterLogger {
  info(fields: Readonly<Record<string, unknown>>, message: string): void;
  warn(fields: Readonly<Record<string, unknown>>, message: string): void;
  error(fields: Readonly<Record<string, unknown>>, message: string): void;
}

/** What the writer calls back into. */
export interface WriterCallbacks {
  /** `NoteTrashedDuringWrite`: the gateway closes the document `note-trashed`. */
  onTrashed(): void;
  /** A vetoed unload can now complete: `hocuspocus.unloadDocument(document)`. */
  requestUnload(): Promise<void>;
  /** The state changed; the persistence layer refreshes the gauges. */
  onStateChange(state: WriterState): void;
  /** Audits `collab.write.rejected {reason:'note_trashed'}` once per document. */
  onWriteRejected(reason: string): void;
}

/** What a writer is created with. */
export interface NoteWriterOptions {
  readonly prepareProjection?: PrepareProjection;
  readonly identity: WriterIdentity;
  readonly document: WriterDocument;
  readonly store: PersistenceStore;
  readonly clock: Clock;
  readonly logger: WriterLogger;
  readonly metrics: WriterMetrics;
  readonly faults: WriterFaults;
  readonly scheduler: WriterScheduler;
  readonly callbacks: WriterCallbacks;
  readonly compactionAwaitTimeoutMs: number;
  /** The baseline `afterLoadDocument` computed. */
  readonly lastPersisted: Persisted;
  /** The latches as loaded: a note already flagged is locked before any client builds on it. */
  readonly contentInvalid: boolean;
  readonly oversize: boolean;
  /** `note_docs.projected_seq` as loaded: what a refused `flush` answers `projected {seq}` with. */
  readonly projectedSeq: number;
  /** Text size at load, then the last committed compaction size, for late latch notices. */
  readonly sizeChars: number;
  /** Injected randomness for the jitter; `Math.random` in production. */
  readonly random?: () => number;
  /** Independent in-memory authorization mutation barrier. */
  readonly principalBlocked?: (userId: UserId) => boolean;
}

interface CompactionJob {
  readonly kind: 'compaction';
  /** Updates enqueued before this job; it runs once that many have been written. */
  readonly position: number;
  trigger: CompactTrigger;
  readonly settle: Array<{
    resolve: (result: CompactResult) => void;
    reject: (error: unknown) => void;
  }>;
}

interface CheckpointJob {
  readonly kind: 'checkpoint';
  readonly position: number;
  readonly request: CheckpointRequest;
  readonly settle: Array<{
    resolve: (result: CheckpointResult) => void;
    reject: (error: unknown) => void;
  }>;
}

interface RestoreAttempt {
  readonly batch: readonly PendingUpdate[];
  readonly rows: readonly UpdateInsert[];
  readonly pendingRows: number;
  readonly from: number;
  readonly before: Captured;
  readonly after: Captured;
  readonly dsAfter: string;
  readonly changed: boolean;
  readonly now: Date;
  submitted: boolean;
}

interface RestoreJob {
  readonly kind: 'restore';
  readonly position: number;
  readonly request: RestoreRequest;
  attempt: RestoreAttempt | null;
  readonly settle: Array<{
    resolve: (result: RestoreResult) => void;
    reject: (error: unknown) => void;
  }>;
}

type WriterJob = CompactionJob | CheckpointJob | RestoreJob;

/** The `retryInMs` a `backpressure` message carries: the writer drains normally. */
const BACKPRESSURE_RETRY_HINT_MS = 1_000;
const MS_PER_SECOND = 1000;

/** Which `persist-failed` reason a thrown value is (05, "Failure handling"). */
export function persistFailureReason(error: unknown): PersistFailedReason {
  if (error instanceof PersistenceUnavailable) return 'db_unavailable';
  const kind = classifyDatabaseFailure(error).kind;
  if (kind === 'unavailable' || kind === 'deadlock' || kind === 'lock_wait_timeout') {
    return 'db_unavailable';
  }
  return 'db_error';
}

const SYSTEM_ACTOR: UpdateActor = Object.freeze({
  userId: null,
  sessionId: null,
  actorType: 'system',
});

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

/** The writer. */
export class NoteWriter implements Schedulable {
  readonly noteId: NoteId;
  readonly documentName: string;
  readonly #identity: WriterIdentity;
  readonly #document: WriterDocument;
  readonly #store: PersistenceStore;
  readonly #prepareProjection: PrepareProjection | undefined;
  readonly #clock: Clock;
  readonly #logger: WriterLogger;
  readonly #metrics: WriterMetrics;
  readonly #faults: WriterFaults;
  readonly #scheduler: WriterScheduler;
  readonly #callbacks: WriterCallbacks;
  readonly #random: () => number;
  readonly #principalBlocked: ((userId: UserId) => boolean) | undefined;
  readonly #compactionAwaitTimeoutMs: number;

  readonly #queue: PendingUpdate[] = [];
  #queueBytes = 0;
  #writeAttempt: WriteAttempt | null = null;
  readonly #jobs: WriterJob[] = [];
  #enqueuedCount = 0;
  #writtenCount = 0;
  #state: WriterState = 'idle';
  #inFlight = false;
  #lastPersisted: Persisted;
  #lastCommittedSeq: number;
  #lastEditor: LastEditor | null = null;
  #attempt = 0;
  #retryingSince: number | null = null;
  #failedSince: number | null = null;
  #retryTimer: TimerHandle | null = null;
  #retryDue = false;
  #casViolated = false;
  #ownershipLost = false;
  #backpressured = false;
  #unloadRequested = false;
  #unloadCompleting = false;
  #unloadRetryTimer: TimerHandle | null = null;
  #unloadAttempt = 0;
  #contentInvalid: boolean;
  #contentInvalidReason: 'cr' | 'attributes' | null = null;
  #oversize: boolean;
  #projectedSeq: number;
  #sizeChars: number;
  #lastFailure: { readonly reason: PersistFailedReason; readonly retryInMs: number } | null = null;
  #drainWaiters: Array<() => void> = [];
  #acceptedWaiters: Array<{
    readonly through: number;
    readonly resolve: () => void;
    readonly reject: (error: unknown) => void;
  }> = [];
  #unknownOriginLogged = false;

  constructor(options: NoteWriterOptions) {
    this.#identity = options.identity;
    this.noteId = options.identity.noteId;
    this.documentName = options.identity.documentName;
    this.#document = options.document;
    this.#store = options.store;
    this.#prepareProjection = options.prepareProjection;
    this.#clock = options.clock;
    this.#logger = options.logger;
    this.#metrics = options.metrics;
    this.#faults = options.faults;
    this.#scheduler = options.scheduler;
    this.#callbacks = options.callbacks;
    this.#random = options.random ?? Math.random;
    this.#principalBlocked = options.principalBlocked;
    this.#compactionAwaitTimeoutMs = options.compactionAwaitTimeoutMs;
    this.#lastPersisted = options.lastPersisted;
    this.#lastCommittedSeq = options.lastPersisted.seq;
    this.#contentInvalid = options.contentInvalid;
    this.#oversize = options.oversize;
    this.#projectedSeq = options.projectedSeq;
    this.#sizeChars = options.sizeChars;
  }

  // ---- what the hooks and the readiness probe read --------------------------------------------

  get state(): WriterState {
    return this.#state;
  }

  /** The baseline `baseline` is answered from. */
  get lastPersisted(): Persisted {
    return this.#lastPersisted;
  }

  /** `=== lastPersisted.seq`; kept separate for readability, as the plan writes it. */
  get lastCommittedSeq(): number {
    return this.#lastCommittedSeq;
  }

  /** The last committed batch's actor, for the next compaction (D03-14). */
  get lastEditor(): LastEditor | null {
    return this.#lastEditor;
  }

  get queueLength(): number {
    return this.#queue.length;
  }

  get queueBytes(): number {
    return this.#queueBytes;
  }

  /** Whether a transaction is running right now. */
  get inFlight(): boolean {
    return this.#inFlight;
  }

  /** `clock.monotonic()` of the oldest queued update, or `null` when nothing is queued. */
  get oldestEnqueuedAt(): number | null {
    return this.#queue[0]?.enqueuedAt ?? null;
  }

  /** When the writer entered `failed`, monotonic ms, or `null`. */
  get failedSince(): number | null {
    return this.#failedSince;
  }

  get contentInvalid(): boolean {
    return this.#contentInvalid;
  }

  get oversize(): boolean {
    return this.#oversize;
  }

  /** The seq the committed projection reflects, as of the last compaction this writer saw. */
  get lastProjectedSeq(): number {
    return this.#projectedSeq;
  }

  /**
   * `afterLoadDocument`: a state that fails the scan is locked before any client builds on it
   * (05, "Hostile CRDT content", "Where it runs").
   */
  lockContentInvalid(reason: 'cr' | 'attributes'): void {
    this.#contentInvalid = true;
    this.#contentInvalidReason = reason;
    this.#setAllReadOnly(true);
    this.#document.broadcastStateless(encodeStateless({ v: 1, t: 'content-invalid', reason }));
  }

  /**
   * The first incoming frame or `connected`, whichever runs first, initializes a later connection's
   * latches and notices; `setAllReadOnly` reached only connections that existed at latch time.
   */
  applyLatches(connection: WriterConnection): void {
    const userId = connection.context.userId;
    if (this.#ownershipLost || (userId !== undefined && this.#principalBlocked?.(userId)))
      connection.readOnly = true;
    if (this.#contentInvalid) {
      connection.readOnly = true;
      if (this.#contentInvalidReason !== null) {
        connection.sendStateless(
          encodeStateless({ v: 1, t: 'content-invalid', reason: this.#contentInvalidReason }),
        );
      }
    }
    if (this.#oversize) {
      connection.readOnly = true;
      connection.sendStateless(
        encodeStateless({
          v: 1,
          t: 'size-exceeded',
          size: this.#sizeChars,
          max: LIMITS.NOTE_SOFT_MAX_UTF16,
        }),
      );
    }
    if (this.#backpressured || this.#state === 'failed') connection.readOnly = true;
  }

  /** The last `persist-failed` the writer sent, for the `baseline` answer of a stuck writer. */
  get lastFailure(): { readonly reason: PersistFailedReason; readonly retryInMs: number } | null {
    return this.#lastFailure;
  }

  /** Compaction jobs waiting in the FIFO. */
  get pendingCompactions(): number {
    return this.#jobs.filter((job) => job.kind === 'compaction').length;
  }

  /** All snapshot jobs which must settle before shutdown or unload can complete. */
  get pendingJobs(): number {
    return this.#jobs.length;
  }

  // ---- enqueue -----------------------------------------------------------------------------------

  /**
   * Appends one captured update. O(1), never awaits, never throws; applies the queue bound and
   * schedules the writer. `source` is the connection the update came from, for the one per-connection
   * refusal (a write to a `content_invalid` note from any origin but `repair`).
   */
  enqueue(pending: PendingUpdate, source?: WriterConnection): void {
    if (this.#state === 'trashed' || this.#state === 'disposed') return;
    if (this.#contentInvalid && pending.origin !== 'repair') {
      this.notifyInvalidWrite(source);
      return;
    }
    this.#queue.push(pending);
    this.#queueBytes += pending.bytes;
    this.#enqueuedCount += 1;
    if (
      !this.#backpressured &&
      (this.#queue.length > LIMITS.WRITER_QUEUE_MAX_UPDATES ||
        this.#queueBytes > LIMITS.WRITER_QUEUE_MAX_BYTES)
    ) {
      this.#enterBackpressure();
    }
    this.#schedule();
  }

  /** The read-only protocol refuses before an update event; report the durable latch explicitly. */
  notifyInvalidWrite(source?: WriterConnection): void {
    if (!this.#contentInvalid) return;
    source?.sendStateless(
      encodeStateless({ v: 1, t: 'persist-failed', reason: 'content_invalid', retryInMs: 0 }),
    );
    this.#metrics.persistFailuresTotal.inc({ reason: 'content_invalid' });
  }

  /**
   * Enqueues a compaction job — or upgrades the pending one — and awaits it, bounded once at this
   * boundary (D05-20). Rejects `CompactionUnavailable` at once when the writer cannot drain, and
   * `CompactionTimeout` after the deadline; in both cases the job stays queued.
   */
  enqueueCompaction(trigger: CompactTrigger): Promise<CompactResult> {
    if (this.#state === 'trashed') {
      // Nothing can ever compact a trashed note; the job resolves without a transaction.
      return Promise.resolve(this.#skippedTrashed());
    }
    if (this.#state === 'disposed') {
      return Promise.reject(new CompactionUnavailable(this.noteId, this.#state));
    }
    if (this.#state === 'retrying' || this.#state === 'failed' || this.#state === 'backpressure') {
      this.#ensureJob(trigger);
      return Promise.reject(new CompactionUnavailable(this.noteId, this.#state));
    }
    const job = this.#ensureJob(trigger);
    const settled = new Promise<CompactResult>((resolve, reject) => {
      job.settle.push({ resolve, reject });
    });
    // A settlement nobody awaits any more must not become an unhandled rejection.
    settled.catch(() => undefined);
    this.#schedule();
    return this.#bounded(settled);
  }

  /**
   * Captures a durable prefix at its own FIFO boundary. Later edits may already be live, but are
   * excluded from the replay and cannot be labelled with this checkpoint's older sequence.
   */
  enqueueCheckpoint(request: CheckpointRequest): Promise<CheckpointResult> {
    if (this.#ownershipLost) return Promise.reject(new CollabOwnershipLost());
    if (
      this.#state === 'trashed' ||
      this.#state === 'disposed' ||
      this.#state === 'retrying' ||
      this.#state === 'failed' ||
      this.#state === 'backpressure'
    )
      return Promise.reject(new CheckpointUnavailable(this.noteId, this.#state));
    const job: CheckpointJob = {
      kind: 'checkpoint',
      position: this.#enqueuedCount,
      request: { ...request, actor: { ...request.actor } },
      settle: [],
    };
    const settled = new Promise<CheckpointResult>((resolve, reject) => {
      job.settle.push({ resolve, reject });
    });
    settled.catch(() => undefined);
    this.#jobs.push(job);
    this.#schedule();
    return this.#bounded(
      settled,
      () => new CheckpointTimeout(this.noteId, this.#compactionAwaitTimeoutMs),
    );
  }

  /** Captures every currently applied update and the restore diff without yielding (D05-21). */
  enqueueRestore(request: RestoreRequest): Promise<RestoreResult> {
    if (this.#ownershipLost) return Promise.reject(new CollabOwnershipLost());
    if (this.#state !== 'idle' && this.#state !== 'writing') {
      return Promise.reject(new CheckpointUnavailable(this.noteId, this.#state));
    }
    if (this.#contentInvalid) return Promise.reject(new RevisionContentRefused('content_invalid'));
    if (this.#oversize) return Promise.reject(new RevisionContentRefused('note_oversized'));
    const job: RestoreJob = {
      kind: 'restore',
      position: this.#enqueuedCount,
      request,
      attempt: null,
      settle: [],
    };
    const settled = new Promise<RestoreResult>((resolve, reject) => {
      job.settle.push({ resolve, reject });
    });
    settled.catch(() => undefined);
    this.#jobs.push(job);
    this.#schedule();
    return this.#bounded(settled, () => new RestoreTimeout(this.noteId));
  }

  #ensureJob(trigger: CompactTrigger): CompactionJob {
    const pending = this.#jobs.at(-1);
    if (
      pending?.kind === 'compaction' &&
      pending.position >= this.#writtenCount &&
      !this.#inFlightJob(pending)
    ) {
      if (COMPACT_TRIGGER_RANK[trigger] > COMPACT_TRIGGER_RANK[pending.trigger]) {
        pending.trigger = trigger;
      }
      return pending;
    }
    const job: CompactionJob = {
      kind: 'compaction',
      position: this.#enqueuedCount,
      trigger,
      settle: [],
    };
    this.#jobs.push(job);
    return job;
  }

  #runningJob: WriterJob | null = null;

  #inFlightJob(job: CompactionJob): boolean {
    return this.#runningJob === job;
  }

  async #bounded<T>(
    settled: Promise<T>,
    timeout: () => Error = () => new CompactionTimeout(this.noteId, this.#compactionAwaitTimeoutMs),
  ): Promise<T> {
    let timer: TimerHandle | undefined;
    try {
      return await Promise.race([
        settled,
        new Promise<never>((_resolve, reject) => {
          timer = this.#clock.after(this.#compactionAwaitTimeoutMs, () => {
            reject(timeout());
          });
        }),
      ]);
    } finally {
      timer?.cancel();
    }
  }

  // ---- the scheduler's view ----------------------------------------------------------------------

  hasWork(): boolean {
    if (this.#ownershipLost || this.#state === 'trashed' || this.#state === 'disposed')
      return false;
    if ((this.#state === 'retrying' || this.#state === 'failed') && !this.#retryDue) return false;
    return this.#nextKind() !== null;
  }

  #nextKind(): 'batch' | 'job' | null {
    const job = this.#jobs[0];
    if (job !== undefined && job.position <= this.#writtenCount) return 'job';
    if (this.#queue.length > 0) return 'batch';
    return null;
  }

  #schedule(): void {
    if (this.hasWork()) this.#scheduler.ready(this);
  }

  /** One turn: a batch, or a job. Never rejects. */
  async runOne(): Promise<void> {
    if (!this.hasWork()) return;
    this.#retryDue = false;
    const kind = this.#nextKind();
    this.#inFlight = true;
    try {
      if (kind === 'batch') await this.#writeBatch();
      else if (kind === 'job') await this.#runJob();
    } finally {
      this.#inFlight = false;
      this.#afterTurn();
    }
  }

  // ---- the batch ---------------------------------------------------------------------------------

  #takeBatch(): readonly PendingUpdate[] {
    const batch: PendingUpdate[] = [];
    let bytes = 0;
    const untilJob = (this.#jobs[0]?.position ?? this.#enqueuedCount) - this.#writtenCount;
    for (const item of this.#queue) {
      if (
        batch.length >= untilJob ||
        batch.length >= LIMITS.WRITER_BATCH_MAX_UPDATES ||
        (batch.length > 0 && bytes + item.bytes > LIMITS.WRITER_BATCH_MAX_RAW_BYTES)
      ) {
        break;
      }
      batch.push(item);
      bytes += item.bytes;
    }
    return batch;
  }

  #prepareWrite(): WriteAttempt | null {
    const batch = this.#takeBatch();
    if (batch.length === 0) return null;
    const runs = groupRuns(batch);
    const now = this.#clock.date();
    const from = this.#lastCommittedSeq;
    for (const run of runs) {
      if (run.storedSv.byteLength === 0) {
        this.#metrics.stateVectorOversizeTotal.inc();
        this.#logger.warn(
          {
            event: 'collab.state_vector.oversize',
            noteId: this.noteId,
            bytes: run.svAfter.byteLength,
          },
          'a state vector exceeded the stored width and was recorded as zero length',
        );
      }
    }
    return {
      batch,
      runs,
      now,
      from,
      submitted: false,
      rows: runs.map((run, index) => ({
        seq: from + index + 1,
        updateV1: run.merged,
        svAfter: this.#faults.fire('sv.not-recorded').fired ? new Uint8Array(0) : run.storedSv,
        actor: run.actor,
        origin: run.origin,
        createdAt: now,
      })),
    };
  }

  async #writeBatch(): Promise<void> {
    const attempt = this.#writeAttempt ?? this.#prepareWrite();
    if (attempt === null) return;
    this.#writeAttempt = attempt;
    const { batch, runs, rows, from, now } = attempt;
    const finalRun = runs.at(-1);
    if (finalRun === undefined) return;
    const { svAfter, dsAfter } = finalRun;

    const recovering = this.#state === 'retrying' || this.#state === 'failed';
    this.#state = this.#backpressured ? 'backpressure' : 'writing';
    this.#callbacks.onStateChange(this.#state);

    let head: number;
    try {
      this.#faults.maybeThrow('store.throw', () => new Error('store.throw fault point'));
      head = await this.#store.runWrite(this.noteId, async (tx) => {
        const row = await tx.lockHead();
        if (this.#ownershipLost) throw new CollabOwnershipLost();
        if (row === null) throw new HeadSeqCasViolation({ table: 'note_docs', id: this.noteId });
        if (row.deletedAt !== null) throw new NoteTrashedDuringWrite(this.noteId);
        // COMMIT can succeed while its reply is lost. Only this retained, previously submitted
        // batch may explain the advanced head; the owner fence and locked row rule out a successor.
        if (
          attempt.submitted &&
          row.headSeq === from + rows.length &&
          (await tx.matchesUpdates(rows))
        ) {
          return from;
        }
        if (row.headSeq !== from) {
          throw new HeadSeqCasViolation({
            table: 'note_docs',
            id: this.noteId,
            expected: from,
          });
        }
        attempt.submitted = true;
        await tx.insertUpdates(rows);
        const matched = await tx.casHead(from, from + runs.length, now);
        if (!matched) {
          throw new HeadSeqCasViolation({ table: 'note_docs', id: this.noteId, expected: from });
        }
        await this.#faults.delay('store.slow');
        await this.#faults.hold('store.hold-before-commit');
        this.#faults.crash('store.crash-before-commit');
        return from;
      });
      this.#faults.maybeThrow('store.throw-after-commit-before-ack', () =>
        Object.assign(
          new Error('the committed transaction result was lost before acknowledgement'),
          { code: 'ECONNRESET' },
        ),
      );
    } catch (error) {
      this.#onWriteFailure(error);
      return;
    }

    if (this.#ownershipLost) return;
    this.#faults.crash('store.crash-after-commit-before-ack');

    const seq = head + runs.length;
    const written = runs.reduce((count, run) => count + run.members, 0);
    this.#writeAttempt = null;
    this.#queue.splice(0, written);
    this.#writtenCount += written;
    this.#queueBytes -= batch.reduce((bytes, item) => bytes + item.bytes, 0);
    this.#lastCommittedSeq = seq;
    this.#lastPersisted = { seq, sv: svAfter, ds: dsAfter };
    const lastRun = runs.at(-1);
    if (lastRun !== undefined) this.#lastEditor = { userId: lastRun.actor.userId, at: now };
    this.#document.broadcastStateless(
      encodeStateless({ v: 1, t: 'persisted', seq, sv: base64(svAfter), ds: dsAfter }),
    );
    const oldest = batch[0];
    if (oldest !== undefined) {
      this.#metrics.persistLatencySeconds.observe(
        (this.#clock.monotonic() - oldest.enqueuedAt) / MS_PER_SECOND,
      );
    }
    this.#onWriteSuccess(recovering);
  }

  #onWriteSuccess(recovered: boolean): void {
    const wasFailed = this.#failedSince !== null;
    this.#attempt = 0;
    this.#retryingSince = null;
    this.#failedSince = null;
    this.#lastFailure = null;
    if (recovered) {
      this.#logger.info(
        { event: 'persist.recovered', noteId: this.noteId },
        'the writer recovered',
      );
    }
    const leftBackpressure = this.#backpressured && this.#belowHalfOfBothBounds();
    if (leftBackpressure) this.#backpressured = false;
    this.#state = this.#backpressured ? 'backpressure' : 'idle';
    // `failed` and `backpressure` both locked every connection; leaving either restores the
    // role-derived flag and tells each client its role again.
    if (!this.#backpressured && (wasFailed || leftBackpressure)) this.#restoreRoleReadOnly();
    this.#callbacks.onStateChange(this.#state);
  }

  #onWriteFailure(error: unknown): void {
    if (this.#ownershipLost) return;
    if (error instanceof NoteTrashedDuringWrite) {
      this.#enterTrashed();
      return;
    }
    if (error instanceof HeadSeqCasViolation) {
      this.#casViolated = true;
      this.#metrics.persistFailuresTotal.inc({ reason: 'cas_mismatch' });
      this.#logger.error(
        { err: error, event: 'persist.cas_mismatch', noteId: this.noteId },
        'the head compare-and-set matched no row: corruption, never a retry',
      );
      this.#enterFailed('db_error', 0);
      return;
    }
    const reason = persistFailureReason(error);
    this.#metrics.persistFailuresTotal.inc({ reason });
    this.#attempt += 1;
    const nowMs = this.#clock.monotonic();
    this.#retryingSince ??= nowMs;
    const retryingForMs = nowMs - this.#retryingSince;
    if (this.#failedSince !== null || hasFailed(this.#attempt, retryingForMs)) {
      if (this.#failedSince === null) {
        this.#logger.error(
          {
            err: error,
            event: 'persist.failed',
            noteId: this.noteId,
            attempts: this.#attempt,
            reason,
          },
          'the writer entered failed after repeated persistence failures',
        );
      }
      this.#enterFailed(reason, FAILED_RETRY_INTERVAL_MS);
      return;
    }
    const retryInMs = retryDelayMs(this.#attempt, this.#random);
    this.#logger.warn(
      {
        err: error,
        event: 'persist.failed',
        noteId: this.noteId,
        attempt: this.#attempt,
        reason,
        retryInMs,
      },
      'a persistence batch failed and will be retried',
    );
    this.#state = 'retrying';
    this.#sendPersistFailed(reason, retryInMs);
    this.#armRetry(retryInMs);
    this.#callbacks.onStateChange(this.#state);
  }

  #enterFailed(reason: PersistFailedReason, retryInMs: number): void {
    this.#failedSince ??= this.#clock.monotonic();
    this.#state = 'failed';
    this.#setAllReadOnly(true);
    this.#sendPersistFailed(reason, retryInMs);
    if (retryInMs > 0) this.#armRetry(retryInMs);
    this.#callbacks.onStateChange(this.#state);
  }

  #armRetry(delayMs: number): void {
    this.#retryTimer?.cancel();
    this.#retryTimer = this.#clock.after(delayMs, () => {
      this.#retryTimer = null;
      this.#retryDue = true;
      this.#schedule();
    });
  }

  #sendPersistFailed(reason: PersistFailedReason, retryInMs: number): void {
    this.#lastFailure = { reason, retryInMs };
    this.#document.broadcastStateless(
      encodeStateless({
        v: 1,
        t: 'persist-failed',
        seq: this.#lastCommittedSeq + 1,
        reason,
        retryInMs,
      }),
    );
  }

  #enterTrashed(): void {
    this.#writeAttempt = null;
    this.#queue.length = 0;
    this.#queueBytes = 0;
    this.#retryTimer?.cancel();
    this.#retryTimer = null;
    this.#state = 'trashed';
    this.#metrics.persistFailuresTotal.inc({ reason: 'note_trashed' });
    this.#callbacks.onWriteRejected('note_trashed');
    this.#lastFailure = { reason: 'note_trashed', retryInMs: 0 };
    this.#document.broadcastStateless(
      encodeStateless({ v: 1, t: 'persist-failed', reason: 'note_trashed', retryInMs: 0 }),
    );
    // Every pending and future compaction resolves without opening a transaction.
    for (const job of this.#jobs.splice(0, this.#jobs.length)) {
      if (job.kind === 'compaction') {
        for (const settle of job.settle) settle.resolve(this.#skippedTrashed());
      } else {
        for (const settle of job.settle)
          settle.reject(new CheckpointUnavailable(this.noteId, 'trashed'));
      }
    }
    this.#callbacks.onStateChange(this.#state);
    this.#callbacks.onTrashed();
  }

  #skippedTrashed(): CompactResult {
    return {
      status: 'skipped_trashed',
      throughSeq: this.#lastCommittedSeq,
      projected: false,
      revision: null,
      contentInvalid: null,
      oversize: false,
      snapshotRefused: false,
      snapshotBytes: 0,
      sizeChars: 0,
    };
  }

  // ---- backpressure ------------------------------------------------------------------------------

  #enterBackpressure(): void {
    this.#backpressured = true;
    if (this.#state === 'idle' || this.#state === 'writing') this.#state = 'backpressure';
    this.#setAllReadOnly(true);
    this.#metrics.persistFailuresTotal.inc({ reason: 'backpressure' });
    this.#logger.warn(
      {
        event: 'persist.backpressure',
        noteId: this.noteId,
        queued: this.#queue.length,
        bytes: this.#queueBytes,
      },
      'the writer queue reached its bound; the document is read-only until it drains',
    );
    this.#sendPersistFailed('backpressure', BACKPRESSURE_RETRY_HINT_MS);
    this.#callbacks.onStateChange(this.#state);
  }

  /** The hysteresis of 05, "Bounded queue and backpressure": below half of both bounds. */
  #belowHalfOfBothBounds(): boolean {
    return (
      this.#queue.length < LIMITS.WRITER_QUEUE_MAX_UPDATES / 2 &&
      this.#queueBytes < LIMITS.WRITER_QUEUE_MAX_BYTES / 2
    );
  }

  #setAllReadOnly(readOnly: boolean): void {
    for (const connection of this.#document.getConnections()) connection.readOnly = readOnly;
  }

  /** Restores `readOnly` from each connection's role and tells every client its role again. */
  #restoreRoleReadOnly(): void {
    if (
      this.#contentInvalid ||
      this.#oversize ||
      this.#casViolated ||
      this.#backpressured ||
      this.#state === 'failed'
    )
      return;
    for (const connection of this.#document.getConnections()) {
      const userId = connection.context.userId;
      if (this.#ownershipLost || (userId !== undefined && this.#principalBlocked?.(userId))) {
        connection.readOnly = true;
        continue;
      }
      const role = connection.context.role ?? 'viewer';
      connection.readOnly = role === 'viewer';
      connection.sendStateless(encodeStateless({ v: 1, t: 'role', role, recovered: true }));
    }
  }

  // ---- compaction --------------------------------------------------------------------------------

  async #runJob(): Promise<void> {
    const job = this.#jobs.shift();
    if (job === undefined) return;
    this.#runningJob = job;
    if (job.kind === 'restore') {
      try {
        await this.#runRestore(job);
      } finally {
        this.#runningJob = null;
      }
      return;
    }
    if (job.kind === 'checkpoint') {
      try {
        await this.#runCheckpoint(job);
      } finally {
        this.#runningJob = null;
      }
      return;
    }
    const faults: CompactionFaults = {
      beforeSnapshot: () => {
        this.#faults.maybeThrow('compact.throw', () => new Error('compact.throw fault point'));
      },
      snapshotRefusedByFault: () => this.#faults.fire('compact.snapshot-oversize').fired,
    };
    let outcome: CompactResult;
    try {
      const captured = await this.#captureCommitted();
      outcome = await runCompaction(this.#store, {
        assertActive: () => {
          if (this.#ownershipLost) throw new CollabOwnershipLost();
        },
        ...(this.#prepareProjection === undefined
          ? {}
          : { prepareProjection: this.#prepareProjection }),
        noteId: this.noteId,
        vaultId: this.#identity.vaultId,
        captured,
        trigger: job.trigger,
        now: this.#clock.date(),
        faults,
        actor:
          captured.lastEditor === null
            ? SYSTEM_ACTOR
            : { userId: captured.lastEditor.userId, sessionId: null, actorType: 'user' },
        onStateVectorOversize: (bytes) => {
          this.#metrics.stateVectorOversizeTotal.inc();
          this.#logger.warn(
            { event: 'collab.state_vector.oversize', noteId: this.noteId, bytes },
            'a state vector exceeded the stored width and was recorded as zero length',
          );
        },
      });
    } catch (error) {
      this.#runningJob = null;
      if (error instanceof HeadSeqCasViolation) this.#onWriteFailure(error);
      this.#metrics.compactionsTotal.inc({ trigger: job.trigger, status: 'error' });
      this.#logger.error(
        { err: error, event: 'compaction.refused', noteId: this.noteId, trigger: job.trigger },
        'a compaction failed; the document stays in memory and the next change re-schedules it',
      );
      for (const settle of job.settle) settle.reject(error);
      return;
    }
    this.#runningJob = null;
    this.#afterCompaction(job.trigger, outcome);
    for (const settle of job.settle) settle.resolve(outcome);
  }

  async #runCheckpoint(job: CheckpointJob): Promise<void> {
    try {
      const captured = await this.#captureCommitted();
      if (job.request.kind === 'named' && !captured.scan.ok)
        throw new RevisionContentRefused('content_invalid');
      if (this.#ownershipLost) throw new CollabOwnershipLost();
      // Keep explicit revisions on the fenced per-note transaction. No target lookup or
      // projection publication occurs, so this path does not need the shared vault gate.
      const revision = await this.#store.runCheckpoint(this.noteId, async (tx) => {
        const head = await tx.lockHead();
        if (this.#ownershipLost) throw new CollabOwnershipLost();
        if (head === null || head.headSeq !== captured.throughSeq) {
          throw new HeadSeqCasViolation({
            table: 'note_docs',
            id: this.noteId,
            expected: captured.throughSeq,
          });
        }
        if (head.deletedAt !== null) throw new NoteTrashedDuringWrite(this.noteId);
        const inserted = await tx.insertRevision({
          seq: captured.throughSeq,
          kind: job.request.kind,
          label: job.request.label,
          actor: job.request.actor,
          markdown: captured.markdown,
          contentHash: captured.contentHash,
          sizeChars: captured.sizeChars,
          snapshot: captured.stateV2,
          snapshotSv: storedSv(captured.sv),
          createdAt: this.#clock.date(),
        });
        if (inserted.inserted && job.request.audit !== undefined) {
          await tx.recordAudit({
            ...job.request.audit,
            metadata: {
              ...job.request.audit.metadata,
              revision: captured.throughSeq,
              revisionId: inserted.id,
              label: job.request.label,
            },
          });
        }
        return inserted;
      });
      if (this.#ownershipLost) throw new CollabOwnershipLost();
      if (revision.inserted && job.request.kind === 'named')
        this.#document.broadcastStateless(
          encodeStateless({
            v: 1,
            t: 'checkpoint',
            seq: captured.throughSeq,
            revisionId: revision.id,
            kind: 'named',
            label: job.request.label,
          }),
        );
      for (const settle of job.settle) settle.resolve({ captured, revision });
    } catch (error) {
      if (error instanceof HeadSeqCasViolation || error instanceof NoteTrashedDuringWrite) {
        this.#onWriteFailure(error);
      }
      for (const settle of job.settle) settle.reject(error);
    }
  }

  #prepareRestore(job: RestoreJob): RestoreAttempt {
    if (this.#ownershipLost) throw new CollabOwnershipLost();
    if (this.#contentInvalid) throw new RevisionContentRefused('content_invalid');
    const request = job.request;
    const pending = [...this.#queue];
    const pendingRuns = groupRuns(pending);
    const from = this.#lastCommittedSeq;
    const before = capture(request.document, {
      lastCommittedSeq: from + pendingRuns.length,
      lastEditor: this.#lastEditor,
    });
    if (!before.scan.ok) throw new RevisionContentRefused('content_invalid');
    if (
      this.#oversize ||
      before.sizeChars > LIMITS.NOTE_SOFT_MAX_UTF16 ||
      request.target.length > LIMITS.NOTE_SOFT_MAX_UTF16
    ) {
      throw new RevisionContentRefused('note_oversized');
    }
    const diff = prefixSuffixDiff(before.markdown, request.target);
    const changed = diff.deleteLength !== 0 || diff.insert.length !== 0;
    // No promise or callback that yields is permitted from capture through both sets of update events.
    if (changed) request.apply(diff);
    const restoreUpdates = this.#queue.slice(pending.length);
    if (
      restoreUpdates.some((update) => update.origin !== 'restore') ||
      (changed && restoreUpdates.length === 0)
    ) {
      throw new Error('The synchronous restore did not produce its bounded restore updates.');
    }
    const restoreRuns = groupRuns(restoreUpdates);
    const runs = [...pendingRuns, ...restoreRuns];
    const after = capture(request.document, {
      lastCommittedSeq: from + runs.length,
      lastEditor: this.#lastEditor,
    });
    if (after.markdown !== request.target || !after.scan.ok)
      throw new Error('Restore must reproduce the revision text exactly.');
    const now = this.#clock.date();
    return {
      batch: [...pending, ...restoreUpdates],
      pendingRows: pendingRuns.length,
      before,
      after,
      from,
      changed,
      now,
      dsAfter: deleteSetFingerprint(request.document),
      submitted: false,
      rows: runs.map((run, index) => ({
        seq: from + index + 1,
        updateV1: run.merged,
        svAfter: run.storedSv,
        actor: run.actor,
        origin: run.origin,
        createdAt: now,
      })),
    };
  }

  async #runRestore(job: RestoreJob): Promise<void> {
    let attempt: RestoreAttempt;
    try {
      attempt = job.attempt ?? this.#prepareRestore(job);
      job.attempt = attempt;
    } catch (error) {
      for (const settle of job.settle) settle.reject(error);
      return;
    }
    const { rows, before, after, from, changed, now } = attempt;
    const recovering = this.#state === 'retrying' || this.#state === 'failed';
    this.#state = this.#backpressured ? 'backpressure' : 'writing';
    this.#callbacks.onStateChange(this.#state);
    const revisionRow = (captured: Captured, kind: 'pre_restore' | 'restore'): RevisionInsert => ({
      seq: captured.throughSeq,
      kind,
      label: null,
      markdown: captured.markdown,
      contentHash: captured.contentHash,
      sizeChars: captured.sizeChars,
      snapshot: captured.stateV2,
      snapshotSv: storedSv(captured.sv),
      actor: job.request.actor,
      createdAt: now,
      ...(kind === 'restore' ? { restoredFromRevisionId: job.request.revisionId } : {}),
    });
    let result: RestoreResult;
    try {
      this.#faults.maybeThrow('store.throw', () => new Error('store.throw fault point'));
      if (!changed && rows.length === 0)
        result = { changed: false, seq: from, contentHash: after.contentHash.toString('hex') };
      else
        result = await this.#store.runWrite(this.noteId, async (tx) => {
          const head = await tx.lockHead();
          if (this.#ownershipLost) throw new CollabOwnershipLost();
          if (head === null) throw new HeadSeqCasViolation({ table: 'note_docs', id: this.noteId });
          if (head.deletedAt !== null) throw new NoteTrashedDuringWrite(this.noteId);
          const committed =
            attempt.submitted &&
            head.headSeq === after.throughSeq &&
            (await tx.matchesUpdates(rows));
          if (!committed && head.headSeq !== from)
            throw new HeadSeqCasViolation({ table: 'note_docs', id: this.noteId, expected: from });
          attempt.submitted = true;
          if (!committed) await tx.insertUpdates(rows.slice(0, attempt.pendingRows));
          const pre = changed ? await tx.insertRevision(revisionRow(before, 'pre_restore')) : null;
          if (!committed) {
            await tx.insertUpdates(rows.slice(attempt.pendingRows));
            if (!(await tx.casHead(from, after.throughSeq, now)))
              throw new HeadSeqCasViolation({
                table: 'note_docs',
                id: this.noteId,
                expected: from,
              });
          }
          const restored = changed ? await tx.insertRevision(revisionRow(after, 'restore')) : null;
          if (restored === null || pre === null)
            return {
              changed: false,
              seq: after.throughSeq,
              contentHash: after.contentHash.toString('hex'),
            };
          if (!committed) {
            await tx.recordAudit({
              ...job.request.audit,
              metadata: {
                ...job.request.audit.metadata,
                revision: after.throughSeq,
                revisionId: restored.id,
                preRestoreRevisionId: pre.id,
                restoredFromRevisionId: job.request.revisionId,
              },
            });
            await this.#faults.hold('store.hold-before-commit');
            this.#faults.crash('store.crash-before-commit');
          }
          return {
            changed: true,
            seq: after.throughSeq,
            contentHash: after.contentHash.toString('hex'),
            preRestoreRevisionId: pre.id,
            restoreRevisionId: restored.id,
          };
        });
      this.#faults.maybeThrow('store.throw-after-commit-before-ack', () =>
        Object.assign(new Error('The restore commit reply was lost.'), { code: 'ECONNRESET' }),
      );
    } catch (error) {
      this.#jobs.unshift(job);
      this.#onWriteFailure(error);
      return;
    }
    if (this.#ownershipLost) {
      for (const settle of job.settle) settle.reject(new CollabOwnershipLost());
      return;
    }
    this.#faults.crash('store.crash-after-commit-before-ack');
    this.#queue.splice(0, attempt.batch.length);
    this.#writtenCount += attempt.batch.length;
    this.#queueBytes -= attempt.batch.reduce((total, update) => total + update.bytes, 0);
    this.#lastCommittedSeq = after.throughSeq;
    this.#lastPersisted = { seq: after.throughSeq, sv: after.sv, ds: attempt.dsAfter };
    const last = attempt.batch.at(-1);
    if (last !== undefined) this.#lastEditor = { userId: last.actor.userId, at: now };
    if (rows.length > 0)
      this.#document.broadcastStateless(
        encodeStateless({
          v: 1,
          t: 'persisted',
          seq: after.throughSeq,
          sv: base64(after.sv),
          ds: attempt.dsAfter,
        }),
      );
    if (result.changed) {
      this.#document.broadcastStateless(
        encodeStateless({
          v: 1,
          t: 'checkpoint',
          seq: before.throughSeq,
          revisionId: result.preRestoreRevisionId,
          kind: 'pre_restore',
        }),
      );
      this.#document.broadcastStateless(
        encodeStateless({
          v: 1,
          t: 'checkpoint',
          seq: result.seq,
          revisionId: result.restoreRevisionId,
          kind: 'restore',
        }),
      );
    }
    this.#onWriteSuccess(recovering);
    for (const settle of job.settle) settle.resolve(result);
  }

  /**
   * Later FIFO entries are already applied to the live document. Rebuild only the committed prefix
   * for this job; otherwise a snapshot could durably contain an update its through-seq excludes.
   * The final transaction rechecks this head under lock, so an out-of-band writer cannot race it.
   */
  async #captureCommitted(): Promise<Captured> {
    const row = await this.#store.loadDoc(this.noteId);
    if (row === null || row.headSeq !== this.#lastCommittedSeq) {
      throw new HeadSeqCasViolation({
        table: 'note_docs',
        id: this.noteId,
        expected: this.#lastCommittedSeq,
      });
    }
    const updates = await this.#store.loadUpdatesAfter(this.noteId, row.snapshotThroughSeq);
    let through = row.snapshotThroughSeq;
    for (const update of updates) {
      if (update.seq !== through + 1 || update.seq > this.#lastCommittedSeq) {
        throw new HeadSeqCasViolation({
          table: 'note_docs',
          id: this.noteId,
          expected: this.#lastCommittedSeq,
        });
      }
      through = update.seq;
    }
    if (through !== this.#lastCommittedSeq) {
      throw new HeadSeqCasViolation({
        table: 'note_docs',
        id: this.noteId,
        expected: this.#lastCommittedSeq,
      });
    }
    const committed = createNoteDoc({ gc: true });
    try {
      applyLoaded(committed, { ...row, updates });
      return capture(committed, this);
    } finally {
      committed.destroy();
    }
  }

  /** Step 7: broadcasts, latches and metrics, after COMMIT. */
  #afterCompaction(trigger: CompactTrigger, outcome: CompactResult): void {
    if (this.#ownershipLost) return;
    this.#metrics.compactionsTotal.inc({ trigger, status: outcome.status });
    if (outcome.status === 'skipped_trashed') return;
    const wasSafetyLatched = this.#contentInvalid || this.#oversize;
    this.#sizeChars = outcome.sizeChars;
    this.#metrics.noteStateBytes.observe(outcome.snapshotBytes);
    if (outcome.projected) {
      this.#projectedSeq = outcome.throughSeq;
      this.#document.broadcastStateless(
        encodeStateless({ v: 1, t: 'projected', seq: outcome.throughSeq }),
      );
    }
    if (outcome.revision !== null) {
      this.#document.broadcastStateless(
        encodeStateless({
          v: 1,
          t: 'checkpoint',
          seq: outcome.throughSeq,
          revisionId: outcome.revision.id,
          kind: outcome.revision.kind,
          ...(outcome.revision.label === null ? {} : { label: outcome.revision.label }),
        }),
      );
    }
    if (outcome.contentInvalid !== null) {
      const newlyInvalid = !this.#contentInvalid;
      this.#contentInvalid = true;
      this.#contentInvalidReason = outcome.contentInvalid.reason;
      this.#setAllReadOnly(true);
      this.#document.broadcastStateless(
        encodeStateless({ v: 1, t: 'content-invalid', reason: outcome.contentInvalid.reason }),
      );
      if (newlyInvalid) {
        this.#metrics.contentInvalidTotal.inc({ reason: outcome.contentInvalid.reason });
        this.#logger.error(
          {
            event: 'projection.invalid_content',
            noteId: this.noteId,
            reason: outcome.contentInvalid.reason,
          },
          'the compaction scan found hostile content; the note is read-only until repaired',
        );
      }
    } else if (this.#contentInvalid) {
      // Apply both safety outcomes before deciding whether this repair made editing safe again.
      this.#contentInvalid = false;
      this.#contentInvalidReason = null;
    }
    if (outcome.snapshotRefused) {
      this.#logger.error(
        { event: 'compaction.refused', noteId: this.noteId, bytes: outcome.snapshotBytes },
        'the V2 snapshot exceeded SNAPSHOT_REFUSE_BYTES; the blob was refused and the note is read-only',
      );
    }
    if (outcome.oversize) {
      const newlyOversize = !this.#oversize;
      this.#oversize = true;
      this.#setAllReadOnly(true);
      if (newlyOversize) {
        this.#document.broadcastStateless(
          encodeStateless({
            v: 1,
            t: 'size-exceeded',
            size: outcome.sizeChars,
            max: LIMITS.NOTE_SOFT_MAX_UTF16,
          }),
        );
      }
    } else if (this.#oversize) {
      this.#oversize = false;
    }
    // One compaction can clear invalid content while imposing a new snapshot-size latch. Recovery
    // describes the complete committed outcome, never the intermediate state between those flags.
    if (wasSafetyLatched && !this.#contentInvalid && !this.#oversize) this.#restoreRoleReadOnly();
  }

  // ---- unload ------------------------------------------------------------------------------------

  /**
   * The four veto conditions of `beforeUnloadDocument`, in the plan's order. `null` means the document
   * may unload. A veto records `unloadRequested`, so the writer completes the unload itself later.
   */
  async unloadVeto(): Promise<UnloadVeto | null> {
    if (this.#state === 'disposed' || this.#ownershipLost) return null;
    // Hocuspocus swallows a beforeUnload rejection and never retries an idle document. Record
    // intent before any asynchronous check, including the first revision read and trashed path.
    this.#unloadRequested = true;
    try {
      if (this.#state === 'trashed') {
        const veto = await this.#trashedUnloadVeto();
        this.#armUnloadRetry();
        return veto;
      }
      let condition: string | null = null;
      if (this.#queue.length > 0) condition = 'the update queue is not empty';
      else if (this.#inFlight) condition = 'a transaction is in flight';
      else if (
        this.#state === 'retrying' ||
        this.#state === 'failed' ||
        this.#state === 'backpressure'
      )
        condition = 'the writer is ' + this.#state;
      else if (this.#jobs.length > 0) condition = 'a snapshot job is queued';
      else if (!(await this.#store.revisionExistsAt(this.noteId, this.#lastCommittedSeq))) {
        condition = 'no note_revisions row exists at head_seq';
        this.#ensureJob('unload');
      }
      if (condition === null) {
        this.#armUnloadRetry();
        return null;
      }
      this.#schedule();
      return new UnloadVeto(condition);
    } catch (error) {
      this.#unloadFailed(error);
      return new UnloadVeto('the committed checkpoint could not be verified');
    }
  }

  /**
   * A trashed writer cannot compact (step 0 refuses), so the checkpoint condition is served from the
   * committed log: the `unload` row is written from a throwaway document built by the loader, never
   * from the live document, which is ahead of the log after the drop.
   */
  async #trashedUnloadVeto(): Promise<UnloadVeto | null> {
    const row = await this.#store.loadDoc(this.noteId);
    if (row === null) return null;
    if (await this.#store.revisionExistsAt(this.noteId, row.headSeq)) return null;
    const updates = await this.#store.loadUpdatesAfter(this.noteId, row.snapshotThroughSeq);
    const throwaway = createNoteDoc({ gc: true });
    try {
      applyLoaded(throwaway, { ...row, updates });
      const markdown = projectMarkdown(throwaway);
      await this.#store.insertRevision(this.noteId, {
        seq: row.headSeq,
        kind: 'unload',
        label: null,
        markdown,
        contentHash: contentHash(markdown),
        sizeChars: markdown.length,
        snapshot: null,
        snapshotSv: null,
        actor: SYSTEM_ACTOR,
        createdAt: this.#clock.date(),
      });
    } finally {
      throwaway.destroy();
    }
    return null;
  }

  /** Whether a vetoed unload is waiting on the writer. @internal */
  get unloadRequested(): boolean {
    return this.#unloadRequested;
  }

  #afterTurn(): void {
    this.#settleAccepted();
    if (this.#ownershipLost) return;
    this.#settleDrainWaiters();
    this.#resumeUnload();
  }

  #readyToCompleteUnload(): boolean {
    return (
      !this.#ownershipLost &&
      (this.#state === 'idle' || this.#state === 'trashed') &&
      this.#queue.length === 0 &&
      this.#jobs.length === 0 &&
      !this.#inFlight &&
      this.#document.getConnectionsCount() === 0
    );
  }

  #resumeUnload(): void {
    if (
      this.#unloadRequested &&
      !this.#unloadCompleting &&
      this.#unloadRetryTimer === null &&
      this.#readyToCompleteUnload()
    )
      void this.#completeUnload();
  }

  #armUnloadRetry(): void {
    if (
      !this.#unloadRequested ||
      this.#ownershipLost ||
      this.#state === 'disposed' ||
      this.#document.getConnectionsCount() > 0 ||
      this.#unloadRetryTimer !== null
    )
      return;
    this.#unloadAttempt += 1;
    // A positive floor prevents a synchronous failure and zero jitter from spinning while idle.
    const delay = Math.max(BACKOFF_BASE_MS, retryDelayMs(this.#unloadAttempt, this.#random));
    this.#unloadRetryTimer = this.#clock.after(delay, () => {
      this.#unloadRetryTimer = null;
      this.#resumeUnload();
    });
  }

  #unloadFailed(error: unknown): void {
    this.#logger.warn(
      { err: error, event: 'compaction.refused', noteId: this.noteId },
      'completing a vetoed unload failed; the writer retains the request and retries while idle',
    );
    this.#armUnloadRetry();
  }

  async #completeUnload(): Promise<void> {
    this.#unloadCompleting = true;
    try {
      if (this.#state === 'trashed') await this.#trashedUnloadVeto();
      else if (!(await this.#store.revisionExistsAt(this.noteId, this.#lastCommittedSeq))) {
        await this.enqueueCompaction('unload');
      }
      if (this.#readyToCompleteUnload()) await this.#callbacks.requestUnload();
      // Hocuspocus may resolve without unloading (another hook vetoed or the save mutex was busy).
      // Only dispose confirms completion, so a still-idle lifetime retains a bounded retry.
      if (this.#readyToCompleteUnload()) this.#armUnloadRetry();
    } catch (error) {
      this.#unloadFailed(error);
    } finally {
      this.#unloadCompleting = false;
    }
  }

  // ---- drain and dispose -------------------------------------------------------------------------

  /** Pending FIFO work still attributed to a principal, including its in-flight batch. */
  hasPendingFor(userId: UserId | null): boolean {
    return userId === null || this.#queue.some((item) => item.actor.userId === userId);
  }

  /** Captures a finite accepted prefix, so unrelated later writers cannot starve revocation. */
  async drainAccepted(): Promise<void> {
    if (this.#ownershipLost) throw new CollabOwnershipLost();
    if (this.#writtenCount >= this.#enqueuedCount) return;
    if (
      this.#state === 'retrying' ||
      this.#state === 'failed' ||
      this.#state === 'disposed' ||
      this.#state === 'trashed'
    ) {
      throw new PersistenceDrainUnavailable(this.noteId, this.#state);
    }
    const settled = new Promise<void>((resolve, reject) => {
      this.#acceptedWaiters.push({ through: this.#enqueuedCount, resolve, reject });
    });
    this.#schedule();
    await settled;
  }

  #settleAccepted(): void {
    const waiters = this.#acceptedWaiters;
    this.#acceptedWaiters = [];
    for (const waiter of waiters) {
      if (this.#ownershipLost) waiter.reject(new CollabOwnershipLost());
      else if (this.#writtenCount >= waiter.through) waiter.resolve();
      else if (
        this.#state === 'retrying' ||
        this.#state === 'failed' ||
        this.#state === 'disposed' ||
        this.#state === 'trashed'
      ) {
        waiter.reject(new PersistenceDrainUnavailable(this.noteId, this.#state));
      } else this.#acceptedWaiters.push(waiter);
    }
  }

  /** Resolves when the queue is empty, no job is pending and nothing is in flight. */
  async drain(): Promise<void> {
    if (this.#ownershipLost) throw new CollabOwnershipLost();
    if (this.#drained()) return;
    this.#schedule();
    await new Promise<void>((resolve) => {
      this.#drainWaiters.push(resolve);
    });
    if (this.#ownershipLost) throw new CollabOwnershipLost();
  }

  #drained(): boolean {
    if (this.#state === 'trashed' || this.#state === 'disposed') return true;
    return this.#queue.length === 0 && this.#jobs.length === 0 && !this.#inFlight;
  }

  #settleDrainWaiters(): void {
    if (!this.#drained() || this.#drainWaiters.length === 0) return;
    const waiters = this.#drainWaiters;
    this.#drainWaiters = [];
    for (const resolve of waiters) resolve();
  }

  /** Freezes this lifetime without discarding an in-flight transaction or announcing recovery. */
  fence(): void {
    this.#ownershipLost = true;
    for (let index = this.#jobs.length - 1; index >= 0; index -= 1) {
      const job = this.#jobs[index];
      if (job === undefined || job.kind === 'compaction') continue;
      this.#jobs.splice(index, 1);
      for (const settle of job.settle) settle.reject(new CollabOwnershipLost());
    }
    this.#unloadRetryTimer?.cancel();
    this.#unloadRetryTimer = null;
    this.#unloadRequested = false;
    this.#settleAccepted();
    this.#retryTimer?.cancel();
    this.#retryTimer = null;
    this.#scheduler.forget(this);
    for (const connection of this.#document.getConnections()) connection.readOnly = true;
  }

  /** `afterUnloadDocument`: clears timers, releases the ring entry, rejects what is still pending. */
  dispose(): void {
    if (this.#state === 'disposed') return;
    this.#retryTimer?.cancel();
    this.#retryTimer = null;
    this.#state = 'disposed';
    this.#unloadRetryTimer?.cancel();
    this.#unloadRetryTimer = null;
    this.#unloadRequested = false;
    this.#writeAttempt = null;
    this.#settleAccepted();
    this.#scheduler.forget(this);
    for (const job of this.#jobs.splice(0, this.#jobs.length)) {
      for (const settle of job.settle) {
        settle.reject(
          job.kind === 'compaction'
            ? new CompactionUnavailable(this.noteId, 'disposed')
            : new CheckpointUnavailable(this.noteId, 'disposed'),
        );
      }
    }
    this.#queue.length = 0;
    this.#queueBytes = 0;
    this.#settleDrainWaiters();
    this.#callbacks.onStateChange(this.#state);
  }

  /** Logs the first unknown transaction origin per document, and no more. @internal */
  noteUnknownOrigin(origin: unknown): void {
    if (this.#unknownOriginLogged) return;
    this.#unknownOriginLogged = true;
    this.#logger.warn(
      { event: 'collab.hook.error', noteId: this.noteId, origin: describeOrigin(origin) },
      'an update with an unknown transaction origin was not persisted',
    );
  }
}

function describeOrigin(origin: unknown): string {
  if (typeof origin === 'symbol') return origin.description ?? 'symbol';
  if (typeof origin === 'object' && origin !== null) return Object.keys(origin).join(',');
  return typeof origin;
}

/** Whether two queued updates belong to one run: equal `(userId, sessionId, origin)`. */
function sameRun(a: PendingUpdate, b: PendingUpdate): boolean {
  return (
    a.actor.userId === b.actor.userId &&
    a.actor.sessionId === b.actor.sessionId &&
    a.actor.actorType === b.actor.actorType &&
    a.origin === b.origin
  );
}

/**
 * Splits a batch into maximal contiguous same-actor runs and merges each into one row, splitting a
 * run at update boundaries when the merged row would exceed `YJS_UPDATE_MAX_BYTES` (05, "Coalescing").
 */
export function groupRuns(batch: readonly PendingUpdate[]): WriteRun[] {
  const runs: WriteRun[] = [];
  let index = 0;
  while (index < batch.length) {
    const first = batch[index];
    if (first === undefined) break;
    let end = index + 1;
    while (end < batch.length) {
      const candidate = batch[end];
      if (candidate === undefined || !sameRun(first, candidate)) break;
      end += 1;
    }
    runs.push(...mergeRun(batch.slice(index, end)));
    index = end;
  }
  return runs;
}

function mergeRun(members: readonly PendingUpdate[]): WriteRun[] {
  const first = members[0];
  const last = members[members.length - 1];
  if (first === undefined || last === undefined) return [];
  const merged = members.length === 1 ? first.update : mergeV1(members.map((item) => item.update));
  if (merged.byteLength <= LIMITS.YJS_UPDATE_MAX_BYTES || members.length === 1) {
    return [
      {
        merged,
        svAfter: last.svAfter,
        dsAfter: last.dsAfter,
        storedSv: storedSv(last.svAfter),
        actor: first.actor,
        origin: first.origin,
        members: members.length,
      },
    ];
  }
  // Too wide for one frame: split at an update boundary and merge each half on its own.
  const middle = Math.ceil(members.length / 2);
  return [...mergeRun(members.slice(0, middle)), ...mergeRun(members.slice(middle))];
}
