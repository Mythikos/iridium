import { isTransactionOrigin, type Connection } from '@hocuspocus/server';
/**
 * `CollabPersistence` — the durability seam the hooks and the note kernel talk to
 * (05-collaboration-and-durability.md, "The interfaces that confine Hocuspocus").
 *
 * One instance per process owns the writers (one per loaded document), the scheduler, the store and
 * the three gauges the `persist_backlog` readiness check reads. `attach` is where a document meets
 * its writer: it registers Iridium's own `document.on('update')` listener — `onChange` is deliberately
 * unused (Hocuspocus issue #754) — which captures the state vector synchronously after every apply
 * and hands the update to the writer with its authorship from the transaction origin, never from
 * awareness.
 */
import { UserId, type NoteId, type VaultId } from '@iridium/contracts';
import {
  createNoteDoc,
  deleteSetFingerprint,
  projectMarkdown,
  LOAD_ORIGIN,
  recordedSv,
  stateVector,
  type NoteDoc,
} from '@iridium/crdt';

import type { Clock } from '../../ops/clock.ts';
import type { PersistBacklogReading } from '../../ops/readiness.ts';
import type { PrepareProjection } from '../../projection/prepare.ts';
import type { CollabHookContext } from '../context.ts';
import type { CollabLimits } from '../limits.ts';
import { applyLoaded, loadNote, recordedVectorOf, type LoaderLogger } from './loader.ts';
import { WriterScheduler } from './scheduler.ts';
import type { OwnedPersistenceStore, PersistenceStore } from './store.ts';
import {
  asV1Update,
  type CompactResult,
  type CompactTrigger,
  type LoadedState,
  type PendingUpdate,
  type Persisted,
  type UpdateActor,
  type WriterIdentity,
  type WriterOrigin,
  type WriterState,
} from './types.ts';
import {
  NoteWriter,
  type WriterCallbacks,
  type WriterConnection,
  type WriterDocument,
  type WriterFaults,
  type WriterLogger,
  type WriterMetrics,
} from './writer.ts';

/** The gauges the persistence layer moves (`ops/metrics.ts`), resolved lazily after boot step 10. */
export interface PersistGauges {
  readonly persistQueueDepth: { set(value: number): void };
  readonly persistBacklogAgeSeconds: { set(value: number): void };
  readonly persistWritersFailed: { set(value: number): void };
}

/** What the layer calls back into, per document. */
export interface PersistenceCallbacks {
  onTrashed(noteId: NoteId, documentName: string): void;
  requestUnload(documentName: string): Promise<void>;
  onWriteRejected(noteId: NoteId, vaultId: VaultId, reason: string): void;
}

/** What `createCollabPersistence` needs. */
export interface CollabPersistenceOptions {
  readonly prepareProjection?: PrepareProjection;
  readonly store: PersistenceStore;
  /** A store bound to the current owner generation; captured before each document load. */
  readonly writerStore?: () => OwnedPersistenceStore;
  readonly principalBlocked?: (userId: UserId) => boolean;
  readonly clock: Clock;
  readonly logger: WriterLogger & LoaderLogger;
  readonly metrics: () => WriterMetrics | null;
  readonly gauges: () => PersistGauges | null;
  readonly faults: WriterFaults;
  readonly limits: Pick<CollabLimits, 'compactionAwaitTimeoutMs'>;
  /** `DB_POOL_PERSIST` minus the lease's connection: the scheduler's slots. */
  readonly slots: number;
  readonly callbacks: PersistenceCallbacks;
  readonly random?: () => number;
}

/** The context a `{source:'local'}` origin carries (04 §6.9). */
interface LocalContextLike {
  readonly reason?: unknown;
  readonly userId?: unknown;
}

interface MappedOrigin {
  readonly actor: UpdateActor;
  readonly origin: WriterOrigin;
  readonly source: WriterConnection | undefined;
}

const MS_PER_SECOND = 1000;

/** The metrics slice that counts nothing, for a hook running before the registry exists. */
const NO_METRICS: WriterMetrics = Object.freeze({
  persistLatencySeconds: { observe(): void {} },
  persistFailuresTotal: { inc(): void {} },
  compactionsTotal: { inc(): void {} },
  noteStateBytes: { observe(): void {} },
  stateVectorOversizeTotal: { inc(): void {} },
  contentInvalidTotal: { inc(): void {} },
});

/** The origin table of 05, "Document model": which origins are persisted, and as what. */
export function mapOrigin(origin: unknown): MappedOrigin | 'load' | null {
  if (origin === LOAD_ORIGIN) return 'load';
  if (!isTransactionOrigin(origin)) return null;
  if (origin.source === 'connection') {
    const connection: Connection<CollabHookContext> = origin.connection;
    const context = connection.context;
    return {
      actor: {
        userId: context.userId ?? null,
        sessionId: context.sessionId ?? null,
        actorType: 'user',
      },
      origin: 'connection',
      source: connection,
    };
  }
  if (origin.source === 'local') {
    const context: LocalContextLike =
      typeof origin.context === 'object' && origin.context !== null ? origin.context : {};
    const reason = context.reason;
    if (reason !== 'restore' && reason !== 'repair') return null;
    const userId = UserId.safeParse(context.userId);
    const actorId = userId.success ? userId.data : null;
    return {
      actor: { userId: actorId, sessionId: null, actorType: actorId === null ? 'system' : 'user' },
      origin: reason,
      source: undefined,
    };
  }
  return null;
}

/** A shutdown cannot call a retired writer clean merely because its live map entry disappeared. */
export class PersistenceShutdownIncomplete extends AggregateError {
  readonly code = 'persist.shutdown_incomplete';
  readonly undrained: readonly NoteId[];

  constructor(undrained: readonly NoteId[], causes: readonly unknown[] = []) {
    super(
      causes,
      `shutdown could not complete the captured writer lifetimes; undrained: ${undrained.join(', ')}`,
    );
    this.name = 'PersistenceShutdownIncomplete';
    this.undrained = [...undrained];
  }
}

/** The persistence layer. */
export class CollabPersistenceService {
  readonly #options: CollabPersistenceOptions;
  readonly #loadedStores = new WeakMap<LoadedState, OwnedPersistenceStore>();
  readonly #documents = new WeakMap<NoteWriter, NoteDoc>();
  readonly #fencedDocuments = new WeakMap<NoteDoc, Promise<void>>();
  readonly #scheduler: WriterScheduler;
  readonly #writers = new Map<NoteId, NoteWriter>();
  readonly #byDocument = new Map<string, NoteWriter>();
  #shutdownWriters: Map<NoteWriter, 'active' | 'complete' | 'fenced'> | null = null;

  constructor(options: CollabPersistenceOptions) {
    this.#options = options;
    this.#scheduler = new WriterScheduler(options.slots, options.logger);
  }

  /** The scheduler, for assertions on fairness. @internal */
  get scheduler(): WriterScheduler {
    return this.#scheduler;
  }

  /** `loader.load`: the state of one note for one vault, or a `CollabRejection`. */
  async load(noteId: NoteId, vaultId: VaultId): Promise<LoadedState> {
    const scoped = this.#options.writerStore?.();
    const loaded = await loadNote(
      scoped ?? this.#options.store,
      noteId,
      vaultId,
      this.#options.logger,
    );
    if (scoped !== undefined) {
      scoped.assertActive();
      this.#loadedStores.set(loaded, scoped);
    }
    return loaded;
  }

  /** Applies a loaded state to a document in place (`onLoadDocument`). */
  apply(document: NoteDoc, loaded: LoadedState): void {
    applyLoaded(document, loaded);
  }

  /**
   * Creates the writer, registers the `update` listener and initialises `lastPersisted` from the
   * recorded vector — or from `stateVector(document)` when the recorded value is zero length or
   * `NULL` (D03-01), which yields the same value because the document has applied everything through
   * `head_seq`.
   */
  attach(
    document: NoteDoc & WriterDocument,
    identity: WriterIdentity,
    loaded: LoadedState,
  ): NoteWriter {
    const existing = this.#writers.get(identity.noteId);
    if (existing !== undefined) return existing;
    const scoped = this.#loadedStores.get(loaded) ?? this.#options.writerStore?.();
    scoped?.assertActive();
    const lastPersisted: Persisted = {
      seq: loaded.headSeq,
      sv: recordedSv(recordedVectorOf(loaded), document),
      ds: deleteSetFingerprint(document),
    };
    const callbacks: WriterCallbacks = {
      onTrashed: () => this.#options.callbacks.onTrashed(identity.noteId, identity.documentName),
      requestUnload: () => this.#options.callbacks.requestUnload(identity.documentName),
      onStateChange: () => this.refreshGauges(),
      onWriteRejected: (reason) =>
        this.#options.callbacks.onWriteRejected(identity.noteId, identity.vaultId, reason),
    };
    const writer = new NoteWriter({
      ...(this.#options.prepareProjection === undefined
        ? {}
        : { prepareProjection: this.#options.prepareProjection }),
      identity,
      document,
      store: scoped ?? this.#options.store,
      clock: this.#options.clock,
      logger: this.#options.logger,
      metrics: this.#lazyMetrics(),
      faults: this.#options.faults,
      scheduler: this.#scheduler,
      callbacks,
      compactionAwaitTimeoutMs: this.#options.limits.compactionAwaitTimeoutMs,
      lastPersisted,
      contentInvalid: loaded.contentInvalid,
      oversize: loaded.oversize,
      projectedSeq: loaded.projectedSeq,
      sizeChars: projectMarkdown(document).length,
      ...(this.#options.random === undefined ? {} : { random: this.#options.random }),
      ...(this.#options.principalBlocked === undefined
        ? {}
        : { principalBlocked: this.#options.principalBlocked }),
    });
    this.#documents.set(writer, document);
    this.#writers.set(identity.noteId, writer);
    this.#byDocument.set(identity.documentName, writer);
    this.#shutdownWriters?.set(writer, 'active');

    const listener = (update: Uint8Array, origin: unknown): void => {
      try {
        const mapped = mapOrigin(origin);
        if (mapped === 'load') return;
        if (mapped === null) {
          writer.noteUnknownOrigin(origin);
          return;
        }
        const pending: PendingUpdate = {
          update: asV1Update(update),
          svAfter: stateVector(document),
          dsAfter: deleteSetFingerprint(document),
          actor: mapped.actor,
          origin: mapped.origin,
          bytes: update.byteLength,
          enqueuedAt: this.#options.clock.monotonic(),
        };
        writer.enqueue(pending, mapped.source);
      } catch (error) {
        // Never rethrow into Yjs: the apply has already happened on every peer.
        this.#options.logger.error(
          {
            err: error,
            event: 'collab.hook.error',
            hook: 'update-listener',
            documentName: identity.documentName,
          },
          'the update listener failed',
        );
        this.#lazyMetrics().persistFailuresTotal.inc({ reason: 'db_error' });
      }
    };
    document.on('update', listener);
    this.refreshGauges();
    return writer;
  }

  /** A metrics slice that resolves the registry at call time, because it exists only after boot. */
  #lazyMetrics(): WriterMetrics {
    const resolve = (): WriterMetrics => this.#options.metrics() ?? NO_METRICS;
    return {
      persistLatencySeconds: { observe: (value) => resolve().persistLatencySeconds.observe(value) },
      persistFailuresTotal: { inc: (labels) => resolve().persistFailuresTotal.inc(labels) },
      compactionsTotal: { inc: (labels) => resolve().compactionsTotal.inc(labels) },
      noteStateBytes: { observe: (value) => resolve().noteStateBytes.observe(value) },
      stateVectorOversizeTotal: { inc: () => resolve().stateVectorOversizeTotal.inc() },
      contentInvalidTotal: { inc: (labels) => resolve().contentInvalidTotal.inc(labels) },
    };
  }

  /** The writer of a loaded note, if any. */
  writerOf(noteId: NoteId): NoteWriter | undefined {
    return this.#writers.get(noteId);
  }

  /** The writer behind a document name, if any. */
  writerOfDocument(documentName: string): NoteWriter | undefined {
    return this.#byDocument.get(documentName);
  }

  /**
   * Enqueues a compaction in the note's FIFO and awaits it, bounded (D05-20). `null` when the note is
   * not loaded: an unloaded note is already current, its last compaction having run at unload.
   */
  compactNow(
    noteId: NoteId,
    options: { readonly trigger: CompactTrigger },
  ): Promise<CompactResult | null> {
    const writer = this.#writers.get(noteId);
    if (writer === undefined) return Promise.resolve(null);
    return writer.enqueueCompaction(options.trigger);
  }

  /** Replay a complete durable prefix, including its delete set, when no writer is attached. */
  async baselineOf(noteId: NoteId): Promise<Persisted | null> {
    const doc = await this.#options.store.loadDoc(noteId);
    if (doc === null) return null;
    // A new writer may commit while these reads await. Its later tail is outside this captured
    // head; a compaction/prune that removes required rows instead makes this baseline retryable.
    const updates = (
      await this.#options.store.loadUpdatesAfter(noteId, doc.snapshotThroughSeq)
    ).filter((update) => update.seq <= doc.headSeq);
    let through = doc.snapshotThroughSeq;
    for (const update of updates) {
      if (update.seq !== through + 1) throw new Error('The committed baseline log is incomplete.');
      through = update.seq;
    }
    if (through !== doc.headSeq) throw new Error('The committed baseline log is incomplete.');
    const throwaway = createNoteDoc({ gc: true });
    try {
      applyLoaded(throwaway, { ...doc, updates });
      return { seq: doc.headSeq, sv: stateVector(throwaway), ds: deleteSetFingerprint(throwaway) };
    } finally {
      throwaway.destroy();
    }
  }

  /** `afterUnloadDocument`: disposes and forgets the writer. */
  detach(documentName: string): void {
    const writer = this.#byDocument.get(documentName);
    if (writer === undefined) return;
    if (this.#shutdownWriters?.get(writer) === 'active') {
      this.#shutdownWriters.set(writer, 'complete');
    }
    writer.dispose();
    this.#byDocument.delete(documentName);
    this.#writers.delete(writer.noteId);
    this.refreshGauges();
  }

  /** Every loaded writer, for the drain and the document listing. */
  writers(): readonly NoteWriter[] {
    return [...this.#writers.values()];
  }

  /**
   * Stops every old-generation queue immediately and waits only for already-running transactions.
   * Their shared fence locks serialize takeover; uncommitted client edits remain in the client Y.Doc.
   */
  async fenceAll(): Promise<void> {
    await this.#fence(this.writers());
  }

  /**
   * Stops the selected queues synchronously; the returned promise waits for already-running SQL.
   * Purge starts this while admission holds the vault, then awaits it only after releasing that lock.
   */
  beginFenceNotes(noteIds: readonly NoteId[]): Promise<void> {
    const ids = new Set(noteIds);
    return this.#fence(this.writers().filter((writer) => ids.has(writer.noteId)));
  }

  /** Tombstoned notes must have no in-flight writer before their durable rows are purged. */
  async fenceNotes(noteIds: readonly NoteId[]): Promise<void> {
    await this.beginFenceNotes(noteIds);
  }

  async #fence(writers: readonly NoteWriter[]): Promise<void> {
    const settled = Promise.withResolvers<void>();
    for (const writer of writers) {
      if (this.#shutdownWriters?.has(writer)) this.#shutdownWriters.set(writer, 'fenced');
      const document = this.#documents.get(writer);
      if (document !== undefined) this.#fencedDocuments.set(document, settled.promise);
      writer.fence();
    }
    await Promise.all(writers.map((writer) => this.#scheduler.settle(writer)));
    for (const writer of writers) this.detach(writer.documentName);
    settled.resolve();
  }

  /** Exact former document objects may unload without an unauthorized new checkpoint. */
  isFenced(document: NoteDoc): boolean {
    return this.#fencedDocuments.has(document);
  }

  /** Old objects may be destroyed only once all already-running SQL has settled. */
  async settleFenced(document: NoteDoc): Promise<void> {
    await this.#fencedDocuments.get(document);
  }

  /**
   * After the gateway fences a principal at the synchronous Yjs apply boundary, every update already
   * accepted from that principal is in these FIFOs. Revocation must await them before its COMMIT.
   * A failed writer stays pending; ownership loss rejects instead of reporting a successful drain.
   */
  async drainForUser(userId: UserId | null): Promise<void> {
    await Promise.all(
      this.writers()
        .filter((writer) => writer.hasPendingFor(userId))
        .map((writer) => writer.drainAccepted()),
    );
  }

  /** Captures exact writer lifetimes before jobs or the socket grace can yield to ownership loss. */
  beginShutdown(): void {
    this.#shutdownWriters ??= new Map(this.writers().map((writer) => [writer, 'active']));
  }

  /** The `writers` drain phase: every queue to COMMIT. The caller bounds it. */
  async drainAll(): Promise<void> {
    const captured = this.#shutdownWriters;
    if (captured === null) {
      await Promise.all(this.writers().map((writer) => writer.drain()));
      return;
    }
    const writers = [...captured.keys()];
    const results = await Promise.allSettled(writers.map((writer) => writer.drain()));
    const failures = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    const undrained = writers
      .filter(
        (writer, index) =>
          captured.get(writer) === 'fenced' || results[index]?.status === 'rejected',
      )
      .map((writer) => writer.noteId);
    if (undrained.length > 0) throw new PersistenceShutdownIncomplete(undrained, failures);
  }

  /** After the unload phase, only a genuine checkpointed unload completes a captured lifetime. */
  assertShutdownComplete(): void {
    const undrained = [...(this.#shutdownWriters ?? [])]
      .filter(([, outcome]) => outcome !== 'complete')
      .map(([writer]) => writer.noteId);
    if (undrained.length > 0) throw new PersistenceShutdownIncomplete(undrained);
  }

  /** The names of writers still holding work — what a drain timeout reports. */
  undrained(): readonly string[] {
    return [
      ...new Set([
        ...this.writers()
          .filter((writer) => writer.queueLength > 0 || writer.inFlight || writer.pendingJobs > 0)
          .map((writer) => writer.noteId),
        ...[...(this.#shutdownWriters ?? [])]
          .filter(([, outcome]) => outcome !== 'complete')
          .map(([writer]) => writer.noteId),
      ]),
    ];
  }

  /** The `persist_backlog` readiness input, and the moment the gauges are refreshed. */
  backlog(): PersistBacklogReading {
    const nowMs = this.#options.clock.monotonic();
    let oldestPendingMs = 0;
    let failedWriters = 0;
    let longestFailedMs = 0;
    for (const writer of this.#writers.values()) {
      const oldest = writer.oldestEnqueuedAt;
      if (oldest !== null) oldestPendingMs = Math.max(oldestPendingMs, nowMs - oldest);
      if (writer.state === 'failed') {
        failedWriters += 1;
        const since = writer.failedSince;
        if (since !== null) longestFailedMs = Math.max(longestFailedMs, nowMs - since);
      }
    }
    return { oldestPendingMs, failedWriters, longestFailedMs };
  }

  /** Pushes the three gauges; called on every writer state change and every readiness evaluation. */
  refreshGauges(): void {
    const gauges = this.#options.gauges();
    if (gauges === null) return;
    let depth = 0;
    for (const writer of this.#writers.values()) depth += writer.queueLength;
    const reading = this.backlog();
    gauges.persistQueueDepth.set(depth);
    gauges.persistBacklogAgeSeconds.set(reading.oldestPendingMs / MS_PER_SECOND);
    gauges.persistWritersFailed.set(reading.failedWriters);
  }

  /** The store, for the one caller that writes a revision outside a compaction (the repair CLI). */
  get store(): PersistenceStore {
    return this.#options.writerStore?.() ?? this.#options.store;
  }

  /** The state of one loaded document's writer, for `loadedDocuments()`. */
  stateOf(documentName: string): WriterState | null {
    return this.#byDocument.get(documentName)?.state ?? null;
  }
}
